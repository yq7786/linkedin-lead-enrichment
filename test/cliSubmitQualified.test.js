import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { renderCandidateMarkdown } from "../src/workflow/candidateFiles.js";

const execFileAsync = promisify(execFile);

test("submit-qualified dry-run reads candidate files without external credentials", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "submit-qualified-cli-"));
  const candidateDirectory = path.join(cwd, ".lead-enrichment-candidates");
  await mkdir(candidateDirectory);
  await writeFile(
    path.join(candidateDirectory, "jane-smith_inv_123.md"),
    renderCandidateMarkdown({
      schemaVersion: 1,
      candidate: {
        inventoryId: "inv_123",
        fileId: "jane-smith_inv_123",
        createdAt: "2026-06-26T00:00:00.000Z",
        status: "website_captured"
      },
      identity: { firstName: "Jane", lastName: "Smith" },
      fit: { founderSignal: true, startupSignal: true, recentActivitySignal: true }
    }),
    "utf8"
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [path.resolve("src/cli.js"), "submit-qualified", "--dry-run"],
    {
      cwd,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH
      }
    }
  );

  const result = JSON.parse(stdout);
  assert.equal(result.status, "dry_run");
  assert.deepEqual(result.summary, { submitted: 0, wouldSubmit: 1, skipped: 0, failed: 0 });
  assert.equal(result.items[0].inventoryId, "inv_123");
  assert.equal(result.items[0].status, "would_submit");
  assert.equal(result.items[0].payload.source, "linkedin_lead_enrichment");
  assert.equal(result.items[0].payload.inventoryId, "inv_123");
});

test("score-fits dry-run scores candidate files without external credentials", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "score-fits-cli-"));
  const candidateDirectory = path.join(cwd, ".lead-enrichment-candidates");
  await mkdir(candidateDirectory);
  await writeFile(
    path.join(candidateDirectory, "jane-smith_inv_456.md"),
    renderCandidateMarkdown({
      schemaVersion: 1,
      candidate: {
        inventoryId: "inv_456",
        fileId: "jane-smith_inv_456",
        createdAt: "2026-06-26T00:00:00.000Z",
        status: "company_captured"
      },
      identity: { firstName: "Jane", lastName: "Smith", headline: "Founder at Acme AI" },
      profileCapture: {
        facts: {
          about: "Building an AI workflow automation startup.",
          currentRoleTitle: "Founder",
          jobHistory: []
        }
      },
      activityCapture: {
        items: [
          {
            activityType: "post",
            postedAt: "2026-06-01T00:00:00.000Z",
            content: "Launching an automation platform."
          }
        ]
      },
      companyCapture: {
        facts: {
          overview: "Acme AI is a software startup.",
          industry: "Software Development"
        }
      }
    }),
    "utf8"
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [path.resolve("src/cli.js"), "score-fits", "--dry-run", "--limit", "1"],
    {
      cwd,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH
      }
    }
  );

  const result = JSON.parse(stdout);
  assert.equal(result.status, "dry_run");
  assert.deepEqual(result.summary, { fitScored: 1, skippedNotFit: 0, failed: 0 });
  assert.equal(result.items[0].inventoryId, "inv_456");
  assert.equal(result.items[0].status, "qualified");
  assert.equal(result.items[0].fit.fitScore, 1);
});
