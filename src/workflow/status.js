export const WorkflowStatus = Object.freeze({
  discovered: "discovered",
  dedupePending: "dedupe_pending",
  dedupedExisting: "deduped_existing",
  queued: "queued",
  inProgress: "in_progress",
  linkedInExtracted: "linkedin_extracted",
  companyExtracted: "company_extracted",
  websiteCaptured: "website_captured",
  qualified: "qualified",
  submitted: "submitted",
  draftCreated: "draft_created",
  draftSentToPortal: "draft_sent_to_portal",
  completed: "completed",
  failedRetryable: "failed_retryable",
  failedNeedsReview: "failed_needs_review",
  skippedNotFit: "skipped_not_fit"
});
