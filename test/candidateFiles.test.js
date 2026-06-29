import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CandidateFileRepository,
  buildCandidateFileId,
  parseCandidateMarkdown,
  renderCandidateMarkdown
} from "../src/workflow/candidateFiles.js";

test("buildCandidateFileId uses readable slug and inventory id", () => {
  assert.equal(
    buildCandidateFileId({ fullName: "Jane Smith", inventoryId: "inv_123" }),
    "jane-smith_inv_123"
  );
  assert.equal(
    buildCandidateFileId({ firstName: "Ada", lastName: "Lovelace", inventoryId: "abc-123" }),
    "ada-lovelace_abc-123"
  );
});

test("render and parse candidate markdown keeps JSON as source of truth", () => {
  const candidate = {
    schemaVersion: 1,
    candidate: {
      inventoryId: "inv_123",
      fileId: "jane-smith_inv_123",
      createdAt: "2026-06-26T00:00:00.000Z",
      status: "profile_captured"
    },
    identity: { firstName: "Jane", lastName: "Smith" }
  };

  const markdown = renderCandidateMarkdown(candidate);
  assert.match(markdown, /^```json\n/);
  assert.match(markdown, /## Candidate Summary/);
  assert.deepEqual(parseCandidateMarkdown(markdown), candidate);
});

test("CandidateFileRepository creates and merges candidate sections", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "candidates-"));
  const repository = new CandidateFileRepository({ directory, now: () => new Date("2026-06-26T00:00:00.000Z") });

  const created = await repository.upsertCandidate({
    inventoryId: "inv_123",
    fullName: "Jane Smith",
    patch: {
      identity: { firstName: "Jane", lastName: "Smith" },
      profileCapture: { facts: { currentCompanyName: "Acme AI" } }
    },
    status: "profile_captured"
  });

  assert.equal(created.candidate.fileId, "jane-smith_inv_123");

  const merged = await repository.upsertCandidate({
    inventoryId: "inv_123",
    fullName: "Jane Smith",
    patch: {
      candidate: {
        createdAt: "1999-01-01T00:00:00.000Z",
        fileId: "incorrect-file-id",
        status: "incorrect_status"
      },
      activityCapture: {
        items: [{ activityType: "post", content: "Building useful automation." }]
      }
    },
    status: "activity_captured"
  });

  assert.equal(merged.candidate.createdAt, created.candidate.createdAt);
  assert.equal(merged.candidate.status, "activity_captured");
  assert.equal(merged.profileCapture.facts.currentCompanyName, "Acme AI");
  assert.equal(merged.activityCapture.items[0].content, "Building useful automation.");

  const markdown = await readFile(path.join(directory, "jane-smith_inv_123.md"), "utf8");
  assert.deepEqual(parseCandidateMarkdown(markdown), merged);
});

test("CandidateFileRepository lists candidates by status", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "candidates-"));
  const repository = new CandidateFileRepository({ directory, now: () => new Date("2026-06-26T00:00:00.000Z") });

  await repository.upsertCandidate({
    inventoryId: "inv_1",
    fullName: "Jane Smith",
    patch: { identity: { firstName: "Jane", lastName: "Smith" } },
    status: "qualified"
  });
  await repository.upsertCandidate({
    inventoryId: "inv_2",
    fullName: "Pat Lee",
    patch: { identity: { firstName: "Pat", lastName: "Lee" } },
    status: "skipped_not_fit"
  });

  const qualified = await repository.listByStatus("qualified");
  assert.equal(qualified.length, 1);
  assert.equal(qualified[0].candidate.inventoryId, "inv_1");
});

test("CandidateFileRepository read paths do not create missing directories", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "candidates-missing-parent-"));
  const directory = path.join(parent, "missing-candidates");
  const repository = new CandidateFileRepository({ directory });

  assert.deepEqual(await repository.listByStatus("qualified"), []);
  assert.equal(await repository.findByInventoryId("inv_1"), null);

  await assert.rejects(access(directory), /ENOENT/);
});
