import { classifyWorkflowError } from "../retryPolicy.js";

export async function submitQualifiedCandidates({
  candidateRepository,
  portalCandidates,
  repository,
  limit,
  inventoryIds,
  dryRun = false,
  now = new Date()
}) {
  const candidates = await candidateRepository.listByStatus("website_captured", { inventoryIds });
  const selected = typeof limit === "number" ? candidates.slice(0, limit) : candidates;
  const summary = { submitted: 0, wouldSubmit: 0, skipped: 0, failed: 0 };
  const items = [];

  for (const candidate of selected) {
    const inventoryId = candidate.candidate?.inventoryId ?? null;
    if (!isSubmittable(candidate)) {
      summary.skipped += 1;
      items.push({ inventoryId, status: "skipped" });
      continue;
    }

    try {
      const payload = buildPortalPayload(candidate);
      validatePortalPayload(payload);

      if (dryRun) {
        summary.wouldSubmit += 1;
        items.push({ inventoryId, status: "would_submit", payload });
        continue;
      }

      const result = await portalCandidates.submitCandidate(payload);
      await candidateRepository.upsertCandidate({
        inventoryId,
        patch: {
          portalSubmission: {
            submittedAt: now.toISOString(),
            status: "submitted",
            portalCandidateId: result.portalCandidateId,
            error: null
          }
        },
        status: "submitted"
      });
      await repository.markSubmitted(inventoryId, result.portalCandidateId);
      summary.submitted += 1;
      items.push({ inventoryId, status: "submitted", portalCandidateId: result.portalCandidateId });
    } catch (error) {
      summary.failed += 1;
      items.push({ inventoryId, status: "failed", error: error.message });
      if (dryRun) continue;

      await candidateRepository.upsertCandidate({
        inventoryId,
        patch: {
          portalSubmission: {
            submittedAt: null,
            status: "failed",
            portalCandidateId: null,
            error: error.message
          }
        },
        status: "website_captured"
      });
      await repository.markSubmissionFailed?.(inventoryId, error);
    }
  }

  return { status: dryRun ? "dry_run" : "processed", summary, items };
}

export function buildPortalPayload(candidate) {
  return {
    source: "linkedin_lead_enrichment",
    inventoryId: candidate.candidate.inventoryId,
    identity: candidate.identity,
    profile: candidate.profileCapture?.facts ?? {},
    activity: candidate.activityCapture?.items ?? [],
    company: candidate.companyCapture?.facts ?? {},
    companyWebsite: candidate.companyWebsite?.pages ?? [],
    fit: candidate.fit
  };
}

export function validatePortalPayload(payload) {
  if (!payload.inventoryId) {
    throw new Error("Portal candidate payload requires inventoryId.");
  }
  if (!isPlainObject(payload.identity)) {
    throw new Error("Portal candidate payload requires identity.");
  }
  if (!hasIdentitySignal(payload.identity)) {
    throw new Error("Portal candidate payload identity requires a name or LinkedIn profile URL.");
  }
  if (!isPlainObject(payload.fit)) {
    throw new Error("Portal candidate payload requires fit.");
  }
}

export function isSubmittable(candidate) {
  return Boolean(
    candidate.fit?.founderSignal &&
    candidate.fit?.startupSignal &&
    candidate.fit?.recentActivitySignal &&
    candidate.portalSubmission?.status !== "submitted"
  );
}

function hasIdentitySignal(identity) {
  return Boolean(
    identity.firstName ||
    identity.lastName ||
    identity.linkedinProfileUrl
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class SubmitQualifiedCandidatesRepository {
  constructor(client) {
    this.client = client;
  }

  async markSubmitted(inventoryId, portalCandidateId) {
    await this.client.query(
      `update linkedin_connection_inventory
       set workflow_status = 'submitted',
           current_step = 'submitted_to_portal',
           completed_at = now(),
           last_error = null
       where id = $1`,
      [inventoryId]
    );
    await this.client.query(
      `insert into audit_events (inventory_id, event_type, status, message, metadata_json)
       values ($1, 'candidate_submitted_to_portal', 'success', 'Qualified candidate submitted to portal.', $2::jsonb)`,
      [inventoryId, JSON.stringify({ portalCandidateId })]
    );
  }

  async markSubmissionFailed(inventoryId, error) {
    const disposition = classifyWorkflowError(error);
    const workflowStatus = disposition === "retryable" ? "failed_retryable" : disposition;
    await this.client.query(
      `update linkedin_connection_inventory
       set workflow_status = $2,
           current_step = 'submit_qualified',
           failed_at = now(),
           retry_count = case when $3 = 'retryable' then retry_count + 1 else retry_count end,
           next_retry_at = case
             when $3 = 'retryable' then now() + make_interval(mins => (5 * power(2, retry_count))::int)
             else null
           end,
           last_error = $4
       where id = $1`,
      [inventoryId, workflowStatus, disposition, error.message]
    );
    await this.client.query(
      `insert into audit_events (inventory_id, event_type, status, message, metadata_json)
       values ($1, 'portal_api_failed', 'failure', $2, $3::jsonb)`,
      [
        inventoryId,
        "Portal candidate submission failed.",
        JSON.stringify({
          disposition,
          httpStatus: error.httpStatus
        })
      ]
    );
  }
}
