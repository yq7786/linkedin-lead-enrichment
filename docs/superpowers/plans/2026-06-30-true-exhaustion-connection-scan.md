# True Exhaustion Connection Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make connection top-up scans continue until they find the requested number of useful rows or the LinkedIn page truly stops yielding additional cards.

**Architecture:** Keep backlog-first selection unchanged, but move exhaustion semantics onto observed page growth instead of useful-row yield. Update the LinkedIn extraction helper and top-up loop together, then verify the guided workflow still retries partial batches unless true exhaustion is proven.

**Tech Stack:** Node.js, built-in test runner, Playwright-facing extraction helpers

---

### Task 1: Capture true-exhaustion behavior in sync tests

**Files:**
- Modify: `test/linkedinSync.test.js`
- Test: `test/linkedinSync.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("syncLinkedInConnections keeps scanning while LinkedIn reveals more cards even if new cards are already known", async () => {
  const scanRequests = [];
  const writes = [];
  const knownUrls = new Set(
    Array.from({ length: 15 }, (_, index) => `https://www.linkedin.com/in/already-known-${index + 1}`)
  );

  const result = await syncLinkedInConnections({
    limit: 10,
    extractConnections: async ({ scanLimit, scrollPasses }) => {
      scanRequests.push({ scanLimit, scrollPasses });
      const cards = [];
      for (let index = 1; index <= 15; index += 1) {
        cards.push({
          profileHref: `https://www.linkedin.com/in/already-known-${index}/`,
          text: `Known ${index}\nFounder at Old Co`
        });
      }
      const newVisible = scrollPasses >= 6 ? 10 : 4;
      for (let index = 1; index <= newVisible; index += 1) {
        cards.push({
          profileHref: `https://www.linkedin.com/in/new-person-${index}/`,
          text: `New Person ${index}\nFounder at New Co`
        });
      }
      return normalizeConnectionCards(cards);
    },
    inventoryRepository: {
      listEligibleForEnrichment: async () => [],
      findByProfileUrls: async (profileUrls) =>
        profileUrls
          .filter((url) => knownUrls.has(url))
          .map((url) => ({ id: `known-${url}`, linkedinProfileUrl: url, workflowStatus: "submitted", dedupeStatus: "dedupe_pending" })),
      upsertMany: async (records) => {
        writes.push(records);
        return { upserted: records.length };
      }
    }
  });

  assert.deepEqual(scanRequests.map((request) => request.scrollPasses), [3, 6]);
  assert.equal(result.summary.batchSize, 10);
  assert.equal(result.summary.discovered, 10);
  assert.equal(result.summary.exhausted, false);
  assert.equal(writes[0].length, 10);
});

test("syncLinkedInConnections reports exhaustion only after LinkedIn stops yielding additional cards", async () => {
  const result = await syncLinkedInConnections({
    limit: 8,
    extractConnections: async ({ scrollPasses }) => {
      const visible = scrollPasses >= 6 ? 5 : 4;
      return normalizeConnectionCards(
        Array.from({ length: visible }, (_, index) => ({
          profileHref: `https://www.linkedin.com/in/person-${index + 1}/`,
          text: `Person ${index + 1}\nFounder at Company ${index + 1}`
        }))
      );
    },
    inventoryRepository: {
      listEligibleForEnrichment: async () => [],
      findByProfileUrls: async () => [],
      upsertMany: async (records) => ({ upserted: records.length })
    }
  });

  assert.equal(result.summary.batchSize, 5);
  assert.equal(result.summary.remaining, 3);
  assert.equal(result.summary.exhausted, true);
  assert.equal(result.summary.scanAttempts, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/linkedinSync.test.js`
Expected: FAIL in the new true-exhaustion tests because the current scanner stops based on useful-row yield and overfetch heuristics.

- [ ] **Step 3: Write minimal implementation**

```js
// In src/linkedin/connectionSync.js, update discoverTopUpConnections(...)
// so it tracks extracted normalized URL growth between attempts and only
// sets exhausted=true when the extracted set stops growing.
//
// Preserve existing backlog-first behavior and DB filtering.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/linkedinSync.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/linkedinSync.test.js src/linkedin/connectionSync.js
git commit -m "fix: use true exhaustion for connection scanning"
```

### Task 2: Verify guided workflow still treats partial syncs correctly

**Files:**
- Modify: `test/guidedWorkflow.test.js`
- Test: `test/guidedWorkflow.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("runGuidedWorkflow stops on partial sync when true exhaustion is proven", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guided-workflow-exhausted-"));
  const syncLimits = [];
  const logs = [];
  const client = {
    async connect() {},
    async end() {},
    async query(sql, params) {
      if (/select workflow_status as status/i.test(sql)) {
        return { rows: [{ status: "skipped_not_fit", count: String(params[0].length) }] };
      }
      return { rows: [] };
    }
  };

  const result = await runGuidedWorkflow({
    answers: {
      databaseUrl: "postgres://example",
      openaiApiKey: "sk-test",
      portalQualifiedIngestUrl: "https://portal.example/ingest",
      portalCallbackSecret: "secret",
      linkedinAccount: "Haydn",
      connectionLimit: 30
    },
    cwd: directory,
    env: {},
    log: (message) => logs.push(message),
    dependencies: {
      validateConfig() {
        return {
          databaseUrl: "postgres://example",
          linkedinBrowserProfilePath: path.join(directory, ".linkedin-browser-profile"),
          portalQualifiedIngestUrl: "https://portal.example/ingest",
          portalCallbackSecret: "secret",
          defaultBatchLimit: 50
        };
      },
      async createDbClient() {
        return client;
      },
      async importPlaywright() {
        return {};
      },
      async createLinkedInBrowserSession() {
        return {
          pages() {
            return [{}];
          },
          async close() {}
        };
      },
      async syncLinkedInConnections(input) {
        syncLimits.push(input.limit);
        const profileUrls = Array.from({ length: 10 }, (_, index) =>
          `https://www.linkedin.com/in/exhausted-person-${index + 1}`
        );
        return {
          connections: profileUrls.map((linkedinProfileUrl) => ({ linkedinProfileUrl })),
          profileUrls,
          inventoryIds: profileUrls.map((_, index) => `inventory-${index + 1}`),
          summary: {
            requested: input.limit,
            batchSize: 10,
            existingSelected: 0,
            discovered: 10,
            upserted: 10,
            remaining: input.limit - 10,
            exhausted: true,
            scanAttempts: 3
          }
        };
      },
      async processQueuedProfiles(input) {
        return { summary: { extracted: input.profileUrls.length, failed: 0 } };
      },
      async syncCompanyProfiles(input) {
        return { summary: { companiesProcessed: input.profileUrls.length, failed: 0 } };
      },
      async dedupeInventory(input) {
        return { summary: { queued: input.profileUrls.length, matchedExisting: 0, needsReview: 0 } };
      },
      async syncLinkedInActivityItems(input) {
        return { summary: { profilesProcessed: input.profileUrls.length, activitiesCaptured: 0, failed: 0 } };
      },
      async scoreExtractedProfiles(input) {
        return { summary: { fitScored: 0, skippedNotFit: input.inventoryIds.length, failed: 0 } };
      },
      async syncCompanyWebsites() {
        return { summary: { websitesProcessed: 0, failed: 0 } };
      },
      async submitQualifiedCandidates() {
        return { summary: { submitted: 0, wouldSubmit: 0, skipped: 0, failed: 0 } };
      },
      async waitForLinkedInLogin() {
        return { status: "session_ready" };
      }
    }
  });

  assert.deepEqual(syncLimits, [30]);
  assert.equal(result.processed, 10);
  assert.match(logs.join("\n"), /Sync exhausted after preparing 10 of 30 requested; 20 remain/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/guidedWorkflow.test.js`
Expected: FAIL until the assertions and any summary expectations match the new semantics.

- [ ] **Step 3: Write minimal implementation**

```js
// Keep src/guidedWorkflow.js retry logic unchanged unless the new test
// shows a mismatch; only adjust log/assertion expectations if needed.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/guidedWorkflow.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/guidedWorkflow.test.js src/guidedWorkflow.js
git commit -m "test: cover guided workflow true exhaustion behavior"
```

### Task 3: Run focused and full verification

**Files:**
- Modify: `src/linkedin/connectionSync.js`
- Modify: `test/linkedinSync.test.js`
- Modify: `test/guidedWorkflow.test.js`

- [ ] **Step 1: Run focused tests**

Run: `node --test test/linkedinSync.test.js test/guidedWorkflow.test.js`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Commit final verification state**

```bash
git add src/linkedin/connectionSync.js test/linkedinSync.test.js test/guidedWorkflow.test.js
git commit -m "fix: keep scanning until true LinkedIn exhaustion"
```
