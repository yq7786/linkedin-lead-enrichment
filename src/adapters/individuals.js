import {
  missingLinkedInIndividualUpdates,
  resolvePortalIndividualMatch
} from "../dedupe.js";

export class IndividualRepositoryAdapter {
  async listCandidateMatches(_candidate) {
    throw new Error("IndividualRepositoryAdapter.listCandidateMatches must be wired to new_individual joined to new_company.");
  }

  async create(_candidate) {
    throw new Error("IndividualRepositoryAdapter.create must be wired to new_individual.");
  }

  async updateMissingLinkedInFields(_id, _fields) {
    throw new Error("IndividualRepositoryAdapter.updateMissingLinkedInFields must be wired to new_individual.");
  }

  async dedupe(candidate) {
    const candidates = await this.listCandidateMatches(candidate);
    return resolvePortalIndividualMatch(candidate, candidates);
  }

  async matchAndPatchMissingLinkedInFields(candidate) {
    const candidates = await this.listCandidateMatches(candidate);
    const match = resolvePortalIndividualMatch(candidate, candidates);
    if (match.status !== "matched") return { match, updated: null };

    const existing = candidates.find((individual) => individual.id === match.matchId);
    const updates = missingLinkedInIndividualUpdates(existing, candidate);
    if (Object.keys(updates).length === 0) return { match, updated: null };

    const updated = await this.updateMissingLinkedInFields(match.matchId, updates);
    return { match, updated };
  }
}
