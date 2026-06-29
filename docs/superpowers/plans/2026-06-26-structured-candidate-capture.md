# Structured Candidate Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pre-fit raw snapshot persistence with structured candidate files and facts JSON, then submit only qualified candidates to the portal.

**Architecture:** Keep PostgreSQL workflow tables for queue/status/retry control, but move pre-fit evidence into one local markdown candidate file per inventory row. Each workflow step owns one candidate JSON section, while `lead_enrichment_snapshots` stores only `facts jsonb` for structured LinkedIn profile/company facts. A new explicit `submit-qualified` step sends only high-potential candidate JSON to the portal, which owns canonical CRM persistence and draft generation.

**Tech Stack:** Node.js ESM, PostgreSQL via `pg`, Playwright, Crawl4AI Python helper, Node test runner, local markdown candidate files with JSON frontmatter.

---

## File Structure

- Create `src/workflow/candidateFiles.js`: candidate filename creation, markdown JSON parsing/rendering, read/write/merge helpers, directory listing by status.
- Create `test/candidateFiles.test.js`: candidate file behavior.
- Modify `sql/001_workflow_tables.sql`: replace snapshot blob columns with `facts jsonb`.
- Modify `src/workflow/processQueue.js`: profile extractor returns structured facts only; repository writes facts; workflow updates candidate files.
- Modify `test/processQueue.test.js`: profile facts and candidate file assertions.
- Modify `src/linkedin/activitySync.js`: workflow-facing activity field becomes `content`; update candidate files.
- Modify `test/activitySync.test.js`: content field and candidate update assertions.
- Modify `src/linkedin/companyProfileSync.js`: LinkedIn company About extraction returns structured facts only; update candidate files and facts snapshots.
- Modify `test/companyProfileSync.test.js`: company fact extraction and facts snapshot assertions.
- Modify `scripts/crawl_company.py`: return multi-page website crawl shape.
- Modify `src/company/crawl4aiExtractor.js`: normalize multi-page crawl output.
- Modify `src/company/playwrightFallback.js`: return one-page `companyWebsite` shape.
- Create or modify website crawl tests in `test/companyWebsite.test.js`.
- Modify `src/workflow/scoreExtractedProfiles.js`: score from candidate files and activity content.
- Modify `test/scoreExtractedProfiles.test.js`: candidate-file scoring.
- Create `src/adapters/portalCandidates.js`: portal candidate submission adapter.
- Create `src/workflow/submitQualifiedCandidates.js`: submit qualified candidate files and record status.
- Create `test/submitQualifiedCandidates.test.js`: portal submission behavior.
- Modify `src/cli.js`: wire candidate directory into affected commands and add `submit-qualified`.
- Modify skill/docs references to match the new workflow contract.

Because the current workspace is not a git repository, commit steps below are written for the eventual implementation environment. If `git rev-parse --show-toplevel` still fails during execution, record the intended commit message after each task and continue without committing.

---

### Task 1: Candidate File Repository

**Files:**
- Create: `src/workflow/candidateFiles.js`
- Create: `test/candidateFiles.test.js`

- [ ] **Step 1: Write failing candidate file tests**

Create `test/candidateFiles.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CandidateFileRepository,
  buildCandidateFileId,
  parseCandidateMarkdown,
  renderCandidateMarkdown
} from "../src/workflow/candidateFiles.js";

test("buildCandidateFileId uses readable slug and inventory id", () => {
  assert.equal(
    buildCandidateFileId({ fullName: "Jane Smith", inventoryId: "inv_123" }),
    "jane-smith_inv_123"
  );
  assert.equal(
    buildCandidateFileId({ firstName: "Ada", lastName: "Lovelace", inventoryId: "abc-123" }),
    "ada-lovelace_abc-123"
  );
});

test("render and parse candidate markdown keeps JSON as source of truth", () => {
  const candidate = {
    schemaVersion: 1,
    candidate: {
      inventoryId: "inv_123",
      fileId: "jane-smith_inv_123",
      createdAt: "2026-06-26T00:00:00.000Z",
      status: "profile_captured"
    },
    identity: { firstName: "Jane", lastName: "Smith" }
  };

  const markdown = renderCandidateMarkdown(candidate);
  assert.match(markdown, /^```json\n/);
  assert.match(markdown, /## Candidate Summary/);
  assert.deepEqual(parseCandidateMarkdown(markdown), candidate);
});

test("CandidateFileRepository creates and merges candidate sections", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "candidates-"));
  const repository = new CandidateFileRepository({ directory, now: () => new Date("2026-06-26T00:00:00.000Z") });

  const created = await repository.upsertCandidate({
    inventoryId: "inv_123",
    fullName: "Jane Smith",
    patch: {
      identity: { firstName: "Jane", lastName: "Smith" },
      profileCapture: { facts: { currentCompanyName: "Acme AI" } }
    },
    status: "profile_captured"
  });

  assert.equal(created.candidate.fileId, "jane-smith_inv_123");

  const merged = await repository.upsertCandidate({
    inventoryId: "inv_123",
    fullName: "Jane Smith",
    patch: {
      activityCapture: {
        items: [{ activityType: "post", content: "Building useful automation." }]
      }
    },
    status: "activity_captured"
  });

  assert.equal(merged.profileCapture.facts.currentCompanyName, "Acme AI");
  assert.equal(merged.activityCapture.items[0].content, "Building useful automation.");

  const markdown = await readFile(path.join(directory, "jane-smith_inv_123.md"), "utf8");
  assert.deepEqual(parseCandidateMarkdown(markdown), merged);
});

test("CandidateFileRepository lists candidates by status", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "candidates-"));
  const repository = new CandidateFileRepository({ directory, now: () => new Date("2026-06-26T00:00:00.000Z") });

  await repository.upsertCandidate({
    inventoryId: "inv_1",
    fullName: "Jane Smith",
    patch: { identity: { firstName: "Jane", lastName: "Smith" } },
    status: "qualified"
  });
  await repository.upsertCandidate({
    inventoryId: "inv_2",
    fullName: "Pat Lee",
    patch: { identity: { firstName: "Pat", lastName: "Lee" } },
    status: "skipped_not_fit"
  });

  const qualified = await repository.listByStatus("qualified");
  assert.equal(qualified.length, 1);
  assert.equal(qualified[0].candidate.inventoryId, "inv_1");
});
```

- [ ] **Step 2: Run candidate file tests and verify they fail**

Run:

```bash
node --test test/candidateFiles.test.js
```

Expected: fail with module-not-found for `src/workflow/candidateFiles.js`.

- [ ] **Step 3: Implement candidate file repository**

Create `src/workflow/candidateFiles.js`:

```js
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const JSON_BLOCK_RE = /^```json\n([\s\S]*?)\n```/;

export function buildCandidateFileId({ fullName, firstName, lastName, inventoryId }) {
  const name = fullName || [firstName, lastName].filter(Boolean).join(" ") || "candidate";
  return `${slugify(name)}_${sanitizeId(inventoryId)}`;
}

export function renderCandidateMarkdown(candidate) {
  const summary = [
    "## Candidate Summary",
    "",
    `- Inventory ID: ${candidate.candidate.inventoryId}`,
    `- Status: ${candidate.candidate.status}`,
    `- Name: ${[candidate.identity?.firstName, candidate.identity?.lastName].filter(Boolean).join(" ") || "Unknown"}`,
    `- LinkedIn: ${candidate.identity?.linkedinProfileUrl || "Not captured"}`
  ].join("\n");

  return `\`\`\`json\n${JSON.stringify(candidate, null, 2)}\n\`\`\`\n\n${summary}\n`;
}

export function parseCandidateMarkdown(markdown) {
  const match = String(markdown).match(JSON_BLOCK_RE);
  if (!match) throw new Error("Candidate markdown must start with a JSON fenced block.");
  return JSON.parse(match[1]);
}

export class CandidateFileRepository {
  constructor({ directory = ".lead-enrichment-candidates", now = () => new Date() } = {}) {
    this.directory = directory;
    this.now = now;
  }

  async upsertCandidate({ inventoryId, fullName, firstName, lastName, patch, status }) {
    await mkdir(this.directory, { recursive: true });
    const existing = await this.findByInventoryId(inventoryId);
    const createdAt = existing?.candidate?.createdAt ?? this.now().toISOString();
    const fileId = existing?.candidate?.fileId ?? buildCandidateFileId({ fullName, firstName, lastName, inventoryId });
    const candidate = deepMerge(existing ?? {}, {
      schemaVersion: 1,
      candidate: {
        inventoryId,
        fileId,
        createdAt,
        status
      },
      ...patch
    });

    await writeFile(path.join(this.directory, `${fileId}.md`), renderCandidateMarkdown(candidate), "utf8");
    return candidate;
  }

  async findByInventoryId(inventoryId) {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory).catch(() => []);
    for (const entry of entries.filter((name) => name.endsWith(".md"))) {
      const candidate = parseCandidateMarkdown(await readFile(path.join(this.directory, entry), "utf8"));
      if (candidate.candidate?.inventoryId === inventoryId) return candidate;
    }
    return null;
  }

  async listByStatus(status) {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory).catch(() => []);
    const candidates = [];
    for (const entry of entries.filter((name) => name.endsWith(".md"))) {
      const candidate = parseCandidateMarkdown(await readFile(path.join(this.directory, entry), "utf8"));
      if (candidate.candidate?.status === status) candidates.push(candidate);
    }
    return candidates;
  }
}

function slugify(value) {
  return String(value ?? "candidate")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "candidate";
}

function sanitizeId(value) {
  return String(value ?? "missing-id").replace(/[^a-z0-9_-]/gi, "_");
}

function deepMerge(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) return right;
  if (!isPlainObject(left) || !isPlainObject(right)) return right;
  const output = { ...left };
  for (const [key, value] of Object.entries(right)) {
    output[key] = key in output ? deepMerge(output[key], value) : value;
  }
  return output;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
```

- [ ] **Step 4: Run candidate file tests and verify they pass**

Run:

```bash
node --test test/candidateFiles.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/candidateFiles.js test/candidateFiles.test.js
git commit -m "feat: add candidate file repository"
```

---

### Task 2: Facts Snapshot Schema

**Files:**
- Modify: `sql/001_workflow_tables.sql`
- Modify: `test/processQueue.test.js`

- [ ] **Step 1: Update process queue repository test expectation**

In `test/processQueue.test.js`, replace snapshot insert assertions that expect `raw_text`, `raw_html_ref`, or `structured_json` with assertions for `facts`. The representative assertion should be:

```js
assert.match(queries[1].sql, /insert into lead_enrichment_snapshots/i);
assert.match(queries[1].sql, /facts/i);
assert.doesNotMatch(queries[1].sql, /raw_text/i);
assert.doesNotMatch(queries[1].sql, /raw_html_ref/i);
assert.doesNotMatch(queries[1].sql, /structured_json/i);
```

- [ ] **Step 2: Run the process queue test and verify it fails**

Run:

```bash
node --test test/processQueue.test.js
```

Expected: fail because implementation still writes `raw_text`, `raw_html_ref`, and `structured_json`.

- [ ] **Step 3: Update SQL table shape**

In `sql/001_workflow_tables.sql`, replace the `lead_enrichment_snapshots` table definition with:

```sql
CREATE TABLE IF NOT EXISTS lead_enrichment_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES workflow_runs(id),
  individual_id integer REFERENCES new_individual(id) ON DELETE SET NULL ON UPDATE CASCADE,
  inventory_id uuid REFERENCES linkedin_connection_inventory(id),
  company_id integer REFERENCES new_company(id) ON DELETE SET NULL ON UPDATE CASCADE,
  source text NOT NULL,
  source_url text,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now()
);
```

For existing local DBs, run this manually before live testing:

```sql
ALTER TABLE lead_enrichment_snapshots ADD COLUMN IF NOT EXISTS facts jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE lead_enrichment_snapshots DROP COLUMN IF EXISTS raw_text;
ALTER TABLE lead_enrichment_snapshots DROP COLUMN IF EXISTS raw_html_ref;
ALTER TABLE lead_enrichment_snapshots DROP COLUMN IF EXISTS screenshot_ref;
ALTER TABLE lead_enrichment_snapshots DROP COLUMN IF EXISTS structured_json;
```

- [ ] **Step 4: Commit**

```bash
git add sql/001_workflow_tables.sql test/processQueue.test.js
git commit -m "feat: store enrichment snapshots as facts"
```

---

### Task 3: Profile Fact Capture And Candidate File Writes

**Files:**
- Modify: `src/workflow/processQueue.js`
- Modify: `test/processQueue.test.js`
- Modify: `src/cli.js`

- [ ] **Step 1: Write failing process queue tests for candidate files and profile facts**

Update `test/processQueue.test.js` to include a live-mode test with a fake `candidateRepository`:

```js
test("processQueuedProfiles writes profile facts to candidate file and marks extracted", async () => {
  const writes = [];
  const result = await processQueuedProfiles({
    queueRepository: {
      listQueued: async () => [
        { id: "inventory_1", fullName: "Jane Smith", linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith" }
      ],
      saveProfileFacts: async (item, capture) => writes.push(["facts", item.id, capture.facts.currentCompanyName]),
      markLinkedInExtracted: async (id) => writes.push(["status", id])
    },
    candidateRepository: {
      upsertCandidate: async (input) => writes.push(["candidate", input.inventoryId, input.patch.profileCapture.facts.currentCompanyName, input.status])
    },
    extractProfile: async (item) => ({
      source: "linkedin_profile",
      sourceUrl: item.linkedinProfileUrl,
      identity: {
        firstName: "Jane",
        lastName: "Smith",
        linkedinProfileUrl: item.linkedinProfileUrl,
        linkedinMemberId: null,
        headline: "Founder at Acme AI",
        location: null
      },
      facts: {
        about: "Building useful automation.",
        currentCompanyName: "Acme AI",
        currentCompanyLinkedInUrl: "https://www.linkedin.com/company/acme-ai",
        currentRoleTitle: "Founder",
        currentRoleStartDate: null,
        jobHistory: [],
        contact: { email: null, mobile: null, tel: null }
      }
    })
  });

  assert.deepEqual(result.summary, { extracted: 1, failed: 0 });
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", "Acme AI", "profile_captured"],
    ["facts", "inventory_1", "Acme AI"],
    ["status", "inventory_1"]
  ]);
});
```

- [ ] **Step 2: Run the targeted process queue tests and verify failure**

Run:

```bash
node --test test/processQueue.test.js
```

Expected: fail because `candidateRepository` and `saveProfileFacts` are not wired.

- [ ] **Step 3: Update `processQueuedProfiles` to write candidates and facts**

Change the `processQueuedProfiles` signature in `src/workflow/processQueue.js` to accept `candidateRepository`. Inside the success path, use this order:

```js
await candidateRepository?.upsertCandidate({
  inventoryId: item.id,
  fullName: item.fullName ?? item.full_name,
  patch: {
    identity: capture.identity,
    profileCapture: {
      capturedAt: new Date().toISOString(),
      source: capture.source,
      sourceUrl: capture.sourceUrl,
      facts: capture.facts
    }
  },
  status: "profile_captured"
});

if (!dryRun) {
  await queueRepository.saveProfileFacts(item, capture);
  await queueRepository.markLinkedInExtracted(item.id);
}
```

Use `capture` instead of the old `snapshot` naming in this function.

- [ ] **Step 4: Replace profile extractor output**

Update `createPlaywrightProfileExtractor` so it returns:

```js
{
  source: "linkedin_profile",
  sourceUrl,
  identity: {
    firstName,
    lastName,
    linkedinProfileUrl: sourceUrl,
    linkedinMemberId: item.linkedinMemberId ?? item.linkedin_member_id ?? null,
    headline,
    location
  },
  facts: {
    about,
    currentCompanyName,
    currentCompanyLinkedInUrl,
    currentRoleTitle,
    currentRoleStartDate,
    jobHistory,
    contact: { email, mobile, tel }
  }
}
```

Implement helper extraction functions in the same file:

```js
function splitName(fullName = "") {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? null, lastName: parts.slice(1).join(" ") || null };
}

function sectionAfterHeading(text, heading) {
  const pattern = new RegExp(`(^|\\n)${heading}\\n([\\s\\S]*?)(\\n(?:About|Activity|Experience|Education|Licenses & certifications|Volunteering|Recommendations|Languages|Honors & awards)\\n|$)`, "i");
  return String(text ?? "").match(pattern)?.[2]?.trim() ?? null;
}
```

Use existing `extractProfileMainText` filtering for clean visible text, but do not call `htmlToMarkdown` and do not return `rawHtml`.

- [ ] **Step 5: Replace repository snapshot write with facts write**

Rename `saveProfileSnapshot` to `saveProfileFacts` in `ProcessQueueRepository`. The insert should be:

```js
await this.client.query(
  `insert into lead_enrichment_snapshots (
     individual_id,
     inventory_id,
     company_id,
     source,
     source_url,
     facts
   )
   values ($1, $2, $3, $4, $5, $6::jsonb)`,
  [
    item.individualId ?? item.individual_id ?? null,
    item.id,
    item.companyId ?? item.company_id ?? null,
    capture.source,
    capture.sourceUrl,
    JSON.stringify(capture.facts)
  ]
);
```

Update inventory current company from `capture.facts.currentCompanyName` and `capture.facts.currentCompanyLinkedInUrl`.

- [ ] **Step 6: Wire candidate repository into CLI**

In `src/cli.js`, import:

```js
import { CandidateFileRepository } from "./workflow/candidateFiles.js";
```

In `process-queue`, pass:

```js
candidateRepository: new CandidateFileRepository({
  directory: path.join(process.cwd(), ".lead-enrichment-candidates")
})
```

Remove `rawHtmlDirectory` wiring.

- [ ] **Step 7: Run process queue tests**

Run:

```bash
node --test test/processQueue.test.js test/candidateFiles.test.js
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/workflow/processQueue.js src/cli.js test/processQueue.test.js
git commit -m "feat: capture profile facts into candidate files"
```

---

### Task 4: Activity Capture Uses `content`

**Files:**
- Modify: `src/linkedin/activitySync.js`
- Modify: `test/activitySync.test.js`
- Modify: `src/cli.js`

- [ ] **Step 1: Write failing activity tests for `content` and candidate updates**

Add or update tests in `test/activitySync.test.js`:

```js
test("normalizeActivityCards returns content instead of textExcerpt", () => {
  const items = normalizeActivityCards(
    [{ text: "Jane posted this\n2w\nBuilding useful automation.", activityHref: "/feed/update/urn:li:activity:123" }],
    { now: new Date("2026-06-26T00:00:00.000Z") }
  );

  assert.equal(items[0].content.includes("Building useful automation."), true);
  assert.equal("textExcerpt" in items[0], false);
});

test("syncLinkedInActivityItems updates candidate file with activityCapture", async () => {
  const writes = [];
  const result = await syncLinkedInActivityItems({
    inventoryRepository: {
      listActivityCandidates: async () => [
        { inventoryId: "inventory_1", linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith" }
      ]
    },
    activityRepository: {
      replaceActivityItems: async (candidate, activities) => writes.push(["db", candidate.inventoryId, activities[0].content])
    },
    candidateRepository: {
      upsertCandidate: async (input) => writes.push(["candidate", input.inventoryId, input.patch.activityCapture.items[0].content, input.status])
    },
    extractActivities: async () => [
      {
        activityType: "post",
        activityUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123",
        postedAt: "2026-06-20T00:00:00.000Z",
        content: "Building useful automation.",
        isVisiblePostOrCommentWithin6Months: true
      }
    ]
  });

  assert.equal(result.summary.activitiesCaptured, 1);
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", "Building useful automation.", "activity_captured"],
    ["db", "inventory_1", "Building useful automation."]
  ]);
});
```

- [ ] **Step 2: Run activity tests and verify failure**

Run:

```bash
node --test test/activitySync.test.js
```

Expected: fail because `textExcerpt` is still returned and candidate repository is not accepted.

- [ ] **Step 3: Update activity normalization**

In `src/linkedin/activitySync.js`, replace `textExcerpt` with `content` in workflow-facing objects:

```js
const content = text.split(/\r?\n/).slice(0, 12).join("\n").slice(0, 4000);

items.push({
  activityType,
  activityUrl,
  postedAt,
  content,
  markdown: text,
  isVisiblePostOrCommentWithin6Months: isWithinRecentWindow(postedAt, now)
});
```

Add:

```js
function isWithinRecentWindow(postedAt, now) {
  if (!postedAt) return false;
  const date = new Date(postedAt);
  if (Number.isNaN(date.getTime())) return false;
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  return date >= cutoff && date <= now;
}
```

- [ ] **Step 4: Update activity sync to merge candidate files**

Add `candidateRepository` to `syncLinkedInActivityItems` and, after extraction, call:

```js
await candidateRepository?.upsertCandidate({
  inventoryId: candidate.inventoryId,
  patch: {
    activityCapture: {
      capturedAt: new Date().toISOString(),
      items: activities.map(({ markdown, ...activity }) => activity)
    }
  },
  status: "activity_captured"
});
```

Keep DB insertion compatible by mapping to `text_excerpt`:

```js
activity.content
```

where the SQL parameter currently uses `activity.textExcerpt`.

- [ ] **Step 5: Wire candidate repository into `sync-activities` CLI**

In `src/cli.js`, pass the same `CandidateFileRepository` directory into `syncLinkedInActivityItems`.

- [ ] **Step 6: Run activity tests**

Run:

```bash
node --test test/activitySync.test.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/linkedin/activitySync.js src/cli.js test/activitySync.test.js
git commit -m "feat: capture activity content in candidate files"
```

---

### Task 5: LinkedIn Company Facts Capture

**Files:**
- Modify: `src/linkedin/companyProfileSync.js`
- Modify: `test/companyProfileSync.test.js`
- Modify: `src/cli.js`

- [ ] **Step 1: Write failing company fact extraction tests**

Update `test/companyProfileSync.test.js`:

```js
test("normalizeCompanyProfileCapture extracts LinkedIn about facts without markdown", () => {
  const company = normalizeCompanyProfileCapture({
    sourceUrl: "https://www.linkedin.com/company/acme-ai/about/",
    text: [
      "Acme AI",
      "Overview",
      "Acme AI builds workflow automation software.",
      "Website",
      "https://acme.ai",
      "Phone",
      "+61 2 1234 5678",
      "Industry",
      "Software Development",
      "Company size",
      "2-10 employees",
      "Headquarters",
      "Sydney, NSW",
      "Founded",
      "2024",
      "Specialties",
      "AI, Automation, SaaS"
    ].join("\n"),
    links: ["https://acme.ai", "https://www.linkedin.com/company/acme-ai/"]
  });

  assert.equal(company.source, "linkedin_company_profile");
  assert.equal(company.sourceUrl, "https://www.linkedin.com/company/acme-ai");
  assert.equal(company.facts.website, "https://acme.ai");
  assert.equal(company.facts.phone, "+61 2 1234 5678");
  assert.equal(company.facts.industry, "Software Development");
  assert.equal(company.facts.companySize, "2-10 employees");
  assert.equal(company.facts.headquarters, "Sydney, NSW");
  assert.equal(company.facts.founded, "2024");
  assert.deepEqual(company.facts.specialties, ["AI", "Automation", "SaaS"]);
  assert.equal("markdown" in company, false);
});
```

- [ ] **Step 2: Add failing candidate update test**

Add:

```js
test("syncCompanyProfiles updates candidate file and facts snapshot", async () => {
  const writes = [];
  const result = await syncCompanyProfiles({
    repository: {
      listCompanyCandidates: async () => [
        { inventoryId: "inventory_1", currentCompanyUrl: "https://www.linkedin.com/company/acme-ai" }
      ],
      saveCompanyFacts: async (candidate, company) => writes.push(["db", candidate.inventoryId, company.facts.website])
    },
    candidateRepository: {
      upsertCandidate: async (input) => writes.push(["candidate", input.inventoryId, input.patch.companyCapture.facts.website, input.status])
    },
    extractCompany: async () => ({
      source: "linkedin_company_profile",
      sourceUrl: "https://www.linkedin.com/company/acme-ai",
      facts: {
        overview: "Acme AI builds workflow automation software.",
        website: "https://acme.ai",
        phone: null,
        industry: "Software Development",
        companySize: "2-10 employees",
        headquarters: "Sydney, NSW",
        founded: "2024",
        specialties: ["AI", "Automation"]
      }
    })
  });

  assert.equal(result.summary.companiesProcessed, 1);
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", "https://acme.ai", "company_captured"],
    ["db", "inventory_1", "https://acme.ai"]
  ]);
});
```

- [ ] **Step 3: Run company tests and verify failure**

Run:

```bash
node --test test/companyProfileSync.test.js
```

Expected: fail because the module still returns markdown and writes old snapshots.

- [ ] **Step 4: Implement company fact normalization**

In `src/linkedin/companyProfileSync.js`, remove `htmlToMarkdown` usage. `normalizeCompanyProfileCapture` should return:

```js
return {
  source: "linkedin_company_profile",
  sourceUrl: normalizeCompanyUrl(capture.sourceUrl),
  facts: {
    overview: extractOverview(capture.text),
    website: findWebsiteUrl(capture.links) ?? fieldAfterLabel(capture.text, "Website"),
    phone: fieldAfterLabel(capture.text, "Phone"),
    industry: fieldAfterLabel(capture.text, "Industry"),
    companySize: fieldAfterLabel(capture.text, "Company size"),
    headquarters: fieldAfterLabel(capture.text, "Headquarters"),
    founded: fieldAfterLabel(capture.text, "Founded"),
    specialties: splitSpecialties(fieldAfterLabel(capture.text, "Specialties"))
  }
};
```

Add helpers:

```js
function fieldAfterLabel(text, label) {
  const lines = cleanLines(text);
  const index = lines.findIndex((line) => line.toLowerCase() === label.toLowerCase());
  return index === -1 ? null : lines[index + 1] ?? null;
}

function extractOverview(text) {
  const lines = cleanLines(text);
  const overviewIndex = lines.findIndex((line) => line.toLowerCase() === "overview");
  if (overviewIndex === -1) return null;
  const stopLabels = new Set(["website", "phone", "industry", "company size", "headquarters", "founded", "specialties"]);
  const values = [];
  for (const line of lines.slice(overviewIndex + 1)) {
    if (stopLabels.has(line.toLowerCase())) break;
    values.push(line);
  }
  return values.join("\n").trim() || null;
}

function splitSpecialties(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function cleanLines(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
```

- [ ] **Step 5: Update repository to write company facts**

Rename `saveCompanySnapshot` to `saveCompanyFacts`. Insert:

```js
await this.client.query(
  `insert into lead_enrichment_snapshots (
     inventory_id,
     company_id,
     source,
     source_url,
     facts
   )
   values ($1, $2, $3, $4, $5::jsonb)`,
  [
    item.inventoryId,
    item.companyId ?? null,
    company.source,
    company.sourceUrl,
    JSON.stringify(company.facts)
  ]
);
```

Update inventory company name only if `current_company_name` is null and a company name is available from the candidate row; do not infer it from markdown.

- [ ] **Step 6: Update company sync to write candidate files**

Add `candidateRepository` to `syncCompanyProfiles` and call:

```js
await candidateRepository?.upsertCandidate({
  inventoryId: candidate.inventoryId,
  fullName: candidate.fullName,
  patch: {
    companyCapture: {
      capturedAt: new Date().toISOString(),
      source: company.source,
      sourceUrl: company.sourceUrl,
      facts: company.facts
    }
  },
  status: "company_captured"
});
```

- [ ] **Step 7: Update company candidate SQL**

Since snapshots now store `facts`, change the lateral fallback:

```sql
select facts #>> '{currentCompanyLinkedInUrl}' as current_company_url
from lead_enrichment_snapshots
where inventory_id = inv.id
  and source = 'linkedin_profile'
order by captured_at desc
limit 1
```

- [ ] **Step 8: Wire candidate repository into CLI**

Pass `candidateRepository` into `syncCompanyProfiles`.

- [ ] **Step 9: Run company tests**

Run:

```bash
node --test test/companyProfileSync.test.js
```

Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/linkedin/companyProfileSync.js src/cli.js test/companyProfileSync.test.js
git commit -m "feat: capture linkedin company facts"
```

---

### Task 6: Multi-Page Company Website Capture

**Files:**
- Modify: `scripts/crawl_company.py`
- Modify: `src/company/crawl4aiExtractor.js`
- Modify: `src/company/playwrightFallback.js`
- Create: `src/workflow/syncCompanyWebsites.js`
- Create: `test/companyWebsite.test.js`
- Modify: `src/cli.js`

- [ ] **Step 1: Write failing website capture tests**

Create `test/companyWebsite.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCrawl4AiWebsiteCapture } from "../src/company/crawl4aiExtractor.js";
import { syncCompanyWebsites } from "../src/workflow/syncCompanyWebsites.js";

test("normalizeCrawl4AiWebsiteCapture supports multi-page output", () => {
  const capture = normalizeCrawl4AiWebsiteCapture({
    rootUrl: "https://acme.ai",
    pages: [
      { pageName: "Home", pageURL: "https://acme.ai", contentMarkdown: "# Home" },
      { pageName: "About", pageURL: "https://acme.ai/about", contentMarkdown: "# About" }
    ]
  });

  assert.equal(capture.source, "crawl4ai");
  assert.equal(capture.rootUrl, "https://acme.ai");
  assert.equal(capture.pages.length, 2);
  assert.equal(capture.pages[1].pageName, "About");
});

test("syncCompanyWebsites updates candidate companyWebsite from company website URL", async () => {
  const writes = [];
  const result = await syncCompanyWebsites({
    candidateRepository: {
      listByStatus: async () => [
        {
          candidate: { inventoryId: "inventory_1", status: "company_captured" },
          companyCapture: { facts: { website: "https://acme.ai" } }
        }
      ],
      upsertCandidate: async (input) => writes.push(["candidate", input.inventoryId, input.patch.companyWebsite.pages.length, input.status])
    },
    captureWebsite: async () => ({
      source: "crawl4ai",
      rootUrl: "https://acme.ai",
      pages: [{ pageName: "Home", pageURL: "https://acme.ai", contentMarkdown: "# Home" }]
    })
  });

  assert.deepEqual(result.summary, { websitesProcessed: 1, failed: 0 });
  assert.deepEqual(writes, [["candidate", "inventory_1", 1, "website_captured"]]);
});
```

- [ ] **Step 2: Run website tests and verify failure**

Run:

```bash
node --test test/companyWebsite.test.js
```

Expected: fail because normalization and workflow module do not exist.

- [ ] **Step 3: Normalize Crawl4AI output in JS**

Modify `src/company/crawl4aiExtractor.js`:

```js
export function normalizeCrawl4AiWebsiteCapture(value) {
  const rootUrl = value.rootUrl ?? value.url ?? value.sourceUrl;
  const pages = Array.isArray(value.pages)
    ? value.pages
    : [{
        pageName: value.pageName ?? "Home",
        pageURL: value.pageURL ?? value.sourceUrl ?? rootUrl,
        contentMarkdown: value.contentMarkdown ?? value.markdown ?? ""
      }];

  return {
    source: "crawl4ai",
    rootUrl,
    pages: pages
      .filter((page) => page.pageURL && page.contentMarkdown)
      .slice(0, 5)
      .map((page) => ({
        pageName: page.pageName ?? inferPageName(page.pageURL),
        pageURL: page.pageURL,
        contentMarkdown: page.contentMarkdown
      }))
  };
}

export async function crawlCompanyWebsite(url, options = {}) {
  const scriptPath = options.scriptPath ?? "scripts/crawl_company.py";
  const args = [scriptPath, url, "--max-pages", String(options.maxPages ?? 5)];
  if (options.configPath) args.push("--config", options.configPath);
  const { stdout } = await execFileAsync("python3", args, { cwd: options.cwd ?? process.cwd() });
  return normalizeCrawl4AiWebsiteCapture(JSON.parse(stdout));
}

function inferPageName(url) {
  try {
    const pathname = new URL(url).pathname.replace(/^\/|\/$/g, "");
    return pathname ? pathname.split("/").at(-1).replace(/[-_]+/g, " ") : "Home";
  } catch {
    return "Page";
  }
}
```

- [ ] **Step 4: Update Python Crawl4AI script output shape**

Modify `scripts/crawl_company.py` to accept `--max-pages` and return:

```python
{
  "rootUrl": args.url,
  "pages": [
    {
      "pageName": title_or_home,
      "pageURL": result.url or args.url,
      "contentMarkdown": result.markdown or ""
    }
  ]
}
```

If Crawl4AI import fails, return:

```python
{
  "rootUrl": args.url,
  "pages": [],
  "error": "crawl4ai_missing"
}
```

Keep the first implementation conservative: homepage support is acceptable in Python as long as the JS shape is multi-page and bounded. Add multi-page crawling in Python only if Crawl4AI exposes discovered internal links in the local installed version.

- [ ] **Step 5: Update Playwright fallback**

Modify `src/company/playwrightFallback.js` to return:

```js
export async function captureCompanyWebsiteWithPlaywright(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const contentMarkdown = await page.locator("body").innerText();
  const pageName = await page.title().catch(() => "Home");
  return {
    source: "company_website_playwright_fallback",
    rootUrl: url,
    pages: [{ pageName: pageName || "Home", pageURL: url, contentMarkdown }]
  };
}
```

- [ ] **Step 6: Create website sync workflow**

Create `src/workflow/syncCompanyWebsites.js`:

```js
export async function syncCompanyWebsites({
  candidateRepository,
  captureWebsite,
  limit,
  dryRun = false
}) {
  const candidates = await candidateRepository.listByStatus("company_captured");
  const selected = typeof limit === "number" ? candidates.slice(0, limit) : candidates;
  const summary = { websitesProcessed: 0, failed: 0 };
  const items = [];

  for (const candidate of selected) {
    const inventoryId = candidate.candidate.inventoryId;
    const website = candidate.companyCapture?.facts?.website;
    if (!website) continue;
    try {
      const companyWebsite = await captureWebsite(website);
      summary.websitesProcessed += 1;
      items.push({ inventoryId, status: "website_captured", pagesCaptured: companyWebsite.pages.length });
      if (!dryRun) {
        await candidateRepository.upsertCandidate({
          inventoryId,
          patch: {
            companyWebsite: {
              capturedAt: new Date().toISOString(),
              ...companyWebsite
            }
          },
          status: "website_captured"
        });
      }
    } catch (error) {
      summary.failed += 1;
      items.push({ inventoryId, status: "failed", error: error.message });
      if (!dryRun) {
        await candidateRepository.upsertCandidate({
          inventoryId,
          patch: {
            companyWebsite: {
              status: "failed",
              error: error.message
            }
          },
          status: candidate.candidate.status
        });
      }
    }
  }

  return { status: dryRun ? "dry_run" : "synced", summary, items };
}
```

- [ ] **Step 7: Add CLI command `sync-company-websites`**

In `src/cli.js`, import `crawlCompanyWebsite`, `captureCompanyWebsiteWithPlaywright`, and `syncCompanyWebsites`. Add command help:

```text
sync-company-websites [--limit N] [--dry-run]
```

Wire command:

```js
if (command === "sync-company-websites") {
  const dryRun = args.includes("--dry-run");
  const limit = readNumberFlag(args, "--limit");
  const config = validateConfig(process.env, { dryRun: true });
  const candidateRepository = new CandidateFileRepository({
    directory: path.join(process.cwd(), ".lead-enrichment-candidates")
  });
  const result = await syncCompanyWebsites({
    candidateRepository,
    captureWebsite: (url) => crawlCompanyWebsite(url, {
      configPath: config.crawl4aiConfigPath,
      maxPages: 5
    }),
    limit: limit ?? config.defaultBatchLimit,
    dryRun
  });
  console.log(JSON.stringify(result, null, 2));
  return;
}
```

If Crawl4AI fails during later live testing, add fallback orchestration in this command by opening a Playwright session and calling `captureCompanyWebsiteWithPlaywright`.

- [ ] **Step 8: Run website tests**

Run:

```bash
node --test test/companyWebsite.test.js
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/crawl_company.py src/company/crawl4aiExtractor.js src/company/playwrightFallback.js src/workflow/syncCompanyWebsites.js src/cli.js test/companyWebsite.test.js
git commit -m "feat: capture company websites into candidate files"
```

---

### Task 7: Score Fits From Candidate Files

**Files:**
- Modify: `src/workflow/scoreExtractedProfiles.js`
- Modify: `test/scoreExtractedProfiles.test.js`
- Modify: `src/cli.js`

- [ ] **Step 1: Write failing candidate-file scoring test**

Update `test/scoreExtractedProfiles.test.js`:

```js
test("scoreExtractedProfiles scores candidate files and writes fit back", async () => {
  const writes = [];
  const result = await scoreExtractedProfiles({
    candidateRepository: {
      listByStatus: async () => [
        {
          candidate: { inventoryId: "inventory_1", status: "website_captured" },
          identity: { firstName: "Jane", lastName: "Smith", headline: "Founder at Acme AI" },
          profileCapture: {
            facts: {
              about: "Building an AI workflow startup.",
              currentRoleTitle: "Founder",
              jobHistory: []
            }
          },
          activityCapture: {
            items: [
              {
                activityType: "post",
                postedAt: "2026-06-01T00:00:00.000Z",
                content: "Launching useful automation."
              }
            ]
          },
          companyCapture: {
            facts: {
              overview: "Acme AI is a venture-backed software startup.",
              industry: "Software Development"
            }
          },
          companyWebsite: {
            pages: [{ contentMarkdown: "# Acme AI\n\nAI workflow automation platform." }]
          }
        }
      ],
      upsertCandidate: async (input) => writes.push(["candidate", input.inventoryId, input.patch.fit.fitScore, input.status])
    },
    repository: {
      markFitScored: async (id) => writes.push(["fit", id]),
      markSkippedNotFit: async (id) => writes.push(["skip", id])
    },
    now: new Date("2026-06-26T00:00:00.000Z")
  });

  assert.deepEqual(result.summary, { fitScored: 1, skippedNotFit: 0, failed: 0 });
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", 1, "qualified"],
    ["fit", "inventory_1"]
  ]);
});
```

- [ ] **Step 2: Run scoring tests and verify failure**

Run:

```bash
node --test test/scoreExtractedProfiles.test.js
```

Expected: fail because scoring still queries snapshots.

- [ ] **Step 3: Update scoring input path**

Modify `scoreExtractedProfiles` signature:

```js
export async function scoreExtractedProfiles({
  repository,
  candidateRepository,
  limit,
  dryRun = false,
  includeScored = false,
  now = new Date()
}) {
  const statuses = includeScored ? ["profile_captured", "activity_captured", "company_captured", "website_captured", "qualified", "skipped_not_fit"] : ["profile_captured", "activity_captured", "company_captured", "website_captured"];
  const allCandidates = [];
  for (const status of statuses) allCandidates.push(...await candidateRepository.listByStatus(status));
  const candidates = typeof limit === "number" ? allCandidates.slice(0, limit) : allCandidates;
}
```

Keep a small DB repository only for `markFitScored` and `markSkippedNotFit`.

- [ ] **Step 4: Update fit derivation**

Replace `deriveFitFromSnapshot` usage with `deriveFitFromCandidate`:

```js
export function deriveFitFromCandidate(candidate, now = new Date()) {
  const text = [
    candidate.identity?.headline,
    candidate.profileCapture?.facts?.about,
    candidate.profileCapture?.facts?.currentRoleTitle,
    ...(candidate.profileCapture?.facts?.jobHistory ?? []).flatMap((job) => [job.title, job.description, job.companyName]),
    candidate.companyCapture?.facts?.overview,
    candidate.companyCapture?.facts?.industry,
    ...(candidate.companyCapture?.facts?.specialties ?? []),
    ...(candidate.companyWebsite?.pages ?? []).map((page) => page.contentMarkdown)
  ].filter(Boolean).join("\n");

  const founderSignal = FOUNDER_RE.test(text);
  const startupSignal = STARTUP_RE.test(text);
  const activities = candidate.activityCapture?.items ?? [];
  const recentActivitySignal = hasRecentVisiblePostOrComment(activities, now);
  const fitScore = [founderSignal, startupSignal, recentActivitySignal].filter(Boolean).length / 3;

  return {
    founderSignal,
    startupSignal,
    recentActivitySignal,
    fitScore,
    fitReasoning: buildFitReasoning({ founderSignal, startupSignal, recentActivitySignal })
  };
}
```

Update `hasRecentVisiblePostOrComment` compatibility if it reads `content` only for evidence and still uses `activityType`/`postedAt`.

- [ ] **Step 5: Write fit back to candidate files**

Inside scoring loop:

```js
const status = highPotential ? "qualified" : "skipped_not_fit";
if (!dryRun) {
  await candidateRepository.upsertCandidate({
    inventoryId: candidate.candidate.inventoryId,
    patch: {
      fit: {
        scoredAt: now.toISOString(),
        ...fit
      }
    },
    status
  });
  if (highPotential) await repository.markFitScored(candidate.candidate.inventoryId);
  else await repository.markSkippedNotFit(candidate.candidate.inventoryId);
}
```

Do not write `lead_research_notes` in this new path.

- [ ] **Step 6: Wire candidate repository into `score-fits` CLI**

In `src/cli.js`, pass `candidateRepository` into `scoreExtractedProfiles`.

- [ ] **Step 7: Run scoring tests**

Run:

```bash
node --test test/scoreExtractedProfiles.test.js
```

Expected: all tests pass after updating/removing old raw snapshot tests.

- [ ] **Step 8: Commit**

```bash
git add src/workflow/scoreExtractedProfiles.js src/cli.js test/scoreExtractedProfiles.test.js
git commit -m "feat: score fits from candidate files"
```

---

### Task 8: Submit Qualified Candidates To Portal

**Files:**
- Create: `src/adapters/portalCandidates.js`
- Create: `src/workflow/submitQualifiedCandidates.js`
- Create: `test/submitQualifiedCandidates.test.js`
- Modify: `src/cli.js`
- Modify: `src/config.js` if existing config names are draft-specific

- [ ] **Step 1: Write failing portal adapter and submit workflow tests**

Create `test/submitQualifiedCandidates.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { PortalCandidateAdapter } from "../src/adapters/portalCandidates.js";
import { submitQualifiedCandidates } from "../src/workflow/submitQualifiedCandidates.js";

test("PortalCandidateAdapter posts candidate payload to portal", async () => {
  const calls = [];
  const adapter = new PortalCandidateAdapter({
    baseUrl: "https://portal.example.com",
    apiKey: "secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() { return { portalCandidateId: "portal_123" }; }
      };
    }
  });

  const result = await adapter.submitCandidate({ identity: { firstName: "Jane" } });
  assert.equal(result.portalCandidateId, "portal_123");
  assert.equal(calls[0].url, "https://portal.example.com/linkedin-candidates");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret");
});

test("submitQualifiedCandidates submits only qualified unsubmitted candidates", async () => {
  const writes = [];
  const result = await submitQualifiedCandidates({
    candidateRepository: {
      listByStatus: async () => [
        {
          candidate: { inventoryId: "inventory_1", status: "qualified" },
          identity: { firstName: "Jane", lastName: "Smith" },
          fit: { founderSignal: true, startupSignal: true, recentActivitySignal: true },
          portalSubmission: { status: "not_submitted" }
        }
      ],
      upsertCandidate: async (input) => writes.push(["candidate", input.inventoryId, input.patch.portalSubmission.portalCandidateId, input.status])
    },
    portalCandidates: {
      submitCandidate: async () => ({ portalCandidateId: "portal_123" })
    },
    repository: {
      markSubmitted: async (inventoryId, portalCandidateId) => writes.push(["db", inventoryId, portalCandidateId])
    }
  });

  assert.deepEqual(result.summary, { submitted: 1, skipped: 0, failed: 0 });
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", "portal_123", "submitted"],
    ["db", "inventory_1", "portal_123"]
  ]);
});
```

- [ ] **Step 2: Run submit tests and verify failure**

Run:

```bash
node --test test/submitQualifiedCandidates.test.js
```

Expected: fail because modules do not exist.

- [ ] **Step 3: Implement portal candidate adapter**

Create `src/adapters/portalCandidates.js`:

```js
export class PortalCandidateAdapter {
  constructor({ baseUrl, apiKey, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async submitCandidate(candidate) {
    if (!this.baseUrl || !this.apiKey) {
      throw new Error("Portal API configuration is missing.");
    }

    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/linkedin-candidates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(candidate)
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Portal candidate submission failed with HTTP ${response.status}: ${text}`);
      error.httpStatus = response.status;
      throw error;
    }

    const json = await response.json();
    return { portalCandidateId: json.portalCandidateId ?? json.id };
  }
}
```

- [ ] **Step 4: Implement submit workflow**

Create `src/workflow/submitQualifiedCandidates.js`:

```js
export async function submitQualifiedCandidates({
  candidateRepository,
  portalCandidates,
  repository,
  limit,
  dryRun = false,
  now = new Date()
}) {
  const candidates = await candidateRepository.listByStatus("qualified");
  const selected = typeof limit === "number" ? candidates.slice(0, limit) : candidates;
  const summary = { submitted: 0, skipped: 0, failed: 0 };
  const items = [];

  for (const candidate of selected) {
    const inventoryId = candidate.candidate.inventoryId;
    if (!isSubmittable(candidate)) {
      summary.skipped += 1;
      items.push({ inventoryId, status: "skipped" });
      continue;
    }

    try {
      if (dryRun) {
        summary.submitted += 1;
        items.push({ inventoryId, status: "would_submit" });
        continue;
      }

      const result = await portalCandidates.submitCandidate(buildPortalPayload(candidate));
      await candidateRepository.upsertCandidate({
        inventoryId,
        patch: {
          portalSubmission: {
            submittedAt: now.toISOString(),
            status: "submitted",
            portalCandidateId: result.portalCandidateId,
            error: null
          }
        },
        status: "submitted"
      });
      await repository.markSubmitted(inventoryId, result.portalCandidateId);
      summary.submitted += 1;
      items.push({ inventoryId, status: "submitted", portalCandidateId: result.portalCandidateId });
    } catch (error) {
      summary.failed += 1;
      items.push({ inventoryId, status: "failed", error: error.message });
      await candidateRepository.upsertCandidate({
        inventoryId,
        patch: {
          portalSubmission: {
            submittedAt: null,
            status: "failed",
            portalCandidateId: null,
            error: error.message
          }
        },
        status: "qualified"
      });
    }
  }

  return { status: dryRun ? "dry_run" : "processed", summary, items };
}

export function buildPortalPayload(candidate) {
  return {
    source: "linkedin_lead_enrichment",
    inventoryId: candidate.candidate.inventoryId,
    identity: candidate.identity,
    profile: candidate.profileCapture?.facts ?? {},
    activity: candidate.activityCapture?.items ?? [],
    company: candidate.companyCapture?.facts ?? {},
    companyWebsite: candidate.companyWebsite?.pages ?? [],
    fit: candidate.fit
  };
}

function isSubmittable(candidate) {
  return Boolean(
    candidate.fit?.founderSignal &&
    candidate.fit?.startupSignal &&
    candidate.fit?.recentActivitySignal &&
    candidate.portalSubmission?.status !== "submitted"
  );
}
```

- [ ] **Step 5: Add DB repository method**

Add `SubmitQualifiedCandidatesRepository` in `src/workflow/submitQualifiedCandidates.js`:

```js
export class SubmitQualifiedCandidatesRepository {
  constructor(client) {
    this.client = client;
  }

  async markSubmitted(inventoryId, portalCandidateId) {
    await this.client.query(
      `update linkedin_connection_inventory
       set workflow_status = 'submitted',
           current_step = 'submitted_to_portal',
           completed_at = now(),
           last_error = null
       where id = $1`,
      [inventoryId]
    );
    await this.client.query(
      `insert into audit_events (inventory_id, event_type, status, message, metadata_json)
       values ($1, 'candidate_submitted_to_portal', 'success', 'Qualified candidate submitted to portal.', $2::jsonb)`,
      [inventoryId, JSON.stringify({ portalCandidateId })]
    );
  }
}
```

- [ ] **Step 6: Wire CLI command**

In `src/cli.js`, import `PortalCandidateAdapter`, `submitQualifiedCandidates`, and `SubmitQualifiedCandidatesRepository`. Add help:

```text
submit-qualified [--limit N] [--dry-run]
```

Add command:

```js
if (command === "submit-qualified") {
  const dryRun = args.includes("--dry-run");
  const limit = readNumberFlag(args, "--limit");
  const config = validateConfig(process.env, { dryRun });
  const client = await connectedDbClient(config.databaseUrl);
  try {
    const result = await submitQualifiedCandidates({
      candidateRepository: new CandidateFileRepository({
        directory: path.join(process.cwd(), ".lead-enrichment-candidates")
      }),
      portalCandidates: new PortalCandidateAdapter({
        baseUrl: config.portalApiBaseUrl,
        apiKey: config.portalApiKey
      }),
      repository: new SubmitQualifiedCandidatesRepository(client),
      limit: limit ?? config.defaultBatchLimit,
      dryRun
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.end();
  }
  return;
}
```

- [ ] **Step 7: Run submit tests**

Run:

```bash
node --test test/submitQualifiedCandidates.test.js
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/portalCandidates.js src/workflow/submitQualifiedCandidates.js src/cli.js test/submitQualifiedCandidates.test.js
git commit -m "feat: submit qualified candidates to portal"
```

---

### Task 9: Update Docs, Skill References, And Status Inspection

**Files:**
- Modify: `skills/linkedin-lead-enrichment/SKILL.md`
- Modify: `skills/linkedin-lead-enrichment/references/extraction-schema.md`
- Modify: `skills/linkedin-lead-enrichment/references/portal-api.md`
- Modify: `skills/linkedin-lead-enrichment/references/workflow.md`
- Modify: `skills/linkedin-lead-enrichment/references/workflow-tables.md`
- Modify: `src/workflow/status.js`
- Modify: `src/workflow/inspectStatus.js` if it enumerates old statuses

- [ ] **Step 1: Update extraction schema reference**

In `skills/linkedin-lead-enrichment/references/extraction-schema.md`, document:

```md
# Extraction Schema

Pre-fit candidate evidence lives in `.lead-enrichment-candidates/*.md` as a JSON block.

LinkedIn profile capture stores only `profileCapture.facts`, not markdown, raw HTML, screenshots, or generic structured JSON.

Activity capture stores visible post/comment text as `activityCapture.items[].content`.

LinkedIn company capture stores only `companyCapture.facts`: overview, website, phone, industry, companySize, headquarters, founded, and specialties.

Company website capture stores `companyWebsite.pages[]`, where each page has pageName, pageURL, and contentMarkdown.
```

- [ ] **Step 2: Update portal API reference**

In `skills/linkedin-lead-enrichment/references/portal-api.md`, replace draft-only language with:

````md
# Portal API

Qualified candidates are submitted to:

```text
POST {PORTAL_API_BASE_URL}/linkedin-candidates
```

The payload includes identity, profile facts, activity facts, LinkedIn company facts, company website pages, fit, and inventoryId.

The portal is responsible for company, individual, title persistence, draft generation, and draft approval queue persistence.
```
````

- [ ] **Step 3: Update workflow docs**

In `skills/linkedin-lead-enrichment/references/workflow.md`, list the command order:

```text
sync-connections
dedupe-inventory
process-queue
sync-activities
sync-company-profiles
sync-company-websites
score-fits
submit-qualified
```

State that `process-queue`, `sync-activities`, `sync-company-profiles`, and `sync-company-websites` update candidate files before scoring.

- [ ] **Step 4: Update workflow tables reference**

In `skills/linkedin-lead-enrichment/references/workflow-tables.md`, describe `lead_enrichment_snapshots.facts jsonb` and remove references to `raw_text`, `raw_html_ref`, `screenshot_ref`, and `structured_json`.

- [ ] **Step 5: Update status constants**

In `src/workflow/status.js`, remove stale `markdownSaved` if unused and add:

```js
websiteCaptured: "website_captured",
qualified: "qualified",
submitted: "submitted"
```

- [ ] **Step 6: Run docs/status checks**

Run:

```bash
rg -n "raw_text|raw_html_ref|screenshot_ref|structured_json|textExcerpt|/drafts|markdown_saved" skills src docs test
```

Expected: no matches that describe current behavior. Historical specs may still mention old behavior if clearly dated; source and active skill references should not.

- [ ] **Step 7: Commit**

```bash
git add skills/linkedin-lead-enrichment src/workflow/status.js src/workflow/inspectStatus.js
git commit -m "docs: update structured candidate workflow references"
```

---

### Task 10: End-To-End Verification And Subagent QA

**Files:**
- No production files unless defects are found.

- [ ] **Step 1: Run full unit test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run CLI dry-run smoke checks**

Run:

```bash
node src/cli.js check-config --dry-run
node src/cli.js process-queue --dry-run --limit 1
node src/cli.js sync-activities --dry-run --limit 1
node src/cli.js sync-company-profiles --dry-run --limit 1
node src/cli.js sync-company-websites --dry-run --limit 1
node src/cli.js score-fits --dry-run --limit 1
node src/cli.js submit-qualified --dry-run --limit 1
```

Expected: `check-config` succeeds. Commands that require LinkedIn/browser/database state may return empty summaries or environment-specific connection errors; they should not fail from missing imports, syntax errors, unknown commands, or old column names.

- [ ] **Step 3: Run schema drift scan**

Run:

```bash
rg -n "raw_text|raw_html_ref|screenshot_ref|structured_json|textExcerpt|saveProfileSnapshot|saveCompanySnapshot" src test skills sql
```

Expected: no active source/test references to removed behavior. Dated design docs can retain historical references outside this scan.

- [ ] **Step 4: Dispatch subagent QA**

Ask a fresh subagent to review the implementation against:

```text
docs/superpowers/specs/2026-06-26-structured-candidate-capture-design.md
docs/superpowers/plans/2026-06-26-structured-candidate-capture.md
```

Required QA focus:

- Candidate schema consistency across every step.
- DB writes use `facts jsonb`.
- No profile/company LinkedIn markdown/raw HTML/screenshot persistence.
- Activity uses `content` at workflow boundaries.
- Company website supports `pages[]`.
- `submit-qualified` posts only qualified unsubmitted candidates.
- CLI commands are wired.
- Tests cover each changed workflow step.

- [ ] **Step 5: Fix QA findings**

For each confirmed issue, add or update a focused test first, run it to fail, fix the code, run it to pass, then rerun:

```bash
npm test
```

- [ ] **Step 6: Final commit**

```bash
git add .
git commit -m "test: verify structured candidate workflow"
```

---

## Self-Review Notes

- Spec coverage: The plan covers candidate file format, DB facts schema, profile fact capture, activity `content`, LinkedIn company facts, multi-page website capture, scoring from candidates, portal submission, docs, tests, and subagent QA.
- Placeholder scan: The plan intentionally avoids unspecified placeholder steps. Any future environment-specific portal endpoint details are isolated to `PortalCandidateAdapter` and currently use `/linkedin-candidates` from the approved design.
- Type consistency: Candidate sections use `identity`, `profileCapture.facts`, `activityCapture.items[].content`, `companyCapture.facts`, `companyWebsite.pages[]`, `fit`, and `portalSubmission` consistently across tasks.
