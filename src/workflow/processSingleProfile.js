import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

import { normalizeLinkedInProfileUrl } from "../dedupe.js";
import { CandidateFileRepository } from "./candidateFiles.js";
import { buildManualSingleProfileFit } from "./manualQualification.js";

export async function runProcessSingleProfile({
  profileUrl,
  account,
  duplicateAction,
  skipFinalization = false,
  candidateRepository,
  cwd = process.cwd(),
  dependencies = {},
  now = () => new Date(),
  log = () => {}
} = {}) {
  const normalizedProfileUrl = normalizeSingleProfileUrl(profileUrl);
  const linkedinAccount = String(account ?? "").trim();
  if (!linkedinAccount) {
    throw new Error("LINKEDIN_ACCOUNT is required. Run guided setup or add LINKEDIN_ACCOUNT to .env.");
  }

  const repository = dependencies.repository;
  if (!repository) throw new Error("Single profile repository is required.");

  const candidates = candidateRepository ?? new CandidateFileRepository({
    directory: path.join(cwd, ".lead-enrichment-candidates")
  });

  const existing = await repository.findByProfileUrl(normalizedProfileUrl);
  if (existing) {
    const action = await resolveDuplicateAction({
      duplicateAction,
      askDuplicateAction: dependencies.askDuplicateAction,
      existing
    });
    if (action === "skip") {
      return {
        status: "skipped_duplicate",
        profileUrl: normalizedProfileUrl,
        existingInventoryId: existing.id
      };
    }

    const deleteResult = await candidates.deleteByInventoryId(existing.id);
    await repository.deleteInventoryRow(existing.id);
    log(`Re-processing duplicate profile: deleted inventory ${existing.id}; candidate file deleted: ${deleteResult.deleted}`);
  }

  const seeded = await repository.seedProfile({
    profileUrl: normalizedProfileUrl,
    account: linkedinAccount
  });
  const inventoryIds = [seeded.id];
  const profileUrls = [normalizedProfileUrl];
  const limit = 1;
  const stepResults = {};

  stepResults.processQueue = await dependencies.processQueuedProfiles({
    candidateRepository: candidates,
    inventoryIds,
    limit,
    profileUrls
  });

  stepResults.syncCompanyProfiles = await dependencies.syncCompanyProfiles({
    candidateRepository: candidates,
    inventoryIds,
    limit,
    profileUrls
  });

  stepResults.dedupeInventory = await dependencies.dedupeInventory({
    inventoryIds,
    limit,
    profileUrls
  });

  if (hasDedupeStop(stepResults.dedupeInventory)) {
    return {
      status: "stopped_after_dedupe",
      profileUrl: normalizedProfileUrl,
      inventoryId: seeded.id,
      steps: stepResults
    };
  }

  stepResults.syncActivities = await dependencies.syncLinkedInActivityItems({
    candidateRepository: candidates,
    inventoryIds,
    limit,
    profileUrls
  });

  const fit = buildManualSingleProfileFit(now());
  await candidates.upsertCandidate({
    inventoryId: seeded.id,
    patch: { fit },
    status: "qualified"
  });
  await repository.markManuallyQualified(seeded.id);

  stepResults.syncCompanyWebsites = await dependencies.syncCompanyWebsites({
    candidateRepository: candidates,
    inventoryIds,
    limit
  });

  if (!skipFinalization) {
    stepResults.submitQualified = await dependencies.submitQualifiedCandidates({
      candidateRepository: candidates,
      inventoryIds,
      limit
    });
  }

  return {
    status: "processed",
    profileUrl: normalizedProfileUrl,
    inventoryId: seeded.id,
    skippedFinalization: skipFinalization,
    steps: stepResults
  };
}

export class SingleProfileRepository {
  constructor(client) {
    this.client = client;
  }

  async findByProfileUrl(profileUrl) {
    const result = await this.client.query(
      `select
         id,
         linkedin_profile_url,
         full_name,
         headline,
         current_company_name,
         current_company_url,
         account,
         processing_source,
         dedupe_status,
         workflow_status
       from linkedin_connection_inventory
       where lower(linkedin_profile_url) = lower($1)
       limit 1`,
      [profileUrl]
    );
    return result.rows[0] ? toCamelInventory(result.rows[0]) : null;
  }

  async seedProfile({ profileUrl, account }) {
    const result = await this.client.query(
      `insert into linkedin_connection_inventory (
         linkedin_profile_url,
         account,
         processing_source,
         dedupe_status,
         workflow_status,
         last_seen_at
       )
       values ($1, $2, $3, 'dedupe_pending', 'discovered', now())
       returning
         id,
         linkedin_profile_url,
         account,
         processing_source,
         dedupe_status,
         workflow_status`,
      [profileUrl, account, "process_profile"]
    );
    return toCamelInventory(result.rows[0]);
  }

  async markManuallyQualified(inventoryId) {
    await this.client.query(
      `update linkedin_connection_inventory
       set workflow_status = 'qualified',
           current_step = 'qualified'
       where id = $1`,
      [inventoryId]
    );
  }

  async deleteInventoryRow(inventoryId) {
    const result = await this.client.query(
      `delete from linkedin_connection_inventory
       where id = $1`,
      [inventoryId]
    );
    return { deleted: (result.rowCount ?? 0) > 0 };
  }
}

export function normalizeSingleProfileUrl(profileUrl) {
  if (!String(profileUrl ?? "").trim()) {
    throw new Error("--profile-url is required.");
  }

  let normalized;
  try {
    normalized = normalizeLinkedInProfileUrl(profileUrl);
  } catch {
    throw new Error("--profile-url must be a valid LinkedIn profile URL.");
  }

  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("--profile-url must be a valid LinkedIn profile URL.");
  }

  const host = url.hostname.replace(/^www\./, "");
  if (host !== "linkedin.com" || !url.pathname.toLowerCase().startsWith("/in/")) {
    throw new Error("--profile-url must be a valid LinkedIn profile URL.");
  }
  return normalized;
}

async function resolveDuplicateAction({ duplicateAction, askDuplicateAction, existing }) {
  const normalizedAction = normalizeDuplicateAction(duplicateAction);
  if (normalizedAction) return normalizedAction;

  if (askDuplicateAction) {
    return normalizeDuplicateAction(await askDuplicateAction(existing)) ?? "skip";
  }

  return askDuplicateActionFromTerminal(existing);
}

function normalizeDuplicateAction(action) {
  const text = String(action ?? "").trim().toLowerCase();
  if (["reprocess", "re-process", "yes", "y"].includes(text)) return "reprocess";
  if (["skip", "no", "n"].includes(text)) return "skip";
  return null;
}

async function askDuplicateActionFromTerminal(existing) {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question(
        `Existing inventory record found for ${existing.linkedinProfileUrl}. Re-process or skip? `
      )).trim();
      const action = normalizeDuplicateAction(answer);
      if (action) return action;
    }
  } finally {
    rl.close();
  }
}

function hasDedupeStop(result) {
  const summary = result?.summary ?? {};
  return Number(summary.matchedExisting ?? 0) > 0 || Number(summary.needsReview ?? 0) > 0;
}

function toCamelInventory(row) {
  return {
    id: row.id,
    linkedinProfileUrl: row.linkedin_profile_url,
    fullName: row.full_name ?? null,
    headline: row.headline ?? null,
    currentCompanyName: row.current_company_name ?? null,
    currentCompanyUrl: row.current_company_url ?? null,
    account: row.account ?? null,
    processingSource: row.processing_source ?? null,
    dedupeStatus: row.dedupe_status ?? null,
    workflowStatus: row.workflow_status ?? null
  };
}
