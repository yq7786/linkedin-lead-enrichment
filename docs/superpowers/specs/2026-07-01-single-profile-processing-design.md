# Single LinkedIn Profile Processing Design

## Purpose

Enable operators and agents to process one user-supplied LinkedIn profile URL as a trusted lead. This mode avoids connection-list discovery and skips automated `score-fits`, while still collecting evidence, deduping against the portal CRM, capturing company/activity/website context, and submitting the candidate to the portal by default.

## User-Facing Behavior

Agents should use this mode when a user provides a single LinkedIn profile URL, asks to process a single connection, or asks to process one lead.

The command shape is:

```bash
npm run process-profile -- --profile-url <linkedin-profile-url>
```

Single-profile mode reads `LINKEDIN_ACCOUNT` from `.env`. Users should not need to pass `--account` for this command after setup.

Portal submission is enabled by default. The command supports `--skip-finalization` for testing so it stops before `submit-qualified`.

## Configuration

Guided setup should persist the selected LinkedIn account into `.env` alongside the other required values:

```text
DATABASE_URL=...
OPENAI_API_KEY=...
PORTAL_QUALIFIED_INGEST_URL=...
PORTAL_CALLBACK_SECRET=...
LINKEDIN_ACCOUNT=<account>
```

`process-profile` must fail before browser or database mutation if `LINKEDIN_ACCOUNT` is missing, with guidance to run guided setup or add `LINKEDIN_ACCOUNT` to `.env`.

## Architecture

Add a dedicated single-profile workflow rather than overloading the batch `guided-workflow`.

The workflow should reuse existing components where possible:

- `normalizeLinkedInProfileUrl` for profile URL normalization.
- A focused single-profile repository for duplicate checks, seed-row creation, manual qualification marking, and approved re-process deletion.
- `ProcessQueueRepository` and `processQueuedProfiles` for LinkedIn profile extraction.
- `syncCompanyProfiles` for current-company capture.
- `dedupeInventory` for CRM dedupe.
- `syncLinkedInActivityItems` for activity capture.
- `syncCompanyWebsites` for company website capture.
- `submitQualifiedCandidates` for portal submission.

It should not call `syncLinkedInConnections` or `scoreExtractedProfiles`.

## Duplicate Gate

Before opening a browser or running enrichment, the command must normalize the provided LinkedIn URL and query `linkedin_connection_inventory` for an existing row with the same normalized URL.

If no existing row is found, create a new inventory row with:

- `linkedin_profile_url` set to the normalized URL.
- `account` set to `LINKEDIN_ACCOUNT`.
- `dedupe_status = dedupe_pending`.
- `workflow_status = discovered`.

If an existing row is found, stop and ask the operator whether to re-process or skip.

If the operator chooses skip:

- Make no changes.
- Return a clear summary that the existing record was skipped.

If the operator chooses re-process:

- Delete only the candidate markdown file whose fenced JSON has the duplicate inventory ID.
- Delete only the matching `linkedin_connection_inventory` row.
- Recreate the inventory row from the normalized URL and current `LINKEDIN_ACCOUNT`.
- Continue through the single-profile workflow.

This re-process branch is the only approved case where the agent may delete a workflow inventory row or candidate markdown file.

## Data Flow

The single-profile run should execute this sequence:

1. Load `.env`.
2. Validate config and require `LINKEDIN_ACCOUNT`.
3. Validate and normalize `--profile-url`.
4. Check `linkedin_connection_inventory` for duplicates.
5. If duplicate exists, ask the operator to re-process or skip.
6. If re-processing, delete the matching candidate markdown file and inventory row.
7. Seed a fresh inventory row for the normalized profile URL with `processing_source = 'process_profile'`.
8. Open one persistent Playwright LinkedIn browser session.
9. Wait for login, checkpoint, CAPTCHA, or security blockers to clear using existing behavior.
10. Run `process-queue` behavior for only the seeded profile URL.
11. Run `sync-company-profiles` behavior for only the seeded profile URL.
12. Run `dedupe-inventory` behavior for only the seeded profile URL.
13. If dedupe finds an existing CRM record or needs review, stop before submission.
14. Run `sync-activities` behavior for only the seeded profile URL.
15. Mark the candidate as manually qualified.
16. Run `sync-company-websites` for the manually qualified candidate.
17. Run `submit-qualified` by default unless `--skip-finalization` is set.
18. Print a final status summary for only the supplied profile URL.

## Manual Qualification

Because `submit-qualified` requires a `fit` block, single-profile mode should write an explicit manual qualification block instead of automated score output:

```json
{
  "mode": "manual_single_profile",
  "manuallyQualified": true,
  "qualifiedAt": "ISO timestamp",
  "fitReasoning": "Operator supplied this LinkedIn profile directly; automated fit scoring was skipped."
}
```

The candidate status and inventory status should be set to `qualified` after this block is written.

`submit-qualified` eligibility should accept this manual single-profile qualification in addition to the existing automated high-potential fit signals.

## Error Handling

- Missing `--profile-url`: fail before config, DB, or browser work.
- Invalid or non-LinkedIn profile URL: fail before DB mutation.
- Missing `LINKEDIN_ACCOUNT`: fail before DB mutation with setup guidance.
- Duplicate profile URL: require an explicit `re-process` or `skip` choice; do not default to deletion.
- Re-process cleanup: delete only the candidate file matching the duplicate inventory ID, then delete only the matching inventory row.
- LinkedIn login, checkpoint, CAPTCHA, or security challenge: preserve current wait-and-resume behavior.
- Dedupe CRM match: stop before manual qualification, website capture, and submission.
- Portal submission failure: preserve existing submission failure and retry marking.

## Documentation Updates

Update skill and reference docs so future agents route natural-language requests correctly:

- If a user provides one LinkedIn profile URL, asks to process a single connection, or asks to process one lead, use `process-profile`.
- Do not run `sync-connections` for this path.
- Do not run `score-fits` for this path.
- Single-profile mode reads `LINKEDIN_ACCOUNT` from `.env`.
- If an existing inventory record is found, ask whether to re-process or skip.
- Re-processing is the only approved case where the agent may delete the matching inventory row and candidate markdown file.
- By default, continue through portal submission unless the user explicitly requests `--skip-finalization`.

Add the command to the manual command list:

```bash
npm run process-profile -- --profile-url <linkedin-profile-url>
```

Add a separate single-profile flow section to the workflow reference so it is not confused with batch mode.

## Testing

Add focused tests for:

- Guided workflow writes `LINKEDIN_ACCOUNT` to `.env`.
- `process-profile` requires `--profile-url`.
- `process-profile` requires `LINKEDIN_ACCOUNT`.
- Fresh URL seeding creates one inventory row and processes only that profile.
- Duplicate skip makes no changes.
- Duplicate re-process deletes only the matching candidate markdown file and only the matching inventory row.
- Manual qualification writes the expected `fit` block and marks the candidate `qualified`.
- Submission eligibility accepts manual single-profile qualification.
- `--skip-finalization` stops before portal submission.

## Out Of Scope

- Bulk importing arbitrary profile URL lists.
- Changing the existing batch guided workflow sequence.
- Changing CRM dedupe rules.
- Sending LinkedIn DMs.
- Bypassing portal submission validation.
