import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { PortalCandidateAdapter } from "./adapters/portalCandidates.js";
import { captureCompanyWebsiteWithPlaywright } from "./company/websiteCapture.js";
import { validateConfig } from "./config.js";
import { createDbClient } from "./db/client.js";
import { createLinkedInBrowserSession, detectLinkedInBlockers } from "./linkedin/browser.js";
import {
  ActivityItemsRepository,
  extractActivityItemsFromPage,
  syncLinkedInActivityItems
} from "./linkedin/activitySync.js";
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
import {
  createPlaywrightProfileExtractor,
  processQueuedProfiles,
  ProcessQueueRepository
} from "./workflow/processQueue.js";
import { CandidateFileRepository } from "./workflow/candidateFiles.js";
import { dedupeInventory, DedupeInventoryRepository } from "./workflow/dedupeInventory.js";
import {
  scoreExtractedProfiles,
  ScoreExtractedProfilesRepository
} from "./workflow/scoreExtractedProfiles.js";
import { CompanyWebsiteRepository, syncCompanyWebsites } from "./workflow/syncCompanyWebsites.js";
import {
  submitQualifiedCandidates,
  SubmitQualifiedCandidatesRepository
} from "./workflow/submitQualifiedCandidates.js";

export const LINKEDIN_ACCOUNT_CHOICES = ["kirk", "kathryb", "terri", "sarah", "ice", "siriluk"];

export async function runGuidedWorkflowFromCli(options = {}) {
  const answers = await askGuidedWorkflowQuestions(options);
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
    DEFAULT_BATCH_LIMIT: String(answers.connectionLimit)
  };
  const envPath = path.join(cwd, ".env");
  await writeLocalEnvFile(envPath, envValues);
  Object.assign(env, envValues);

  const config = (dependencies.validateConfig ?? validateConfig)(env, { dryRun: false });
  log(`Configuration saved to ${envPath}`);
  log(`Processing up to ${answers.connectionLimit} LinkedIn connections for account: ${answers.linkedinAccount}`);
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

    log("Step 1/8: sync-connections");
    const syncResult = await syncConnections({
      extractConnections: async () => {
        const connections = await extractConnectionCardsFromPage(page, { limit: answers.connectionLimit });
        const pageText = (await page.textContent("body")) ?? "";
        const blocker = detectLinkedInBlockers(pageText);
        if (blocker.blocked) {
          throw new Error(`LinkedIn browser blocked: ${blocker.kind}`);
        }
        return connections;
      },
      inventoryRepository: new ConnectionInventoryRepository(client),
      account: answers.linkedinAccount
    });
    logStepSummary(syncResult, log);

    const profileUrls = syncResult.connections.map((connection) => connection.linkedinProfileUrl).filter(Boolean);
    const inventoryRows = await findInventoryRowsByProfileUrls(client, profileUrls);
    const inventoryIds = inventoryRows.map((row) => row.id);

    log("Step 2/8: process-queue");
    logStepSummary(await processProfiles({
      queueRepository: new ProcessQueueRepository(client),
      candidateRepository,
      extractProfile: async (item) => createPlaywrightProfileExtractor(page)(item),
      limit: answers.connectionLimit,
      profileUrls
    }), log);

    log("Step 3/8: sync-company-profiles");
    logStepSummary(await syncCompanies({
      repository: new CompanyProfileRepository(client),
      candidateRepository,
      extractCompany: async (item) => extractCompanyProfileFromPage(page, { companyUrl: item.currentCompanyUrl }),
      limit: answers.connectionLimit,
      profileUrls
    }), log);

    log("Step 4/8: dedupe-inventory");
    logStepSummary(await dedupeRows({
      inventoryRepository: new DedupeInventoryRepository(client),
      limit: answers.connectionLimit,
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
          limit: 10
        }),
      limit: answers.connectionLimit,
      profileUrls
    }), log);

    log("Step 6/8: score-fits");
    logStepSummary(await scoreProfiles({
      candidateRepository,
      repository: new ScoreExtractedProfilesRepository(client),
      limit: answers.connectionLimit,
      inventoryIds
    }), log);

    log("Step 7/8: sync-company-websites");
    logStepSummary(await syncWebsites({
      candidateRepository,
      repository: new CompanyWebsiteRepository(client),
      captureWebsite: async (url) => captureCompanyWebsiteWithPlaywright(page, url),
      limit: answers.connectionLimit,
      inventoryIds
    }), log);

    if (skipFinalization) {
      return {
        account: answers.linkedinAccount,
        processed: profileUrls.length,
        skippedFinalization: true
      };
    }

    log("Step 8/8: submit-qualified");
    logStepSummary(await submitCandidates({
      candidateRepository,
      portalCandidates: new PortalCandidateAdapter({
        endpointUrl: config.portalQualifiedIngestUrl,
        callbackSecret: config.portalCallbackSecret
      }),
      repository: new SubmitQualifiedCandidatesRepository(client),
      limit: answers.connectionLimit,
      inventoryIds
    }), log);

    const statusSummary = await summarizeInventoryStatuses(client, profileUrls);
    printFinalStatusSummary({
      account: answers.linkedinAccount,
      processed: profileUrls.length,
      statusSummary,
      log
    });

    return {
      account: answers.linkedinAccount,
      processed: profileUrls.length,
      statusSummary
    };
  } finally {
    await context?.close();
    await client.end();
  }
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

async function askLinkedInAccount(rl) {
  const answer = (await rl.question(
    `LinkedIn Account (${LINKEDIN_ACCOUNT_CHOICES.join(", ")}, or type a custom account name): `
  )).trim();
  if (!answer) return askLinkedInAccount(rl);
  const known = LINKEDIN_ACCOUNT_CHOICES.find((choice) => choice.toLowerCase() === answer.toLowerCase());
  return known ?? answer;
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

function printFinalStatusSummary({ account, processed, statusSummary, log }) {
  log("");
  log(`Processed ${processed} LinkedIn connections for account: ${account}`);
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
