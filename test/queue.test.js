import test from "node:test";
import assert from "node:assert/strict";

import { selectQueuedInventory } from "../src/queue.js";

test("selectQueuedInventory honors explicit limit", () => {
  const selected = selectQueuedInventory(
    [
      { id: "1", workflowStatus: "queued", queuedAt: "2026-06-24T00:00:00Z" },
      { id: "2", workflowStatus: "queued", queuedAt: "2026-06-24T00:01:00Z" },
      { id: "3", workflowStatus: "queued", queuedAt: "2026-06-24T00:02:00Z" }
    ],
    { limit: 2, defaultBatchLimit: 10 }
  );

  assert.deepEqual(
    selected.map((item) => item.id),
    ["1", "2"]
  );
});

test("selectQueuedInventory uses default batch limit when no explicit limit is provided", () => {
  const selected = selectQueuedInventory(
    [
      { id: "1", workflowStatus: "queued", queuedAt: "2026-06-24T00:00:00Z" },
      { id: "2", workflowStatus: "queued", queuedAt: "2026-06-24T00:01:00Z" }
    ],
    { defaultBatchLimit: 1 }
  );

  assert.deepEqual(
    selected.map((item) => item.id),
    ["1"]
  );
});
