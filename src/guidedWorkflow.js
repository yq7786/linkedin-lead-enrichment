import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

import { PortalCandidateAdapter } from "./adapters/portalCandidates.js";
import { captureCompanyWebsiteWithPlaywright } from "./company/websiteCapture.js";
import { loadDotenv, validateConfig } from "./config.js";
import { createDbClient } from "./db/client.js";
import {
  ActivityItemsRepository,
  extractActivityItemsFromPage,
  syncLinkedInActivityItems
} from "./linkedin/activitySync.js";
import { createLinkedInBrowserSession, waitForLinkedInBlockersToClear } from "./linkedin/browser.js";
import {
  CompanyProfileRepository,
  extractCompanyProfileFromPage,
  syncCompanyProfiles
} from "./linkedin/companyProfileSync.js";
import {
  ConnectionInventoryRepository,
  extractConnectionCardsFromPage,
  syncLinkedInConnections
} from "./linkedin/connectionSync.js";
import { waitForLinkedInLogin } from "./linkedin/login.js";
import { CandidateFileRepository } from "./workflow/candidateFiles.js";
import { dedupeInventory, DedupeInventoryRepository } from "./workflow/dedupeInventory.js";
import {
  createPlaywrightProfileExtractor,
  processQueuedProfiles,
  ProcessQueueRepository
} from "./workflow/processQueue.js";
import {
  scoreExtractedProfiles,
  ScoreExtractedProfilesRepository
} from "./workflow/scoreExtractedProfiles.js";
import {
  submitQualifiedCandidates,
  SubmitQualifiedCandidatesRepository
} from "./workflow/submitQualifiedCandidates.js";
import { CompanyWebsiteRepository, syncCompanyWebsites } from "./workflow/syncCompanyWebsites.js";

export const LINKEDIN_ACCOUNT_CHOICES = ["kirk", "kathryn", "terri", "sarah", "ice", "siriluk"];
export const DEFAULT_GUIDED_WORKFLOW_BATCH_SIZE = 50;
export const DEFAULT_PARTIAL_SYNC_RETRIES = 2;

export function resolveGuidedWorkflowAnswers({ env = process.env, account, limit } = {}) {
  loadDotenv(env);
  let config;
  try {
    config = validateConfig(env, { dryRun: false });
  } catch {
    return null;
  }

  const linkedinAccount = normalizeLinkedInAccount(account ?? env.LINKEDIN_ACCOUNT ?? "");
  const parsedLimit = limit ?? parseOptionalPositiveInteger(env.CONNECTION_LIMIT) ?? config.defaultBatchLimit;
  if (!linkedinAccount || !parsedLimit) return null;

  return {
    databaseUrl: env.DATABASE_URL,
    openaiApiKey: env.OPENAI_API_KEY,
    portalQualifiedIngestUrl: config.portalQualifiedIngestUrl,
    portalCallbackSecret: env.PORTAL_CALLBACK_SECRET,
    linkedinAccount,
    connectionLimit: parsedLimit
  };
}

export async function runGuidedWorkflowFromCli(options = {}) {
  const answers = resolveGuidedWorkflowAnswers(options) ?? await askGuidedWorkflowQuestions(options);
  return runGuidedWorkflow({ ...options, answers });
}

export async function askGuidedWorkflowQuestions({ inputStream = input, outputStream = output } = {}) {
  const rl = readline.createInterface({ input: inputStream, output: outputStream });
  try {
    outputStream.write(
      "Paste DATABASE_URL, OPENAI_API_KEY, PORTAL_QUALIFIED_INGEST_URL, and PORTAL_CALLBACK_SECRET as KEY=value lines, or press Enter to answer one by one.\n"
    );
    const pastedEnv = parseEnvLines(await rl.question("Env values: "));
    const databaseUrl = await askRequiredEnvValue(rl, pastedEnv, "DATABASE_URL");
    const openaiApiKey = await askRequiredEnvValue(rl, pastedEnv, "OPENAI_API_KEY");
    const portalQualifiedIngestUrl = await askRequiredEnvValue(rl, pastedEnv, "PORTAL_QUALIFIED_INGEST_URL");
    const portalCallbackSecret = await askRequiredEnvValue(rl, pastedEnv, "PORTAL_CALLBACK_SECRET");
    const linkedinAccount = await askLinkedInAccount(rl);
    const connectionLimit = await askConnectionLimit(rl, outputStream);

    return {
      databaseUrl,
      openaiApiKey,
      portalQualifiedIngestUrl,
      portalCallbackSecret,
      linkedinAccount,
      connectionLimit
    };
  } finally {
    rl.close();
  }
}

export async function runGuidedWorkflow({
  answers,
  cwd = process.cwd(),
  env = process.env,
  log = console.log,
  dependencies = {},
  skipFinalization = false
} = {}) {
  if (!answers) throw new Error("Guided workflow answers are required.");

  const envValues = {
    DATABASE_URL: answers.databaseUrl,
    OPENAI_API_KEY: answers.openaiApiKey,
    PORTAL_QUALIFIED_INGEST_URL: answers.portalQualifiedIngestUrl,
    PORTAL_CALLBACK_SECRET: answers.portalCallbackSecret,
    DEFAULT_BATCH_LIMIT: String(DEFAULT_GUIDED_WORKFLOW_BATCH_SIZE)
  };
  const envPath = path.join(cwd, ".env");
  await writeLocalEnvFile(envPath, envValues);
  Object.assign(env, envValues);

  const config = (dependencies.validateConfig ?? validateConfig)(env, { dryRun: false });
  const maxBatchSize = dependencies.maxGuidedWorkflowBatchSize ?? config.defaultBatchLimit ?? DEFAULT_GUIDED_WORKFLOW_BATCH_SIZE;
  const batchLimits = createGuidedWorkflowBatchLimits(answers.connectionLimit, maxBatchSize);
  log(`Configuration saved to ${envPath}`);
  log(`Processing up to ${answers.connectionLimit} LinkedIn connections for account: ${answers.linkedinAccount}`);
  if (batchLimits.length > 1) {
    log(`Requests above ${maxBatchSize} connections will run in ${batchLimits.length} sequential batches.`);
  }
  if (skipFinalization) {
    log("Testing mode enabled: skipping submit-qualified and final status summary.");
  }

  const dbClientFactory = dependencies.createDbClient ?? createDbClient;
  const client = await dbClientFactory(config.databaseUrl);
  await client.connect();

  const importPlaywright = dependencies.importPlaywright ?? (() => import("playwright"));
  const browserSessionFactory = dependencies.createLinkedInBrowserSession ?? createLinkedInBrowserSession;
  const syncConnections = dependencies.syncLinkedInConnections ?? syncLinkedInConnections;
  const processProfiles = dependencies.processQueuedProfiles ?? processQueuedProfiles;
  const syncCompanies = dependencies.syncCompanyProfiles ?? syncCompanyProfiles;
  const dedupeRows = dependencies.dedupeInventory ?? dedupeInventory;
  const syncActivities = dependencies.syncLinkedInActivityItems ?? syncLinkedInActivityItems;
  const scoreProfiles = dependencies.scoreExtractedProfiles ?? scoreExtractedProfiles;
  const syncWebsites = dependencies.syncCompanyWebsites ?? syncCompanyWebsites;
  const submitCandidates = dependencies.submitQualifiedCandidates ?? submitQualifiedCandidates;
  const waitForLogin = dependencies.waitForLinkedInLogin ?? waitForLinkedInLogin;
  const maxPartialSyncRetries = dependencies.maxPartialSyncRetries ?? DEFAULT_PARTIAL_SYNC_RETRIES;
  let context;
  try {
    await ensureInventoryAccountColumn(client);
    const playwright = await importPlaywright();
    context = await browserSessionFactory({
      profilePath: config.linkedinBrowserProfilePath,
      playwright
    });
    const page = context.pages()[0] ?? await context.newPage();
    const candidateRepository = new CandidateFileRepository({
      directory: path.join(cwd, ".lead-enrichment-candidates")
    });

    await ensureLinkedInSession(page, { waitForLogin, log });

    const allProfileUrls = [];
    let stoppedBeforeRequested = null;

    for (const [batchIndex, batchLimit] of batchLimits.entries()) {
      if (batchLimits.length > 1) {
        log(`Batch ${batchIndex + 1}/${batchLimits.length}: processing up to ${batchLimit} connections`);
      }

      let remainingBatchLimit = batchLimit;
      let partialSyncRetries = 0;

      while (remainingBatchLimit > 0) {
        log("Step 1/8: sync-connections");
        const syncResult = await syncConnections({
          extractConnections: async (options = {}) => {
            return extractConnectionCardsFromPage(page, { ...options, log });
          },
          inventoryRepository: new ConnectionInventoryRepository(client),
          account: answers.linkedinAccount,
          limit: remainingBatchLimit
        });
        logStepSummary(syncResult, log);

        const profileUrls = (
          syncResult.profileUrls?.length
            ? syncResult.profileUrls
            : syncResult.connections.map((connection) => connection.linkedinProfileUrl)
        ).filter(Boolean);

        if (profileUrls.length > 0) {
          const inventoryRows = syncResult.inventoryIds?.length
            ? []
            : await findInventoryRowsByProfileUrls(client, profileUrls);
          const inventoryIds = syncResult.inventoryIds?.length
            ? syncResult.inventoryIds
            : inventoryRows.map((row) => row.id);

          log("Step 2/8: process-queue");
          logStepSummary(await processProfiles({
            queueRepository: new ProcessQueueRepository(client),
            candidateRepository,
            extractProfile: async (item) => createPlaywrightProfileExtractor(page, { log })(item),
            limit: remainingBatchLimit,
            profileUrls
          }), log);

          log("Step 3/8: sync-company-profiles");
          logStepSummary(await syncCompanies({
            repository: new CompanyProfileRepository(client),
            candidateRepository,
            extractCompany: async (item) => extractCompanyProfileFromPage(page, { companyUrl: item.currentCompanyUrl, log }),
            limit: remainingBatchLimit,
            profileUrls
          }), log);

          log("Step 4/8: dedupe-inventory");
          logStepSummary(await dedupeRows({
            inventoryRepository: new DedupeInventoryRepository(client),
            limit: remainingBatchLimit,
            profileUrls
          }), log);

          log("Step 5/8: sync-activities");
          const activityRepository = new ActivityItemsRepository(client);
          logStepSummary(await syncActivities({
            inventoryRepository: activityRepository,
            activityRepository,
            candidateRepository,
            extractActivities: async (item) =>
              extractActivityItemsFromPage(page, {
                profileUrl: item.linkedinProfileUrl,
                limit: 10,
                log
              }),
            limit: remainingBatchLimit,
            profileUrls
          }), log);

          log("Step 6/8: score-fits");
          logStepSummary(await scoreProfiles({
            candidateRepository,
            repository: new ScoreExtractedProfilesRepository(client),
            limit: remainingBatchLimit,
            inventoryIds
          }), log);

          log("Step 7/8: sync-company-websites");
          logStepSummary(await syncWebsites({
            candidateRepository,
            repository: new CompanyWebsiteRepository(client),
            captureWebsite: async (url) => captureCompanyWebsiteWithPlaywright(page, url),
            limit: remainingBatchLimit,
            inventoryIds
          }), log);

          if (!skipFinalization) {
            log("Step 8/8: submit-qualified");
            logStepSummary(await submitCandidates({
              candidateRepository,
              portalCandidates: new PortalCandidateAdapter({
                endpointUrl: config.portalQualifiedIngestUrl,
                callbackSecret: config.portalCallbackSecret
              }),
              repository: new SubmitQualifiedCandidatesRepository(client),
              limit: remainingBatchLimit,
              inventoryIds
            }), log);
          }

          allProfileUrls.push(...profileUrls);
          remainingBatchLimit -= profileUrls.length;
          if (remainingBatchLimit <= 0) break;
        }

        const requested = syncResult.summary?.requested ?? remainingBatchLimit;
        const batchSize = syncResult.summary?.batchSize ?? profileUrls.length;
        if (syncResult.summary?.exhausted) {
          stoppedBeforeRequested = `Sync exhausted after preparing ${batchSize} of ${requested} requested; ${remainingBatchLimit} remain.`;
          log(stoppedBeforeRequested);
          break;
        }
        if (partialSyncRetries >= maxPartialSyncRetries) {
          stoppedBeforeRequested = `Partial sync prepared ${batchSize} of ${requested} requested without proving exhaustion; stopped after ${maxPartialSyncRetries} retry attempts with ${remainingBatchLimit} remaining.`;
          log(stoppedBeforeRequested);
          break;
        }

        partialSyncRetries += 1;
        log(`Partial sync prepared ${batchSize} of ${requested} requested; retrying remaining ${remainingBatchLimit}`);
      }

      if (stoppedBeforeRequested) break;
    }

    if (skipFinalization) {
      return {
        account: answers.linkedinAccount,
        processed: allProfileUrls.length,
        requested: answers.connectionLimit,
        partialReason: stoppedBeforeRequested,
        skippedFinalization: true
      };
    }

    const statusSummary = await summarizeInventoryStatuses(client, allProfileUrls);
    printFinalStatusSummary({
      account: answers.linkedinAccount,
      requested: answers.connectionLimit,
      processed: allProfileUrls.length,
      partialReason: stoppedBeforeRequested,
      statusSummary,
      log
    });

    return {
      account: answers.linkedinAccount,
      processed: allProfileUrls.length,
      requested: answers.connectionLimit,
      partialReason: stoppedBeforeRequested,
      statusSummary
    };
  } finally {
    await context?.close();
    await client.end();
  }
}

function createGuidedWorkflowBatchLimits(totalLimit, maxBatchSize) {
  const total = parseOptionalPositiveInteger(totalLimit) ?? DEFAULT_GUIDED_WORKFLOW_BATCH_SIZE;
  const batchSize = parseOptionalPositiveInteger(maxBatchSize) ?? DEFAULT_GUIDED_WORKFLOW_BATCH_SIZE;
  const batches = [];
  let remaining = total;
  while (remaining > 0) {
    const next = Math.min(batchSize, remaining);
    batches.push(next);
    remaining -= next;
  }
  return batches;
}

async function ensureLinkedInSession(page, { waitForLogin, log }) {
  const result = await waitForLogin(page, { log });
  if (result.status === "session_ready") return;
  if (result.status === "blocked") {
    await waitForLinkedInBlockersToClear(page, { log });
    return;
  }
  throw new Error("LinkedIn login was not completed before the timeout. Rerun the workflow when ready.");
}

export async function writeLocalEnvFile(envPath, values) {
  const existing = await fs.readFile(envPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const parsed = parseEnvLines(existing);
  for (const [key, value] of Object.entries(values)) {
    parsed.set(key, formatEnvValue(value));
  }
  const content = `${[...parsed.entries()].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
  await fs.writeFile(envPath, content, "utf8");
}

export async function summarizeInventoryStatuses(client, profileUrls) {
  const normalizedProfileUrls = normalizeProfileUrls(profileUrls);
  if (normalizedProfileUrls.length === 0) return {};
  const result = await client.query(
    `select workflow_status as status, count(*) as count
     from linkedin_connection_inventory
     where lower(linkedin_profile_url) = any($1::text[])
     group by workflow_status
     order by workflow_status`,
    [normalizedProfileUrls]
  );
  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]));
}

async function findInventoryRowsByProfileUrls(client, profileUrls) {
  const normalizedProfileUrls = normalizeProfileUrls(profileUrls);
  if (normalizedProfileUrls.length === 0) return [];
  const result = await client.query(
    `select id, linkedin_profile_url, workflow_status
     from linkedin_connection_inventory
     where lower(linkedin_profile_url) = any($1::text[])
     order by discovered_at asc`,
    [normalizedProfileUrls]
  );
  return result.rows;
}

async function ensureInventoryAccountColumn(client) {
  await client.query("alter table linkedin_connection_inventory add column if not exists account text");
}

async function askRequired(rl, question) {
  const answer = (await rl.question(question)).trim();
  if (answer) return answer;
  return askRequired(rl, question);
}

async function askRequiredEnvValue(rl, envValues, key) {
  const pastedValue = envValues.get(key);
  if (pastedValue) return unquoteEnvValue(pastedValue);
  return askRequired(rl, `${key}: `);
}

function normalizeLinkedInAccount(answer) {
  const text = String(answer ?? "").trim();
  if (!text) return null;
  const known = LINKEDIN_ACCOUNT_CHOICES.find((choice) => choice.toLowerCase() === text.toLowerCase());
  return known ?? text;
}

async function askLinkedInAccount(rl) {
  const answer = (await rl.question(
    `LinkedIn Account (${LINKEDIN_ACCOUNT_CHOICES.join(", ")}, or type a custom account name): `
  )).trim();
  const normalized = normalizeLinkedInAccount(answer);
  if (!normalized) return askLinkedInAccount(rl);
  return normalized;
}

function parseOptionalPositiveInteger(value) {
  if (value == null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return parsed;
}

async function askConnectionLimit(rl, outputStream = output) {
  outputStream.write("High connection counts can hit LinkedIn usage limits or paid API limits. Start small when unsure.\n");
  const answer = (await rl.question("Number of connections to process: ")).trim();
  const limit = Number.parseInt(answer, 10);
  if (Number.isFinite(limit) && limit > 0) return limit;
  return askConnectionLimit(rl, outputStream);
}

function logStepSummary(result, log) {
  if (result?.summary) {
    log(JSON.stringify(result.summary));
    return;
  }
  if (typeof result?.upserted === "number") {
    log(JSON.stringify({ upserted: result.upserted }));
  }
}

function printFinalStatusSummary({ account, requested, processed, partialReason, statusSummary, log }) {
  log("");
  if (requested && processed < requested) {
    log(`Processed ${processed} of requested ${requested} LinkedIn connections for account: ${account}`);
    if (partialReason) log(partialReason);
  } else {
    log(`Processed ${processed} LinkedIn connections for account: ${account}`);
  }
  log("");
  log("Status summary:");
  for (const [status, count] of Object.entries(statusSummary)) {
    log(`  ${status}: ${count}`);
  }
}

function parseEnvLines(content) {
  const entries = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const assignments = line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|$)/g);
    for (const match of assignments) {
      entries.set(match[1].trim(), match[2].trim());
    }
  }
  return entries;
}

function unquoteEnvValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return text;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

function formatEnvValue(value) {
  const text = String(value ?? "");
  if (/[\s#"'\\]/.test(text)) return JSON.stringify(text);
  return text;
}

function normalizeProfileUrls(profileUrls) {
  return [...new Set((profileUrls ?? []).map((url) => String(url ?? "").trim().toLowerCase()).filter(Boolean))];
}
