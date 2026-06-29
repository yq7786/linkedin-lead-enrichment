import { buildAuditEvent } from "./auditPolicy.js";
import {
  buildCompanyIndividualTitleRecord,
  buildNewCompanyRecord,
  buildNewIndividualRecord
} from "./dedupe.js";
import { isHighPotentialFit } from "./ai/scoreFit.js";

export async function createPortalRecordsForHighPotentialFit(candidate, dependencies) {
  if (!isHighPotentialFit(candidate.fit)) {
    return { status: "skipped_not_fit", individualId: null, companyId: null, titleResult: null };
  }

  const company = await dependencies.companies.findOrCreate(buildNewCompanyRecord(candidate.company));
  const individual = await dependencies.individuals.create(
    buildNewIndividualRecord(candidate.individual, company.id)
  );
  const titleResult = await dependencies.titles.createOrUpdate(
    buildCompanyIndividualTitleRecord(candidate.title, {
      companyId: company.id,
      individualId: individual.id
    })
  );

  return {
    status: "created",
    individualId: individual.id,
    companyId: company.id,
    titleResult
  };
}

export async function processDraftSubmission(draft, dependencies) {
  const savedDraft = await dependencies.drafts.saveDraft({
    ...draft,
    portalDraftId: null,
    createdAt: new Date().toISOString()
  });

  if (dependencies.dryRun) {
    return { ...savedDraft, portalDraftId: null, status: "draft_created" };
  }

  try {
    const portalResult = await dependencies.portalDrafts.createDraft(draft);
    const updatedDraft = await dependencies.drafts.saveDraft({
      ...savedDraft,
      portalDraftId: portalResult.portalDraftId
    });

    const auditEvent = buildAuditEvent("draft_sent_to_portal", {
      status: "success",
      message: "Draft saved to portal approval queue.",
      individualId: draft.individualId,
      inventoryId: draft.inventoryId,
      metadataJson: { portalDraftId: portalResult.portalDraftId }
    });
    await dependencies.audit.write(auditEvent);

    return { ...updatedDraft, status: "draft_sent_to_portal" };
  } catch (error) {
    const auditEvent = buildAuditEvent("portal_api_failed", {
      status: "failed",
      message: error.message,
      individualId: draft.individualId,
      inventoryId: draft.inventoryId,
      metadataJson: { errorName: error.name }
    });
    await dependencies.audit.write(auditEvent);
    throw error;
  }
}
