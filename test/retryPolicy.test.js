import test from "node:test";
import assert from "node:assert/strict";

import { classifyWorkflowError, nextRetryAt } from "../src/retryPolicy.js";

test("classifyWorkflowError treats network and 5xx failures as retryable", () => {
  assert.equal(classifyWorkflowError({ code: "ETIMEDOUT" }), "retryable");
  assert.equal(classifyWorkflowError({ httpStatus: 503 }), "retryable");
});

test("classifyWorkflowError treats LinkedIn checkpoints as needs_review", () => {
  assert.equal(classifyWorkflowError({ kind: "linkedin_checkpoint" }), "needs_review");
});

test("nextRetryAt schedules exponential-ish retry windows", () => {
  const base = new Date("2026-06-24T00:00:00Z");

  assert.equal(nextRetryAt(0, base).toISOString(), "2026-06-24T00:05:00.000Z");
  assert.equal(nextRetryAt(2, base).toISOString(), "2026-06-24T00:20:00.000Z");
});
