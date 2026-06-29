import { resolvePortalIndividualMatch } from "../dedupe.js";

export async function dedupeInventory({ inventoryRepository, limit, profileUrls, dryRun = false }) {
  const pending = await inventoryRepository.listPending({ limit, profileUrls });
  const items = [];
  const summary = { queued: 0, matchedExisting: 0, needsReview: 0 };

  for (const item of pending) {
    const candidate = toDedupeCandidate(item);
    const matches = await inventoryRepository.listIndividualMatches(candidate);
    const match = resolvePortalIndividualMatch(candidate, matches);

    if (match.status === "matched") {
      const existing = matches.find((individual) => individual.id === match.matchId);
      const action = {
        inventoryId: item.id,
        action: "matched_existing",
        individualId: match.matchId,
        companyId: existing?.companyId ?? null,
        strategy: match.strategy
      };
      items.push(action);
      summary.matchedExisting += 1;
      if (!dryRun) {
        await inventoryRepository.markMatchedExisting(item.id, {
          individualId: action.individualId,
          companyId: action.companyId,
          strategy: action.strategy
        });
      }
      continue;
    }

    if (match.status === "needs_review") {
      const action = {
        inventoryId: item.id,
        action: "needs_review",
        strategy: match.strategy
      };
      items.push(action);
      summary.needsReview += 1;
      if (!dryRun) {
        await inventoryRepository.markNeedsReview(item.id, match.strategy);
      }
      continue;
    }

    const action = {
      inventoryId: item.id,
      action: "queue",
      strategy: match.strategy
    };
    items.push(action);
    summary.queued += 1;
    if (!dryRun) {
      await inventoryRepository.markQueued(item.id);
    }
  }

  return { status: dryRun ? "dry_run" : "deduped", summary, items };
}

export function toDedupeCandidate(item) {
  const { firstName, lastName } = splitFullName(item.fullName ?? item.full_name);
  return {
    inventoryId: item.id,
    firstName,
    lastName,
    currentCompanyName: item.currentCompanyName ?? item.current_company_name ?? null,
    linkedinLink: item.linkedinProfileUrl ?? item.linkedin_profile_url ?? null
  };
}

export class DedupeInventoryRepository {
  constructor(client) {
    this.client = client;
  }

  async listPending({ limit, profileUrls } = {}) {
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
         dedupe_status,
         workflow_status
       from linkedin_connection_inventory
       where dedupe_status = 'dedupe_pending'
         and workflow_status = 'company_captured'
         ${profileFilter}
       order by discovered_at asc
       ${limitClause}`,
      params
    );
    return result.rows;
  }

  async listIndividualMatches(candidate) {
    const result = await this.client.query(
      `select
         i.id,
         i.first_name as "firstName",
         i.last_name as "lastName",
         i.linkedin_link as "linkedinLink",
         i.new_company_id as "companyId",
         c.name as "companyName"
       from new_individual i
       left join new_company c on c.id = i.new_company_id
       where $1::text is not null
         and $2::text is not null
         and $3::text is not null
         and lower(trim(i.first_name)) = lower(trim($1))
         and lower(trim(coalesce(i.last_name, ''))) = lower(trim($2))
         and lower(trim(coalesce(c.name, ''))) = lower(trim($3))
       limit 10`,
      [candidate.firstName, candidate.lastName, candidate.currentCompanyName]
    );
    return result.rows;
  }

  async markMatchedExisting(id, { individualId, companyId, strategy }) {
    await this.client.query(
      `update linkedin_connection_inventory
       set individual_id = $2,
           company_id = $3,
           dedupe_status = 'matched_existing',
           dedupe_match_method = $4,
           workflow_status = 'deduped_existing',
           current_step = 'dedupe_existing_linked'
       where id = $1`,
      [id, individualId, companyId, strategy]
    );
  }

  async markNeedsReview(id, strategy) {
    await this.client.query(
      `update linkedin_connection_inventory
       set dedupe_status = 'needs_review',
           dedupe_match_method = $2,
           workflow_status = 'failed_needs_review',
           current_step = 'dedupe_needs_review',
           failed_at = now()
       where id = $1`,
      [id, strategy]
    );
  }

  async markQueued(id) {
    await this.client.query(
      `update linkedin_connection_inventory
       set dedupe_status = 'not_found',
           dedupe_match_method = 'cleared_for_enrichment',
           current_step = 'dedupe_cleared_for_enrichment',
           queued_at = now()
       where id = $1`,
      [id]
    );
  }
}

function splitFullName(fullName) {
  const parts = String(fullName ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" ")
  };
}

function normalizeProfileUrlFilter(profileUrls) {
  return [...new Set((profileUrls ?? []).map((url) => String(url ?? "").trim().toLowerCase()).filter(Boolean))];
}
