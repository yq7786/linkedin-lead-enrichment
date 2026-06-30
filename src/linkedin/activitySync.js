import { normalizeLinkedInProfileUrl } from "../dedupe.js";
import { waitForLinkedInBlockersToClear } from "./browser.js";

const DEFAULT_ACTIVITY_LIMIT = 10;

export async function extractActivityItemsFromPage(page, options = {}) {
  const profileUrl = normalizeLinkedInProfileUrl(options.profileUrl);
  if (!profileUrl) throw new Error("profileUrl is required for activity extraction.");

  const activityUrl = `${profileUrl.replace(/\/$/, "")}/recent-activity/all/`;
  await page.goto(activityUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState?.("networkidle", { timeout: options.networkIdleTimeoutMs ?? 10000 }).catch(() => {});
  await waitForLinkedInBlockersToClear(page, { log: options.log });
  await autoScroll(page, options.scrollPasses ?? 3);
  await expandTruncatedActivityContent(page, options.expandPasses ?? 3);
  await waitForLinkedInBlockersToClear(page, { log: options.log });

  const rawCards = await page.evaluate((limit) => {
    const nodes = [
      ...document.querySelectorAll('[data-urn*="activity"], .feed-shared-update-v2, article, li')
    ];
    const cards = [];

    for (const node of nodes) {
      const text = node.innerText || "";
      if (!text.trim()) continue;
      if (!/\b(posted|commented|reposted|shared|\d+\s*(d|w|wk|mo|month|year|yr))\b/i.test(text)) continue;

      const link =
        node.querySelector('a[href*="/feed/update/"]') ||
        node.querySelector('a[href*="/posts/"]') ||
        node.querySelector('a[href*="activity-"]');

      cards.push({
        text,
        activityHref: link?.href || link?.getAttribute("href") || null
      });

      if (cards.length >= limit * 3) break;
    }

    return cards;
  }, options.limit ?? DEFAULT_ACTIVITY_LIMIT);

  return normalizeActivityCards(rawCards, options);
}

export function normalizeActivityCards(rawCards = [], options = {}) {
  const limit = options.limit ?? DEFAULT_ACTIVITY_LIMIT;
  const now = options.now ?? new Date();
  const seen = new Set();
  const items = [];

  for (const rawCard of rawCards) {
    const text = cleanText(rawCard.text);
    if (!text) continue;

    const activityType = inferActivityType(text);
    if (!["post", "comment"].includes(activityType)) continue;

    const relativeTime = extractRelativeTime(text);
    const postedAt = relativeTime ? estimatePostedAt(relativeTime.amount, relativeTime.unit, now).toISOString() : null;
    const activityUrl = normalizeActivityUrl(rawCard.activityHref);
    const content = extractActivityContent(text).slice(0, 4000);
    if (!content) continue;
    const identity = activityUrl || content;
    if (seen.has(identity)) continue;
    seen.add(identity);

    items.push({
      activityType,
      activityUrl,
      postedAt,
      content,
      markdown: text,
      isVisiblePostOrCommentWithin6Months: isWithinRecentWindow(postedAt, now)
    });

    if (items.length >= limit) break;
  }

  return items;
}

export async function syncLinkedInActivityItems({
  inventoryRepository,
  activityRepository,
  candidateRepository,
  extractActivities,
  limit,
  profileUrls,
  dryRun = false
}) {
  const candidates = await inventoryRepository.listActivityCandidates({ limit, profileUrls });
  const summary = { profilesProcessed: 0, activitiesCaptured: 0, failed: 0 };
  const items = [];

  for (const candidate of candidates) {
    try {
      const activities = await extractActivities(candidate);
      summary.profilesProcessed += 1;
      summary.activitiesCaptured += activities.length;
      items.push({
        inventoryId: candidate.inventoryId,
        status: "activities_extracted",
        activitiesCaptured: activities.length
      });

      if (!dryRun) {
        await candidateRepository?.upsertCandidate({
          inventoryId: candidate.inventoryId,
          patch: {
            activityCapture: {
              capturedAt: new Date().toISOString(),
              items: activities.map(({ markdown, ...activity }) => activity)
            }
          },
          status: "activity_captured"
        });
        await inventoryRepository.markActivitiesExtracted?.(candidate.inventoryId);
      }
    } catch (error) {
      summary.failed += 1;
      items.push({
        inventoryId: candidate.inventoryId,
        status: "failed",
        error: error.message
      });
    }
  }

  return {
    status: dryRun ? "dry_run" : "synced",
    summary,
    items
  };
}

export class ActivityItemsRepository {
  constructor(client) {
    this.client = client;
  }

  async listActivityCandidates({ limit, profileUrls } = {}) {
    const params = [];
    const normalizedProfileUrls = normalizeProfileUrlFilter(profileUrls);
    const profileFilter = normalizedProfileUrls.length
      ? `and lower(linkedin_profile_url) = any($${params.push(normalizedProfileUrls)}::text[])`
      : "";
    const limitClause = limit ? `limit $${params.push(limit)}` : "";

    const result = await this.client.query(
      `select
         id as inventory_id,
         individual_id,
         linkedin_profile_url
       from linkedin_connection_inventory
       where linkedin_profile_url is not null
         and workflow_status = 'company_captured'
         and dedupe_status = 'not_found'
         ${profileFilter}
       order by discovered_at asc
       ${limitClause}`,
      params
    );

    return result.rows.map((row) => ({
      inventoryId: row.inventory_id,
      individualId: row.individual_id,
      linkedinProfileUrl: row.linkedin_profile_url
    }));
  }

  async replaceActivityItems(item, activities) {
    await this.markActivitiesExtracted(item.inventoryId);
  }

  async markActivitiesExtracted(inventoryId) {
    await this.client.query(
      `update linkedin_connection_inventory
       set workflow_status = 'activity_captured',
           current_step = 'linkedin_activity_extracted'
       where id = $1`,
      [inventoryId]
    );
  }
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeProfileUrlFilter(profileUrls) {
  return [...new Set((profileUrls ?? []).map((url) => String(url ?? "").trim().toLowerCase()).filter(Boolean))];
}

function extractActivityContent(text) {
  const lines = cleanText(text).split(/\r?\n/).map((line) => line.trim());
  const timeIndex = lines.findIndex((line) => Boolean(extractRelativeTime(line)));
  const contentLines = [];
  const source = timeIndex === -1 ? lines : lines.slice(timeIndex + 1);

  for (const line of source) {
    if (!line) {
      if (contentLines.length > 0) contentLines.push("");
      continue;
    }
    if (isActivityMetadataLine(line)) {
      if (contentLines.length === 0) continue;
      if (isHardActivityBoundary(line)) break;
      continue;
    }
    if (contentLines.length > 0 && isActivityFooterLine(line)) break;
    contentLines.push(line);
  }

  return contentLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isActivityMetadataLine(line) {
  return (
    /^Feed post number \d+$/i.test(line) ||
    /^Follow$/i.test(line) ||
    /^hashtag$/i.test(line) ||
    /^Activate to view larger image/i.test(line) ||
    /^\d[\d,]*(\s+\d[\d,]*){0,3}$/.test(line) ||
    /^[\d,]+\s+followers$/i.test(line) ||
    /^…\s?more$/i.test(line) ||
    /^Show all comments$/i.test(line)
  );
}

function isHardActivityBoundary(line) {
  return /^…\s?more$/i.test(line) || /^Show all comments$/i.test(line);
}

function isActivityFooterLine(line) {
  return (
    /^(Like|Comment|Repost|Send|Share)$/i.test(line) ||
    /^[\d,]+\s+(comment|comments|repost|reposts|reaction|reactions)$/i.test(line)
  );
}

function inferActivityType(text) {
  if (/\bcommented\b/i.test(text)) return "comment";
  if (/\b(posted|shared|reposted)\b/i.test(text)) return "post";
  return "post";
}

function extractRelativeTime(text) {
  const match = String(text).match(/\b(\d+)\s*(d|day|days|w|wk|week|weeks|mo|mos|month|months|y|yr|year|years)\b/i);
  if (!match) return null;
  return { amount: Number.parseInt(match[1], 10), unit: match[2].toLowerCase() };
}

function estimatePostedAt(amount, unit, now) {
  const date = new Date(now.getTime());
  if (unit.startsWith("d")) {
    date.setUTCDate(date.getUTCDate() - amount);
  } else if (unit === "w" || unit === "wk" || unit.startsWith("week")) {
    date.setUTCDate(date.getUTCDate() - amount * 7);
  } else if (unit.startsWith("mo") || unit.startsWith("month")) {
    date.setUTCMonth(date.getUTCMonth() - amount);
  } else {
    date.setUTCFullYear(date.getUTCFullYear() - amount);
  }
  return date;
}

function isWithinRecentWindow(postedAt, now) {
  if (!postedAt) return false;
  const date = new Date(postedAt);
  if (Number.isNaN(date.getTime())) return false;
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  return date >= cutoff && date <= now;
}

function normalizeActivityUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value, "https://www.linkedin.com");
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function autoScroll(page, passes) {
  for (let index = 0; index < passes; index += 1) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout?.(500);
  }
}

async function expandTruncatedActivityContent(page, passes) {
  for (let pass = 0; pass < passes; pass += 1) {
    const clicked = await page.evaluate(() => {
      const controls = [...document.querySelectorAll("button, span[role='button']")];
      let count = 0;
      for (const control of controls) {
        const label = `${control.innerText || ""} ${control.getAttribute("aria-label") || ""}`.trim();
        if (!/(^|\s)(see more|show more|…more|more)(\s|$)/i.test(label)) continue;
        const button = control.closest("button") || control;
        button.click();
        count += 1;
        if (count >= 25) break;
      }
      return count;
    }).catch(() => 0);
    if (!clicked) break;
    await page.waitForTimeout?.(300);
  }
}
