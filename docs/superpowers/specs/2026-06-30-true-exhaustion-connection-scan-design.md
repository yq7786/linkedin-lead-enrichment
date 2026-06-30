# True Exhaustion Connection Scan Design

## Goal

Make `sync-connections --limit N` and `guided-workflow --limit N` keep scanning LinkedIn until they either:

1. find `N` useful rows to process, or
2. reach the true end of the LinkedIn connections list.

The current behavior can stop too early when the first visible LinkedIn cards are mostly already known or already processed. In that case, the workflow may discover only a few new rows and incorrectly report exhaustion even though additional unseen rows exist further down the list.

## Problem Statement

Today the batch builder already excludes previously processed inventory rows from the selected batch. That part is correct.

The failure is in top-up discovery:

- The extractor is optimized around loading roughly `remaining` visible cards.
- Many of those cards can map to already-known inventory rows.
- When that happens, the top-up step can return too few useful rows.
- The workflow can then report `exhausted: true` before proving that LinkedIn has no more cards to reveal.

This creates a mismatch between requested batch size and actual useful capacity. Example:

- Database has 7 previously processed rows.
- Operator requests 30 connections.
- Backlog selection correctly ignores those 7 processed rows.
- LinkedIn scan reveals 3 new rows near the top, but most visible cards are already known.
- Workflow stops at 3 instead of continuing to scroll for more unseen rows.

## Approved Semantics

`--limit N` means:

> Prepare up to `N` useful, unprocessed workflow rows.

Rules:

1. Select existing eligible backlog rows first.
2. Previously processed rows do not count toward `N`.
3. If backlog rows are fewer than `N`, keep scanning LinkedIn until either:
   - `N` useful rows are found, or
   - the page has stopped yielding additional connection cards.
4. Do not declare exhaustion just because newly revealed cards are already known or already processed.
5. Declare exhaustion only after the page itself appears exhausted.

## Scope

In scope:

- `sync-connections --limit N`
- `guided-workflow --limit N`
- LinkedIn top-up scanning behavior
- Exhaustion semantics and summaries
- Tests and workflow documentation

Out of scope:

- Changing which workflow statuses count as existing eligible backlog
- Re-queueing already processed rows
- Changing downstream step eligibility rules
- Any CRM or scoring rule changes

## Existing Backlog Semantics

The existing backlog-first rule remains unchanged:

```sql
workflow_status = 'discovered'
and dedupe_status = 'dedupe_pending'
```

This means:

- pending discovered rows are resumed first
- already processed rows are excluded
- later-stage rows such as `linkedin_extracted`, `company_captured`, `submitted`, `skipped_not_fit`, or failed/review states do not count toward the new batch request

This design intentionally does not broaden backlog eligibility. The fix is about scanning deeper for new useful rows, not reusing processed rows.

## Required Behavior Change

### Before

The scanner can stop after it has loaded enough visible cards to satisfy a raw extraction target, even if most of those cards are already known inventory rows.

### After

The scanner must continue while the LinkedIn page is still revealing additional connection cards, regardless of whether the newly revealed cards are useful.

The scanner stops only when one of these is true:

1. the batch builder has collected `N` useful rows
2. the page has stopped growing across several stable scroll/read passes
3. a LinkedIn blocker or hard error interrupts the scan

## Definition Of “True Exhaustion”

`exhausted: true` means:

> The workflow attempted to reveal more LinkedIn connection cards and the page stopped yielding additional normalized profile URLs across the configured stability threshold.

This is a page-growth concept, not a useful-row-yield concept.

Examples:

- If 40 additional cards appear but all 40 are already processed, that is **not** exhaustion yet.
- If repeated scroll passes reveal no additional cards at all, that **is** exhaustion.

## Proposed Architecture

### Separation Of Responsibilities

Keep the extractor and the batch builder distinct:

- extractor responsibility: reveal and normalize as many connection cards as the page can currently provide within bounded scanning rules
- batch builder responsibility: determine which revealed cards are useful after filtering against inventory

This avoids mixing “page growth” with “inventory usefulness.”

### Extractor Contract

The LinkedIn extractor should support scanning deeper than the remaining useful-row count.

Expected behavior:

1. read currently visible connection cards
2. normalize and deduplicate by profile URL
3. scroll
4. read again
5. track whether normalized card count increased
6. continue until:
   - the requested scan depth is reached, or
   - the page stops growing for the configured stability threshold

Important:

- the extractor must not stop merely because it has reached `remaining` visible cards
- the extractor should measure progress using normalized unique profile URLs

### Batch Builder Contract

The batch builder should:

1. select existing eligible backlog rows
2. compute remaining capacity
3. if remaining capacity is positive, scan LinkedIn for additional cards
4. compare extracted profile URLs against known inventory rows
5. keep only new, unseen rows for top-up
6. continue scanning deeper until:
   - enough useful rows are found, or
   - true exhaustion is proven

## Scanning Strategy

Recommended strategy:

1. Start with existing eligible backlog rows.
2. If remaining capacity is `R`, begin a top-up scan with an overfetch window larger than `R`.
3. After each extraction pass:
   - collect normalized URLs
   - filter against known inventory URLs
   - count newly useful rows
4. If useful row count is still below `R`, keep scrolling as long as total normalized URL count is still increasing.
5. Mark exhaustion only after several consecutive passes with no increase in total normalized URL count.

This means the scan adapts to pages with many already-known rows near the top.

## Boundedness And Safety

The scanner should still be bounded so it does not loop forever.

Recommended guards:

- maximum total scroll passes
- stability threshold for “no page growth”
- blocker detection and timeout handling already used by the LinkedIn browser utilities

Preferred stop order:

1. useful-row target reached
2. page-growth exhaustion proven
3. hard cap reached
4. blocker/error

If a hard cap is reached before target or true exhaustion, do **not** report `exhausted: true`. Return a partial batch with `exhausted: false` so guided workflow retry logic can decide whether to attempt another pass.

## Guided Workflow Semantics

Guided workflow should keep its current partial-batch retry behavior, but it should benefit from more accurate exhaustion reporting.

Expected outcomes:

- If `sync-connections` returns fewer than requested rows and `exhausted: false`, guided workflow should retry the remaining amount.
- If `sync-connections` returns fewer than requested rows and `exhausted: true`, guided workflow should stop and report a partial run because the connection list was truly exhausted.

This preserves the current control flow while making the sync step more trustworthy.

## Output Summary Changes

The summary shape can remain the same, but `exhausted` must use the new meaning.

Expected interpretation:

```json
{
  "summary": {
    "requested": 30,
    "batchSize": 12,
    "existingSelected": 0,
    "discovered": 12,
    "remaining": 18,
    "exhausted": true,
    "scanAttempts": 4
  }
}
```

This means:

- 12 useful rows were found
- the workflow still needed 18 more
- the LinkedIn page stopped yielding additional cards, so the list was truly exhausted for this run

## Implementation Notes

Implementation should prefer these changes:

1. update the page extractor so it can continue gathering additional normalized cards beyond the immediate remaining count
2. make exhaustion depend on observed page growth, not discovered useful-row count
3. preserve DB filtering against known inventory URLs before selecting top-up rows
4. preserve current backlog-first semantics
5. keep guided workflow retry behavior unchanged unless testing reveals a necessary adjustment

## Testing

Add or update tests for:

1. Existing eligible backlog rows fully satisfy the limit and skip LinkedIn scanning.
2. Processed/known rows near the top do not consume the useful-row target.
3. The scanner continues when the page grows but newly revealed cards are all already known.
4. The scanner stops with `exhausted: true` only after repeated passes with no page growth.
5. A hard cap or bounded retry stop returns partial results with `exhausted: false`.
6. Guided workflow retries partial syncs when exhaustion is not proven.
7. Guided workflow stops on partial syncs when true exhaustion is proven.

Representative scenario to cover:

- request 30
- top of LinkedIn list contains mostly already processed profiles
- deeper scroll reveals additional unseen profiles
- final batch reaches 30 without falsely reporting exhaustion

Run:

```bash
node --test test/linkedinSync.test.js test/guidedWorkflow.test.js
npm test
```

## Documentation Updates

Update:

- `skills/linkedin-lead-enrichment/references/workflow.md`
- `skills/linkedin-lead-enrichment/references/operator-run.md`
- CLI help text for `sync-connections`

Documentation should clearly state:

- `N` means useful rows, not visible cards
- processed rows do not count toward `N`
- exhaustion means LinkedIn stopped revealing more cards, not merely that visible rows were already known

## Non-Goals

This design does not:

- reprocess completed rows
- expand backlog eligibility beyond `discovered + dedupe_pending`
- guarantee that every run reaches `N` if LinkedIn truly has fewer unseen rows available
- change scoring, dedupe, company sync, activity sync, or submission semantics

## Success Criteria

The design is successful when:

1. Requesting `N` connections processes `N` useful rows whenever at least `N` unseen or pending rows exist across backlog plus deeper LinkedIn scanning.
2. The workflow no longer stops early just because early visible cards were already processed.
3. `exhausted: true` is only reported after the LinkedIn page has truly stopped yielding additional connection cards.
