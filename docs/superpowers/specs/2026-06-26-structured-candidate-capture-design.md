# Structured Candidate Capture Design

Date: 2026-06-26

## Overview

Refactor the LinkedIn lead enrichment workflow so pre-fit candidate evidence is captured as structured local candidate files instead of being saved as raw database snapshots. The database remains the workflow control plane for queueing, statuses, activity rows, and retryability. The portal becomes the owner of canonical company, individual, title, and draft-message persistence after a candidate passes the fit gate.

Each queued connection gets one local markdown candidate file named with a readable name slug and the stable `linkedin_connection_inventory.id`, for example:

```text
jane-smith_<inventory-id>.md
```

The inventory UUID is the canonical local candidate identity. The name slug is only for readability.

## Goals

- Stop saving pre-fit profile markdown, raw HTML, screenshot references, and blob-like structured JSON to `lead_enrichment_snapshots`.
- Change `lead_enrichment_snapshots` into a structured facts capture table using `facts jsonb`.
- Keep `linkedin_connection_inventory` as the queue and workflow status source.
- Store each candidate's pre-fit evidence in one local markdown file with a parseable JSON block.
- Make each workflow step own a narrow candidate JSON section.
- Capture only structured facts from LinkedIn profile and LinkedIn company pages.
- Capture company website content as a bounded multi-page markdown crawl.
- Submit only qualified candidates to the portal.
- Let the portal save canonical CRM rows and generate the draft outreach message.

## Non-Goals

- Building a dashboard UI.
- Automatically sending LinkedIn messages.
- Keeping raw LinkedIn HTML or screenshots for every candidate.
- Creating portal-side company, individual, title, or draft-generation logic in this local repository.
- Replacing `linkedin_connection_inventory` with local files.

## Architecture

The workflow stays DB-controlled but becomes file-backed for candidate evidence.

1. `linkedin_connection_inventory` stores queue state, retry state, current step, dedupe status, and workflow status.
2. `process-queue` creates or updates the local candidate file and writes profile facts into `lead_enrichment_snapshots.facts`.
3. `sync-activities` captures recent activity facts and updates the candidate file. It may continue writing activity rows to `linkedin_activity_items`.
4. `sync-company-profiles` captures structured LinkedIn company About-page facts and updates both the candidate file and `lead_enrichment_snapshots.facts`.
5. A website capture step crawls the company website and updates the candidate file with multi-page website markdown.
6. `score-fits` reads candidate files and activity facts, writes fit results back to the candidate file, and marks the inventory item as `qualified` or `skipped_not_fit`.
7. `submit-qualified` posts only qualified candidate JSON to the portal, then records submission state locally.

The local workflow produces a qualified candidate package. The portal consumes it and owns canonical persistence and draft generation.

## Candidate File Format

Candidate files are markdown files with a parseable JSON block as the source of truth. A short human-readable summary may follow the JSON block for review/debugging, but code must read and write the JSON block.

```json
{
  "schemaVersion": 1,
  "candidate": {
    "inventoryId": "uuid",
    "fileId": "jane-smith_uuid",
    "createdAt": "iso",
    "status": "profile_captured"
  },
  "identity": {
    "firstName": "Jane",
    "lastName": "Smith",
    "linkedinProfileUrl": "https://www.linkedin.com/in/jane-smith",
    "linkedinMemberId": "member-id",
    "headline": "Founder at Acme AI",
    "location": "Sydney, Australia"
  },
  "profileCapture": {
    "capturedAt": "iso",
    "source": "linkedin_profile",
    "sourceUrl": "https://www.linkedin.com/in/jane-smith",
    "facts": {
      "about": "Profile about text if visible",
      "currentCompanyName": "Acme AI",
      "currentCompanyLinkedInUrl": "https://www.linkedin.com/company/acme-ai",
      "currentRoleTitle": "Founder",
      "currentRoleStartDate": null,
      "jobHistory": [],
      "contact": {
        "email": null,
        "mobile": null,
        "tel": null
      }
    }
  },
  "activityCapture": {
    "capturedAt": "iso",
    "items": [
      {
        "activityType": "post",
        "activityUrl": "https://www.linkedin.com/feed/update/urn:li:activity:1234567890",
        "postedAt": "iso",
        "content": "Visible post/comment content captured from LinkedIn.",
        "isVisiblePostOrCommentWithin6Months": true
      }
    ]
  },
  "companyCapture": {
    "capturedAt": "iso",
    "source": "linkedin_company_profile",
    "sourceUrl": "https://www.linkedin.com/company/acme-ai/about/",
    "facts": {
      "overview": "Acme AI builds workflow automation software for small teams.",
      "website": "https://acme.ai",
      "phone": null,
      "industry": "Software Development",
      "companySize": "2-10 employees",
      "headquarters": "Sydney, NSW",
      "founded": "2024",
      "specialties": ["AI", "Automation"]
    }
  },
  "companyWebsite": {
    "capturedAt": "iso",
    "source": "crawl4ai",
    "rootUrl": "https://acme.ai",
    "pages": [
      {
        "pageName": "Home",
        "pageURL": "https://acme.ai",
        "contentMarkdown": "# Acme AI\n\nWorkflow automation software for small teams."
      }
    ]
  },
  "fit": {
    "scoredAt": "iso",
    "founderSignal": true,
    "startupSignal": true,
    "recentActivitySignal": true,
    "fitScore": 1,
    "fitReasoning": "Founder/startup/recent activity signals found."
  },
  "portalSubmission": {
    "submittedAt": null,
    "status": "not_submitted",
    "portalCandidateId": null,
    "error": null
  }
}
```

## Step Ownership

### `process-queue`

Owns:

- `candidate`
- `identity`
- `profileCapture`

Playwright should extract only structured facts from the connection's LinkedIn profile page. It should not capture or save raw HTML, screenshot references, or profile markdown.

Profile facts include:

- about
- current company name
- current company LinkedIn URL
- current role title
- current role start date if visible
- job history relevant to founder/startup scoring
- visible contact fields: email, mobile, tel

### `sync-activities`

Owns:

- `activityCapture`

Activity items use `content` for the actual visible post/comment text captured from LinkedIn. The workflow-facing JSON should not use `textExcerpt`.

Activity facts include:

- activity type
- activity URL
- posted date or inferred date
- content
- whether the item is a visible post/comment within 6 months

The existing `linkedin_activity_items.text_excerpt` column may remain for now to reduce migration scope, but the module should map it to and from `content` at the workflow boundary.

### `sync-company-profiles`

Owns:

- `companyCapture`

Playwright should visit the current company's LinkedIn About page and capture only structured facts. It should not capture or save company markdown.

Company facts include:

- overview
- website
- phone
- industry
- company size
- headquarters
- founded
- specialties

### Company Website Capture

Owns:

- `companyWebsite`

The company website capture should use Crawl4AI first and Playwright fallback if Crawl4AI is unavailable or fails. It should support multi-page capture from the start.

Default crawl behavior:

- Use `companyCapture.facts.website` as `rootUrl`.
- Capture the homepage.
- Capture up to 4 additional useful internal pages, for 5 total pages by default.
- Prefer pages whose URL or title suggests `about`, `product`, `solutions`, `pricing`, `case-studies`, `customers`, or `blog`.
- Store each page as `pageName`, `pageURL`, and `contentMarkdown`.

### `score-fits`

Owns:

- `fit`
- final candidate status for fit result

`score-fits` should read candidate files instead of `lead_enrichment_snapshots.raw_text`. It should derive:

- `founderSignal` from profile identity, role, about, and job history facts.
- `startupSignal` from profile facts, company LinkedIn facts, and company website pages.
- `recentActivitySignal` from `activityCapture.items` where a visible post/comment is within 6 months.

A candidate is qualified only when:

```text
founderSignal && startupSignal && recentActivitySignal
```

Qualified candidates are marked with `candidate.status = "qualified"` and inventory status `qualified`. Not-fit candidates are marked with `candidate.status = "skipped_not_fit"` and inventory status `skipped_not_fit`.

### `submit-qualified`

Owns:

- `portalSubmission`
- final submitted/completed inventory state

Submission should be explicit, not hidden inside scoring. The command reads candidate files with:

```text
candidate.status = "qualified"
fit.founderSignal = true
fit.startupSignal = true
fit.recentActivitySignal = true
portalSubmission.status != "submitted"
```

It posts one consolidated candidate JSON payload to the portal. The portal saves the right company, individual, and title rows, then generates the draft message.

The portal response should return a stable identifier such as `portalCandidateId`. The local workflow writes that ID into `portalSubmission` and marks the inventory item submitted/completed.

## Database Changes

`lead_enrichment_snapshots` should become structured facts storage.

Target table shape:

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

Remove or stop using:

```text
raw_text
raw_html_ref
screenshot_ref
structured_json
```

The implementation should include a migration path for existing local databases. It may either add `facts jsonb` and stop writing old columns first, or replace the table definition in the setup SQL if this project is still pre-production. Existing tests should be updated to assert writes to `facts`.

## Portal Payload

The local workflow should send a compact, portal-oriented version of the candidate JSON. It should include:

- identity
- profile facts
- activity facts
- LinkedIn company facts
- company website pages
- fit result
- source metadata including `inventoryId`

The local workflow should not send raw HTML, screenshots, or LinkedIn profile/company markdown.

The portal owns:

- company dedupe and `new_company` persistence
- individual dedupe and `new_individual` persistence
- `company_individual_title` persistence
- draft message generation
- draft approval queue persistence

## Error Handling And Retry Behavior

Profile extraction failure:

- Mark inventory `failed_needs_review`.
- Write no candidate file unless partial facts are useful and explicitly marked incomplete.

Activity extraction failure:

- Keep the candidate file.
- Add `activityCapture.status = "failed"` and an error message if useful.
- Leave the item retryable.

LinkedIn company extraction failure:

- Keep the candidate file.
- Add `companyCapture.status = "failed"` and an error message.
- Leave the item retryable.

Company website crawl failure:

- Keep the candidate eligible for scoring if profile, company, and activity facts are sufficient.
- Add `companyWebsite.status = "failed"` and an error message.

Portal submission failure:

- Keep `candidate.status = "qualified"`.
- Set `portalSubmission.status = "failed"` and record the error.
- Allow rerunning `submit-qualified` to retry.

## Impacted Files

Expected source changes:

- `sql/001_workflow_tables.sql`
- `src/workflow/processQueue.js`
- `src/linkedin/activitySync.js`
- `src/linkedin/companyProfileSync.js`
- `src/company/crawl4aiExtractor.js`
- `src/company/playwrightFallback.js`
- `scripts/crawl_company.py`
- `src/workflow/scoreExtractedProfiles.js`
- `src/adapters/portalDrafts.js` or a new portal candidate adapter
- `src/cli.js`
- New candidate file repository/helper module
- New `src/workflow/submitQualifiedCandidates.js`

Expected test updates/additions:

- `test/processQueue.test.js`
- `test/activitySync.test.js`
- `test/companyProfileSync.test.js`
- Existing or new website crawl tests
- `test/scoreExtractedProfiles.test.js`
- New candidate file repository tests
- New submit-qualified tests

Expected docs/skill updates:

- `skills/linkedin-lead-enrichment/SKILL.md`
- `skills/linkedin-lead-enrichment/references/extraction-schema.md`
- `skills/linkedin-lead-enrichment/references/portal-api.md`
- `skills/linkedin-lead-enrichment/references/workflow.md`
- `skills/linkedin-lead-enrichment/references/workflow-tables.md`
- Any stale docs that describe raw profile markdown snapshot storage as the current design.

## Testing Strategy

Add focused unit tests for:

- Candidate file create/read/update/merge behavior.
- Candidate filenames using `name-slug + inventoryId`, with inventory ID as the canonical identity.
- Profile fact extraction from representative LinkedIn profile DOM snippets.
- LinkedIn company About fact extraction for overview, website, phone, industry, company size, headquarters, founded, and specialties.
- Activity capture using `content` and recent visible post/comment detection.
- Multi-page website crawl normalization.
- Playwright fallback website capture returning the same multi-page shape.
- `score-fits` reading candidate files instead of `lead_enrichment_snapshots.raw_text`.
- `submit-qualified` posting only high-potential candidates and recording portal submission state.

Run the existing Node test suite after implementation:

```text
npm test
```

After implementation, call a subagent or code-review QA pass to test the workflow step by step and look for contract drift between the candidate schema, DB writes, CLI commands, and portal payload.

## Success Criteria

- Queued connections are not saved as portal/company/individual data until they pass the fit gate.
- Pre-fit profile and company LinkedIn captures are structured facts, not markdown/raw HTML blobs.
- `lead_enrichment_snapshots` stores `facts jsonb` instead of raw text, raw HTML references, screenshots, or generic structured JSON.
- Candidate files are readable by humans and deterministic for code.
- Activity capture stores actual visible activity text as `content`.
- Company website capture supports multiple pages.
- `score-fits` can score from candidate files and structured activity facts.
- Qualified candidates are submitted to the portal as one JSON payload.
- The portal is responsible for canonical persistence and draft generation.
- Tests cover every workflow step that reads or writes the candidate schema.
