---
name: linkedin-lead-enrichment
description: Operates the local LinkedIn lead enrichment workflow — sync connections, dedupe against portal CRM, capture profile/company/activity/website evidence, score fit, submit qualified candidates, inspect status, and retry failures. Use when running guided-workflow, sync-connections, process-queue, dedupe-inventory, score-fits, submit-qualified, inspect-status, retry-failed, or debugging enrichment candidates and workflow statuses.
---

# LinkedIn Lead Enrichment

## Rules

- Never send LinkedIn DMs directly.
- Submit qualified candidates through the portal qualified-ingest webhook only.
- Use Playwright for LinkedIn and company website capture.
- Treat Neon as workflow control plane; do not mutate portal CRM rows locally.
- When LinkedIn shows login expiry, CAPTCHA, checkpoint, or security challenge, stop automated LinkedIn actions and keep the current browser open while the user resolves it.
- Update `linkedin_connection_inventory.workflow_status` throughout the run.
- `recentActivitySignal` means at least one visible LinkedIn post or comment in the last 6 months.
- Do not probe live LinkedIn or portal endpoints unless the user explicitly asks. Prefer `--dry-run` first.

## Quick start

This skill operates the `linkedin-lead-enrichment` project. Before running workflow commands, ensure the user is inside a cloned repo with `package.json`, `src/`, `sql/`, and `.env.example`. If the skill was installed by itself, ask the user to clone and enter the project first:

```bash
git clone https://github.com/yq7786/linkedin-lead-enrichment.git
cd linkedin-lead-enrichment
```

```bash
npm run setup-project
cp .env.example .env
```

## Run a batch

Read [references/operator-run.md](references/operator-run.md) before any live run. It defines how to collect env values (bulk paste or one-by-one), LinkedIn account selection, connection limit with usage-limit warning, and the non-interactive agent path.

**Live operator run** (after collecting inputs in chat and writing `.env`):

```bash
npm run guided-workflow -- --account <account> --limit <N>
```

**Testing / skill optimization** (skips `submit-qualified` and final summary):

```bash
npm run guided-workflow -- --account <account> --limit <N> --skip-finalization
```

**Interactive terminal** (CLI prompts handle all inputs):

```bash
npm run guided-workflow
```

The guided workflow runs all steps sequentially with **one persistent browser context** until every step completes or the run fails. Do not interleave separate browser-backed CLI commands during a guided run.

When `sync-connections` returns fewer rows than requested, do not call the requested batch complete unless its summary has `exhausted: true`, LinkedIn shows a blocker, or a downstream hard failure stopped the workflow. If `exhausted` is not true, keep topping up the remaining count within the guided workflow or clearly report the partial run.

If LinkedIn is not logged in or shows a checkpoint, `guided-workflow` opens the persistent Playwright browser profile and waits for the user to complete login or clear the challenge before `sync-connections`. Keep that browser open. Do not tell the user to run a separate login command unless they explicitly want to pre-login.

## Reference routing

| Task | Read |
| --- | --- |
| Operator inputs and run modes | [references/operator-run.md](references/operator-run.md) |
| Step order and status transitions | [references/workflow.md](references/workflow.md) |
| Inventory columns and ownership | [references/inventory-table.md](references/inventory-table.md) |
| Candidate files and payload shape | [references/extraction-schema.md](references/extraction-schema.md) |
| Dedupe rules | [references/dedupe-rules.md](references/dedupe-rules.md), [references/portal-crm-tables.md](references/portal-crm-tables.md) |
| Portal submission | [references/portal-api.md](references/portal-api.md) |
| Failures | [references/troubleshooting.md](references/troubleshooting.md) |

## Preflight

```bash
node src/cli.js inspect-status
node src/cli.js check-config --dry-run
node src/cli.js process-queue --dry-run
node src/cli.js submit-qualified --dry-run
```

## Data model

| Store | Purpose |
| --- | --- |
| `linkedin_connection_inventory` | Queue and workflow status (agent read/write) |
| `new_individual`, `new_company` | Read only — dedupe match |
| `.lead-enrichment-candidates/*.md` | Enrichment evidence; fenced JSON is submission source of truth |

## Manual commands

Use individual commands only for debugging — not during a guided batch run:

```bash
npm run login-linkedin
npm run sync-connections -- --limit 10 --dry-run
npm run process-queue -- --limit 10 --dry-run
npm run sync-company-profiles -- --dry-run
npm run dedupe-inventory -- --dry-run
npm run sync-activities -- --dry-run
npm run score-fits -- --dry-run
npm run sync-company-websites -- --dry-run
npm run submit-qualified -- --dry-run
npm run retry-failed
```
