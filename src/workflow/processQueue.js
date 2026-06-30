import { detectLinkedInBlockers, waitForLinkedInBlockersToClear } from "../linkedin/browser.js";

export async function processQueuedProfiles({
  queueRepository,
  candidateRepository,
  extractProfile,
  limit,
  profileUrls,
  dryRun = false
}) {
  const queued = await queueRepository.listQueued({ limit, profileUrls });
  const items = [];
  const summary = { extracted: 0, failed: 0 };

  for (const item of queued) {
    try {
      const capture = await extractProfile(item);
      const result = {
        inventoryId: item.id,
        status: "extracted",
        sourceUrl: capture.sourceUrl,
        currentCompanyName: capture.facts?.currentCompanyName ?? null
      };
      items.push(result);
      summary.extracted += 1;

      if (!dryRun) {
        await candidateRepository?.upsertCandidate({
          inventoryId: item.id,
          fullName: item.fullName ?? item.full_name,
          patch: {
            identity: capture.identity,
            profileCapture: {
              capturedAt: new Date().toISOString(),
              source: capture.source,
              sourceUrl: capture.sourceUrl,
              facts: capture.facts
            }
          },
          status: "profile_captured"
        });

        await queueRepository.updateInventoryCompanyFromFacts?.(item, capture);
        await queueRepository.markLinkedInExtracted(item.id);
      }
    } catch (error) {
      summary.failed += 1;
      items.push({
        inventoryId: item.id,
        status: "failed",
        error: error.message
      });
      if (!dryRun) {
        await queueRepository.markFailedNeedsReview(item.id, error.message);
      }
    }
  }

  return {
    status: dryRun ? "dry_run" : "processed",
    summary,
    items
  };
}

export async function refreshProfileCaptures({
  repository,
  candidateRepository,
  extractProfile,
  limit,
  dryRun = false
}) {
  const queued = await repository.listProfilesForRefresh({ limit });
  const items = [];

  for (const item of queued) {
    const capture = await extractProfile(item);
    items.push({
      inventoryId: item.id,
      sourceUrl: capture.sourceUrl,
      currentCompanyName: capture.facts?.currentCompanyName ?? null
    });

    if (!dryRun) {
      const existing = await candidateRepository?.findByInventoryId?.(item.id);
      await candidateRepository?.upsertCandidate({
        inventoryId: item.id,
        fullName: item.fullName ?? item.full_name,
        firstName: capture.identity?.firstName,
        lastName: capture.identity?.lastName,
        patch: {
          identity: capture.identity,
          profileCapture: {
            capturedAt: new Date().toISOString(),
            source: capture.source,
            sourceUrl: capture.sourceUrl,
            facts: capture.facts
          }
        },
        status: existing?.candidate?.status ?? "profile_captured"
      });
      await repository.updateInventoryCompanyFromFacts?.(item, capture);
    }
  }

  return {
    status: dryRun ? "dry_run" : "refreshed",
    summary: { profilesRefreshed: items.length },
    items
  };
}

export function createPlaywrightProfileExtractor(page, options = {}) {
  return async function extractProfile(item) {
    const sourceUrl = item.linkedinProfileUrl ?? item.linkedin_profile_url;
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState?.("networkidle", { timeout: 10000 }).catch(() => {});
    await waitForLinkedInBlockersToClear(page, { log: options.log });

    const profileCapture = await page.evaluate(() => {
      const main = document.querySelector("main");
      const sections = [...document.querySelectorAll("main section")]
        .filter((section) => !section.querySelector("section"))
        .map((section) => ({
          text: section.innerText || "",
          html: section.outerHTML || ""
        }));
      if (sections.length > 0) {
        return {
          sections,
          rawText: main?.innerText || document.body?.innerText || "",
          rawHtml: main?.outerHTML || document.body?.outerHTML || ""
        };
      }
      return {
        sections: [
          {
            text: main?.innerText || document.body?.innerText || "",
            html: main?.outerHTML || document.body?.outerHTML || ""
          }
        ],
        rawText: main?.innerText || document.body?.innerText || "",
        rawHtml: main?.outerHTML || document.body?.outerHTML || ""
      };
    });
    const normalizedCapture = normalizeProfileCapture(profileCapture);
    const profileSections = normalizeProfileSections(normalizedCapture.sections);
    const headerSection = findProfileHeaderSection(profileSections);
    const aboutSection = findSectionByHeading(profileSections, "About");
    const experienceSection = findSectionByHeading(profileSections, "Experience");
    const profileContent = extractProfileMainContent(profileSections);
    const profileText = profileContent.text;
    const rawProfileText = normalizedCapture.rawText || htmlToVisibleText(normalizedCapture.rawHtml);
    const blocker = detectLinkedInBlockers(profileText);
    if (blocker.blocked) {
      await waitForLinkedInBlockersToClear(page, { log: options.log });
      return extractProfile(item);
    }

    const headerText = headerSection?.text || profileText;
    const lines = cleanLines(headerText);
    const nameLine = lines[0] ?? item.fullName ?? item.full_name ?? "";
    const { firstName, lastName } = splitName(nameLine);
    const headline =
      item.headline ??
      item.headline_text ??
      extractHeadlineFromProfileText(headerText) ??
      extractHeadlineFromProfileText(profileText) ??
      null;
    const experienceText = experienceSection?.text
      ? stripSectionHeading(experienceSection.text, "Experience")
      : sectionAfterHeading(profileText, "Experience");
    const { currentRoleTitle, currentRoleStartDate, jobHistory } = parseExperienceFacts(
      experienceText,
      null,
      headline
    );
    const currentJob = jobHistory[0] ?? null;
    const currentCompany = extractCurrentCompanyFromProfileHtml(
      [experienceSection?.html, headerSection?.html, normalizedCapture.rawHtml].filter(Boolean).join("\n"),
      currentJob?.companyName ?? headline ?? headerText
    );
    const currentCompanyName = currentJob?.companyName ?? currentCompany.name;
    const contactText = [headerSection?.text, aboutSection?.text, experienceSection?.text].filter(Boolean).join("\n\n");

    return {
      source: "linkedin_profile",
      sourceUrl,
      identity: {
        firstName,
        lastName,
        linkedinProfileUrl: sourceUrl,
        headline,
        location: extractLocationFromProfileText(headerText) ?? extractLocationFromProfileText(rawProfileText)
      },
      facts: {
        about: aboutSection?.text
          ? cleanAboutText(stripSectionHeading(aboutSection.text, "About"))
          : cleanAboutText(sectionAfterHeading(profileText, "About")),
        currentCompanyName,
        currentCompanyLinkedInUrl: currentCompany.linkedinCompanyUrl,
        currentRoleTitle,
        currentRoleStartDate,
        jobHistory,
        contact: extractContactFromText(contactText || profileText)
      }
    };
  };
}

function normalizeProfileCapture(profileCapture) {
  if (Array.isArray(profileCapture)) {
    return {
      sections: profileCapture.map((text) => ({ text, html: "" })),
      rawText: "",
      rawHtml: ""
    };
  }

  const rawHtml = String(profileCapture?.rawHtml ?? "");
  const rawText = cleanSectionText(profileCapture?.rawText ?? "");
  if (Array.isArray(profileCapture?.sections)) {
    return { sections: profileCapture.sections, rawText, rawHtml };
  }

  if (Array.isArray(profileCapture?.sectionTexts)) {
    return {
      sections: profileCapture.sectionTexts.map((text) => ({ text, html: "" })),
      rawText,
      rawHtml
    };
  }

  return {
    sections: [{ text: profileCapture ?? "", html: "" }],
    rawText: "",
    rawHtml
  };
}

export function extractProfileMainText(sectionTexts) {
  const sections = Array.isArray(sectionTexts) ? sectionTexts : [sectionTexts];
  return extractProfileMainContent(
    sections.map((section) =>
      typeof section === "object" && section !== null
        ? section
        : { text: section, html: "" }
    )
  ).text;
}

export function extractCurrentCompanyFromProfileHtml(html = "", fallbackText = "") {
  const fallbackName = extractCompanyNameFromText(fallbackText);
  const companyLinkMatch = String(html).match(/<a\b[^>]*href=["']([^"']*\/company\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
  if (companyLinkMatch) {
    return {
      name: cleanHtmlText(companyLinkMatch[2]) || fallbackName,
      linkedinCompanyUrl: normalizeLinkedInCompanyUrl(companyLinkMatch[1])
    };
  }

  return {
    name: fallbackName,
    linkedinCompanyUrl: null
  };
}

function normalizeProfileSections(sectionCaptures) {
  const sections = Array.isArray(sectionCaptures) ? sectionCaptures : [sectionCaptures];
  return sections
    .map((section) => ({
      text: cleanSectionText(section?.text ?? section),
      html: String(section?.html ?? "")
    }))
    .filter((section) => section.text);
}

function extractProfileMainContent(sectionCaptures) {
  const filtered = normalizeProfileSections(sectionCaptures)
    .filter((section) => section.text)
    .filter((section) => isProfileContentSection(section.text));

  return {
    text: filtered.map((section) => section.text).join("\n\n").trim(),
    html: filtered.map((section) => section.html).filter(Boolean).join("\n\n").trim()
  };
}

function findProfileHeaderSection(sections) {
  return sections.find((section) => {
    const firstLine = firstCleanLine(section.text);
    return firstLine && !isKnownSectionHeading(firstLine);
  }) ?? null;
}

function findSectionByHeading(sections, heading) {
  const normalizedHeading = heading.toLowerCase();
  return sections.find((section) => firstCleanLine(section.text)?.toLowerCase() === normalizedHeading) ?? null;
}

export class ProcessQueueRepository {
  constructor(client) {
    this.client = client;
  }

  async listQueued({ limit, profileUrls } = {}) {
    const params = [];
    const normalizedProfileUrls = normalizeProfileUrlFilter(profileUrls);
    const profileFilter = normalizedProfileUrls.length
      ? `and lower(linkedin_profile_url) = any($${params.push(normalizedProfileUrls)}::text[])`
      : "";
    const limitClause = limit ? `limit $${params.push(limit)}` : "";
    const result = await this.client.query(
      `select
         id,
         linkedin_profile_url,
         full_name,
         headline,
         current_company_name,
         current_company_url,
         individual_id,
         company_id
       from linkedin_connection_inventory
       where workflow_status = 'discovered'
         and dedupe_status = 'dedupe_pending'
         ${profileFilter}
       order by queued_at asc nulls last, discovered_at asc
       ${limitClause}`,
      params
    );
    return result.rows.map(toCamelInventory);
  }

  async listProfilesForRefresh({ limit } = {}) {
    const params = [];
    const limitClause = limit ? "limit $1" : "";
    if (limit) params.push(limit);
    const result = await this.client.query(
      `select
         id,
         linkedin_profile_url,
         full_name,
         headline,
         current_company_name,
         current_company_url,
         individual_id,
         company_id
       from linkedin_connection_inventory
       where linkedin_profile_url is not null
         and workflow_status in ('linkedin_extracted', 'qualified', 'skipped_not_fit')
       order by discovered_at asc
       ${limitClause}`,
      params
    );
    return result.rows.map(toCamelInventory);
  }

  async saveProfileFacts(item, capture) {
    await this.updateInventoryCompanyFromFacts(item, capture);
  }

  async updateInventoryCompanyFromFacts(item, capture) {
    const { currentCompanyName, currentCompanyLinkedInUrl } = capture.facts ?? {};
    if (!currentCompanyName && !currentCompanyLinkedInUrl) return;

    await this.client.query(
      `update linkedin_connection_inventory
       set current_company_name = coalesce($1, current_company_name),
           current_company_url = coalesce($2, current_company_url)
       where id = $3`,
      [currentCompanyName ?? null, currentCompanyLinkedInUrl ?? null, item.id]
    );
  }

  async markLinkedInExtracted(id) {
    await this.client.query(
      `update linkedin_connection_inventory
       set workflow_status = 'linkedin_extracted',
           current_step = 'linkedin_profile_extracted',
           in_progress_at = coalesce(in_progress_at, now())
       where id = $1`,
      [id]
    );
  }

  async markFailedNeedsReview(id, message) {
    await this.client.query(
      `update linkedin_connection_inventory
       set workflow_status = 'failed_needs_review',
           current_step = 'linkedin_profile_extract_failed',
           failed_at = now(),
           last_error = $2
       where id = $1`,
      [id, message]
    );
  }
}

function splitName(fullName = "") {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? null, lastName: parts.slice(1).join(" ") || null };
}

function normalizeProfileUrlFilter(profileUrls) {
  return [...new Set((profileUrls ?? []).map((url) => String(url ?? "").trim().toLowerCase()).filter(Boolean))];
}

function sectionAfterHeading(text, heading) {
  const pattern = new RegExp(`(^|\\n)${heading}\\n([\\s\\S]*?)(\\n(?:About|Activity|Experience|Education|Licenses & certifications|Volunteering|Recommendations|Languages|Honors & awards)\\n|$)`, "i");
  return String(text ?? "").match(pattern)?.[2]?.trim() ?? null;
}

function stripSectionHeading(text, heading) {
  const lines = cleanLines(text);
  if (lines[0]?.toLowerCase() === heading.toLowerCase()) return lines.slice(1).join("\n");
  return lines.join("\n");
}

function cleanAboutText(text) {
  const lines = cleanLines(text);
  const output = [];
  for (const line of lines) {
    if (/^top skills$/i.test(line)) break;
    if (line === "… more") continue;
    output.push(line);
  }
  return output.join("\n\n").trim() || null;
}

function extractHeadlineFromProfileText(profileText) {
  const lines = cleanLines(profileText);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("·")) continue;
    if (/^(About|Activity|Experience|Education|Contact info)\b/i.test(line)) break;
    if (isLikelyProfileLocation(line)) continue;
    return line;
  }
  return null;
}

function extractLocationFromProfileText(profileText) {
  const headline = extractHeadlineFromProfileText(profileText);
  const lines = cleanLines(profileText);
  const startIndex = headline ? lines.indexOf(headline) + 1 : 1;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^(About|Activity|Experience|Education|Contact info)\b/i.test(line)) break;
    if (isLikelyProfileLocation(line)) {
      return line;
    }
  }
  return null;
}

function isLikelyProfileLocation(line) {
  return (
    line.includes(",") ||
    /\b(Australia|United States|United Kingdom|Canada|India|New Zealand|Singapore)\b/i.test(line) ||
    /\bArea$/i.test(line)
  );
}

function parseExperienceFacts(experienceText, currentCompany, headline) {
  if (!experienceText) {
    return {
      currentRoleTitle: extractRoleTitleFromHeadline(headline),
      currentRoleStartDate: null,
      jobHistory: []
    };
  }

  const jobHistory = parseExperienceLines(cleanLines(experienceText)).slice(0, 5);
  const currentJob = jobHistory[0] ?? null;

  return {
    currentRoleTitle: currentJob?.title ?? extractRoleTitleFromHeadline(headline),
    currentRoleStartDate: currentJob?.startDate ?? null,
    jobHistory
  };
}

function parseExperienceBlock(block) {
  const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const title = lines[0] ?? null;
  const companyName = lines[1] ?? null;
  const dateLine = lines.find((line) => /\d{4}|Present/i.test(line)) ?? null;
  const { startDate, endDate } = parseDateRange(dateLine);

  return {
    title,
    companyName,
    startDate,
    endDate,
    description: lines.slice(2).filter((line) => line !== dateLine).join("\n") || null
  };
}

function parseExperienceLines(lines) {
  const anchors = findExperienceRoleAnchors(lines);

  return anchors.map((anchor, position) => {
    const nextAnchor = anchors[position + 1];
    const nextGroupHeaderIndex =
      nextAnchor?.groupHeaderIndex != null && nextAnchor.groupHeaderIndex > anchor.dateIndex
        ? nextAnchor.groupHeaderIndex
        : null;
    const descriptionEndIndex = nextAnchor
      ? Math.min(nextGroupHeaderIndex ?? nextAnchor.roleStartIndex, nextAnchor.roleStartIndex)
      : lines.length;
    const descriptionLines = lines
      .slice(anchor.dateIndex + 1, Math.max(anchor.dateIndex + 1, descriptionEndIndex))
      .filter((line) => !isExperienceNoiseLine(line) && !isExperienceLocationLine(line));

    return {
      title: anchor.title,
      companyName: anchor.companyName,
      startDate: anchor.startDate,
      endDate: anchor.endDate,
      description: descriptionLines.join("\n") || null
    };
  }).filter((job) => job.title || job.companyName);
}

function findExperienceRoleAnchors(lines) {
  const anchors = [];
  for (let dateIndex = 0; dateIndex < lines.length; dateIndex += 1) {
    const { startDate, endDate } = parseDateRange(lines[dateIndex]);
    if (!startDate) continue;

    if (dateIndex >= 2 && isCompanyEmploymentLine(lines[dateIndex - 1])) {
      anchors.push({
        roleStartIndex: dateIndex - 2,
        dateIndex,
        title: lines[dateIndex - 2] ?? null,
        companyName: cleanCompanyName(lines[dateIndex - 1]),
        startDate,
        endDate
      });
      continue;
    }

    const groupHeader = findGroupedCompanyHeader(lines, dateIndex);
    if (!groupHeader) continue;

    anchors.push({
      roleStartIndex: dateIndex - 1,
      groupHeaderIndex: groupHeader.index,
      dateIndex,
      title: lines[dateIndex - 1] ?? null,
      companyName: groupHeader.companyName,
      startDate,
      endDate
    });
  }
  return anchors;
}

function findGroupedCompanyHeader(lines, dateIndex) {
  for (let index = dateIndex - 2; index >= 0; index -= 1) {
    if (!isDateLine(lines[index]) && isCompanyEmploymentLine(lines[index])) break;
    if (isGroupedCompanyHeaderAt(lines, index)) {
      return { index, companyName: lines[index] };
    }
  }
  return null;
}

function isGroupedCompanyHeaderAt(lines, index) {
  if (!lines[index] || isExperienceNoiseLine(lines[index])) return false;
  if (!isEmploymentSummaryLine(lines[index + 1])) return false;
  let cursor = index + 2;
  while (isLikelyProfileLocation(lines[cursor])) cursor += 1;
  return Boolean(lines[cursor] && isDateLine(lines[cursor + 1]));
}

function isDateLine(line) {
  return Boolean(parseDateRange(line).startDate);
}

function isCompanyEmploymentLine(line) {
  return /\s·\s/.test(String(line ?? "")) && !isEmploymentSummaryLine(line);
}

function isEmploymentSummaryLine(line) {
  return /^(Full-time|Part-time|Contract|Self-employed|Freelance|Internship|Apprenticeship|Temporary)(\s*·|$)/i.test(String(line ?? ""));
}

function parseDateRange(value) {
  if (!value) return { startDate: null, endDate: null };
  const match = String(value).match(/([A-Za-z]+ \d{4}|\d{4})\s*(?:-|–|to)\s*([A-Za-z]+ \d{4}|\d{4}|Present)/i);
  if (!match) return { startDate: null, endDate: null };
  return {
    startDate: match[1] ?? null,
    endDate: match[2] === "Present" ? null : match[2] ?? null
  };
}

function cleanCompanyName(value) {
  if (!value) return null;
  return String(value).split("·")[0].trim().replace(/\s+/g, " ") || null;
}

function isExperienceNoiseLine(line) {
  return (
    line === "… more" ||
    /(?:^|\s)and \+\d+ skills$/i.test(line) ||
    /(?:^|,\s*)[A-Z][A-Za-z ]+(?:,\s*[A-Z][A-Za-z ]+)* and \+\d+ skills$/i.test(line) ||
    /\b(Remote|Hybrid|On-site)\b/i.test(line)
  );
}

function isExperienceLocationLine(line) {
  const value = String(line ?? "").trim();
  if (/^(Australia|United States|United Kingdom|Canada|India|New Zealand|Singapore)$/i.test(value)) return true;
  return value.length < 80 && value.includes(",") && !/[.!?]/.test(value);
}

function extractRoleTitleFromHeadline(headline) {
  const match = String(headline ?? "").match(/^(.+?)\s+at\s+/i);
  return match?.[1]?.trim() ?? null;
}

function extractContactFromText(text) {
  const source = String(text ?? "");
  return {
    email: source.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] ?? null,
    mobile: source.match(/\+?\d[\d\s()-]{7,}/)?.[0]?.trim() ?? null,
    tel: null
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
    individualId: row.individual_id,
    companyId: row.company_id
  };
}

function cleanSectionText(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(/(?:Sales Insights|Retry Premium for A\$0)[\s\S]*?(\n\n(?:About|Activity|Experience|Education|Licenses & certifications|Volunteering|Recommendations|Languages|Honors & awards)\b)/gi, "$1")
    .replace(/(?:Sales Insights|Retry Premium for A\$0)[\s\S]*$/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function firstCleanLine(text) {
  return cleanLines(text)[0] ?? null;
}

function isKnownSectionHeading(line) {
  return /^(About|Activity|Experience|Education|Licenses & certifications|Volunteering|Recommendations|Languages|Honors & awards|Interests)$/i.test(line);
}

function isProfileContentSection(text) {
  if (!text) return false;
  if (/(^|\n)(Skip to main content|Home|My Network|Messaging|Notifications|For Business)(\n|$)/i.test(text)) return false;
  if (/^Sales Insights\b/i.test(text)) return false;
  if (/^Interests\b/i.test(text)) return false;
  if (/^More profiles for you\b/i.test(text)) return false;
  if (/^(People you may know|You might like|.+providers you might be interested in)\b/i.test(text)) return false;
  if (/^About\nAccessibility\nTalent Solutions\b/i.test(text)) return false;
  if (/LinkedIn Corporation ©/i.test(text)) return false;
  if (/window\.__|__webpack|__como/i.test(text)) return false;
  return true;
}

function cleanHtmlText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToVisibleText(value) {
  return cleanSectionText(
    String(value ?? "")
      .replace(/<[^>]*>/g, "\n")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
  );
}

function normalizeLinkedInCompanyUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value, "https://www.linkedin.com");
    const match = url.pathname.match(/^\/company\/([^/]+)/i);
    if (match) {
      return `https://www.linkedin.com/company/${match[1]}`;
    }
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function extractCompanyNameFromText(value) {
  const match = String(value ?? "").match(/\bat\s+([^\n|·]+)/i);
  return match?.[1]?.trim() ?? null;
}
