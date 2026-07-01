# Troubleshooting

**LinkedIn login expired:** For guided runs, keep the persistent browser open and wait for the operator to finish login before Step 1. For manual command debugging, run `npm run login-linkedin`; it waits for a ready session and only closes the browser after login succeeds or the login wait times out.

**CAPTCHA / checkpoint / security screen:** Stop automated LinkedIn actions immediately, but keep the browser open so the operator can clear the challenge manually. Do not close/reopen the browser, retry automatically, or probe additional LinkedIn pages while the challenge is visible. Keep waiting on the same browser session until the challenge is cleared.

**Company website capture failure:** Run `npm run setup-project`, then retry `sync-company-websites`.

**Portal webhook failure:** 5xx and network errors are retryable; auth, 4xx, and contract failures are needs-review. `submit-qualified` records `last_error`, retry metadata, and a `portal_api_failed` audit event. Use `retry-failed` for retryable rows.

**Missing individual_id / company_id after submission:** Expected until the portal processes the candidate. The portal sets these fields on `linkedin_connection_inventory` after successful acceptance.

**Single profile already exists:** `process-profile` checks `linkedin_connection_inventory` for the normalized LinkedIn profile URL before browser work. Stop and ask the user: "Should I re-process the provided lead, or skip processing it?" Skip makes no changes. Re-process deletes only the matching candidate markdown file and only the matching inventory row, then processes that one profile again. This duplicate re-process branch is the only approved AI deletion case.
