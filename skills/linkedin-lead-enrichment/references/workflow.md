# Workflow

```text
check-config
sync-connections
process-queue
sync-company-profiles
dedupe-inventory
sync-activities
score-fits
sync-company-websites
submit-qualified
final status summary
```

Use `npm run guided-workflow` for live operator runs. Pass `--account` and `--limit` after writing `.env` to skip duplicate prompts when the agent already collected inputs in chat.

Use `npm run guided-workflow -- --skip-finalization` only for skill optimization, local testing, or dry rehearsals that must stop before portal submission. This mode still runs the browser-backed workflow sequentially with one persistent browser context, then stops after `sync-company-websites` and skips `submit-qualified` plus the final status summary.

`dedupe-inventory` runs after `process-queue` and `sync-company-profiles` because CRM matching requires a reliable `current_company_name`. `process-queue` derives it from the LinkedIn Experience details page, then `sync-company-profiles` can correct it from the company page `h1`.

## Step summary

| Step | Selects | Writes to |
| --- | --- | --- |
| `sync-connections` | Existing `discovered` + `dedupe_pending`, then LinkedIn top-up if needed | `linkedin_connection_inventory` (`discovered`, `dedupe_pending`) |
| `process-queue` | `discovered` + `dedupe_pending` | Candidate file + `linkedin_extracted` |
| `sync-company-profiles` | `linkedin_extracted` + `dedupe_pending` | Candidate file + `company_captured` |
| `dedupe-inventory` | `company_captured` + `dedupe_pending` | Inventory CRM link or `dedupe_cleared_for_enrichment` |
| `sync-activities` | `company_captured` + `not_found` | Candidate file + `activity_captured` |
| `score-fits` | Candidate files (`profile_captured`, `company_captured`, `activity_captured`) | Candidate file + `qualified` / `skipped_not_fit` |
| `sync-company-websites` | `qualified` candidates only | Candidate file + `website_captured` when capture succeeds |
| `submit-qualified` | `qualified` + `website_captured` candidates | Portal webhook + `submitted` |
| Final status summary | Selected batch profile URLs | Counts grouped by `linkedin_connection_inventory.workflow_status` |

## Dedupe outcomes

| Result | Next steps |
| --- | --- |
| CRM match (`deduped_existing`) | Stop — already in portal |
| No match (`dedupe_status = not_found`) | Continue with `sync-activities` → scoring |
| Ambiguous match (`failed_needs_review`) | Stop — operator review |

Enrichment evidence lives in `.lead-enrichment-candidates/*.md`. The fenced JSON block at the top is the source of truth.

`--limit N` means up to N eligible workflow items, not N visible LinkedIn cards. The default guided batch size is 50; requests above 50 are split into sequential batches of 50 plus a final remainder batch. Within each batch, `sync-connections` first selects existing `discovered` + `dedupe_pending` rows, then scans LinkedIn only enough to top up that batch to its requested cap. Manual command behavior processes all eligible rows per step unless `--limit N` caps the batch size. The guided workflow filters downstream steps to each selected batch's profile URLs.

The `sync-connections` summary reports `requested`, `batchSize`, `existingSelected`, `discovered`, `upserted`, `remaining`, `exhausted`, and `scanAttempts`. If `batchSize < requested` and `exhausted = true`, the scanner stopped after the LinkedIn connection list stopped yielding new cards; that means the current scanner could not find enough additional eligible rows, not necessarily that the account has no more connections.

Do not treat a partial sync batch as complete unless `exhausted = true`, LinkedIn shows a blocker, or a downstream hard failure stops the workflow. If `batchSize < requested` and `exhausted` is not true, the guided workflow must continue trying to top up the remaining count, bounded by its partial-sync retry limit, or explicitly report the run as partial.

## Single-profile workflow

Use `npm run process-profile -- --profile-url <linkedin-profile-url>` when the user provides one LinkedIn profile URL, asks to process a single connection, or asks to process one lead.

Single-profile mode is separate from the batch workflow:

```text
check-config / load .env
read LINKEDIN_ACCOUNT
check linkedin_connection_inventory duplicate by normalized profile URL
process-queue
sync-company-profiles
dedupe-inventory
sync-activities
manual single-profile qualification
sync-company-websites
submit-qualified
single profile status summary
```

Do not run `sync-connections` in this mode. Do not run `score-fits` in this mode. The user-supplied profile is treated as operator-trusted and receives a manual `fit` block after dedupe clears.

Before opening LinkedIn, `process-profile` checks for an existing inventory row with the same normalized profile URL. If one exists, ask the user whether to re-process or skip. Skip exits with no changes. Re-process deletes only the matching candidate markdown file and only the matching inventory row, then recreates that row for the supplied profile URL. This duplicate re-process branch is the only approved AI deletion case.

Portal submission runs by default. Use `--skip-finalization` only for explicit testing runs that should stop before portal submission.
