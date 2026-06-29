---
name: linkedin-lead-enrichment
description: "Operate and troubleshoot the local LinkedIn lead enrichment workflow: sync LinkedIn connections, dedupe against portal CRM, capture LinkedIn profile/company/activity/website evidence into candidate files, score fit, submit qualified candidates to the portal webhook, inspect status, and retry failures. Use when running commands like sync-connections, process-queue, sync-company-profiles, dedupe-inventory, sync-activities, score-fits, sync-company-websites, submit-qualified, inspect-status, retry-failed, or debugging candidate files, workflow statuses, portal submission, LinkedIn capture, or enrichment data quality."
---

# LinkedIn Lead Enrichment

## Rules

- Never send LinkedIn DMs directly.
- Submit qualified candidates through the portal qualified-ingest webhook; the portal owns CRM persistence, draft generation, and the approval queue.
- Use Playwright for LinkedIn and company website capture.
- Treat Neon as a workflow control plane. Do not create, update, or delete portal CRM rows locally.
- Stop on LinkedIn login expiry, CAPTCHA, checkpoint, or security challenge.
- Update `linkedin_connection_inventory.workflow_status` throughout the run.
- Read `audit_events` when troubleshooting portal submission; only the CLI should write audit rows during `submit-qualified`.
- `dedupe-inventory` may read `new_individual` / `new_company` and link existing matches only.
- The portal creates or links CRM records for new candidates after `submit-qualified`.
- `recentActivitySignal` means at least one visible LinkedIn post or comment in the last 6 months.
- Do not probe or test live LinkedIn or portal endpoints unless the user explicitly asks. Prefer `--dry-run` first.

## Setup

Run once per machine or fresh clone:

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

For live operator runs, prefer the guided workflow. It accepts required configuration as one pasted env block or asks for missing values one question at a time, writes `.env`, records the selected LinkedIn account on discovered inventory rows, processes the requested batch sequentially with one persistent browser context, and prints a final status summary:

```bash
npm run guided-workflow
```

For skill optimization, local testing, or dry rehearsals where portal submission is not part of the test, run the same sequential workflow but skip the final two steps (`submit-qualified` and final status summary):

```bash
npm run guided-workflow -- --skip-finalization
```

Set `DATABASE_URL` and `OPENAI_API_KEY` before database-backed commands if running commands manually. Set `PORTAL_CALLBACK_SECRET` before live portal submission. `PORTAL_QUALIFIED_INGEST_URL` defaults to the Leapsheep qualified-ingest webhook.

## Reference Routing

Read only the references needed for the task:

| Task | Read |
| --- | --- |
| Run or explain the overall workflow | [references/workflow.md](references/workflow.md) |
| Inspect DB ownership, statuses, or retry state | [references/inventory-table.md](references/inventory-table.md) |
| Work with candidate files or portal payload shape | [references/extraction-schema.md](references/extraction-schema.md) |
| Run or debug `dedupe-inventory` | [references/dedupe-rules.md](references/dedupe-rules.md), [references/portal-crm-tables.md](references/portal-crm-tables.md) |
| Run or debug `submit-qualified` | [references/portal-api.md](references/portal-api.md) |
| Diagnose failures | [references/troubleshooting.md](references/troubleshooting.md) |

## Preflight

Before live runs, use dry-run checks:

```bash
node src/cli.js inspect-status
node src/cli.js check-config --dry-run
node src/cli.js process-queue --dry-run
node src/cli.js submit-qualified --dry-run
```

`submit-qualified --dry-run` only reads local candidate files and does not require database, OpenAI, or Portal credentials.

For `npm run guided-workflow`, first allow the user to provide all required env values at once as `KEY=value` lines or a single space-separated line:

```text
DATABASE_URL=...
OPENAI_API_KEY=...
PORTAL_QUALIFIED_INGEST_URL=...
PORTAL_CALLBACK_SECRET=...
```

If any required env value is missing, ask for missing values exactly one at a time in this order:

1. `DATABASE_URL`
2. `OPENAI_API_KEY`
3. `PORTAL_QUALIFIED_INGEST_URL`
4. `PORTAL_CALLBACK_SECRET`
5. LinkedIn account: `kirk`, `kathryb`, `terri`, `sarah`, `ice`, `siriluk`, or a custom account name. Use this value for `linkedin_connection_inventory.account`.
6. Number of connections to process; warn that high counts can hit LinkedIn usage limits or paid API limits

After the user answers, let the command write `.env` and run the workflow. Run workflow steps sequentially in the documented order. Do not close and reopen LinkedIn between workflow steps; the command keeps one Playwright persistent browser context open until all required connections are processed or the run fails. Only use `--skip-finalization` when testing or optimizing the skill; live operator runs should include `submit-qualified` after explicit confirmation that portal submission is intended.

## Data model

| Store | Purpose |
| --- | --- |
| `linkedin_connection_inventory` | Agent read/write — queue and workflow status |
| `new_individual`, `new_company` | Read only — dedupe match against existing CRM |
| `audit_events` | CLI-written portal submission audit trail; read manually for troubleshooting only |
| `workflow_runs` | Read only — run ledger (reserved, not populated yet) |
| `.lead-enrichment-candidates/*.md` | Enrichment evidence; fenced JSON block is the submission source of truth |

See [references/inventory-table.md](references/inventory-table.md) for column ownership.

## Commands

Run in the order listed in [references/workflow.md](references/workflow.md):

```bash
npm run guided-workflow
npm run guided-workflow -- --skip-finalization
npm run check-config -- --dry-run
npm run inspect-status
npm run login-linkedin
npm run sync-connections -- --dry-run
npm run process-queue -- --dry-run
npm run process-queue -- --limit 10
npm run sync-company-profiles -- --dry-run
npm run dedupe-inventory -- --dry-run
npm run sync-activities -- --dry-run
npm run score-fits -- --dry-run
npm run sync-company-websites -- --dry-run
npm run submit-qualified -- --dry-run
npm run retry-failed
```

Run `login-linkedin` before the first sync on a new profile. Only run live enrichment or `submit-qualified` after the operator confirms LinkedIn login, Neon access, OpenAI access, and `PORTAL_CALLBACK_SECRET`.

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md).
