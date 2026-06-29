export async function syncCompanyWebsites({
  candidateRepository,
  repository,
  captureWebsite,
  limit,
  inventoryIds,
  dryRun = false,
  resync = false
}) {
  const statuses = resync ? ["qualified", "website_captured"] : ["qualified"];
  const candidates = [];
  for (const status of statuses) {
    candidates.push(...await candidateRepository.listByStatus(status, { inventoryIds }));
  }
  const selected = typeof limit === "number" ? candidates.slice(0, limit) : candidates;
  const summary = { websitesProcessed: 0, failed: 0 };
  const items = [];

  for (const candidate of selected) {
    const inventoryId = candidate.candidate.inventoryId;
    const website = candidate.companyCapture?.facts?.website;
    if (!website) continue;
    try {
      const companyWebsite = await captureWebsite(website);
      summary.websitesProcessed += 1;
      items.push({ inventoryId, status: "website_captured", pagesCaptured: companyWebsite.pages.length });
      if (!dryRun) {
        await candidateRepository.upsertCandidate({
          inventoryId,
          patch: {
            companyWebsite: {
              capturedAt: new Date().toISOString(),
              ...companyWebsite
            }
          },
          status: "website_captured"
        });
        await repository?.markWebsiteCaptured(inventoryId);
      }
    } catch (error) {
      summary.failed += 1;
      items.push({ inventoryId, status: "failed", error: error.message });
      if (!dryRun) {
        await candidateRepository.upsertCandidate({
          inventoryId,
          patch: {
            companyWebsite: {
              status: "failed",
              error: error.message
            }
          },
          status: candidate.candidate.status
        });
      }
    }
  }

  return { status: dryRun ? "dry_run" : "synced", summary, items };
}

export class CompanyWebsiteRepository {
  constructor(client) {
    this.client = client;
  }

  async markWebsiteCaptured(inventoryId) {
    await this.client.query(
      `update linkedin_connection_inventory
       set workflow_status = 'website_captured',
           current_step = 'company_website_captured'
       where id = $1`,
      [inventoryId]
    );
  }
}
