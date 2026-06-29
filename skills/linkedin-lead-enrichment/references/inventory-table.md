# Database tables

Schema lives in `sql/001_workflow_tables.sql`. Three workflow tables remain; five legacy tables were removed after enrichment moved into candidate files.

## Agent access

| Table | Agent access | Purpose |
| --- | --- | --- |
| `linkedin_connection_inventory` | Read + write | Queue, status, and connection metadata |
| `new_individual` | Read only | Dedupe match against existing contacts |
| `new_company` | Read only | Dedupe match against existing companies |
| `audit_events` | CLI writes; agent reads only | Portal submission success/failure history |
| `workflow_runs` | Read only | Run ledger (reserved; not populated by current CLI yet) |

Portal CRM column details: [portal-crm-tables.md](portal-crm-tables.md).

Enrichment evidence lives in `.lead-enrichment-candidates/*.md`, not in Neon.

## linkedin_connection_inventory

### Columns the agent sets locally

| Column | When |
| --- | --- |
| `linkedin_profile_url` | Connection sync |
| `full_name`, `headline`, `current_company_name`, `current_company_url` | Connection sync |
| `account` | Guided workflow connection sync; selected LinkedIn account such as `Kirk`, `Kathryn`, `Ice`, `Terri`, `Sarah`, `Siriluk`, or custom |
| `last_seen_at` | Connection sync |
| `dedupe_status`, `dedupe_match_method` | Dedupe step |
| `workflow_status`, `current_step` | Every workflow step |
| `queued_at`, `in_progress_at`, `completed_at`, `failed_at` | Step transitions |
| `retry_count`, `next_retry_at`, `last_error` | Failures and retries |

### Columns set by dedupe or portal

| Column | Source |
| --- | --- |
| `individual_id`, `company_id` | `dedupe-inventory` when name+company matches existing CRM, or portal after candidate submission |

Do not create portal CRM records locally outside these paths.

### Key statuses

**`dedupe_status`:** `dedupe_pending` → `matched_existing` | `not_found` (continue enrichment) | `needs_review`

**`workflow_status`:** `discovered` → `linkedin_extracted` → `company_captured` → (`deduped_existing` | continue) → `activity_captured` → `qualified` → `website_captured` → `submitted`

Use `inspect-status` to see all inventory counts by status. The guided workflow prints a final summary for only the profile URLs discovered in the current batch.

## audit_events

Written automatically by `submit-qualified` on portal success or failure. Read these when troubleshooting submission issues; do not insert audit rows manually.

Common `event_type` values: `candidate_submitted_to_portal`, `portal_api_failed`.

## workflow_runs

Reserved for future batch run tracking. Current CLI commands do not insert rows here yet; `inspect-status` may show an empty run summary until run logging is wired up.

## Removed legacy tables

These were dropped from the schema. They are not used by the current codebase:

- `connection_sync_runs` — sync metrics never wired up
- `lead_enrichment_snapshots` — replaced by candidate file JSON
- `linkedin_activity_items` — replaced by `activityCapture` in candidate files
- `lead_research_notes` — replaced by `fit` in candidate files
- `outreach_drafts` — owned by the portal after candidate submission
