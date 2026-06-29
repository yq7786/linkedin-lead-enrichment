import { normalizeLinkedInProfileUrl } from "../dedupe.js";
import { toInventoryRecord } from "./sync.js";

const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

export async function extractConnectionCardsFromPage(page, options = {}) {
  await page.goto(options.url ?? CONNECTIONS_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState?.("networkidle", { timeout: options.networkIdleTimeoutMs ?? 10000 }).catch(() => {});
  await autoScroll(page, options.scrollPasses ?? 3);

  const rawCards = await page.evaluate((limit) => {
    const anchors = [...document.querySelectorAll('a[href*="/in/"]')];
    const cards = [];
    const maxAnchors = limit ? limit * 4 : null;

    for (const anchor of anchors) {
      const href = anchor.href || anchor.getAttribute("href");
      if (!href) continue;

      const card =
        anchor.closest("li") ||
        anchor.closest('[data-view-name*="connection"]') ||
        anchor.closest(".mn-connection-card") ||
        anchor.parentElement;
      const companyAnchor = card?.querySelector('a[href*="/company/"]');

      cards.push({
        profileHref: href,
        text: card?.innerText || anchor.innerText || "",
        companyHref: companyAnchor?.href || companyAnchor?.getAttribute("href") || null
      });

      if (maxAnchors && cards.length >= maxAnchors) break;
    }

    return cards;
  }, options.limit ?? null);

  const normalized = normalizeConnectionCards(rawCards);
  return options.limit ? normalized.slice(0, options.limit) : normalized;
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
      currentCompanyName: rawCard.currentCompanyName ?? extractCompanyName(lines[1]),
      currentCompanyUrl: normalizeLinkedInProfileUrl(rawCard.companyHref)
    };
    const record = toInventoryRecord(connection);
    const existing = byProfileUrl.get(record.linkedinProfileUrl);
    byProfileUrl.set(record.linkedinProfileUrl, mergeConnectionRecord(existing, record));
  }

  return [...byProfileUrl.values()];
}

export async function syncLinkedInConnections({ extractConnections, inventoryRepository, dryRun = false, account = null }) {
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
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout?.(500);
  }
}

function extractCompanyName(headline) {
  const match = String(headline ?? "").match(/\bat\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
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
