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
   - LinkedIn account: `kirk`, `kathryb`, `terri`, `sarah`, `ice`, `siriluk`, or a custom account name (stored in `linkedin_connection_inventory.account`)
   - Number of connections to process — warn that processing too many connections at once might hit LinkedIn usage limits or paid API limits
2. Write `.env` with the four env keys.
3. Run:

```bash
npm run guided-workflow -- --account <account> --limit <N>
```

For skill optimization or local testing (skips portal submission):

```bash
npm run guided-workflow -- --account <account> --limit <N> --skip-finalization
```

When `.env` is complete and `--account` / `--limit` are passed, the CLI skips interactive prompts.

### B. Interactive terminal

Run `npm run guided-workflow` and answer the built-in prompts (bulk env paste or one-by-one, then account, then limit with usage-limit warning).

## Workflow guarantees

- Steps run **sequentially** in the order in [workflow.md](workflow.md).
- One **persistent** Playwright browser context stays open from the first browser-backed step through the last; it is only closed after all steps finish or the run fails.
- Do not run individual browser-backed CLI commands between guided steps — that would open and close separate browser sessions.

## Preflight

```bash
npm install
npx playwright install chromium
psql "$DATABASE_URL" -f sql/001_workflow_tables.sql
npm run login-linkedin   # first run on a new machine/profile only
node src/cli.js check-config --dry-run
```
