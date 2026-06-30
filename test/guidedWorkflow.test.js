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

test("resolveGuidedWorkflowAnswers returns null when required env is missing", () => {
  assert.equal(resolveGuidedWorkflowAnswers({
    env: { OPENAI_API_KEY: "sk-test" },
    account: "kirk",
    limit: 5
  }), null);
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
        inputStream.write("kathryb\n");
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
    linkedinAccount: "kathryb",
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
    async syncLinkedInConnections() {
      calls.push("sync-connections");
      return {
        connections: [{ linkedinProfileUrl: "https://www.linkedin.com/in/example" }],
        summary: { upserted: 1 }
      };
    },
    async processQueuedProfiles() {
      calls.push("process-queue");
      return stepResult;
    },
    async syncCompanyProfiles() {
      calls.push("sync-company-profiles");
      return stepResult;
    },
    async dedupeInventory() {
      calls.push("dedupe-inventory");
      return stepResult;
    },
    async syncLinkedInActivityItems() {
      calls.push("sync-activities");
      return stepResult;
    },
    async scoreExtractedProfiles() {
      calls.push("score-fits");
      return stepResult;
    },
    async syncCompanyWebsites() {
      calls.push("sync-company-websites");
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
      linkedinAccount: "kathryb",
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
