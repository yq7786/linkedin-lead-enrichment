import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  askGuidedWorkflowQuestions,
  resolveGuidedWorkflowAnswers,
  runGuidedWorkflow,
  summarizeInventoryStatuses,
  writeLocalEnvFile
} from "../src/guidedWorkflow.js";

test("writeLocalEnvFile creates and updates local env values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guided-workflow-"));
  const envPath = path.join(directory, ".env");

  await writeLocalEnvFile(envPath, {
    DATABASE_URL: "postgres://example",
    OPENAI_API_KEY: "sk-test",
    PORTAL_QUALIFIED_INGEST_URL: "https://portal.example/ingest",
    PORTAL_CALLBACK_SECRET: "secret",
    DEFAULT_BATCH_LIMIT: "5"
  });
  await writeLocalEnvFile(envPath, {
    OPENAI_API_KEY: "sk-updated",
    DEFAULT_BATCH_LIMIT: "10"
  });

  const content = await readFile(envPath, "utf8");
  assert.match(content, /^DATABASE_URL=postgres:\/\/example$/m);
  assert.match(content, /^OPENAI_API_KEY=sk-updated$/m);
  assert.match(content, /^PORTAL_QUALIFIED_INGEST_URL=https:\/\/portal\.example\/ingest$/m);
  assert.match(content, /^PORTAL_CALLBACK_SECRET=secret$/m);
  assert.match(content, /^DEFAULT_BATCH_LIMIT=10$/m);
});

test("summarizeInventoryStatuses counts only the requested profile URLs", async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      return {
        rows: [
          { status: "submitted", count: "2" },
          { status: "skipped_not_fit", count: "1" }
        ]
      };
    }
  };

  const result = await summarizeInventoryStatuses(client, [
    "https://www.linkedin.com/in/Jane-Smith",
    "https://www.linkedin.com/in/jane-smith",
    "https://www.linkedin.com/in/alex-lee"
  ]);

  assert.deepEqual(result, { submitted: 2, skipped_not_fit: 1 });
  assert.match(queries[0].sql, /where lower\(linkedin_profile_url\) = any\(\$1::text\[\]\)/i);
  assert.deepEqual(queries[0].params, [[
    "https://www.linkedin.com/in/jane-smith",
    "https://www.linkedin.com/in/alex-lee"
  ]]);
});

test("resolveGuidedWorkflowAnswers skips prompts when env and flags are complete", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guided-workflow-resolve-"));
  const envPath = path.join(directory, ".env");
  await writeLocalEnvFile(envPath, {
    DATABASE_URL: "postgres://example",
    OPENAI_API_KEY: "sk-test",
    PORTAL_QUALIFIED_INGEST_URL: "https://portal.example/ingest",
    PORTAL_CALLBACK_SECRET: "secret"
  });

  const originalCwd = process.cwd();
  process.chdir(directory);
  try {
    const answers = resolveGuidedWorkflowAnswers({
      env: {},
      account: "siriluk",
      limit: 7
    });
    assert.deepEqual(answers, {
      databaseUrl: "postgres://example",
      openaiApiKey: "sk-test",
      portalQualifiedIngestUrl: "https://portal.example/ingest",
      portalCallbackSecret: "secret",
      linkedinAccount: "siriluk",
      connectionLimit: 7
    });
  } finally {
    process.chdir(originalCwd);
  }
});

test("resolveGuidedWorkflowAnswers returns null when required env is missing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guided-workflow-missing-"));
  const originalCwd = process.cwd();
  process.chdir(directory);
  try {
    assert.equal(resolveGuidedWorkflowAnswers({
      env: { OPENAI_API_KEY: "sk-test" },
      account: "kirk",
      limit: 5
    }), null);
  } finally {
    process.chdir(originalCwd);
  }
});

test("askGuidedWorkflowQuestions accepts env values at once before account and limit", async () => {
  const inputStream = new PassThrough();
  const output = [];
  const answered = new Set();
  const outputStream = new Writable({
    write(chunk, encoding, callback) {
      const text = chunk.toString();
      output.push(text);
      if (text.includes("Env values:") && !answered.has("env")) {
        answered.add("env");
        inputStream.write("DATABASE_URL=postgres://example OPENAI_API_KEY=sk-test PORTAL_QUALIFIED_INGEST_URL=https://portal.example/ingest PORTAL_CALLBACK_SECRET=secret\n");
      }
      if (text.includes("LinkedIn Account") && !answered.has("account")) {
        answered.add("account");
        inputStream.write("kathryn\n");
      }
      if (text.includes("Number of connections") && !answered.has("limit")) {
        answered.add("limit");
        inputStream.end("3\n");
      }
      callback();
    }
  });

  const answers = await askGuidedWorkflowQuestions({ inputStream, outputStream });

  assert.deepEqual(answers, {
    databaseUrl: "postgres://example",
    openaiApiKey: "sk-test",
    portalQualifiedIngestUrl: "https://portal.example/ingest",
    portalCallbackSecret: "secret",
    linkedinAccount: "kathryn",
    connectionLimit: 3
  });
  assert.match(output.join(""), /High connection counts can hit LinkedIn usage limits or paid API limits/);
});

test("runGuidedWorkflow skipFinalization stops before submit-qualified and final summary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guided-workflow-skip-"));
  const calls = [];
  let contextClosed = false;
  let clientEnded = false;
  const client = {
    async connect() {},
    async end() {
      clientEnded = true;
    },
    async query(sql) {
      if (/select id, linkedin_profile_url, workflow_status/i.test(sql)) {
        return {
          rows: [
            {
              id: "inventory-1",
              linkedin_profile_url: "https://www.linkedin.com/in/example",
              workflow_status: "discovered"
            }
          ]
        };
      }
      return { rows: [] };
    }
  };
  const stepResult = { summary: { processed: 1 } };
  const dependencies = {
    validateConfig() {
      return {
        databaseUrl: "postgres://example",
        linkedinBrowserProfilePath: path.join(directory, ".linkedin-browser-profile"),
        portalQualifiedIngestUrl: "https://portal.example/ingest",
        portalCallbackSecret: "secret"
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
        async close() {
          contextClosed = true;
        }
      };
    },
    async syncLinkedInConnections(input) {
      calls.push("sync-connections");
      assert.equal(input.limit, 1);
      return {
        connections: [
          { linkedinProfileUrl: "https://www.linkedin.com/in/example" },
          { linkedinProfileUrl: "https://www.linkedin.com/in/unselected" }
        ],
        profileUrls: ["https://www.linkedin.com/in/example"],
        inventoryIds: ["inventory-1"],
        summary: { upserted: 1 }
      };
    },
    async processQueuedProfiles(input) {
      calls.push("process-queue");
      assert.deepEqual(input.profileUrls, ["https://www.linkedin.com/in/example"]);
      return stepResult;
    },
    async syncCompanyProfiles(input) {
      calls.push("sync-company-profiles");
      assert.deepEqual(input.profileUrls, ["https://www.linkedin.com/in/example"]);
      return stepResult;
    },
    async dedupeInventory(input) {
      calls.push("dedupe-inventory");
      assert.deepEqual(input.profileUrls, ["https://www.linkedin.com/in/example"]);
      return stepResult;
    },
    async syncLinkedInActivityItems(input) {
      calls.push("sync-activities");
      assert.deepEqual(input.profileUrls, ["https://www.linkedin.com/in/example"]);
      return stepResult;
    },
    async scoreExtractedProfiles(input) {
      calls.push("score-fits");
      assert.deepEqual(input.inventoryIds, ["inventory-1"]);
      return stepResult;
    },
    async syncCompanyWebsites(input) {
      calls.push("sync-company-websites");
      assert.deepEqual(input.inventoryIds, ["inventory-1"]);
      return stepResult;
    },
    async submitQualifiedCandidates() {
      throw new Error("submit-qualified should be skipped");
    },
    async waitForLinkedInLogin() {
      calls.push("wait-for-login");
      return { status: "session_ready" };
    }
  };
  const logs = [];

  const result = await runGuidedWorkflow({
    answers: {
      databaseUrl: "postgres://example",
      openaiApiKey: "sk-test",
      portalQualifiedIngestUrl: "https://portal.example/ingest",
      portalCallbackSecret: "secret",
      linkedinAccount: "kathryn",
      connectionLimit: 1
    },
    cwd: directory,
    env: {},
    log: (message) => logs.push(message),
    dependencies,
    skipFinalization: true
  });

  assert.deepEqual(calls, [
    "wait-for-login",
    "sync-connections",
    "process-queue",
    "sync-company-profiles",
    "dedupe-inventory",
    "sync-activities",
    "score-fits",
    "sync-company-websites"
  ]);
  assert.equal(result.skippedFinalization, true);
  assert.equal(contextClosed, true);
  assert.equal(clientEnded, true);
  assert.doesNotMatch(logs.join("\n"), /Step 8\/8: submit-qualified/);
  assert.doesNotMatch(logs.join("\n"), /Status summary/);
});

test("runGuidedWorkflow splits requests above the batch cap into sequential batches", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guided-workflow-batches-"));
  const syncLimits = [];
  const processBatches = [];
  let contextClosed = false;
  let clientEnded = false;
  const client = {
    async connect() {},
    async end() {
      clientEnded = true;
    },
    async query(sql, params) {
      if (/select workflow_status as status/i.test(sql)) {
        return { rows: [{ status: "skipped_not_fit", count: String(params[0].length) }] };
      }
      return { rows: [] };
    }
  };
  const dependencies = {
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
        async close() {
          contextClosed = true;
        }
      };
    },
    async syncLinkedInConnections(input) {
      syncLimits.push(input.limit);
      const batchIndex = syncLimits.length;
      const profileUrls = Array.from({ length: input.limit }, (_, index) =>
        `https://www.linkedin.com/in/batch-${batchIndex}-person-${index + 1}`
      );
      return {
        connections: profileUrls.map((linkedinProfileUrl) => ({ linkedinProfileUrl })),
        profileUrls,
        inventoryIds: profileUrls.map((_, index) => `inventory-${batchIndex}-${index + 1}`),
        summary: {
          requested: input.limit,
          batchSize: profileUrls.length,
          existingSelected: 0,
          discovered: profileUrls.length,
          upserted: profileUrls.length,
          exhausted: false
        }
      };
    },
    async processQueuedProfiles(input) {
      processBatches.push({ step: "process-queue", limit: input.limit, profileUrls: input.profileUrls });
      return { summary: { extracted: input.profileUrls.length, failed: 0 } };
    },
    async syncCompanyProfiles(input) {
      processBatches.push({ step: "sync-company-profiles", limit: input.limit, profileUrls: input.profileUrls });
      return { summary: { companiesProcessed: input.profileUrls.length, failed: 0 } };
    },
    async dedupeInventory(input) {
      processBatches.push({ step: "dedupe-inventory", limit: input.limit, profileUrls: input.profileUrls });
      return { summary: { queued: input.profileUrls.length, matchedExisting: 0, needsReview: 0 } };
    },
    async syncLinkedInActivityItems(input) {
      processBatches.push({ step: "sync-activities", limit: input.limit, profileUrls: input.profileUrls });
      return { summary: { profilesProcessed: input.profileUrls.length, activitiesCaptured: 0, failed: 0 } };
    },
    async scoreExtractedProfiles(input) {
      processBatches.push({ step: "score-fits", limit: input.limit, inventoryIds: input.inventoryIds });
      return { summary: { fitScored: 0, skippedNotFit: input.inventoryIds.length, failed: 0 } };
    },
    async syncCompanyWebsites(input) {
      processBatches.push({ step: "sync-company-websites", limit: input.limit, inventoryIds: input.inventoryIds });
      return { summary: { websitesProcessed: 0, failed: 0 } };
    },
    async submitQualifiedCandidates(input) {
      processBatches.push({ step: "submit-qualified", limit: input.limit, inventoryIds: input.inventoryIds });
      return { summary: { submitted: 0, wouldSubmit: 0, skipped: 0, failed: 0 } };
    },
    async waitForLinkedInLogin() {
      return { status: "session_ready" };
    }
  };

  const result = await runGuidedWorkflow({
    answers: {
      databaseUrl: "postgres://example",
      openaiApiKey: "sk-test",
      portalQualifiedIngestUrl: "https://portal.example/ingest",
      portalCallbackSecret: "secret",
      linkedinAccount: "Haydn",
      connectionLimit: 120
    },
    cwd: directory,
    env: {},
    log: () => {},
    dependencies
  });

  assert.deepEqual(syncLimits, [50, 50, 20]);
  assert.equal(processBatches.filter((batch) => batch.step === "process-queue").length, 3);
  assert.deepEqual(
    processBatches.filter((batch) => batch.step === "process-queue").map((batch) => batch.limit),
    [50, 50, 20]
  );
  assert.equal(result.processed, 120);
  assert.deepEqual(result.statusSummary, { skipped_not_fit: 120 });
  assert.equal(contextClosed, true);
  assert.equal(clientEnded, true);
});

test("runGuidedWorkflow retries a partial sync batch when exhaustion is not proven", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guided-workflow-partial-"));
  const syncLimits = [];
  const processedProfileUrls = [];
  const logs = [];
  let contextClosed = false;
  let clientEnded = false;
  const client = {
    async connect() {},
    async end() {
      clientEnded = true;
    },
    async query(sql, params) {
      if (/select workflow_status as status/i.test(sql)) {
        return { rows: [{ status: "skipped_not_fit", count: String(params[0].length) }] };
      }
      return { rows: [] };
    }
  };
  const dependencies = {
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
        async close() {
          contextClosed = true;
        }
      };
    },
    async syncLinkedInConnections(input) {
      syncLimits.push(input.limit);
      const batchIndex = syncLimits.length;
      const count = batchIndex === 1 ? 10 : input.limit;
      const profileUrls = Array.from({ length: count }, (_, index) =>
        `https://www.linkedin.com/in/partial-${batchIndex}-person-${index + 1}`
      );
      return {
        connections: profileUrls.map((linkedinProfileUrl) => ({ linkedinProfileUrl })),
        profileUrls,
        inventoryIds: profileUrls.map((_, index) => `inventory-${batchIndex}-${index + 1}`),
        summary: {
          requested: input.limit,
          batchSize: profileUrls.length,
          existingSelected: 0,
          discovered: profileUrls.length,
          upserted: profileUrls.length,
          remaining: input.limit - profileUrls.length,
          exhausted: false,
          scanAttempts: batchIndex
        }
      };
    },
    async processQueuedProfiles(input) {
      processedProfileUrls.push(...input.profileUrls);
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
    dependencies
  });

  assert.deepEqual(syncLimits, [30, 20]);
  assert.equal(processedProfileUrls.length, 30);
  assert.equal(result.processed, 30);
  assert.match(logs.join("\n"), /Partial sync prepared 10 of 30 requested; retrying remaining 20/);
  assert.equal(contextClosed, true);
  assert.equal(clientEnded, true);
});
