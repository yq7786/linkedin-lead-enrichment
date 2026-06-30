import { normalizeLinkedInProfileUrl } from "../dedupe.js";
import { waitForLinkedInBlockersToClear } from "./browser.js";

export async function extractCompanyProfileFromPage(page, options = {}) {
  const companyUrl = normalizeCompanyUrl(options.companyUrl);
  if (!companyUrl) throw new Error("companyUrl is required for company profile extraction.");

  const aboutUrl = `${companyUrl.replace(/\/$/, "")}/about/`;
  await page.goto(aboutUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState?.("networkidle", { timeout: options.networkIdleTimeoutMs ?? 10000 }).catch(() => {});
  await waitForLinkedInBlockersToClear(page, { log: options.log });

  const capture = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      sourceUrl: window.location.href,
      html: main?.outerHTML || document.body?.outerHTML || "",
      text: main?.innerText || document.body?.innerText || "",
      links: [...document.querySelectorAll("main a[href], a[href]")]
        .map((anchor) => anchor.href || anchor.getAttribute("href"))
        .filter(Boolean)
    };
  });

  return normalizeCompanyProfileCapture(capture);
}

export function normalizeCompanyProfileCapture(capture) {
  return {
    source: "linkedin_company_profile",
    sourceUrl: normalizeCompanyUrl(capture.sourceUrl),
    facts: {
      name: extractCompanyName(capture.html) ?? firstNonLabelLine(capture.text),
      overview: extractOverview(capture.text),
      website: normalizeExternalUrl(findWebsiteUrl(capture.links) ?? fieldAfterLabel(capture.text, "Website")),
      phone: fieldAfterLabel(capture.text, "Phone"),
      industry: fieldAfterLabel(capture.text, "Industry"),
      companySize: fieldAfterLabel(capture.text, "Company size"),
      headquarters: fieldAfterLabel(capture.text, "Headquarters"),
      founded: fieldAfterLabel(capture.text, "Founded"),
      specialties: splitSpecialties(fieldAfterLabel(capture.text, "Specialties"))
    }
  };
}

function normalizeCompanyUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value, "https://www.linkedin.com");
    const match = url.pathname.match(/^\/company\/([^/]+)/i);
    if (match) return `https://www.linkedin.com/company/${match[1]}`;
    return normalizeLinkedInProfileUrl(value);
  } catch {
    return normalizeLinkedInProfileUrl(value);
  }
}

export async function syncCompanyProfiles({
  repository,
  candidateRepository,
  extractCompany,
  limit,
  profileUrls,
  dryRun = false
}) {
  const candidates = await repository.listCompanyCandidates({ limit, profileUrls });
  const summary = { companiesProcessed: 0, failed: 0 };
  const items = [];

  for (const candidate of candidates) {
    try {
      if (!candidate.currentCompanyUrl) continue;
      const company = await extractCompany(candidate);
      summary.companiesProcessed += 1;
      items.push({
        inventoryId: candidate.inventoryId,
        status: "company_extracted",
        sourceUrl: company.sourceUrl,
        websiteUrl: company.facts?.website ?? null
      });

      if (!dryRun) {
        await candidateRepository?.upsertCandidate({
          inventoryId: candidate.inventoryId,
          fullName: candidate.fullName,
          patch: {
            companyCapture: {
              capturedAt: new Date().toISOString(),
              source: company.source,
              sourceUrl: company.sourceUrl,
              facts: company.facts
            }
          },
          status: "company_captured"
        });
        await repository.saveCompanyFacts?.(candidate, company);
        await repository.markCompanyCaptured?.(candidate.inventoryId);
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

export class CompanyProfileRepository {
  constructor(client) {
    this.client = client;
  }

  async listCompanyCandidates({ limit, profileUrls } = {}) {
    const params = [];
    const normalizedProfileUrls = normalizeProfileUrlFilter(profileUrls);
    const profileFilter = normalizedProfileUrls.length
      ? `and lower(inv.linkedin_profile_url) = any($${params.push(normalizedProfileUrls)}::text[])`
      : "";
    const limitClause = limit ? `limit $${params.push(limit)}` : "";

    const result = await this.client.query(
      `select distinct on (inv.current_company_url)
         inv.id as inventory_id,
         inv.company_id,
         inv.current_company_name,
         inv.current_company_url as current_company_url
       from linkedin_connection_inventory inv
       where inv.current_company_url is not null
         and inv.workflow_status = 'linkedin_extracted'
         and inv.dedupe_status = 'dedupe_pending'
         ${profileFilter}
       order by inv.current_company_url, inv.discovered_at asc
       ${limitClause}`,
      params
    );

    return result.rows.map((row) => ({
      inventoryId: row.inventory_id,
      companyId: row.company_id,
      currentCompanyName: row.current_company_name,
      currentCompanyUrl: row.current_company_url
    }));
  }

  async saveCompanyFacts(item, company) {
    await this.client.query(
      `update linkedin_connection_inventory
       set current_company_name = coalesce($1, current_company_name)
       where id = $2`,
      [company.facts?.name ?? null, item.inventoryId]
    );
  }

  async markCompanyCaptured(inventoryId) {
    await this.client.query(
      `update linkedin_connection_inventory
       set workflow_status = 'company_captured',
           current_step = 'linkedin_company_profile_extracted'
       where id = $1`,
      [inventoryId]
    );
  }
}

function fieldAfterLabel(text, label) {
  const lines = cleanLines(text);
  const index = lines.findIndex((line) => line.toLowerCase() === label.toLowerCase());
  return index === -1 ? null : lines[index + 1] ?? null;
}

function extractCompanyName(html) {
  const h1Match = String(html ?? "").match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (!h1Match) return null;

  const titleMatch = h1Match[0].match(/\stitle=(["'])(.*?)\1/i);
  return cleanHtmlText(titleMatch?.[2] ?? h1Match[1]) || null;
}

function firstNonLabelLine(text) {
  const labels = new Set(["overview", "website", "phone", "industry", "company size", "headquarters", "founded", "specialties"]);
  return cleanLines(text).find((line) => !labels.has(line.toLowerCase())) ?? null;
}

function extractOverview(text) {
  const lines = cleanLines(text);
  const overviewIndex = lines.findIndex((line) => line.toLowerCase() === "overview");
  if (overviewIndex === -1) return null;
  const stopLabels = new Set(["website", "phone", "industry", "company size", "headquarters", "founded", "specialties"]);
  const values = [];
  for (const line of lines.slice(overviewIndex + 1)) {
    if (stopLabels.has(line.toLowerCase())) break;
    values.push(line);
  }
  return values.join("\n").trim() || null;
}

function splitSpecialties(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function cleanLines(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function cleanHtmlText(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProfileUrlFilter(profileUrls) {
  return [...new Set((profileUrls ?? []).map((url) => String(url ?? "").trim().toLowerCase()).filter(Boolean))];
}

function normalizeExternalUrl(value) {
  if (!value) return null;
  return String(value).replace(/\/$/, "");
}

function findWebsiteUrl(links = []) {
  for (const link of links) {
    try {
      const url = new URL(link, "https://www.linkedin.com");
      const hostname = url.hostname.replace(/^www\./, "");
      if (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) continue;
      if (isUtilityLink(url)) continue;
      if (!["http:", "https:"].includes(url.protocol)) continue;
      return url.toString();
    } catch {
      // Ignore invalid links.
    }
  }
  return null;
}

function isUtilityLink(url) {
  const hostname = url.hostname.replace(/^www\./, "");
  return (
    hostname === "bing.com" ||
    hostname === "google.com" ||
    hostname === "maps.google.com" ||
    hostname.endsWith(".google.com") ||
    hostname === "facebook.com" ||
    hostname === "x.com" ||
    hostname === "twitter.com" ||
    hostname === "instagram.com"
  );
}
