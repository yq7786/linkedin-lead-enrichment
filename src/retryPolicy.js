const RETRYABLE_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"]);
const NEEDS_REVIEW_KINDS = new Set([
  "linkedin_checkpoint",
  "linkedin_login_expired",
  "captcha",
  "ambiguous_dedupe",
  "low_confidence"
]);

export function classifyWorkflowError(error) {
  if (NEEDS_REVIEW_KINDS.has(error?.kind)) return "needs_review";
  if (RETRYABLE_CODES.has(error?.code)) return "retryable";
  if (error?.httpStatus >= 500 && error?.httpStatus <= 599) return "retryable";
  if (error?.terminalSkip === true) return "terminal_skip";
  return "needs_review";
}

export function nextRetryAt(retryCount, base = new Date()) {
  const minutes = 5 * 2 ** Math.max(0, retryCount);
  return new Date(base.getTime() + minutes * 60 * 1000);
}
