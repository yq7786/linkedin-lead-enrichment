import test from "node:test";
import assert from "node:assert/strict";

import { CompanyRepositoryAdapter } from "../src/adapters/companies.js";
import { IndividualRepositoryAdapter } from "../src/adapters/individuals.js";

test("IndividualRepositoryAdapter links a name/company match and updates missing LinkedIn fields", async () => {
  const updates = [];
  class FakeIndividuals extends IndividualRepositoryAdapter {
    async listCandidateMatches() {
      return [{ id: 10, firstName: "Jane", lastName: "Smith", companyName: "Acme", linkedinMemberId: null, linkedinLink: null }];
    }

    async updateMissingLinkedInFields(id, fields) {
      updates.push({ id, fields });
      return { id, ...fields };
    }
  }

  const result = await new FakeIndividuals().matchAndPatchMissingLinkedInFields({
    firstName: "Jane",
    lastName: "Smith",
    currentCompanyName: "Acme",
    linkedinMemberId: "member_1",
    linkedinLink: "https://www.linkedin.com/in/jane-smith"
  });

  assert.deepEqual(result.match, { status: "matched", matchId: 10, strategy: "name_company" });
  assert.deepEqual(updates, [
    {
      id: 10,
      fields: {
        linkedinMemberId: "member_1",
        linkedinLink: "https://www.linkedin.com/in/jane-smith"
      }
    }
  ]);
});

test("CompanyRepositoryAdapter.findOrCreate reuses a matched company before creating", async () => {
  let created = false;
  class FakeCompanies extends CompanyRepositoryAdapter {
    async listCandidateMatches() {
      return [{ id: 20, linkedinCompanyId: "company_1" }];
    }

    async createCompany() {
      created = true;
    }
  }

  const result = await new FakeCompanies().findOrCreate({ linkedinCompanyId: "company_1", name: "Acme" });

  assert.deepEqual(result, { id: 20, reused: true, strategy: "linkedin_company_id" });
  assert.equal(created, false);
});
