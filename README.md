# LinkedIn Lead Enrichment

Local-first LinkedIn lead enrichment workflow plus a Codex skill for operating it.

The project captures LinkedIn connection/profile/company/activity evidence, dedupes against portal CRM tables, scores fit, captures qualified company websites, and can submit qualified candidates to a portal webhook.

## What's Included

- `src/` - workflow CLI and enrichment implementation
- `test/` - Node test suite
- `sql/` - workflow table setup
- `skills/linkedin-lead-enrichment/` - Codex skill package
- `.env.example` - local configuration template with placeholder values only

Generated data and local runtime state are intentionally ignored: `.env`, `.linkedin-browser-profile/`, `.lead-enrichment-candidates/`, `.lead-enrichment-snapshots/`, and `node_modules/`.

## Install

```bash
git clone <repo-url>
cd linkedin-lead-enrichment
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env` with your own values:

```text
DATABASE_URL=...
OPENAI_API_KEY=...
PORTAL_QUALIFIED_INGEST_URL=...
PORTAL_CALLBACK_SECRET=...
```

Create the workflow tables in your database:

```bash
psql "$DATABASE_URL" -f sql/001_workflow_tables.sql
```

## Install the Codex Skill

Copy the skill folder into your Codex skills directory:

```bash
mkdir -p ~/.codex/skills
cp -R skills/linkedin-lead-enrichment ~/.codex/skills/
```

Then start a new Codex session and ask:

```text
Use $linkedin-lead-enrichment to run the guided LinkedIn lead enrichment workflow.
```

## Run

Live operator workflow:

```bash
npm run guided-workflow
```

Optimization/testing mode, which skips `submit-qualified` and the final status summary:

```bash
npm run guided-workflow -- --skip-finalization
```

Run tests:

```bash
npm test
```

## Safety Notes

- Do not commit `.env` or any local browser profile.
- Do not commit generated candidate files unless they have been explicitly sanitized.
- Start with a small connection count; high counts can hit LinkedIn usage limits or paid API limits.
- Use `--skip-finalization` while testing workflow changes so the portal webhook is not called.
