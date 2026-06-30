import { normalizeLinkedInProfileUrl } from "../dedupe.js";
import { waitForLinkedInBlockersToClear } from "./browser.js";
import { toInventoryRecord } from "./sync.js";

const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

export async function extractConnectionCardsFromPage(page, options = {}) {
  await page.goto(options.url ?? CONNECTIONS_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState?.("networkidle", { timeout: options.networkIdleTimeoutMs ?? 10000 }).catch(() => {});
  await waitForLinkedInBlockersToClear(page, { log: options.log });
  const resultLimit = options.scanLimit ?? options.limit;
  const maxScrollTarget = resultLimit ?? options.limit;
  const maxScrollPasses = options.maxScrollPasses ?? Math.max(options.scrollPasses ?? 3, maxScrollTarget ? Math.ceil(maxScrollTarget / 4) + 3 : 8);
  const stableScrollPasses = options.stableScrollPasses ?? 2;
  let rawCards = [];
  let normalized = [];
  let stablePasses = 0;

  for (let pass = 0; pass <= maxScrollPasses; pass += 1) {
    rawCards = await readConnectionCardsFromPage(page, resultLimit);
    const nextNormalized = normalizeConnectionCards(rawCards);
    if (nextNormalized.length > normalized.length) {
      normalized = nextNormalized;
      stablePasses = 0;
    } else {
      stablePasses += 1;
    }

    if (resultLimit && normalized.length >= resultLimit) break;

    const belowScanTarget = resultLimit && normalized.length < resultLimit;
    const reachedScrollBudget = pass >= maxScrollPasses;
    if ((!belowScanTarget || reachedScrollBudget) && pass >= (options.scrollPasses ?? 3) && stablePasses >= stableScrollPasses) {
      break;
    }

    await autoScroll(page, 1);
    await waitForLinkedInBlockersToClear(page, { log: options.log });
  }

  return resultLimit ? normalized.slice(0, resultLimit) : normalized;
}

async function readConnectionCardsFromPage(page, scanLimit) {
  return page.evaluate((scanLimit) => {
    const anchors = [...document.querySelectorAll('a[href*="/in/"]')];
    const cards = [];
    const maxAnchors = scanLimit ? scanLimit * 4 : null;

    for (const anchor of anchors) {
      const href = anchor.href || anchor.getAttribute("href");
      if (!href) continue;

      const card =
        anchor.closest("li") ||
        anchor.closest('[data-view-name*="connection"]') ||
        anchor.closest(".mn-connection-card") ||
        anchor.parentElement;

      cards.push({
        profileHref: href,
        text: card?.innerText || anchor.innerText || ""
      });

      if (maxAnchors && cards.length >= maxAnchors) break;
    }

    return cards;
  }, scanLimit ?? null);
}

export function normalizeConnectionCards(rawCards) {
  const byProfileUrl = new Map();

  for (const rawCard of rawCards) {
    const linkedinProfileUrl = normalizeLinkedInProfileUrl(rawCard.profileHref);
    if (!linkedinProfileUrl) continue;

    const lines = String(rawCard.text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const connection = {
      linkedinProfileUrl,
      fullName: lines[0] ?? null,
      headline: lines[1] ?? null,
      currentCompanyName: null,
      currentCompanyUrl: null
    };
    const record = toInventoryRecord(connection);
    const existing = byProfileUrl.get(record.linkedinProfileUrl);
    byProfileUrl.set(record.linkedinProfileUrl, mergeConnectionRecord(existing, record));
  }

  return [...byProfileUrl.values()];
}

export async function syncLinkedInConnections({
  extractConnections,
  inventoryRepository,
  dryRun = false,
  account = null,
  limit
}) {
  if (typeof limit === "number" && inventoryRepository?.listEligibleForEnrichment) {
    return syncUsefulConnectionBatch({
      extractConnections,
      inventoryRepository,
      dryRun,
      account,
      limit
    });
  }

  const connections = (await extractConnections()).map((connection) => ({
    ...connection,
    account: account ?? connection.account ?? null
  }));
  if (dryRun) {
    return { status: "dry_run", connections };
  }

  const result = await inventoryRepository.upsertMany(connections);
  return { status: "synced", connections, upserted: result.upserted };
}

async function syncUsefulConnectionBatch({
  extractConnections,
  inventoryRepository,
  dryRun,
  account,
  limit
}) {
  const existing = await inventoryRepository.listEligibleForEnrichment({ limit, account });
  const existingConnections = existing.map(inventoryRowToConnection);
  const remaining = Math.max(0, limit - existingConnections.length);
  let discovered = [];
  let upserted = 0;
  let exhausted = remaining > 0;
  let scanAttempts = 0;

  if (remaining > 0) {
    const discoveryResult = await discoverTopUpConnections({
      extractConnections,
      inventoryRepository,
      account,
      remaining
    });
    discovered = discoveryResult.discovered;
    exhausted = discoveryResult.exhausted;
    scanAttempts = discoveryResult.scanAttempts;

    if (!dryRun && discovered.length > 0) {
      const result = await inventoryRepository.upsertMany(discovered);
      upserted = result.upserted;
    }
  }

  const connections = [...existingConnections, ...discovered].slice(0, limit);
  const profileUrls = connections.map((connection) => connection.linkedinProfileUrl).filter(Boolean);
  let inventoryIds = existing.map((row) => row.id).filter(Boolean).slice(0, existingConnections.length);
  if (!dryRun && profileUrls.length > 0 && inventoryRepository.findByProfileUrls) {
    const selectedRows = await inventoryRepository.findByProfileUrls(profileUrls);
    const rowsByUrl = new Map(selectedRows.map((row) => [row.linkedinProfileUrl, row]));
    const selectedIds = profileUrls.map((url) => rowsByUrl.get(url)?.id).filter(Boolean);
    if (selectedIds.length > 0) inventoryIds = selectedIds;
  }

  return {
    status: dryRun ? "dry_run" : "synced",
    connections,
    profileUrls,
    inventoryIds,
    summary: {
      requested: limit,
      batchSize: connections.length,
      existingSelected: existingConnections.length,
      discovered: discovered.length,
      upserted,
      remaining: Math.max(0, limit - connections.length),
      exhausted,
      scanAttempts
    },
    upserted
  };
}

async function discoverTopUpConnections({
  extractConnections,
  inventoryRepository,
  account,
  remaining
}) {
  const attempts = [
    { scanLimit: remaining * 4, scrollPasses: 3 },
    { scanLimit: remaining * 4, scrollPasses: 6 },
    { scanLimit: remaining * 6, scrollPasses: 9 }
  ];
  let discovered = [];
  let peakExtractedCount = 0;
  let noGrowthAttempts = 0;
  let scanAttempts = 0;
  const hardScanLimit = attempts.at(-1).scanLimit;

  for (const attempt of attempts) {
    scanAttempts += 1;
    const extracted = (await extractConnections({
      limit: remaining,
      scanLimit: attempt.scanLimit,
      scrollPasses: attempt.scrollPasses
    })).map((connection) => ({
      ...connection,
      account: account ?? connection.account ?? null
    }));
    const extractedCount = extracted.length;
    if (extractedCount > peakExtractedCount) {
      peakExtractedCount = extractedCount;
      noGrowthAttempts = 0;
    } else {
      noGrowthAttempts += 1;
    }

    const extractedUrls = extracted.map((connection) => connection.linkedinProfileUrl).filter(Boolean);
    const knownRows = inventoryRepository.findByProfileUrls
      ? await inventoryRepository.findByProfileUrls(extractedUrls)
      : [];
    const knownUrls = new Set(knownRows.map((row) => row.linkedinProfileUrl));
    const seenUrls = new Set();

    discovered = extracted
      .filter((connection) => {
        if (!connection.linkedinProfileUrl) return false;
        if (knownUrls.has(connection.linkedinProfileUrl)) return false;
        if (seenUrls.has(connection.linkedinProfileUrl)) return false;
        seenUrls.add(connection.linkedinProfileUrl);
        return true;
      })
      .slice(0, remaining);

    if (discovered.length >= remaining) {
      return { discovered, exhausted: false, scanAttempts };
    }
  }

  const hardCapReached = peakExtractedCount >= hardScanLimit;
  const pageStoppedGrowing = noGrowthAttempts >= 1;

  return {
    discovered,
    exhausted: discovered.length < remaining && pageStoppedGrowing && !hardCapReached,
    scanAttempts
  };
}

export class ConnectionInventoryRepository {
  constructor(client) {
    this.client = client;
  }

  async upsertMany(records) {
    let upserted = 0;
    for (const record of records) {
      if (!record.linkedinProfileUrl) continue;
      await this.upsertOne(record);
      upserted += 1;
    }
    return { upserted };
  }

  async listEligibleForEnrichment({ limit, account } = {}) {
    const params = [];
    const accountClause = account ? `and account = $${params.push(account)}` : "";
    const limitClause = limit ? `limit $${params.push(limit)}` : "";
    const result = await this.client.query(
      `select
         id,
         linkedin_profile_url,
         full_name,
         headline,
         current_company_name,
         current_company_url,
         account,
         dedupe_status,
         workflow_status
       from linkedin_connection_inventory
       where workflow_status = 'discovered'
         and dedupe_status = 'dedupe_pending'
         ${accountClause}
       order by queued_at asc nulls last, discovered_at asc
       ${limitClause}`,
      params
    );
    return result.rows.map(toCamelInventory);
  }

  async findByProfileUrls(profileUrls = []) {
    const urls = [...new Set(profileUrls.map(normalizeLinkedInProfileUrl).filter(Boolean))];
    if (urls.length === 0) return [];
    const result = await this.client.query(
      `select
         id,
         linkedin_profile_url,
         full_name,
         headline,
         current_company_name,
         current_company_url,
         account,
         dedupe_status,
         workflow_status
       from linkedin_connection_inventory
       where lower(linkedin_profile_url) = any($1::text[])`,
      [urls.map((url) => url.toLowerCase())]
    );
    return result.rows.map(toCamelInventory);
  }

  async upsertOne(record) {
    return this.client.query(
      `insert into linkedin_connection_inventory (
         linkedin_profile_url,
         full_name,
         headline,
         current_company_name,
         current_company_url,
         account,
         dedupe_status,
         workflow_status,
         last_seen_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (lower(linkedin_profile_url)) where linkedin_profile_url is not null
       do update set
         full_name = coalesce(excluded.full_name, linkedin_connection_inventory.full_name),
         headline = coalesce(excluded.headline, linkedin_connection_inventory.headline),
         current_company_name = coalesce(excluded.current_company_name, linkedin_connection_inventory.current_company_name),
         current_company_url = coalesce(excluded.current_company_url, linkedin_connection_inventory.current_company_url),
         account = coalesce(excluded.account, linkedin_connection_inventory.account),
         last_seen_at = now()`,
      [
        record.linkedinProfileUrl,
        record.fullName,
        record.headline,
        record.currentCompanyName,
        record.currentCompanyUrl,
        record.account,
        record.dedupeStatus,
        record.workflowStatus
      ]
    );
  }
}

async function autoScroll(page, passes) {
  for (let index = 0; index < passes; index += 1) {
    await page.evaluate(() => {
      const scrollToBottom = (element) => {
        if (!element) return;
        element.scrollTop = element.scrollHeight;
      };

      for (const selector of [
        ".scaffold-finite-scroll__content",
        ".scaffold-finite-scroll",
        '[data-view-name="connections-list"]',
        "main.scaffold-layout__main",
        "main"
      ]) {
        scrollToBottom(document.querySelector(selector));
      }

      scrollToBottom(document.scrollingElement ?? document.documentElement);
      window.scrollTo(0, document.body.scrollHeight);
      window.scrollBy(0, window.innerHeight);
    });

    if (page.keyboard?.press) {
      await page.keyboard.press("PageDown").catch(() => {});
      await page.keyboard.press("End").catch(() => {});
    }

    await page.waitForTimeout?.(800);
  }
}

function mergeConnectionRecord(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing,
    fullName: existing.fullName ?? incoming.fullName,
    headline: existing.headline ?? incoming.headline,
    currentCompanyName: existing.currentCompanyName ?? incoming.currentCompanyName,
    currentCompanyUrl: existing.currentCompanyUrl ?? incoming.currentCompanyUrl
  };
}

function inventoryRowToConnection(row) {
  return {
    linkedinProfileUrl: row.linkedinProfileUrl ?? row.linkedin_profile_url,
    fullName: row.fullName ?? row.full_name ?? null,
    headline: row.headline ?? null,
    currentCompanyName: row.currentCompanyName ?? row.current_company_name ?? null,
    currentCompanyUrl: row.currentCompanyUrl ?? row.current_company_url ?? null,
    account: row.account ?? null,
    dedupeStatus: row.dedupeStatus ?? row.dedupe_status ?? "dedupe_pending",
    workflowStatus: row.workflowStatus ?? row.workflow_status ?? "discovered"
  };
}

function toCamelInventory(row) {
  return {
    id: row.id,
    linkedinProfileUrl: row.linkedin_profile_url,
    fullName: row.full_name,
    headline: row.headline,
    currentCompanyName: row.current_company_name,
    currentCompanyUrl: row.current_company_url,
    account: row.account,
    dedupeStatus: row.dedupe_status,
    workflowStatus: row.workflow_status
  };
}
