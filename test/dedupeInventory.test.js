import test from "node:test";
import assert from "node:assert/strict";

import {
  DedupeInventoryRepository,
  dedupeInventory,
  toDedupeCandidate
} from "../src/workflow/dedupeInventory.js";

test("toDedupeCandidate splits full name and carries company fields", () => {
  assert.deepEqual(
    toDedupeCandidate({
      id: "inventory_1",
      fullName: "Jane Mary Smith",
      currentCompanyName: "Acme AI",
      linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith"
    }),
    {
      inventoryId: "inventory_1",
      firstName: "Jane",
      lastName: "Mary Smith",
      currentCompanyName: "Acme AI",
      linkedinLink: "https://www.linkedin.com/in/jane-smith"
    }
  );
});

test("dedupeInventory dry-run reports actions without mutating inventory", async () => {
  const writes = [];
  const result = await dedupeInventory({
    inventoryRepository: {
      listPending: async () => [
        {
          id: "inventory_1",
          fullName: "Jane Smith",
          currentCompanyName: null,
          linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith"
        }
      ],
      listIndividualMatches: async () => [],
      markQueued: async (...args) => writes.push(["queued", args])
    },
    dryRun: true
  });

  assert.deepEqual(result.summary, { queued: 1, matchedExisting: 0, needsReview: 0 });
  assert.equal(result.items[0].action, "queue");
  assert.deepEqual(writes, []);
});

test("dedupeInventory queues unmatched candidates in live mode", async () => {
  const writes = [];
  const result = await dedupeInventory({
    inventoryRepository: {
      listPending: async () => [
        {
          id: "inventory_1",
          fullName: "Jane Smith",
          currentCompanyName: null,
          linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith"
        }
      ],
      listIndividualMatches: async () => [],
      markQueued: async (id) => writes.push(["queued", id])
    }
  });

  assert.deepEqual(result.summary, { queued: 1, matchedExisting: 0, needsReview: 0 });
  assert.deepEqual(writes, [["queued", "inventory_1"]]);
});

test("dedupeInventory links exact name and company matches", async () => {
  const writes = [];
  const result = await dedupeInventory({
    inventoryRepository: {
      listPending: async () => [
        {
          id: "inventory_1",
          fullName: "Jane Smith",
          currentCompanyName: "Acme AI",
          linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith"
        }
      ],
      listIndividualMatches: async () => [
        { id: 10, companyId: 20, firstName: "Jane", lastName: "Smith", companyName: "Acme AI" }
      ],
      markMatchedExisting: async (id, match) => writes.push(["matched", id, match])
    }
  });

  assert.deepEqual(result.summary, { queued: 0, matchedExisting: 1, needsReview: 0 });
  assert.deepEqual(writes, [
    ["matched", "inventory_1", { individualId: 10, companyId: 20, strategy: "name_company" }]
  ]);
});

test("dedupeInventory marks ambiguous name and company matches for review", async () => {
  const writes = [];
  const result = await dedupeInventory({
    inventoryRepository: {
      listPending: async () => [
        {
          id: "inventory_1",
          fullName: "Jane Smith",
          currentCompanyName: "Acme AI",
          linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith"
        }
      ],
      listIndividualMatches: async () => [
        { id: 10, firstName: "Jane", lastName: "Smith", companyName: "Acme AI" },
        { id: 11, firstName: "Jane", lastName: "Smith", companyName: "Acme AI" }
      ],
      markNeedsReview: async (id, strategy) => writes.push(["review", id, strategy])
    }
  });

  assert.deepEqual(result.summary, { queued: 0, matchedExisting: 0, needsReview: 1 });
  assert.deepEqual(writes, [["review", "inventory_1", "name_company"]]);
});

test("DedupeInventoryRepository lists pending rows and updates queue state", async () => {
  const queries = [];
  const repository = new DedupeInventoryRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("from linkedin_connection_inventory")) {
        return { rows: [{ id: "inventory_1" }] };
      }
      return { rowCount: 1, rows: [] };
    }
  });

  assert.deepEqual(await repository.listPending({ limit: 5 }), [{ id: "inventory_1" }]);
  await repository.markQueued("inventory_1");

  assert.match(queries[0].sql, /workflow_status = 'company_captured'/);
  assert.match(queries[0].sql, /dedupe_status = 'dedupe_pending'/);
  assert.deepEqual(queries[0].params, [5]);
  assert.match(queries[1].sql, /dedupe_status = 'not_found'/);
  assert.match(queries[1].sql, /cleared_for_enrichment/);
  assert.deepEqual(queries[1].params, ["inventory_1"]);
});
