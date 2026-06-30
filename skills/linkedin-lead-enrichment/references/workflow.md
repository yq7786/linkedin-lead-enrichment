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

`dedupe-inventory` runs after `sync-company-profiles` because CRM matching requires a reliable `current_company_name`, which profile sync alone may not provide.

## Step summary

| Step | Selects | Writes to |
| --- | --- | --- |
| `sync-connections` | Existing `discovered` + `dedupe_pending`, then LinkedIn top-up if needed | `linkedin_connection_inventory` (`discovered`, `dedupe_pending`) |
| `process-queue` | `discovered` + `dedupe_pending` | Candidate file + `linkedin_extracted` |
| `sync-company-profiles` | `linkedin_extracted` + `dedupe_pending` | Candidate file + `company_captured` |
| `dedupe-inventory` | `company_captured` + `dedupe_pending` | Inventory CRM link or `dedupe_cleared_for_enrichment` |
| `sync-activities` | `company_captured` + `not_found` | Candidate file + `activity_captured` |
| `score-fits` | Candidate files (`profile_captured`, `company_captured`, `activity_captured`) | Candidate file + `qualified` / `skipped_not_fit` |
| `sync-company-websites` | `qualified` candidates only | Candidate file + `website_captured` |
| `submit-qualified` | `website_captured` candidates | Portal webhook + `submitted` |
| Final status summary | Selected batch profile URLs | Counts grouped by `linkedin_connection_inventory.workflow_status` |

## Dedupe outcomes

| Result | Next steps |
| --- | --- |
| CRM match (`deduped_existing`) | Stop — already in portal |
| No match (`dedupe_status = not_found`) | Continue with `sync-activities` → scoring |
| Ambiguous match (`failed_needs_review`) | Stop — operator review |

Enrichment evidence lives in `.lead-enrichment-candidates/*.md`. The fenced JSON block at the top is the source of truth.

`--limit N` means up to N eligible workflow items, not N visible LinkedIn cards. `sync-connections` first selects existing `discovered` + `dedupe_pending` rows, then scans LinkedIn only enough to top up the batch. Manual command behavior processes all eligible rows per step unless `--limit N` caps the batch size. The guided workflow filters downstream steps to the selected batch profile URLs.
