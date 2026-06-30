import test from "node:test";
import assert from "node:assert/strict";

import { PortalCandidateAdapter } from "../src/adapters/portalCandidates.js";
import {
  SubmitQualifiedCandidatesRepository,
  submitQualifiedCandidates
} from "../src/workflow/submitQualifiedCandidates.js";

test("PortalCandidateAdapter posts candidate payload to portal", async () => {
  const calls = [];
  const adapter = new PortalCandidateAdapter({
    endpointUrl: "https://portal.example.com/api/webhooks/lead-enrichment/qualified-ingest",
    callbackSecret: "secret",
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
  assert.equal(calls[0].url, "https://portal.example.com/api/webhooks/lead-enrichment/qualified-ingest");
  assert.equal(calls[0].options.headers["x-make-callback-secret"], "secret");
  assert.equal(calls[0].options.headers.authorization, undefined);
});

test("submitQualifiedCandidates submits only qualified unsubmitted candidates", async () => {
  const writes = [];
  const statusesListed = [];
  const result = await submitQualifiedCandidates({
    candidateRepository: {
      listByStatus: async (status) => {
        statusesListed.push(status);
        return status === "website_captured"
          ? [{
              candidate: { inventoryId: "inventory_1", status: "website_captured" },
              identity: { firstName: "Jane", lastName: "Smith" },
              fit: { founderSignal: true, startupSignal: true, recentActivitySignal: true },
              portalSubmission: { status: "not_submitted" }
            }]
          : [{
              candidate: { inventoryId: "inventory_2", status: "qualified" },
              identity: { firstName: "Michelle", lastName: "Chua-Lagare" },
              fit: { founderSignal: true, startupSignal: true, recentActivitySignal: true },
              portalSubmission: { status: "not_submitted" }
            }];
      },
      upsertCandidate: async (input) => writes.push(["candidate", input.inventoryId, input.patch.portalSubmission.portalCandidateId, input.status])
    },
    portalCandidates: {
      submitCandidate: async (payload) => ({ portalCandidateId: `portal_${payload.inventoryId}` })
    },
    repository: {
      markSubmitted: async (inventoryId, portalCandidateId) => writes.push(["db", inventoryId, portalCandidateId])
    }
  });

  assert.deepEqual(statusesListed, ["qualified", "website_captured"]);
  assert.deepEqual(result.summary, { submitted: 2, wouldSubmit: 0, skipped: 0, failed: 0 });
  assert.deepEqual(writes, [
    ["candidate", "inventory_2", "portal_inventory_2", "submitted"],
    ["db", "inventory_2", "portal_inventory_2"],
    ["candidate", "inventory_1", "portal_inventory_1", "submitted"],
    ["db", "inventory_1", "portal_inventory_1"]
  ]);
});

test("submitQualifiedCandidates dry-run builds portal payloads and reports malformed candidates", async () => {
  const result = await submitQualifiedCandidates({
    candidateRepository: {
      listByStatus: async (status) => status === "website_captured"
        ? [{
            candidate: { inventoryId: "inventory_1", status: "website_captured" },
            identity: { firstName: "Jane", lastName: "Smith" },
            fit: { founderSignal: true, startupSignal: true, recentActivitySignal: true }
          }]
        : [{
            candidate: { inventoryId: "inventory_2", status: "qualified" },
            fit: { founderSignal: true, startupSignal: true, recentActivitySignal: true }
          }],
      upsertCandidate: async () => {
        throw new Error("dry-run must not write candidate files");
      }
    },
    portalCandidates: {
      submitCandidate: async () => {
        throw new Error("dry-run must not call portal");
      }
    },
    repository: {
      markSubmitted: async () => {
        throw new Error("dry-run must not write database status");
      }
    },
    dryRun: true
  });

  assert.deepEqual(result.summary, { submitted: 0, wouldSubmit: 1, skipped: 0, failed: 1 });
  assert.equal(result.items[0].status, "failed");
  assert.match(result.items[0].error, /identity/);
  assert.equal(result.items[1].status, "would_submit");
  assert.equal(result.items[1].payload.source, "linkedin_lead_enrichment");
  assert.equal(result.items[1].payload.inventoryId, "inventory_1");
});

test("submitQualifiedCandidates records portal failures for audit", async () => {
  const writes = [];
  const result = await submitQualifiedCandidates({
    candidateRepository: {
      listByStatus: async (status) => status === "website_captured"
        ? [{
            candidate: { inventoryId: "inventory_1", status: "website_captured" },
            identity: { firstName: "Jane", lastName: "Smith" },
            fit: { founderSignal: true, startupSignal: true, recentActivitySignal: true }
          }]
        : [],
      upsertCandidate: async (input) => writes.push(["candidate", input.inventoryId, input.patch.portalSubmission.status, input.status])
    },
    portalCandidates: {
      submitCandidate: async () => {
        const error = new Error("Portal temporarily unavailable");
        error.httpStatus = 503;
        throw error;
      }
    },
    repository: {
      markSubmitted: async () => writes.push(["unexpected submitted"]),
      markSubmissionFailed: async (inventoryId, error) => writes.push(["db_failed", inventoryId, error.message])
    }
  });

  assert.deepEqual(result.summary, { submitted: 0, wouldSubmit: 0, skipped: 0, failed: 1 });
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", "failed", "website_captured"],
    ["db_failed", "inventory_1", "Portal temporarily unavailable"]
  ]);
});

test("SubmitQualifiedCandidatesRepository marks portal API failures with audit event", async () => {
  const queries = [];
  const repository = new SubmitQualifiedCandidatesRepository({
    query: async (sql, params) => queries.push({ sql, params })
  });

  const error = new Error("Portal unavailable");
  error.httpStatus = 503;
  await repository.markSubmissionFailed("inventory_1", error);

  assert.match(queries[0].sql, /workflow_status = \$2/);
  assert.equal(queries[0].params[1], "failed_retryable");
  assert.match(queries[1].sql, /portal_api_failed/);
  assert.equal(queries[1].params[0], "inventory_1");
  assert.deepEqual(JSON.parse(queries[1].params[2]), {
    disposition: "retryable",
    httpStatus: 503
  });
});
