# Troubleshooting

**LinkedIn login expired:** Stop the run. Ask the operator to run `login-linkedin`. Mark the item `failed_needs_review`.

**CAPTCHA / checkpoint / security screen:** Stop immediately. Do not retry automatically.

**Company website capture failure:** Run `npx playwright install chromium`, then retry `sync-company-websites`.

**Portal webhook failure:** 5xx and network errors are retryable; auth, 4xx, and contract failures are needs-review. `submit-qualified` records `last_error`, retry metadata, and a `portal_api_failed` audit event. Use `retry-failed` for retryable rows.

**Missing individual_id / company_id after submission:** Expected until the portal processes the candidate. The portal sets these fields on `linkedin_connection_inventory` after successful acceptance.
