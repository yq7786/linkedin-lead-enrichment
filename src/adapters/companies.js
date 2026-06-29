import { resolvePortalCompanyMatch } from "../dedupe.js";

export class CompanyRepositoryAdapter {
  async listCandidateMatches(_candidate) {
    throw new Error("CompanyRepositoryAdapter.listCandidateMatches must be wired to new_company.");
  }

  async createCompany(_candidate) {
    throw new Error("CompanyRepositoryAdapter.createCompany must be wired to new_company.");
  }

  async dedupe(candidate) {
    const candidates = await this.listCandidateMatches(candidate);
    return resolvePortalCompanyMatch(candidate, candidates);
  }

  async findOrCreate(candidate) {
    const candidates = await this.listCandidateMatches(candidate);
    const match = resolvePortalCompanyMatch(candidate, candidates);
    if (match.status === "matched") {
      return { id: match.matchId, reused: true, strategy: match.strategy };
    }
    if (match.status === "needs_review") {
      return { status: "needs_review", strategy: match.strategy };
    }
    const created = await this.createCompany(candidate);
    return { ...created, reused: false, strategy: "created" };
  }
}
