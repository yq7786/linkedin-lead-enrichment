import test from "node:test";
import assert from "node:assert/strict";

import { buildAuditEvent, shouldWriteAuditEvent } from "../src/auditPolicy.js";

test("shouldWriteAuditEvent writes only draft success and meaningful errors", () => {
  assert.equal(shouldWriteAuditEvent("draft_sent_to_portal"), true);
  assert.equal(shouldWriteAuditEvent("portal_api_failed"), true);
  assert.equal(shouldWriteAuditEvent("linkedin_extract_failed"), true);
  assert.equal(shouldWriteAuditEvent("current_step_updated"), false);
  assert.equal(shouldWriteAuditEvent("linkedin_profile_opened"), false);
});

test("buildAuditEvent stores portal contact references as individualId", () => {
  const event = buildAuditEvent("draft_sent_to_portal", {
    individualId: 123,
    inventoryId: "inventory_1"
  });

  assert.equal(event.individualId, 123);
  assert.equal(Object.hasOwn(event, "leadId"), false);
});
