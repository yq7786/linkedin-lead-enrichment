# LinkedIn Lead Enrichment

Local-first LinkedIn lead enrichment workflow plus a Codex skill for operating it.

The project captures LinkedIn connection/profile/company/activity evidence, dedupes against portal CRM tables, scores fit, captures qualified company websites, and can submit qualified candidates to a portal webhook.

## Install the Codex Skill

Fastest path from another Codex session:

```text
Use $skill-installer to install https://github.com/yq7786/linkedin-lead-enrichment/tree/main/skills/linkedin-lead-enrichment
```

Restart Codex after installation, then ask:

```text
Use $linkedin-lead-enrichment to run the guided LinkedIn lead enrichment workflow.
```

This installs only the skill instructions. To run the enrichment workflow, also clone and set up the full project below.

If you already cloned this repo, install the local skill with:

```bash
bash scripts/install-skill.sh
```

## What's Included

- `src/` - workflow CLI and enrichment implementation
- `test/` - Node test suite
- `sql/` - workflow table setup
- `skills/linkedin-lead-enrichment/` - Codex skill package
- `.env.example` - local configuration template with placeholder values only

Generated data and local runtime state are intentionally ignored: `.env`, `.linkedin-browser-profile/`, `.lead-enrichment-candidates/`, `.lead-enrichment-snapshots/`, and `node_modules/`.

## Install the Full Workflow App

```bash
git clone https://github.com/yq7786/linkedin-lead-enrichment.git
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

## Local Skill Install Options

Use these only when you have already cloned the repository.

**Option A - repo-local copy**

```bash
mkdir -p .agents/skills
cp -R skills/linkedin-lead-enrichment .agents/skills/
```

**Option B - user-level install script**

```bash
bash scripts/install-skill.sh
# or: bash scripts/install-skill.sh ~/.codex/skills/linkedin-lead-enrichment
```

**Option C - manual user-level copy**

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/linkedin-lead-enrichment "${CODEX_HOME:-$HOME/.codex}/skills/"
```

The skill collects env values in chat (bulk paste or one-by-one), asks for LinkedIn account and connection limit, writes `.env`, then runs:

```bash
npm run guided-workflow -- --account <account> --limit <N>
```

## Run

Live operator workflow (interactive prompts):

```bash
npm run guided-workflow
```

After collecting inputs in chat and writing `.env` (agent or operator):

```bash
npm run guided-workflow -- --account kathryb --limit 10
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
