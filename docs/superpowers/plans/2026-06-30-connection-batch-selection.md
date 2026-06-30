# Connection Batch Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `--limit N` select up to N useful, unprocessed connection work items for manual `sync-connections` and `guided-workflow`.

**Architecture:** Add backlog-first batch preparation to the LinkedIn connection sync module. The sync step selects existing eligible inventory rows first, tops up from LinkedIn only when needed, and returns profile URLs/inventory IDs for downstream guided workflow steps.

**Tech Stack:** Node.js ES modules, `node:test`, Playwright extraction, PostgreSQL repositories.

---

### Task 1: Batch Builder And Repository

**Files:**
- Modify: `src/linkedin/connectionSync.js`
- Test: `test/linkedinSync.test.js`

- [ ] Add failing tests for existing eligible rows filling the limit, partial top-up, and known processed rows not consuming top-up capacity.
- [ ] Add `ConnectionInventoryRepository.listEligibleForEnrichment({ limit, account })`.
- [ ] Add `ConnectionInventoryRepository.findByProfileUrls(profileUrls)`.
- [ ] Update `syncLinkedInConnections` to build a useful batch before upserting top-up records.
- [ ] Run `node --test test/linkedinSync.test.js`.

### Task 2: CLI And Guided Workflow Wiring

**Files:**
- Modify: `src/cli.js`
- Modify: `src/guidedWorkflow.js`
- Test: `test/guidedWorkflow.test.js`

- [ ] Add/update tests proving guided workflow forwards the selected batch URLs downstream.
- [ ] Make manual `sync-connections` pass a repository in dry-run as well as live mode.
- [ ] Make guided workflow use `syncResult.profileUrls` and `syncResult.inventoryIds` instead of deriving from all returned connections.
- [ ] Run `node --test test/guidedWorkflow.test.js test/linkedinSync.test.js`.

### Task 3: Documentation And Verification

**Files:**
- Modify: `skills/linkedin-lead-enrichment/references/workflow.md`
- Modify: `skills/linkedin-lead-enrichment/references/operator-run.md`
- Modify: `src/cli.js`

- [ ] Update CLI help and workflow docs so `--limit N` means eligible workflow items.
- [ ] Run `npm test`.
