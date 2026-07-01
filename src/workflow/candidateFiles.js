import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const JSON_BLOCK_RE = /^```json\n([\s\S]*?)\n```/;

export function buildCandidateFileId({ fullName, firstName, lastName, inventoryId }) {
  const name = fullName || [firstName, lastName].filter(Boolean).join(" ") || "candidate";
  return `${slugify(name)}_${sanitizeId(inventoryId)}`;
}

export function renderCandidateMarkdown(candidate) {
  const summary = [
    "## Candidate Summary",
    "",
    `- Inventory ID: ${candidate.candidate.inventoryId}`,
    `- Status: ${candidate.candidate.status}`,
    `- Name: ${[candidate.identity?.firstName, candidate.identity?.lastName].filter(Boolean).join(" ") || "Unknown"}`,
    `- LinkedIn: ${candidate.identity?.linkedinProfileUrl || "Not captured"}`
  ].join("\n");

  return `\`\`\`json\n${JSON.stringify(candidate, null, 2)}\n\`\`\`\n\n${summary}\n`;
}

export function parseCandidateMarkdown(markdown) {
  const match = String(markdown).match(JSON_BLOCK_RE);
  if (!match) throw new Error("Candidate markdown must start with a JSON fenced block.");
  return JSON.parse(match[1]);
}

export class CandidateFileRepository {
  constructor({ directory = ".lead-enrichment-candidates", now = () => new Date() } = {}) {
    this.directory = directory;
    this.now = now;
  }

  async upsertCandidate({ inventoryId, fullName, firstName, lastName, patch, status }) {
    await mkdir(this.directory, { recursive: true });
    const existing = await this.findByInventoryId(inventoryId);
    const createdAt = existing?.candidate?.createdAt ?? this.now().toISOString();
    const fileId = existing?.candidate?.fileId ?? buildCandidateFileId({ fullName, firstName, lastName, inventoryId });
    const candidate = deepMerge(existing ?? {}, {
      schemaVersion: 1,
      ...patch,
      candidate: {
        inventoryId,
        fileId,
        createdAt,
        status
      }
    });

    await writeFile(path.join(this.directory, `${fileId}.md`), renderCandidateMarkdown(candidate), "utf8");
    return candidate;
  }

  async findByInventoryId(inventoryId) {
    const entries = await readdir(this.directory).catch(() => []);
    for (const entry of entries.filter((name) => name.endsWith(".md"))) {
      const candidate = parseCandidateMarkdown(await readFile(path.join(this.directory, entry), "utf8"));
      if (candidate.candidate?.inventoryId === inventoryId) return candidate;
    }
    return null;
  }

  async deleteByInventoryId(inventoryId) {
    const entries = await readdir(this.directory).catch(() => []);
    for (const entry of entries.filter((name) => name.endsWith(".md"))) {
      const filePath = path.join(this.directory, entry);
      const candidate = parseCandidateMarkdown(await readFile(filePath, "utf8"));
      if (candidate.candidate?.inventoryId !== inventoryId) continue;
      await unlink(filePath);
      return { deleted: true, fileId: candidate.candidate?.fileId ?? path.basename(entry, ".md") };
    }
    return { deleted: false, fileId: null };
  }

  async listByStatus(status, { inventoryIds } = {}) {
    const idFilter = new Set((inventoryIds ?? []).map((id) => String(id)));
    const entries = await readdir(this.directory).catch(() => []);
    const candidates = [];
    for (const entry of entries.filter((name) => name.endsWith(".md"))) {
      const candidate = parseCandidateMarkdown(await readFile(path.join(this.directory, entry), "utf8"));
      if (
        candidate.candidate?.status === status &&
        (idFilter.size === 0 || idFilter.has(String(candidate.candidate?.inventoryId)))
      ) {
        candidates.push(candidate);
      }
    }
    return candidates;
  }
}

function slugify(value) {
  return String(value ?? "candidate")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "candidate";
}

function sanitizeId(value) {
  return String(value ?? "missing-id").replace(/[^a-z0-9_-]/gi, "_");
}

function deepMerge(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) return right;
  if (!isPlainObject(left) || !isPlainObject(right)) return right;
  const output = { ...left };
  for (const [key, value] of Object.entries(right)) {
    output[key] = key in output ? deepMerge(output[key], value) : value;
  }
  return output;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
