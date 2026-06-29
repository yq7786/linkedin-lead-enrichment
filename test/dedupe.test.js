import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeLinkedInProfileUrl,
  resolveInventoryMatch,
  resolvePortalCompanyMatch,
  resolvePortalIndividualMatch,
  shouldCreateOrUpdateTitle
} from "../src/dedupe.js";

test("normalizeLinkedInProfileUrl removes query strings and trailing slash", () => {
  assert.equal(
    normalizeLinkedInProfileUrl("https://www.linkedin.com/in/Jane-Smith/?miniProfileUrn=abc"),
    "https://www.linkedin.com/in/jane-smith"
  );
});

test("resolveInventoryMatch matches existing inventory by exact LinkedIn member ID", () => {
  const result = resolveInventoryMatch(
    { linkedinMemberId: "abc123", linkedinProfileUrl: "https://linkedin.com/in/jane-smith" },
    [
      { id: "inventory_a", linkedinMemberId: "ABC123" },
      { id: "inventory_b", linkedinMemberId: "abc123" }
    ]
  );

  assert.deepEqual(result, { status: "matched", matchId: "inventory_b", strategy: "linkedin_member_id" });
});

test("resolveInventoryMatch does not use profile URL as primary inventory identity", () => {
  const result = resolveInventoryMatch(
    { linkedinProfileUrl: "https://linkedin.com/in/jane-smith" },
    [{ id: "inventory_a", linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith" }]
  );

  assert.deepEqual(result, { status: "not_found", strategy: "none" });
});

test("resolvePortalIndividualMatch prefers LinkedIn member ID over name and company", () => {
  const result = resolvePortalIndividualMatch(
    {
      linkedinMemberId: "member_1",
      firstName: "Jane",
      lastName: "Smith",
      currentCompanyName: "Acme"
    },
    [
      { id: 10, linkedinMemberId: "member_1", firstName: "Someone", lastName: "Else", companyName: "Other" },
      { id: 11, firstName: "Jane", lastName: "Smith", companyName: "Acme" }
    ]
  );

  assert.deepEqual(result, { status: "matched", matchId: 10, strategy: "linkedin_member_id" });
});

test("resolvePortalIndividualMatch falls back to first name, last name, and company name", () => {
  const result = resolvePortalIndividualMatch(
    { firstName: " Jane ", lastName: "Smith", currentCompanyName: "Acme AI" },
    [
      { id: 10, firstName: "Jane", lastName: "Smith", companyName: "Other" },
      { id: 11, firstName: "jane", lastName: "smith", companyName: "Acme AI" }
    ]
  );

  assert.deepEqual(result, { status: "matched", matchId: 11, strategy: "name_company" });
});

test("resolvePortalIndividualMatch marks ambiguous name and company matches for review", () => {
  const result = resolvePortalIndividualMatch(
    { firstName: "Jane", lastName: "Smith", currentCompanyName: "Acme" },
    [
      { id: 10, firstName: "Jane", lastName: "Smith", companyName: "Acme" },
      { id: 11, firstName: "Jane", lastName: "Smith", companyName: "Acme" }
    ]
  );

  assert.deepEqual(result, { status: "needs_review", strategy: "name_company" });
});

test("resolvePortalCompanyMatch prefers exact LinkedIn company ID", () => {
  const result = resolvePortalCompanyMatch(
    { linkedinCompanyId: "12345", linkedinCompanyUrl: "https://www.linkedin.com/company/acme-ai" },
    [
      { id: 1, linkedinCompanyId: "999", linkedinCompanyUrl: "https://www.linkedin.com/company/acme-ai" },
      { id: 2, linkedinCompanyId: "12345" }
    ]
  );

  assert.deepEqual(result, { status: "matched", matchId: 2, strategy: "linkedin_company_id" });
});

test("resolvePortalCompanyMatch falls back to normalized LinkedIn company URL", () => {
  const result = resolvePortalCompanyMatch(
    { linkedinCompanyUrl: "https://linkedin.com/company/Acme-AI/" },
    [{ id: 1, linkedinCompanyUrl: "https://www.linkedin.com/company/acme-ai" }]
  );

  assert.deepEqual(result, { status: "matched", matchId: 1, strategy: "linkedin_company_url" });
});

test("shouldCreateOrUpdateTitle updates an existing individual/company/status title instead of duplicating", () => {
  const result = shouldCreateOrUpdateTitle(
    { individualId: 10, companyId: 20, status: "Employed", title: "Founder", isPrimary: true },
    [{ id: 1, individualId: 10, companyId: 20, status: "Employed", title: null, isPrimary: null }]
  );

  assert.deepEqual(result, {
    action: "update",
    titleId: 1,
    updates: { title: "Founder", isPrimary: true }
  });
});
