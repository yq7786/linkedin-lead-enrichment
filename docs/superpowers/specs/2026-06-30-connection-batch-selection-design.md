# Connection Batch Selection Design

## Goal

Make `--limit N` mean "prepare up to N useful, unprocessed connection work items" for both manual `sync-connections` and `guided-workflow`.

Today `sync-connections --limit N` scrapes the first N visible LinkedIn connection cards. Existing or already-processed profiles can consume the whole limit, leaving no useful work for downstream enrichment. The new behavior should drain pending database work first, then scan LinkedIn only enough to top up the batch.

## Scope

In scope:

- Manual `sync-connections --limit N`.
- `guided-workflow --limit N`.
- Selection of existing pending inventory rows.
- Top-up discovery from LinkedIn connection cards.
- Output summaries that distinguish existing selected rows from newly discovered rows.
- Tests and workflow documentation for the new semantics.

Out of scope:

- Changing downstream step eligibility rules beyond using the selected batch.
- Resetting processed, skipped, submitted, failed, or review rows.
- Changing CRM dedupe semantics.
- Changing the shape of candidate files.

## Semantics

`--limit N` selects a batch of at most N profile URLs that are eligible to continue enrichment.

A row is eligible when:

```sql
workflow_status = 'discovered'
and dedupe_status = 'dedupe_pending'
```

Selection order for existing rows:

```sql
order by queued_at asc nulls last, discovered_at asc
```

Batch building:

1. Select existing eligible rows from `linkedin_connection_inventory`.
2. If at least N rows exist, use the first N and skip LinkedIn scraping.
3. If fewer than N rows exist, scrape LinkedIn connections to discover enough new profile URLs to fill the remaining slots.
4. Existing inventory profiles that are already processed, skipped, submitted, failed, or in review do not consume the requested N.
5. Newly discovered rows are upserted with the current default inventory state: `workflow_status = 'discovered'` and `dedupe_status = 'dedupe_pending'`.
6. The final batch is the existing eligible rows plus newly discovered eligible rows, capped at N.

## Manual Command Behavior

`npm run sync-connections -- --limit N` becomes a batch-preparation command.

Expected live behavior:

- Query existing eligible rows.
- Scrape LinkedIn only when existing eligible rows are fewer than N.
- Upsert only newly discovered profiles needed to top up the batch.
- Return the selected batch and a summary.

Expected dry-run behavior:

- Query existing eligible rows. This command now requires database config even in dry-run mode because useful-batch semantics depend on current inventory state.
- Scrape LinkedIn only when needed to estimate the top-up.
- Report what would be selected and discovered without writing to the database.

The output summary must include:

```json
{
  "status": "synced",
  "summary": {
    "batchSize": 10,
    "existingSelected": 7,
    "discovered": 3,
    "upserted": 3
  },
  "connections": []
}
```

Definitions:

- `batchSize`: final selected batch size.
- `existingSelected`: eligible database rows selected before LinkedIn scanning.
- `discovered`: new LinkedIn profiles selected for top-up.
- `upserted`: new profiles written to inventory; in dry-run this is 0.

## Guided Workflow Behavior

`npm run guided-workflow -- --limit N` uses the same batch builder as manual `sync-connections`.

Step 1 becomes "prepare connection batch":

- Select existing eligible rows.
- Top up from LinkedIn only if needed.
- Return the exact batch profile URLs and inventory IDs.

All downstream guided steps must continue to receive the selected profile URLs or inventory IDs so the run only processes that batch. This preserves the existing guided-workflow isolation guarantee while making the first step more useful.

## Components

### Batch Repository Methods

Add repository behavior near `ConnectionInventoryRepository`:

- `listEligibleForEnrichment({ limit, account })`
- `findByProfileUrls(profileUrls)`

When an account is provided, eligible existing rows must match that account exactly. Manual `sync-connections` without an account should not apply an account filter.

### Batch Builder

Add a workflow-level helper near `syncLinkedInConnections` that:

- Accepts `limit`, `account`, `extractConnections`, and `inventoryRepository`.
- Selects existing eligible rows first.
- Computes remaining capacity.
- Calls `extractConnections({ limit: remainingCapacity, excludeProfileUrls })` or equivalent only when remaining capacity is positive.
- Filters extracted records against known inventory profile URLs so already-processed rows do not consume capacity.
- Upserts the top-up records in live mode.
- Returns `connections`, `profileUrls`, and a summary.

### LinkedIn Extraction

The browser extractor may need to scan more than `remainingCapacity` visible cards to find enough new profiles, because some visible cards may already exist in inventory. Keep this bounded:

- Fetch up to `remainingCapacity * 4` raw LinkedIn anchors per extraction pass, matching the current extractor's over-fetch behavior.
- Deduplicate by normalized profile URL.
- Stop once the top-up capacity is filled or visible cards are exhausted.

## Error Handling

- If the database query fails, fail the sync step. Existing DB state is required to know whether a profile is useful.
- If LinkedIn is blocked or login expires during top-up discovery, use the existing blocker handling.
- If no existing eligible rows and no new rows are found, return an empty successful batch rather than treating it as an error.
- If upsert partially fails, surface the error and do not continue guided downstream steps.

## Testing

Add or update unit tests for:

- Existing eligible rows fill the limit and prevent LinkedIn extraction.
- Existing eligible rows partially fill the limit and LinkedIn discovery tops up the remainder.
- Already-known processed/submitted/skipped rows from LinkedIn extraction do not consume top-up capacity.
- Dry-run reports the planned batch without calling `upsertMany`.
- Guided workflow passes the selected batch profile URLs to downstream steps.
- Manual `sync-connections --limit N` reports `existingSelected`, `discovered`, and `batchSize`.

Run:

```bash
node --test test/linkedinSync.test.js test/guidedWorkflow.test.js
npm test
```

## Documentation

Update:

- `skills/linkedin-lead-enrichment/references/workflow.md`
- `skills/linkedin-lead-enrichment/references/operator-run.md`
- CLI help text for `sync-connections`

The documentation should say that `--limit N` means up to N eligible workflow items, not N visible LinkedIn cards.
