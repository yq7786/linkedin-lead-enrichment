#!/usr/bin/env node
import path from "node:path";

import { validateConfig } from "./config.js";
import { createDbClient } from "./db/client.js";
import { runGuidedWorkflowFromCli } from "./guidedWorkflow.js";
import { createLinkedInBrowserSession, detectLinkedInBlockers } from "./linkedin/browser.js";
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
import { openLinkedInLoginSession } from "./linkedin/login.js";
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
      skipFinalization: args.includes("--skip-finalization")
    });
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
      const result = await syncLinkedInConnections({
        extractConnections: async () => {
          const connections = await extractConnectionCardsFromPage(page, { limit });
          const pageText = (await page.textContent("body")) ?? "";
          const blocker = detectLinkedInBlockers(pageText);
          if (blocker.blocked) {
            throw new Error(`LinkedIn browser blocked: ${blocker.kind}`);
          }
          return connections;
        },
        inventoryRepository: dryRun
          ? null
          : new ConnectionInventoryRepository((client = await connectedDbClient(config.databaseUrl))),
        dryRun
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
          return createPlaywrightProfileExtractor(page)(item);
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
          return createPlaywrightProfileExtractor(page)(item);
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
            limit: 10
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
          return extractCompanyProfileFromPage(page, { companyUrl: item.currentCompanyUrl });
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
  guided-workflow [--skip-finalization]
  sync-connections [--limit N] [--dry-run]
  dedupe-inventory [--limit N] [--dry-run]
  process-queue [--limit N] [--dry-run]
  refresh-profiles [--limit N] [--dry-run]
  sync-activities [--limit N] [--dry-run]
  sync-company-profiles [--limit N] [--dry-run]
  score-fits [--limit N] [--dry-run] [--rescore]
  sync-company-websites [--limit N] [--dry-run] [--resync]
  submit-qualified [--limit N] [--dry-run]
  retry-failed
`);
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
