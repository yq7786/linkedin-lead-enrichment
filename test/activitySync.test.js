import test from "node:test";
import assert from "node:assert/strict";

import {
  ActivityItemsRepository,
  normalizeActivityCards,
  syncLinkedInActivityItems
} from "../src/linkedin/activitySync.js";

test("normalizeActivityCards keeps the last 10 visible posts/comments with inferred dates", () => {
  const now = new Date("2026-06-25T00:00:00Z");
  const cards = Array.from({ length: 12 }, (_, index) => ({
    text: `${index % 2 === 0 ? "Jane posted this" : "Jane commented on this"}\n${index + 1}w\nUseful update ${index + 1}`,
    activityHref: `https://www.linkedin.com/feed/update/${index + 1}`
  }));

  const items = normalizeActivityCards(cards, { now, limit: 10 });

  assert.equal(items.length, 10);
  assert.equal(items[0].activityType, "post");
  assert.equal(items[1].activityType, "comment");
  assert.equal(items[0].postedAt, "2026-06-18T00:00:00.000Z");
  assert.match(items[0].markdown, /Jane posted this/);
  assert.equal(items[0].content, "Useful update 1");
  assert.equal(items[9].activityUrl, "https://www.linkedin.com/feed/update/10");
});

test("normalizeActivityCards returns only post body content instead of actor metadata", () => {
  const items = normalizeActivityCards(
    [{
      text: [
        "Feed post number 1",
        "Jane Smith",
        "   • 1st",
        "Founder at Acme AI",
        "2w • Edited •",
        "",
        "Building useful automation.",
        "…more",
        "Acme AI",
        "1,234 followers"
      ].join("\n"),
      activityHref: "/feed/update/urn:li:activity:123"
    }],
    { now: new Date("2026-06-26T00:00:00.000Z") }
  );

  assert.equal(items[0].content, "Building useful automation.");
  assert.equal("textExcerpt" in items[0], false);
});

test("normalizeActivityCards removes LinkedIn action footer lines from content", () => {
  const items = normalizeActivityCards(
    [{
      text: [
        "Jane Smith",
        "2w •",
        "",
        "Building useful automation.",
        "",
        "1 comment",
        "3 reposts",
        "Like",
        "Comment",
        "Repost",
        "Send"
      ].join("\n"),
      activityHref: "/feed/update/urn:li:activity:123"
    }],
    { now: new Date("2026-06-26T00:00:00.000Z") }
  );

  assert.equal(items[0].content, "Building useful automation.");
});

test("normalizeActivityCards returns only reposted body content after metadata", () => {
  const items = normalizeActivityCards(
    [{
      text: [
        "Feed post number 2",
        "Jane Smith reposted this",
        "Acme AI",
        "1,234 followers",
        "2mo •",
        "",
        "Follow",
        "Your legacy app is not just slowing you down,",
        "But it is silently bleeding your business dry."
      ].join("\n"),
      activityHref: null
    }],
    { now: new Date("2026-06-26T00:00:00.000Z") }
  );

  assert.equal(items[0].content, "Your legacy app is not just slowing you down,\nBut it is silently bleeding your business dry.");
});

test("syncLinkedInActivityItems dry-run extracts activities without writing", async () => {
  const writes = [];
  const result = await syncLinkedInActivityItems({
    inventoryRepository: {
      listActivityCandidates: async () => [
        { inventoryId: "inventory_1", linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith" }
      ]
    },
    extractActivities: async () => [
      {
        activityType: "post",
        activityUrl: "https://www.linkedin.com/feed/update/1",
        postedAt: "2026-06-18T00:00:00.000Z",
        content: "Jane posted this",
        markdown: "Jane posted this\n\nUseful update."
      }
    ],
    activityRepository: {
      replaceActivityItems: async (...args) => writes.push(args)
    },
    dryRun: true
  });

  assert.equal(result.status, "dry_run");
  assert.deepEqual(result.summary, { profilesProcessed: 1, activitiesCaptured: 1, failed: 0 });
  assert.deepEqual(writes, []);
});

test("syncLinkedInActivityItems live mode updates workflow status without writing activity rows", async () => {
  const writes = [];
  const result = await syncLinkedInActivityItems({
    inventoryRepository: {
      listActivityCandidates: async () => [
        { inventoryId: "inventory_1", linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith" }
      ],
      markActivitiesExtracted: async (inventoryId) => writes.push(["status", inventoryId])
    },
    extractActivities: async () => [
      {
        activityType: "comment",
        activityUrl: "https://www.linkedin.com/feed/update/1",
        postedAt: "2026-06-18T00:00:00.000Z",
        content: "Jane commented on this",
        markdown: "Jane commented on this\n\nUseful comment."
      }
    ],
    activityRepository: {
      replaceActivityItems: async () => writes.push(["db"])
    }
  });

  assert.equal(result.status, "synced");
  assert.deepEqual(result.summary, { profilesProcessed: 1, activitiesCaptured: 1, failed: 0 });
  assert.deepEqual(writes, [["status", "inventory_1"]]);
});

test("syncLinkedInActivityItems updates candidate file with activityCapture", async () => {
  const writes = [];
  const result = await syncLinkedInActivityItems({
    inventoryRepository: {
      listActivityCandidates: async () => [
        { inventoryId: "inventory_1", linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith" }
      ],
      markActivitiesExtracted: async (inventoryId) => writes.push(["status", inventoryId])
    },
    candidateRepository: {
      upsertCandidate: async (input) => writes.push(["candidate", input.inventoryId, input.patch.activityCapture.items[0].content, input.status])
    },
    extractActivities: async () => [
      {
        activityType: "post",
        activityUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123",
        postedAt: "2026-06-20T00:00:00.000Z",
        content: "Building useful automation.",
        isVisiblePostOrCommentWithin6Months: true
      }
    ]
  });

  assert.equal(result.summary.activitiesCaptured, 1);
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", "Building useful automation.", "activity_captured"],
    ["status", "inventory_1"]
  ]);
});

test("ActivityItemsRepository lists candidates and marks activities extracted without activity row writes", async () => {
  const queries = [];
  const repository = new ActivityItemsRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("from linkedin_connection_inventory")) {
        return {
          rows: [
            {
              inventory_id: "inventory_1",
              individual_id: 10,
              linkedin_profile_url: "https://www.linkedin.com/in/jane-smith"
            }
          ]
        };
      }
      return { rows: [], rowCount: 1 };
    }
  });

  const candidates = await repository.listActivityCandidates({ limit: 1 });
  await repository.markActivitiesExtracted(candidates[0].inventoryId);

  assert.equal(candidates[0].inventoryId, "inventory_1");
  assert.match(queries[0].sql, /workflow_status = 'company_captured'/);
  assert.match(queries[0].sql, /dedupe_status = 'not_found'/);
  assert.deepEqual(queries[0].params, [1]);
  assert.match(queries[1].sql, /workflow_status = 'activity_captured'/i);
  assert.match(queries[1].sql, /current_step = 'linkedin_activity_extracted'/i);
  assert.equal(queries.some((query) => /linkedin_activity_items/i.test(query.sql)), false);
});
