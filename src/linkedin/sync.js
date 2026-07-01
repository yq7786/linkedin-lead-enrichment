import { normalizeLinkedInProfileUrl } from "../dedupe.js";

export function toInventoryRecord(connection) {
  return {
    linkedinProfileUrl: normalizeLinkedInProfileUrl(connection.linkedinProfileUrl),
    fullName: connection.fullName ?? null,
    headline: connection.headline ?? null,
    currentCompanyName: connection.currentCompanyName ?? null,
    currentCompanyUrl: connection.currentCompanyUrl ?? null,
    account: connection.account ?? null,
    processingSource: connection.processingSource ?? "connection_sync",
    dedupeStatus: "dedupe_pending",
    workflowStatus: "discovered"
  };
}
