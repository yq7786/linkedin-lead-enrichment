export function selectQueuedInventory(items, options = {}) {
  const limit = options.limit ?? options.defaultBatchLimit;
  return [...items]
    .filter((item) => item.workflowStatus === "queued" || item.workflow_status === "queued")
    .sort((a, b) => String(a.queuedAt ?? a.queued_at ?? "").localeCompare(String(b.queuedAt ?? b.queued_at ?? "")))
    .slice(0, limit);
}
