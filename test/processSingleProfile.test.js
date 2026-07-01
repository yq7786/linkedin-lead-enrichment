import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CandidateFileRepository } from "../src/workflow/candidateFiles.js";
import { buildManualSingleProfileFit } from "../src/workflow/manualQualification.js";
import {
  SingleProfileRepository,
  runProcessSingleProfile
} from "../src/workflow/processSingleProfile.js";

test("buildManualSingleProfileFit records explicit manual qualification", () => {
  const fit = buildManualSingleProfileFit(new Date("2026-07-01T00:00:00.000Z"));

  assert.deepEqual(fit, {
    mode: "manual_single_profile",
    manuallyQualified: true,
    qualifiedAt: "2026-07-01T00:00:00.000Z",
    fitReasoning: "Operator supplied this LinkedIn profile directly; automated fit scoring was skipped."
  });
});

test("runProcessSingleProfile requires a profile URL before dependencies run", async () => {
  await assert.rejects(
    runProcessSingleProfile({
      profileUrl: "",
      account: "kirk",
      dependencies: {
        repository: {
          findByProfileUrl: async () => {
            throw new Error("must not query database");
          }
        }
      }
    }),
    /--profile-url is required/
  );
});

test("runProcessSingleProfile requires LINKEDIN_ACCOUNT before database mutation", async () => {
  const calls = [];

  await assert.rejects(
    runProcessSingleProfile({
      profileUrl: "https://www.linkedin.com/in/jane-smith/",
      account: "",
      dependencies: {
        repository: {
          findByProfileUrl: async () => {
            calls.push("find");
          },
          seedProfile: async () => {
            calls.push("seed");
          }
        }
      }
    }),
    /LINKEDIN_ACCOUNT/
  );

  assert.deepEqual(calls, []);
});

test("runProcessSingleProfile seeds and processes one fresh profile through submission", async () => {
  const calls = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), "single-profile-"));
  const candidateRepository = new CandidateFileRepository({
    directory,
    now: () => new Date("2026-07-01T00:00:00.000Z")
  });
  const repository = createMemorySingleProfileRepository();

  const result = await runProcessSingleProfile({
    profileUrl: "https://www.linkedin.com/in/Jane-Smith/",
    account: "kirk",
    candidateRepository,
    dependencies: {
      repository,
      processQueuedProfiles: async (input) => {
        calls.push(["process-queue", input.profileUrls, input.limit]);
        await input.candidateRepository.upsertCandidate({
          inventoryId: input.inventoryIds[0],
          fullName: "Jane Smith",
          patch: {
            identity: {
              firstName: "Jane",
              lastName: "Smith",
              linkedinProfileUrl: input.profileUrls[0]
            },
            profileCapture: {
              facts: {
                currentCompanyName: "Acme AI",
                currentCompanyLinkedInUrl: "https://www.linkedin.com/company/acme-ai"
              }
            }
          },
          status: "profile_captured"
        });
        return { summary: { extracted: 1, failed: 0 } };
      },
      syncCompanyProfiles: async (input) => {
        calls.push(["sync-company-profiles", input.profileUrls, input.limit]);
        await input.candidateRepository.upsertCandidate({
          inventoryId: input.inventoryIds[0],
          patch: {
            companyCapture: {
              facts: {
                name: "Acme AI",
                website: "https://acme.example"
              }
            }
          },
          status: "company_captured"
        });
        return { summary: { companiesProcessed: 1, failed: 0 } };
      },
      dedupeInventory: async (input) => {
        calls.push(["dedupe-inventory", input.profileUrls, input.limit]);
        return { summary: { matchedExisting: 0, needsReview: 0 } };
      },
      syncLinkedInActivityItems: async (input) => {
        calls.push(["sync-activities", input.profileUrls, input.limit]);
        return { summary: { profilesProcessed: 1, failed: 0 } };
      },
      syncCompanyWebsites: async (input) => {
        calls.push(["sync-company-websites", input.inventoryIds, input.limit]);
        return { summary: { websitesProcessed: 1, failed: 0 } };
      },
      submitQualifiedCandidates: async (input) => {
        calls.push(["submit-qualified", input.inventoryIds, input.limit]);
        return { summary: { submitted: 1, wouldSubmit: 0, skipped: 0, failed: 0 } };
      }
    },
    now: () => new Date("2026-07-01T00:00:00.000Z")
  });

  assert.equal(result.status, "processed");
  assert.equal(result.profileUrl, "https://www.linkedin.com/in/jane-smith");
  assert.deepEqual(calls, [
    ["process-queue", ["https://www.linkedin.com/in/jane-smith"], 1],
    ["sync-company-profiles", ["https://www.linkedin.com/in/jane-smith"], 1],
    ["dedupe-inventory", ["https://www.linkedin.com/in/jane-smith"], 1],
    ["sync-activities", ["https://www.linkedin.com/in/jane-smith"], 1],
    ["sync-company-websites", ["inventory-1"], 1],
    ["submit-qualified", ["inventory-1"], 1]
  ]);

  const candidate = await candidateRepository.findByInventoryId("inventory-1");
  assert.equal(candidate.candidate.status, "qualified");
  assert.equal(candidate.fit.mode, "manual_single_profile");
  assert.equal(repository.rows[0].processingSource, "process_profile");
  assert.equal(repository.rows[0].workflowStatus, "qualified");
});

test("runProcessSingleProfile duplicate skip makes no changes", async () => {
  const repository = createMemorySingleProfileRepository([
    {
      id: "existing-1",
      linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith",
      account: "kirk",
      workflowStatus: "submitted"
    }
  ]);

  const result = await runProcessSingleProfile({
    profileUrl: "https://www.linkedin.com/in/jane-smith",
    account: "kirk",
    duplicateAction: "skip",
    dependencies: {
      repository,
      processQueuedProfiles: async () => {
        throw new Error("must not process skipped duplicate");
      }
    }
  });

  assert.equal(result.status, "skipped_duplicate");
  assert.equal(repository.rows.length, 1);
  assert.equal(repository.deletedInventoryIds.length, 0);
});

test("runProcessSingleProfile duplicate reprocess deletes matching candidate and inventory row", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "single-profile-reprocess-"));
  const candidateRepository = new CandidateFileRepository({
    directory,
    now: () => new Date("2026-07-01T00:00:00.000Z")
  });
  await candidateRepository.upsertCandidate({
    inventoryId: "existing-1",
    fullName: "Jane Smith",
    patch: { identity: { firstName: "Jane", lastName: "Smith" } },
    status: "submitted"
  });
  await candidateRepository.upsertCandidate({
    inventoryId: "other-1",
    fullName: "Other Person",
    patch: { identity: { firstName: "Other", lastName: "Person" } },
    status: "qualified"
  });
  const repository = createMemorySingleProfileRepository([
    {
      id: "existing-1",
      linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith",
      account: "kirk",
      workflowStatus: "submitted"
    }
  ]);

  const result = await runProcessSingleProfile({
    profileUrl: "https://www.linkedin.com/in/jane-smith",
    account: "kirk",
    duplicateAction: "reprocess",
    skipFinalization: true,
    candidateRepository,
    dependencies: {
      repository,
      processQueuedProfiles: async (input) => {
        await input.candidateRepository.upsertCandidate({
          inventoryId: input.inventoryIds[0],
          fullName: "Jane Smith",
          patch: { identity: { firstName: "Jane", lastName: "Smith", linkedinProfileUrl: input.profileUrls[0] } },
          status: "profile_captured"
        });
        return { summary: { extracted: 1, failed: 0 } };
      },
      syncCompanyProfiles: async () => ({ summary: { companiesProcessed: 1, failed: 0 } }),
      dedupeInventory: async () => ({ summary: { matchedExisting: 0, needsReview: 0 } }),
      syncLinkedInActivityItems: async () => ({ summary: { profilesProcessed: 1, failed: 0 } }),
      syncCompanyWebsites: async () => ({ summary: { websitesProcessed: 0, failed: 0 } }),
      submitQualifiedCandidates: async () => {
        throw new Error("must skip finalization");
      }
    }
  });

  assert.equal(result.status, "processed");
  assert.deepEqual(repository.deletedInventoryIds, ["existing-1"]);
  assert.equal(await candidateRepository.findByInventoryId("existing-1"), null);
  assert.equal((await candidateRepository.findByInventoryId("other-1")).identity.firstName, "Other");
  assert.equal(repository.rows.length, 1);
  assert.equal(repository.rows[0].id, "inventory-1");
});

test("SingleProfileRepository reads, seeds, marks, and deletes inventory rows", async () => {
  const queries = [];
  const repository = new SingleProfileRepository({
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/select/i.test(sql)) {
        return {
          rows: [{
            id: "inv_1",
            linkedin_profile_url: "https://www.linkedin.com/in/jane-smith",
            account: "kirk",
            workflow_status: "discovered"
          }]
        };
      }
      if (/insert into/i.test(sql)) {
        return {
          rows: [{
            id: "inv_2",
            linkedin_profile_url: params[0],
            account: params[1],
            workflow_status: "discovered"
          }]
        };
      }
      return { rows: [] };
    }
  });

  assert.equal((await repository.findByProfileUrl("https://www.linkedin.com/in/jane-smith")).id, "inv_1");
  assert.equal((await repository.seedProfile({
    profileUrl: "https://www.linkedin.com/in/pat-lee",
    account: "ice"
  })).id, "inv_2");
  await repository.markManuallyQualified("inv_2");
  await repository.deleteInventoryRow("inv_1");

  assert.match(queries[0].sql, /lower\(linkedin_profile_url\) = lower\(\$1\)/i);
  assert.match(queries[1].sql, /insert into linkedin_connection_inventory/i);
  assert.match(queries[1].sql, /processing_source/i);
  assert.equal(queries[1].params[2], "process_profile");
  assert.match(queries[2].sql, /workflow_status = 'qualified'/i);
  assert.match(queries[3].sql, /delete from linkedin_connection_inventory/i);
});

function createMemorySingleProfileRepository(initialRows = []) {
  return {
    rows: initialRows.map((row) => ({ ...row })),
    deletedInventoryIds: [],
    nextId: 1,
    async findByProfileUrl(profileUrl) {
      return this.rows.find((row) => row.linkedinProfileUrl === profileUrl) ?? null;
    },
    async seedProfile({ profileUrl, account }) {
      const row = {
        id: `inventory-${this.nextId++}`,
        linkedinProfileUrl: profileUrl,
        account,
        processingSource: "process_profile",
        dedupeStatus: "dedupe_pending",
        workflowStatus: "discovered"
      };
      this.rows.push(row);
      return row;
    },
    async deleteInventoryRow(inventoryId) {
      this.deletedInventoryIds.push(inventoryId);
      this.rows = this.rows.filter((row) => row.id !== inventoryId);
      return { deleted: true };
    },
    async markManuallyQualified(inventoryId) {
      const row = this.rows.find((item) => item.id === inventoryId);
      if (row) row.workflowStatus = "qualified";
    }
  };
}
