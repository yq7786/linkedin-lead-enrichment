import { hasRecentVisiblePostOrComment, isHighPotentialFit } from "../ai/scoreFit.js";

const FOUNDER_RE = /\b(co[-\s]?founder|founder|founding|owner|chief executive|ceo|managing director)\b/i;
const STARTUP_RE = /\b(startup|start-up|stealth|pre-seed|seed|venture-backed|ai|saas|software|platform|automation|technology|tech)\b/i;

export async function scoreExtractedProfiles({
  repository,
  candidateRepository,
  limit,
  inventoryIds,
  dryRun = false,
  includeScored = false,
  now = new Date()
}) {
  const statuses = includeScored
    ? ["profile_captured", "activity_captured", "company_captured", "qualified", "website_captured", "skipped_not_fit"]
    : ["profile_captured", "activity_captured", "company_captured"];
  const allCandidates = [];
  for (const status of statuses) {
    allCandidates.push(...await candidateRepository.listByStatus(status, { inventoryIds }));
  }
  const candidates = typeof limit === "number" ? allCandidates.slice(0, limit) : allCandidates;
  const summary = { fitScored: 0, skippedNotFit: 0, failed: 0 };
  const items = [];

  for (const candidate of candidates) {
    try {
      const fit = deriveFitFromCandidate(candidate, now);
      const highPotential = isHighPotentialFit(fit);
      const status = highPotential ? "qualified" : "skipped_not_fit";

      items.push({
        inventoryId: candidate.candidate.inventoryId,
        status,
        fit
      });

      if (highPotential) summary.fitScored += 1;
      else summary.skippedNotFit += 1;

      if (!dryRun) {
        await candidateRepository.upsertCandidate({
          inventoryId: candidate.candidate.inventoryId,
          patch: {
            fit: {
              scoredAt: now.toISOString(),
              ...fit
            }
          },
          status
        });
        if (highPotential) {
          await repository.markFitScored(candidate.candidate.inventoryId);
        } else {
          await repository.markSkippedNotFit(candidate.candidate.inventoryId);
        }
      }
    } catch (error) {
      summary.failed += 1;
      items.push({
        inventoryId: candidate.candidate.inventoryId,
        status: "failed",
        error: error.message
      });
    }
  }

  return {
    status: dryRun ? "dry_run" : "processed",
    summary,
    items
  };
}

export function deriveFitFromCandidate(candidate, now = new Date()) {
  const text = [
    candidate.identity?.headline,
    candidate.profileCapture?.facts?.about,
    candidate.profileCapture?.facts?.currentRoleTitle,
    ...(candidate.profileCapture?.facts?.jobHistory ?? []).flatMap((job) => [job.title, job.description, job.companyName]),
    candidate.companyCapture?.facts?.overview,
    candidate.companyCapture?.facts?.industry,
    ...(candidate.companyCapture?.facts?.specialties ?? []),
    ...(candidate.companyWebsite?.pages ?? []).map((page) => page.contentMarkdown)
  ].filter(Boolean).join("\n");

  const founderSignal = FOUNDER_RE.test(text);
  const startupSignal = STARTUP_RE.test(text);
  const activities = candidate.activityCapture?.items ?? [];
  const recentActivitySignal = hasRecentVisiblePostOrComment(activities, now);
  const fitScore = [founderSignal, startupSignal, recentActivitySignal].filter(Boolean).length / 3;

  return {
    founderSignal,
    startupSignal,
    recentActivitySignal,
    fitScore,
    fitReasoning: buildFitReasoning({ founderSignal, startupSignal, recentActivitySignal })
  };
}

export class ScoreExtractedProfilesRepository {
  constructor(client) {
    this.client = client;
  }

  async markFitScored(inventoryId) {
    await this.client.query(
      `update linkedin_connection_inventory
       set workflow_status = 'qualified',
           current_step = 'qualified'
       where id = $1`,
      [inventoryId]
    );
  }

  async markSkippedNotFit(inventoryId) {
    await this.client.query(
      `update linkedin_connection_inventory
       set workflow_status = 'skipped_not_fit',
           current_step = 'skipped_not_fit'
       where id = $1`,
      [inventoryId]
    );
  }
}

function buildFitReasoning({ founderSignal, startupSignal, recentActivitySignal }) {
  return [
    founderSignal ? "Founder-like role found." : "No founder-like role found.",
    startupSignal ? "Startup/technology signal found." : "No startup/technology signal found.",
    recentActivitySignal ? "Recent visible activity found." : "No recent visible activity found."
  ].join(" ");
}
