const AUDIT_EVENTS = new Set([
  "draft_sent_to_portal",
  "portal_api_failed",
  "linkedin_extract_failed",
  "computer_use_fallback_failed",
  "company_extract_failed",
  "dedupe_ambiguous",
  "run_stopped_unexpectedly",
  "linkedin_session_blocked"
]);

export function shouldWriteAuditEvent(eventType) {
  return AUDIT_EVENTS.has(eventType);
}

export function buildAuditEvent(eventType, overrides = {}) {
  if (!shouldWriteAuditEvent(eventType)) return null;
  return {
    eventType,
    status: overrides.status ?? "recorded",
    message: overrides.message ?? eventType,
    metadataJson: overrides.metadataJson ?? {},
    runId: overrides.runId ?? null,
    individualId: overrides.individualId ?? null,
    inventoryId: overrides.inventoryId ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString()
  };
}
