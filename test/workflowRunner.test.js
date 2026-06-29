import test from "node:test";
import assert from "node:assert/strict";

import { hasRecentVisiblePostOrComment, isHighPotentialFit } from "../src/ai/scoreFit.js";
import { createPortalRecordsForHighPotentialFit, processDraftSubmission } from "../src/workflowRunner.js";

test("processDraftSubmission skips portal calls in dry-run mode", async () => {
  let calls = 0;
  const result = await processDraftSubmission(
    {
      individualId: 1,
      inventoryId: "inventory_1",
      draftText: "Hi Jane",
      personalizationEvidence: ["recent post"]
    },
    {
      dryRun: true,
      portalDrafts: {
        createDraft: async () => {
          calls += 1;
          return { portalDraftId: "portal_1" };
        }
      },
      drafts: { saveDraft: async (draft) => ({ ...draft, id: "draft_1" }) },
      audit: { write: async () => undefined }
    }
  );

  assert.equal(calls, 0);
  assert.equal(result.portalDraftId, null);
  assert.equal(result.status, "draft_created");
});

test("hasRecentVisiblePostOrComment requires a visible post or comment within the last 6 months", () => {
  const now = new Date("2026-06-25T00:00:00Z");

  assert.equal(
    hasRecentVisiblePostOrComment(
      [
        { activityType: "like", postedAt: "2026-06-01T00:00:00Z", content: "Liked a post" },
        { activityType: "post", postedAt: "2025-12-24T00:00:00Z", content: "Old post" },
        { activityType: "comment", postedAt: "2026-01-25T00:00:00Z", content: "Recent comment" }
      ],
      now
    ),
    true
  );

  assert.equal(
    hasRecentVisiblePostOrComment(
      [
        { activityType: "like", postedAt: "2026-06-01T00:00:00Z", content: "Liked a post" },
        { activityType: "post", postedAt: "2025-12-24T00:00:00Z", content: "Old post" }
      ],
      now
    ),
    false
  );
});

test("isHighPotentialFit requires founder, startup, and recent activity signals", () => {
  assert.equal(
    isHighPotentialFit({ founderSignal: true, startupSignal: true, recentActivitySignal: true, fitScore: 0.1 }),
    true
  );
  assert.equal(
    isHighPotentialFit({ founderSignal: true, startupSignal: true, recentActivitySignal: false, fitScore: 1 }),
    false
  );
});

test("createPortalRecordsForHighPotentialFit reuses company before creating individual and title", async () => {
  const calls = [];
  const result = await createPortalRecordsForHighPotentialFit(
    {
      fit: { founderSignal: true, startupSignal: true, recentActivitySignal: true },
      company: {
        name: "Acme AI",
        websiteUrl: "https://acme.ai",
        linkedinCompanyUrl: "https://www.linkedin.com/company/acme-ai",
        linkedinCompanyId: "123",
        briefBackground: "AI workflow startup."
      },
      individual: {
        firstName: "Jane",
        lastName: "Smith",
        email: "jane@example.com",
        linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith",
        linkedinMemberId: "member_1"
      },
      title: { title: "Founder", startDate: "2025-01-01T00:00:00.000Z" }
    },
    {
      companies: {
        findOrCreate: async (record) => {
          calls.push(["company", record]);
          return { id: 20, reused: true };
        }
      },
      individuals: {
        create: async (record) => {
          calls.push(["individual", record]);
          return { id: 10 };
        }
      },
      titles: {
        createOrUpdate: async (record) => {
          calls.push(["title", record]);
          return { action: "create", id: 30 };
        }
      }
    }
  );

  assert.deepEqual(result, { status: "created", individualId: 10, companyId: 20, titleResult: { action: "create", id: 30 } });
  assert.equal(calls[0][0], "company");
  assert.equal(calls[0][1].bba, "Kirk");
  assert.equal(calls[0][1].typeOfBusinessId, 2);
  assert.equal(calls[1][0], "individual");
  assert.equal(calls[1][1].newCompanyId, 20);
  assert.equal(calls[1][1].source, "LinkedIn Outreach - AI targeting");
  assert.equal(calls[2][0], "title");
  assert.equal(calls[2][1].status, "Employed");
  assert.equal(calls[2][1].isPrimary, true);
});

test("createPortalRecordsForHighPotentialFit skips portal creation when any required signal is false", async () => {
  let created = false;
  const result = await createPortalRecordsForHighPotentialFit(
    {
      fit: { founderSignal: true, startupSignal: true, recentActivitySignal: false },
      company: { name: "Acme AI" },
      individual: { firstName: "Jane" },
      title: { title: "Founder" }
    },
    {
      companies: { findOrCreate: async () => { created = true; } },
      individuals: { create: async () => { created = true; } },
      titles: { createOrUpdate: async () => { created = true; } }
    }
  );

  assert.deepEqual(result, { status: "skipped_not_fit", individualId: null, companyId: null, titleResult: null });
  assert.equal(created, false);
});
