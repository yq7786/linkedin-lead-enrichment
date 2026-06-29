import test from "node:test";
import assert from "node:assert/strict";

import { inspectWorkflowStatus } from "../src/workflow/inspectStatus.js";

test("inspectWorkflowStatus summarizes workflow and inventory counts", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("from workflow_runs")) {
        return { rows: [{ status: "completed", count: "2" }] };
      }
      if (sql.includes("group by workflow_status")) {
        return {
          rows: [
            { status: "discovered", count: "3" },
            { status: "failed_retryable", count: "1" }
          ]
        };
      }
      if (sql.includes("workflow_status = 'discovered'")) {
        return { rows: [{ count: "3" }] };
      }
      if (sql.includes("workflow_status = 'failed_retryable'")) {
        return { rows: [{ count: "1" }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  assert.deepEqual(await inspectWorkflowStatus(client), {
    workflowRuns: { completed: 2 },
    inventoryStatuses: { discovered: 3, failed_retryable: 1 },
    pendingProfileCapture: 3,
    retryableDue: 1
  });
  assert.equal(calls.length, 4);
});
