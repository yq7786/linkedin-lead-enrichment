import test from "node:test";
import assert from "node:assert/strict";

import {
  ScoreExtractedProfilesRepository,
  deriveFitFromCandidate,
  scoreExtractedProfiles
} from "../src/workflow/scoreExtractedProfiles.js";

function sampleCandidate(overrides = {}) {
  return {
    candidate: { inventoryId: "inventory_1", status: "company_captured" },
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
          postedAt: "2026-05-01T00:00:00Z",
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
    },
    ...overrides
  };
}

test("deriveFitFromCandidate detects recent activity only from saved post/comment rows", () => {
  const fit = deriveFitFromCandidate(
    sampleCandidate(),
    new Date("2026-06-25T00:00:00Z")
  );

  assert.equal(fit.founderSignal, true);
  assert.equal(fit.startupSignal, true);
  assert.equal(fit.recentActivitySignal, true);
  assert.equal(fit.fitScore, 1);
});

test("deriveFitFromCandidate does not infer recent activity from profile text alone", () => {
  const fit = deriveFitFromCandidate(
    sampleCandidate({
      activityCapture: { items: [] }
    }),
    new Date("2026-06-25T00:00:00Z")
  );

  assert.equal(fit.founderSignal, true);
  assert.equal(fit.startupSignal, true);
  assert.equal(fit.recentActivitySignal, false);
  assert.equal(fit.fitScore, 2 / 3);
});

test("deriveFitFromCandidate prefers saved post/comment activity rows for recent activity", () => {
  const fit = deriveFitFromCandidate(
    sampleCandidate({
      activityCapture: {
        items: [
          { activityType: "like", postedAt: "2026-06-01T00:00:00Z", content: "Liked a post" },
          { activityType: "comment", postedAt: "2026-04-01T00:00:00Z", content: "Recent comment" }
        ]
      }
    }),
    new Date("2026-06-25T00:00:00Z")
  );

  assert.equal(fit.recentActivitySignal, true);
});

function mockCandidateRepository(candidates = []) {
  return {
    listByStatus: async (status) => candidates.filter((candidate) => candidate.candidate.status === status),
    upsertCandidate: async () => {}
  };
}

test("scoreExtractedProfiles scores candidate files and writes fit back", async () => {
  const writes = [];
  const repository = mockCandidateRepository([sampleCandidate()]);
  repository.upsertCandidate = async (input) => writes.push(["candidate", input.inventoryId, input.patch.fit.fitScore, input.status]);
  const result = await scoreExtractedProfiles({
    candidateRepository: repository,
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

test("scoreExtractedProfiles dry-run reports fit decisions without writing notes or status", async () => {
  const writes = [];
  const repository = mockCandidateRepository([sampleCandidate()]);
  repository.upsertCandidate = async (...args) => writes.push(["candidate", args]);
  const result = await scoreExtractedProfiles({
    candidateRepository: repository,
    repository: {
      markFitScored: async (...args) => writes.push(["fit", args]),
      markSkippedNotFit: async (...args) => writes.push(["skip", args])
    },
    dryRun: true,
    now: new Date("2026-06-25T00:00:00Z")
  });

  assert.equal(result.status, "dry_run");
  assert.deepEqual(result.summary, { fitScored: 1, skippedNotFit: 0, failed: 0 });
  assert.equal(result.items[0].status, "qualified");
  assert.deepEqual(writes, []);
});

test("scoreExtractedProfiles live mode writes fit to candidate files and updates status", async () => {
  const writes = [];
  const repository = mockCandidateRepository([
    sampleCandidate({
      activityCapture: {
        items: [
          {
            activityType: "comment",
            postedAt: "2026-06-01T00:00:00Z",
            content: "Built an AI workflow startup."
          }
        ]
      }
    })
  ]);
  repository.upsertCandidate = async (input) => writes.push(["candidate", input.inventoryId, input.patch.fit.fitScore, input.status]);
  const result = await scoreExtractedProfiles({
    candidateRepository: repository,
    repository: {
      markFitScored: async (id) => writes.push(["fit", id]),
      markSkippedNotFit: async (id) => writes.push(["skip", id])
    },
    now: new Date("2026-06-25T00:00:00Z")
  });

  assert.equal(result.status, "processed");
  assert.deepEqual(result.summary, { fitScored: 1, skippedNotFit: 0, failed: 0 });
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", 1, "qualified"],
    ["fit", "inventory_1"]
  ]);
});

test("scoreExtractedProfiles marks not-fit profiles as skipped", async () => {
  const writes = [];
  const repository = mockCandidateRepository([
    sampleCandidate({
      identity: { firstName: "Jane", lastName: "Smith", headline: "Account Manager" },
      profileCapture: {
        facts: {
          about: "Managing enterprise accounts.",
          currentRoleTitle: "Account Manager",
          jobHistory: []
        }
      },
      companyCapture: {
        facts: {
          overview: "Acme Services provides consulting.",
          industry: "Professional Services"
        }
      },
      companyWebsite: { pages: [] },
      activityCapture: { items: [] }
    })
  ]);
  repository.upsertCandidate = async (input) => writes.push(["candidate", input.inventoryId, input.patch.fit.fitScore, input.status]);
  const result = await scoreExtractedProfiles({
    candidateRepository: repository,
    repository: {
      markFitScored: async (id) => writes.push(["fit", id]),
      markSkippedNotFit: async (id) => writes.push(["skip", id])
    },
    now: new Date("2026-06-25T00:00:00Z")
  });

  assert.deepEqual(result.summary, { fitScored: 0, skippedNotFit: 1, failed: 0 });
  assert.equal(result.items[0].status, "skipped_not_fit");
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", 0, "skipped_not_fit"],
    ["skip", "inventory_1"]
  ]);
});

test("ScoreExtractedProfilesRepository updates workflow status for fit decisions", async () => {
  const queries = [];
  const repository = new ScoreExtractedProfilesRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
  });

  await repository.markFitScored("inventory_1");
  await repository.markSkippedNotFit("inventory_2");

  assert.match(queries[0].sql, /workflow_status = 'qualified'/);
  assert.deepEqual(queries[0].params, ["inventory_1"]);
  assert.match(queries[1].sql, /workflow_status = 'skipped_not_fit'/);
  assert.deepEqual(queries[1].params, ["inventory_2"]);
});
