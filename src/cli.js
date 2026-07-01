#!/usr/bin/env node
import path from "node:path";

import { validateConfig } from "./config.js";
import { createDbClient } from "./db/client.js";
import { runGuidedWorkflowFromCli } from "./guidedWorkflow.js";
import { createLinkedInBrowserSession, waitForLinkedInBlockersToClear } from "./linkedin/browser.js";
import {
  ConnectionInventoryRepository,
  extractConnectionCardsFromPage,
  syncLinkedInConnections
} from "./linkedin/connectionSync.js";
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
import { openLinkedInLoginSession, waitForLinkedInLogin } from "./linkedin/login.js";
import { selectQueuedInventory } from "./queue.js";
import { dedupeInventory, DedupeInventoryRepository } from "./workflow/dedupeInventory.js";
import { CandidateFileRepository } from "./workflow/candidateFiles.js";
import { inspectWorkflowStatus } from "./workflow/inspectStatus.js";
import {
  createPlaywrightProfileExtractor,
  processQueuedProfiles,
  ProcessQueueRepository,
  refreshProfileCaptures
} from "./workflow/processQueue.js";
import { PortalCandidateAdapter } from "./adapters/portalCandidates.js";
import {
  scoreExtractedProfiles,
  ScoreExtractedProfilesRepository
} from "./workflow/scoreExtractedProfiles.js";
import {
  submitQualifiedCandidates,
  SubmitQualifiedCandidatesRepository
} from "./workflow/submitQualifiedCandidates.js";
import { captureCompanyWebsiteWithPlaywright } from "./company/websiteCapture.js";
import { CompanyWebsiteRepository, syncCompanyWebsites } from "./workflow/syncCompanyWebsites.js";
import { SingleProfileRepository, runProcessSingleProfile } from "./workflow/processSingleProfile.js";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);

async function main() {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "check-config") {
    const dryRun = args.includes("--dry-run");
    const config = validateConfig(process.env, { dryRun });
    console.log(`Configuration OK. Default batch limit: ${config.defaultBatchLimit}`);
    return;
  }

  if (command === "guided-workflow") {
    await runGuidedWorkflowFromCli({
      skipFinalization: args.includes("--skip-finalization"),
      account: readStringFlag(args, "--account"),
      limit: readNumberFlag(args, "--limit")
    });
    return;
  }

  if (command === "process-profile") {
    const profileUrl = readStringFlag(args, "--profile-url");
    if (!profileUrl) throw new Error("--profile-url is required.");
    const duplicateAction = args.includes("--reprocess")
      ? "reprocess"
      : args.includes("--skip-duplicate")
        ? "skip"
        : undefined;
    const config = validateConfig(process.env, { dryRun: false, requireOpenAI: false });
    const account = process.env.LINKEDIN_ACCOUNT;
    const client = await connectedDbClient(config.databaseUrl);
    let context;
    let pagePromise;
    async function getPage() {
      if (!context) {
        const playwright = await import("playwright");
        context = await createLinkedInBrowserSession({
          profilePath: config.linkedinBrowserProfilePath,
          playwright
        });
      }
      if (!pagePromise) {
        pagePromise = (async () => {
          const page = context.pages()[0] ?? await context.newPage();
          await ensureLinkedInSessionForCli(page);
          return page;
        })();
      }
      return pagePromise;
    }
    try {
      const candidateRepository = new CandidateFileRepository({
        directory: path.join(process.cwd(), ".lead-enrichment-candidates")
      });
      const result = await runProcessSingleProfile({
        profileUrl,
        account,
        duplicateAction,
        skipFinalization: args.includes("--skip-finalization"),
        candidateRepository,
        dependencies: {
          repository: new SingleProfileRepository(client),
          processQueuedProfiles: async ({ candidateRepository, limit, profileUrls }) =>
            processQueuedProfiles({
              queueRepository: new ProcessQueueRepository(client),
              candidateRepository,
              extractProfile: async (item) => createPlaywrightProfileExtractor(await getPage(), { log: console.error })(item),
              limit,
              profileUrls
            }),
          syncCompanyProfiles: async ({ candidateRepository, limit, profileUrls }) =>
            syncCompanyProfiles({
              repository: new CompanyProfileRepository(client),
              candidateRepository,
              extractCompany: async (item) =>
                extractCompanyProfileFromPage(await getPage(), { companyUrl: item.currentCompanyUrl, log: console.error }),
              limit,
              profileUrls
            }),
          dedupeInventory: async ({ limit, profileUrls }) =>
            dedupeInventory({
              inventoryRepository: new DedupeInventoryRepository(client),
              limit,
              profileUrls
            }),
          syncLinkedInActivityItems: async ({ candidateRepository, limit, profileUrls }) => {
            const activityRepository = new ActivityItemsRepository(client);
            return syncLinkedInActivityItems({
              inventoryRepository: activityRepository,
              activityRepository,
              candidateRepository,
              extractActivities: async (item) =>
                extractActivityItemsFromPage(await getPage(), {
                  profileUrl: item.linkedinProfileUrl,
                  limit: 10,
                  log: console.error
                }),
              limit,
              profileUrls
            });
          },
          syncCompanyWebsites: async ({ candidateRepository, limit, inventoryIds }) =>
            syncCompanyWebsites({
              candidateRepository,
              repository: new CompanyWebsiteRepository(client),
              captureWebsite: async (url) => captureCompanyWebsiteWithPlaywright(await getPage(), url),
              limit,
              inventoryIds
            }),
          submitQualifiedCandidates: async ({ candidateRepository, limit, inventoryIds }) =>
            submitQualifiedCandidates({
              candidateRepository,
              portalCandidates: new PortalCandidateAdapter({
                endpointUrl: config.portalQualifiedIngestUrl,
                callbackSecret: config.portalCallbackSecret
              }),
              repository: new SubmitQualifiedCandidatesRepository(client),
              limit,
              inventoryIds
            })
        },
        log: console.error
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await client.end();
      await context?.close();
    }
    return;
  }

  if (command === "inspect-status") {
    const config = validateConfig(process.env, { dryRun: true });
    const client = await createDbClient(config.databaseUrl);
    await client.connect();
    try {
      const status = await inspectWorkflowStatus(client);
      console.log(JSON.stringify(status, null, 2));
    } finally {
      await client.end();
    }
    return;
  }

  if (command === "login-linkedin") {
    const config = validateConfig(process.env, { dryRun: true });
    const playwright = await import("playwright");
    const result = await openLinkedInLoginSession({
      profilePath: config.linkedinBrowserProfilePath,
      playwright
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "sync-connections") {
    const dryRun = args.includes("--dry-run");
    const limit = readNumberFlag(args, "--limit");
    const config = validateConfig(process.env, { dryRun: true });
    const playwright = await import("playwright");
    const context = await createLinkedInBrowserSession({
      profilePath: config.linkedinBrowserProfilePath,
      playwright
    });
    let client;
    try {
      const page = context.pages()[0] ?? await context.newPage();
      client = await connectedDbClient(config.databaseUrl);
      const result = await syncLinkedInConnections({
        extractConnections: async (options = {}) => {
          return extractConnectionCardsFromPage(page, { ...options, log: console.error });
        },
        inventoryRepository: new ConnectionInventoryRepository(client),
        dryRun,
        limit
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await client?.end();
      await context.close();
    }
    return;
  }

  if (command === "dedupe-inventory") {
    const dryRun = args.includes("--dry-run");
    const limit = readNumberFlag(args, "--limit");
    const config = validateConfig(process.env, { dryRun: true });
    const client = await connectedDbClient(config.databaseUrl);
    try {
      const result = await dedupeInventory({
        inventoryRepository: new DedupeInventoryRepository(client),
        limit,
        dryRun
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await client.end();
    }
    return;
  }

  if (command === "process-queue") {
    const limit = readNumberFlag(args, "--limit");
    const dryRun = args.includes("--dry-run");
    const config = validateConfig(process.env, { dryRun: true });
    const browser = createLazyLinkedInBrowser(config);
    const client = await connectedDbClient(config.databaseUrl);
    try {
      const result = await processQueuedProfiles({
        queueRepository: new ProcessQueueRepository(client),
        candidateRepository: new CandidateFileRepository({
          directory: path.join(process.cwd(), ".lead-enrichment-candidates")
        }),
        extractProfile: async (item) => {
          const page = await browser.page();
          return createPlaywrightProfileExtractor(page, { log: console.error })(item);
        },
        limit: limit ?? config.defaultBatchLimit,
        dryRun
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await client.end();
      await browser.close();
    }
    return;
  }

  if (command === "refresh-profiles") {
    const limit = readNumberFlag(args, "--limit");
    const dryRun = args.includes("--dry-run");
    const profileUrls = readStringFlags(args, "--profile-url");
    const config = validateConfig(process.env, { dryRun: true });
    const client = await connectedDbClient(config.databaseUrl);
    const browser = createLazyLinkedInBrowser(config);
    try {
      const repository = new ProcessQueueRepository(client);
      const result = await refreshProfileCaptures({
        repository,
        candidateRepository: new CandidateFileRepository({
          directory: path.join(process.cwd(), ".lead-enrichment-candidates")
        }),
        extractProfile: async (item) => {
          const page = await browser.page();
          return createPlaywrightProfileExtractor(page, { log: console.error })(item);
        },
        limit: limit ?? config.defaultBatchLimit,
        profileUrls,
        dryRun
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await client.end();
      await browser.close();
    }
    return;
  }

  if (command === "score-fits") {
    const dryRun = args.includes("--dry-run");
    const includeScored = args.includes("--rescore");
    const limit = readNumberFlag(args, "--limit");
    const config = validateConfig(process.env, {
      dryRun: true,
      requireDatabase: !dryRun,
      requireOpenAI: false
    });
    const client = dryRun ? null : await connectedDbClient(config.databaseUrl);
    try {
      const result = await scoreExtractedProfiles({
        candidateRepository: new CandidateFileRepository({
          directory: path.join(process.cwd(), ".lead-enrichment-candidates")
        }),
        repository: client ? new ScoreExtractedProfilesRepository(client) : null,
        limit: limit ?? config.defaultBatchLimit,
        dryRun,
        includeScored
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await client?.end();
    }
    return;
  }

  if (command === "submit-qualified") {
    const dryRun = args.includes("--dry-run");
    const limit = readNumberFlag(args, "--limit");
    const config = validateConfig(process.env, {
      dryRun,
      requireDatabase: !dryRun,
      requireOpenAI: false
    });
    const client = dryRun ? null : await connectedDbClient(config.databaseUrl);
    try {
      const result = await submitQualifiedCandidates({
        candidateRepository: new CandidateFileRepository({
          directory: path.join(process.cwd(), ".lead-enrichment-candidates")
        }),
        portalCandidates: new PortalCandidateAdapter({
          endpointUrl: config.portalQualifiedIngestUrl,
          callbackSecret: config.portalCallbackSecret
        }),
        repository: new SubmitQualifiedCandidatesRepository(client),
        limit: limit ?? config.defaultBatchLimit,
        dryRun
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await client?.end();
    }
    return;
  }

  if (command === "sync-activities") {
    const dryRun = args.includes("--dry-run");
    const limit = readNumberFlag(args, "--limit");
    const config = validateConfig(process.env, { dryRun: true });
    const browser = createLazyLinkedInBrowser(config);
    const client = await connectedDbClient(config.databaseUrl);
    try {
      const repository = new ActivityItemsRepository(client);
      const candidateRepository = new CandidateFileRepository({
        directory: path.join(process.cwd(), ".lead-enrichment-candidates")
      });
      const result = await syncLinkedInActivityItems({
        inventoryRepository: repository,
        activityRepository: repository,
        candidateRepository,
        extractActivities: async (item) => {
          const page = await browser.page();
          return extractActivityItemsFromPage(page, {
            profileUrl: item.linkedinProfileUrl,
            limit: 10,
            log: console.error
          });
        },
        limit: limit ?? config.defaultBatchLimit,
        dryRun
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await client.end();
      await browser.close();
    }
    return;
  }

  if (command === "sync-company-websites") {
    const dryRun = args.includes("--dry-run");
    const resync = args.includes("--resync");
    const limit = readNumberFlag(args, "--limit");
    const config = validateConfig(process.env, { dryRun: true });
    const candidateRepository = new CandidateFileRepository({
      directory: path.join(process.cwd(), ".lead-enrichment-candidates")
    });
    const browser = createLazyLinkedInBrowser(config);
    const client = dryRun ? null : await connectedDbClient(config.databaseUrl);
    try {
      const result = await syncCompanyWebsites({
        candidateRepository,
        repository: client ? new CompanyWebsiteRepository(client) : null,
        captureWebsite: async (url) => {
          const page = await browser.page();
          return captureCompanyWebsiteWithPlaywright(page, url);
        },
        limit: limit ?? config.defaultBatchLimit,
        dryRun,
        resync
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await client?.end();
      await browser.close();
    }
    return;
  }

  if (command === "sync-company-profiles") {
    const dryRun = args.includes("--dry-run");
    const limit = readNumberFlag(args, "--limit");
    const profileUrls = readStringFlags(args, "--profile-url");
    const config = validateConfig(process.env, { dryRun: true });
    const browser = createLazyLinkedInBrowser(config);
    const client = await connectedDbClient(config.databaseUrl);
    try {
      const repository = new CompanyProfileRepository(client);
      const candidateRepository = new CandidateFileRepository({
        directory: path.join(process.cwd(), ".lead-enrichment-candidates")
      });
      const result = await syncCompanyProfiles({
        repository,
        candidateRepository,
        extractCompany: async (item) => {
          const page = await browser.page();
          return extractCompanyProfileFromPage(page, { companyUrl: item.currentCompanyUrl, log: console.error });
        },
        limit: limit ?? config.defaultBatchLimit,
        profileUrls,
        dryRun
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await client.end();
      await browser.close();
    }
    return;
  }

  if (command === "retry-failed") {
    console.log("retry-failed is scaffolded. It will select failed_retryable records whose next_retry_at is due.");
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`LinkedIn Lead Enrichment

Commands:
  check-config [--dry-run]
  inspect-status
  login-linkedin
  guided-workflow [--skip-finalization] [--account NAME] [--limit N]
  process-profile --profile-url URL [--skip-finalization] [--reprocess] [--skip-duplicate]
  sync-connections [--limit N] [--dry-run]
  dedupe-inventory [--limit N] [--dry-run]
  process-queue [--limit N] [--dry-run]
  refresh-profiles [--limit N] [--dry-run] [--profile-url URL]
  sync-activities [--limit N] [--dry-run]
  sync-company-profiles [--limit N] [--dry-run] [--profile-url URL]
  score-fits [--limit N] [--dry-run] [--rescore]
  sync-company-websites [--limit N] [--dry-run] [--resync]
  submit-qualified [--limit N] [--dry-run]
  retry-failed

Notes:
  sync-connections --limit N prepares up to N eligible workflow items. It selects existing discovered/dedupe_pending inventory first, then scans LinkedIn only to top up the batch.
`);
}

async function ensureLinkedInSessionForCli(page) {
  const result = await waitForLinkedInLogin(page, { log: console.error });
  if (result.status === "session_ready") return;
  if (result.status === "blocked") {
    await waitForLinkedInBlockersToClear(page, { log: console.error });
    return;
  }
  throw new Error("LinkedIn login was not completed before the timeout. Rerun the workflow when ready.");
}

async function connectedDbClient(databaseUrl) {
  const client = await createDbClient(databaseUrl);
  await client.connect();
  return client;
}

function createLazyLinkedInBrowser(config) {
  let contextPromise;
  let pagePromise;

  return {
    async page() {
      if (!contextPromise) {
        const playwright = await import("playwright");
        contextPromise = createLinkedInBrowserSession({
          profilePath: config.linkedinBrowserProfilePath,
          playwright
        });
      }

      const context = await contextPromise;
      if (!pagePromise) {
        pagePromise = Promise.resolve(context.pages()[0] ?? context.newPage());
      }
      return pagePromise;
    },
    async close() {
      if (!contextPromise) return;
      const context = await contextPromise;
      await context.close();
    }
  };
}

function readStringFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1) return undefined;
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} must be followed by a value`);
  }
  return value;
}

function readStringFlags(values, flag) {
  const results = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== flag) continue;
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} must be followed by a value`);
    }
    results.push(value);
  }
  return results;
}

function readNumberFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1) return undefined;
  const value = Number.parseInt(values[index + 1], 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${flag} must be followed by a positive integer`);
  }
  return value;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
