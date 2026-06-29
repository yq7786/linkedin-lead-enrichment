export function normalizeLinkedInProfileUrl(value) {
  if (!value) return null;
  const withProtocol = value.startsWith("http") ? value : `https://${value}`;
  const url = new URL(withProtocol);
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  return `https://www.${host}${path}`;
}

export function normalizeCompanyDomain(value) {
  if (!value) return null;
  const withProtocol = value.startsWith("http") ? value : `https://${value}`;
  const url = new URL(withProtocol);
  return url.hostname.replace(/^www\./, "").toLowerCase();
}

export function normalizeText(value) {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function resolveLeadMatch(candidate, existingLeads) {
  const byUrl = uniqueMatch(existingLeads, (lead) => {
    const left = normalizeLinkedInProfileUrl(candidate.linkedinProfileUrl);
    const right = normalizeLinkedInProfileUrl(lead.linkedinProfileUrl);
    return left && right && left === right;
  });
  if (byUrl) return toResult(byUrl, "linkedin_profile_url");

  const byMemberId = uniqueMatch(existingLeads, (lead) => {
    return candidate.linkedinMemberId && lead.linkedinMemberId && candidate.linkedinMemberId === lead.linkedinMemberId;
  });
  if (byMemberId) return toResult(byMemberId, "linkedin_member_id");

  const byNameCompany = matches(existingLeads, (lead) => {
    return (
      normalizeText(candidate.fullName) &&
      normalizeText(candidate.fullName) === normalizeText(lead.fullName) &&
      normalizeText(candidate.currentCompanyName) &&
      normalizeText(candidate.currentCompanyName) === normalizeText(lead.currentCompanyName)
    );
  });
  if (byNameCompany.length === 1) return toResult(byNameCompany[0], "full_name_current_company");
  if (byNameCompany.length > 1) return { status: "needs_review", strategy: "full_name_current_company" };

  return { status: "not_found", strategy: "none" };
}

export function resolveCompanyMatch(candidate, existingCompanies) {
  const byDomain = uniqueMatch(existingCompanies, (company) => {
    const left = normalizeCompanyDomain(candidate.websiteUrl);
    const right = normalizeCompanyDomain(company.websiteUrl);
    return left && right && left === right;
  });
  if (byDomain) return toResult(byDomain, "website_domain");

  const byLinkedIn = uniqueMatch(existingCompanies, (company) => {
    const left = normalizeLinkedInProfileUrl(candidate.linkedinCompanyUrl);
    const right = normalizeLinkedInProfileUrl(company.linkedinCompanyUrl);
    return left && right && left === right;
  });
  if (byLinkedIn) return toResult(byLinkedIn, "linkedin_company_url");

  const byName = matches(existingCompanies, (company) => {
    return normalizeText(candidate.name) && normalizeText(candidate.name) === normalizeText(company.name);
  });
  if (byName.length === 1) return toResult(byName[0], "company_name");
  if (byName.length > 1) return { status: "needs_review", strategy: "company_name" };

  return { status: "not_found", strategy: "none" };
}

export function resolveInventoryMatch(candidate, existingInventory) {
  const byMemberId = uniqueMatch(existingInventory, (item) => {
    return Boolean(candidate.linkedinMemberId) && candidate.linkedinMemberId === item.linkedinMemberId;
  });
  if (byMemberId) return toResult(byMemberId, "linkedin_member_id");

  return { status: "not_found", strategy: "none" };
}

export function resolvePortalIndividualMatch(candidate, existingIndividuals) {
  const byMemberId = uniqueMatch(existingIndividuals, (individual) => {
    return (
      Boolean(candidate.linkedinMemberId) &&
      Boolean(individual.linkedinMemberId) &&
      candidate.linkedinMemberId === individual.linkedinMemberId
    );
  });
  if (byMemberId) return toResult(byMemberId, "linkedin_member_id");

  const byNameCompany = matches(existingIndividuals, (individual) => {
    return (
      normalizeText(candidate.firstName) &&
      normalizeText(candidate.firstName) === normalizeText(individual.firstName) &&
      normalizeText(candidate.lastName) === normalizeText(individual.lastName) &&
      normalizeText(candidate.currentCompanyName) &&
      normalizeText(candidate.currentCompanyName) === normalizeText(individual.companyName)
    );
  });
  if (byNameCompany.length === 1) return toResult(byNameCompany[0], "name_company");
  if (byNameCompany.length > 1) return { status: "needs_review", strategy: "name_company" };

  return { status: "not_found", strategy: "none" };
}

export function resolvePortalCompanyMatch(candidate, existingCompanies) {
  const byLinkedInCompanyId = uniqueMatch(existingCompanies, (company) => {
    return (
      Boolean(candidate.linkedinCompanyId) &&
      Boolean(company.linkedinCompanyId) &&
      candidate.linkedinCompanyId === company.linkedinCompanyId
    );
  });
  if (byLinkedInCompanyId) return toResult(byLinkedInCompanyId, "linkedin_company_id");

  const byLinkedInUrl = uniqueMatch(existingCompanies, (company) => {
    const left = normalizeLinkedInProfileUrl(candidate.linkedinCompanyUrl ?? candidate.linkedin);
    const right = normalizeLinkedInProfileUrl(company.linkedinCompanyUrl ?? company.linkedin);
    return left && right && left === right;
  });
  if (byLinkedInUrl) return toResult(byLinkedInUrl, "linkedin_company_url");

  return { status: "not_found", strategy: "none" };
}

export function missingLinkedInIndividualUpdates(existingIndividual, connection) {
  const updates = {};
  if (!existingIndividual.linkedinMemberId && connection.linkedinMemberId) {
    updates.linkedinMemberId = connection.linkedinMemberId;
  }
  if (!existingIndividual.linkedinLink && connection.linkedinLink) {
    updates.linkedinLink = connection.linkedinLink;
  }
  return updates;
}

export function buildNewCompanyRecord(company) {
  return {
    name: company.name,
    website: company.website ?? company.websiteUrl ?? null,
    linkedin: company.linkedin ?? company.linkedinCompanyUrl ?? null,
    linkedinCompanyId: company.linkedinCompanyId ?? null,
    briefBackground: company.briefBackground ?? null,
    bba: "Kirk",
    typeOfBusiness: "Startup",
    typeOfBusinessId: 2
  };
}

export function buildNewIndividualRecord(individual, companyId) {
  return {
    newCompanyId: companyId,
    firstName: individual.firstName,
    lastName: individual.lastName ?? null,
    mobile: individual.mobile ?? null,
    tel: individual.tel ?? null,
    contactOwner: "Kirk",
    source: "LinkedIn Outreach - AI targeting",
    email: individual.email ?? null,
    linkedinLink: individual.linkedinLink ?? individual.linkedinProfileUrl ?? null,
    linkedinMemberId: individual.linkedinMemberId ?? null
  };
}

export function buildCompanyIndividualTitleRecord(title, ids) {
  return {
    companyId: ids.companyId,
    individualId: ids.individualId,
    status: "Employed",
    title: title.title ?? null,
    isPrimary: true,
    startDate: title.startDate ?? null
  };
}

export function shouldCreateOrUpdateTitle(candidateTitle, existingTitles) {
  const existing = existingTitles.find((title) => {
    return (
      title.individualId === candidateTitle.individualId &&
      title.companyId === candidateTitle.companyId &&
      title.status === candidateTitle.status
    );
  });

  if (!existing) return { action: "create", record: candidateTitle };

  const updates = {};
  for (const field of ["title", "isPrimary", "startDate"]) {
    if (candidateTitle[field] != null && candidateTitle[field] !== existing[field]) {
      updates[field] = candidateTitle[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return { action: "none", titleId: existing.id };
  }

  return { action: "update", titleId: existing.id, updates };
}

function uniqueMatch(items, predicate) {
  const results = matches(items, predicate);
  if (results.length === 1) return results[0];
  if (results.length > 1) return { ambiguous: true };
  return null;
}

function matches(items, predicate) {
  return items.filter((item) => {
    try {
      return predicate(item);
    } catch {
      return false;
    }
  });
}

function toResult(item, strategy) {
  if (item.ambiguous) return { status: "needs_review", strategy };
  return { status: "matched", matchId: item.id, strategy };
}
