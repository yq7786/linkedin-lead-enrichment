# Single Profile Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `process-profile` so one user-supplied LinkedIn profile URL can be processed as a trusted, manually qualified lead and submitted by default.

**Architecture:** Add a focused single-profile workflow module that seeds one inventory row, handles duplicate skip/re-process decisions, reuses the existing enrichment steps for that profile only, writes a manual qualification fit block, and then submits through the existing portal path. Persist `LINKEDIN_ACCOUNT` during guided setup and update skill docs so natural-language single-lead requests route to the new command.

**Tech Stack:** Node.js ESM, built-in `node:test`, PostgreSQL repository pattern, Playwright-backed existing LinkedIn extractors, local markdown candidate files.

---

### Task 1: Persist LinkedIn Account In Setup

**Files:**
- Modify: `src/guidedWorkflow.js`
- Modify: `.env.example`
- Test: `test/guidedWorkflow.test.js`

- [ ] **Step 1: Write failing tests**

Add or update tests in `test/guidedWorkflow.test.js` asserting `runGuidedWorkflow` writes `LINKEDIN_ACCOUNT=<account>` to `.env` and `resolveGuidedWorkflowAnswers` reads `LINKEDIN_ACCOUNT` from env when no `account` option is passed.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- test/guidedWorkflow.test.js`

Expected: at least one assertion fails because `.env` does not include `LINKEDIN_ACCOUNT`.

- [ ] **Step 3: Implement account persistence**

In `src/guidedWorkflow.js`, include `LINKEDIN_ACCOUNT: answers.linkedinAccount` in the `envValues` object written by `runGuidedWorkflow`.

In `.env.example`, add:

```text
LINKEDIN_ACCOUNT=kirk
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/guidedWorkflow.test.js`

Expected: PASS.

### Task 2: Manual Qualification And Submission Eligibility

**Files:**
- Modify: `src/workflow/submitQualifiedCandidates.js`
- Create: `src/workflow/manualQualification.js`
- Test: `test/submitQualifiedCandidates.test.js`
- Test: `test/processSingleProfile.test.js`

- [ ] **Step 1: Write failing tests**

Add tests proving `isSubmittable` returns true when `candidate.fit.mode === "manual_single_profile"` and `candidate.fit.manuallyQualified === true`, and false when that candidate was already submitted.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- test/submitQualifiedCandidates.test.js`

Expected: manual single-profile candidate is skipped until implementation accepts it.

- [ ] **Step 3: Implement manual qualification helpers**

Create `src/workflow/manualQualification.js` exporting:

```js
export function buildManualSingleProfileFit(now = new Date()) {
  return {
    mode: "manual_single_profile",
    manuallyQualified: true,
    qualifiedAt: now.toISOString(),
    fitReasoning: "Operator supplied this LinkedIn profile directly; automated fit scoring was skipped."
  };
}

export function isManualSingleProfileFit(fit) {
  return fit?.mode === "manual_single_profile" && fit.manuallyQualified === true;
}
```

Update `submitQualifiedCandidates.js` so `isSubmittable` accepts `isManualSingleProfileFit(candidate.fit)` as an alternative to the existing three automated signals, while still rejecting already submitted candidates.

- [ ] **Step 4: Run tests**

Run: `npm test -- test/submitQualifiedCandidates.test.js`

Expected: PASS.

### Task 3: Single Profile Workflow Core

**Files:**
- Create: `src/workflow/processSingleProfile.js`
- Modify: `src/workflow/candidateFiles.js`
- Test: `test/processSingleProfile.test.js`

- [ ] **Step 1: Write failing workflow tests**

Add tests for:

- Missing profile URL fails before dependencies run.
- Missing `LINKEDIN_ACCOUNT` fails before database mutation.
- Fresh URL seeds one inventory row and calls each workflow dependency with only that profile URL/inventory ID.
- Duplicate skip returns `status: "skipped_duplicate"` and does not delete or process.
- Duplicate re-process deletes only the matching candidate file and matching inventory row before seeding.
- Manual qualification writes the fit block and marks inventory/candidate status `qualified`.
- `skipFinalization: true` does not call submission.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- test/processSingleProfile.test.js`

Expected: FAIL because `processSingleProfile.js` does not exist.

- [ ] **Step 3: Add candidate-file deletion by inventory ID**

In `src/workflow/candidateFiles.js`, add `deleteByInventoryId(inventoryId)` that scans markdown files, parses fenced JSON, deletes the file whose `candidate.inventoryId` matches, and returns `{ deleted: true, fileId }` or `{ deleted: false, fileId: null }`.

- [ ] **Step 4: Implement repository and workflow**

Create `src/workflow/processSingleProfile.js` with:

- `SingleProfileRepository.findByProfileUrl(profileUrl)`.
- `SingleProfileRepository.seedProfile({ profileUrl, account })`.
- `SingleProfileRepository.deleteInventoryRow(inventoryId)`.
- `SingleProfileRepository.markManuallyQualified(inventoryId)`.
- `runProcessSingleProfile({ profileUrl, account, duplicateAction, skipFinalization, dependencies, log, cwd })`.

The workflow validates URL/account, checks duplicates, prompts or uses `duplicateAction`, performs approved cleanup for `reprocess`, seeds a fresh row, runs existing injected workflow functions, writes manual qualification through `CandidateFileRepository.upsertCandidate`, marks inventory qualified, runs website capture, and submits unless skipped.

- [ ] **Step 5: Run tests**

Run: `npm test -- test/processSingleProfile.test.js`

Expected: PASS.

### Task 4: CLI And Package Script

**Files:**
- Modify: `src/cli.js`
- Modify: `package.json`
- Test: `test/cliProcessProfile.test.js`

- [ ] **Step 1: Write failing CLI tests**

Add tests that spawn `node src/cli.js process-profile` without `--profile-url` and assert a clear error. Add a lightweight unit-style test if existing CLI spawning patterns make dependency injection impractical.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- test/cliProcessProfile.test.js`

Expected: FAIL because the command is unknown.

- [ ] **Step 3: Implement CLI route**

In `src/cli.js`, add:

```text
process-profile --profile-url URL [--skip-finalization] [--reprocess] [--skip-duplicate]
```

The route loads config, reads `LINKEDIN_ACCOUNT`, creates one persistent LinkedIn browser session, waits for LinkedIn login/blocker behavior using existing helpers, and calls `runProcessSingleProfile`.

Add package script:

```json
"process-profile": "node src/cli.js process-profile"
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/cliProcessProfile.test.js`

Expected: PASS.

### Task 5: Skill And Reference Docs

**Files:**
- Modify: `skills/linkedin-lead-enrichment/SKILL.md`
- Modify: `skills/linkedin-lead-enrichment/references/workflow.md`
- Modify: `skills/linkedin-lead-enrichment/references/operator-run.md`
- Modify: `skills/linkedin-lead-enrichment/references/troubleshooting.md`

- [ ] **Step 1: Update docs**

Document:

- Use `process-profile` when a user provides one LinkedIn profile URL, asks to process one connection, or asks to process one lead.
- `process-profile` reads `LINKEDIN_ACCOUNT` from `.env`.
- It checks duplicates before browser work.
- Duplicate re-process is the only approved AI deletion path for matching candidate markdown plus matching inventory row.
- It skips `score-fits` and submits by default.

- [ ] **Step 2: Verify docs mention command**

Run: `rg "process-profile|single profile|single connection|LINKEDIN_ACCOUNT" skills/linkedin-lead-enrichment`

Expected: command and routing instructions appear in the skill and references.

### Task 6: Full Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 2: Inspect git diff**

Run: `git diff --stat`

Expected: only implementation, tests, docs, and plan files for single-profile processing changed.

- [ ] **Step 3: Commit**

Stage and commit the implementation with:

```bash
git add .
git commit -m "Add single profile processing workflow"
```
