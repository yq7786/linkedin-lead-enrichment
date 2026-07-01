# Operator Run

Use this reference when starting a live or test enrichment run.

## Two ways to collect inputs

### A. Agent or operator in chat (recommended for Codex/Cursor)

Collect configuration in chat, then run the CLI without duplicate prompts.

1. Offer to paste all env values at once as `KEY=value` lines, or ask for missing values **one at a time** in this order:
   - `DATABASE_URL`
   - `OPENAI_API_KEY`
   - `PORTAL_QUALIFIED_INGEST_URL`
   - `PORTAL_CALLBACK_SECRET`
   - LinkedIn account: `kirk`, `kathryn`, `terri`, `sarah`, `ice`, `siriluk`, or a custom account name (stored in `linkedin_connection_inventory.account`)
   - Number of eligible workflow items to process — warn that processing too many connections at once might hit LinkedIn usage limits or paid API limits
2. Write `.env` with the four env keys plus `LINKEDIN_ACCOUNT=<account>`.
3. Run:

```bash
npm run guided-workflow -- --account <account> --limit <N>
```

For skill optimization or local testing (skips portal submission):

```bash
npm run guided-workflow -- --account <account> --limit <N> --skip-finalization
```

When `.env` is complete and `--account` / `--limit` are passed, the CLI skips interactive prompts. Guided workflow also persists `LINKEDIN_ACCOUNT` so later single-profile runs can use the same LinkedIn account without another flag.

`--limit N` means up to N useful workflow items. The default batch size is 50. If N is greater than 50, `guided-workflow` runs sequential batches of 50 until it reaches N or LinkedIn stops yielding new eligible rows.

Within each batch, existing `discovered` + `dedupe_pending` inventory rows are selected first, and LinkedIn connection scanning only tops up that batch when there are fewer than the batch cap already waiting. If the `sync-connections` summary returns `batchSize` lower than `requested` with `exhausted = true`, the current scanner stopped after LinkedIn stopped yielding additional unseen cards.

Never call a partial batch complete unless `exhausted = true`, LinkedIn shows a blocker, or a downstream hard failure stopped the workflow. If `batchSize < requested` and `exhausted` is not true, continue the guided top-up for the remaining count or report the run as partial. Use the summary fields `remaining` and `scanAttempts` to explain what happened.

### B. Interactive terminal

Run `npm run guided-workflow` and answer the built-in prompts (bulk env paste or one-by-one, then account, then limit with usage-limit warning).

## Single-profile runs

When the user provides one LinkedIn profile URL, asks to process a single connection, or asks to process one lead, run:

```bash
npm run process-profile -- --profile-url <linkedin-profile-url>
```

This mode reads `LINKEDIN_ACCOUNT` from `.env`, checks for an existing `linkedin_connection_inventory` row with the same normalized profile URL, skips `sync-connections`, skips `score-fits`, manually qualifies the candidate after dedupe clears, and submits to the portal by default.

If a duplicate inventory row exists, stop and ask the user: "This lead already exists in the workflow inventory. What would you like me to do? Re-process — delete only this lead's existing candidate file/inventory record, then process it fresh. Skip — leave the existing record untouched." Re-processing deletes only the matching candidate markdown file and only the matching inventory row before recreating the row and processing it again. This duplicate re-process branch is the only approved AI deletion case.

Use `--skip-finalization` only for testing when the user explicitly does not want portal submission.

## Workflow guarantees

- Steps run **sequentially** in the order in [workflow.md](workflow.md).
- One **persistent** Playwright browser context stays open from the first browser-backed step through the last; it is only closed after all steps finish or the run fails.
- Do not run individual browser-backed CLI commands between guided steps — that would open and close separate browser sessions.

## Preflight

```bash
npm run setup-project
node src/cli.js check-config --dry-run
```

Do not require a separate `npm run login-linkedin` preflight. If LinkedIn is not logged in or shows a checkpoint, `guided-workflow` opens the persistent browser profile and waits for the user to finish login or clear the challenge before Step 1. Keep the browser open; do not close/reopen it while the user is handling LinkedIn.
