import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectionInventoryRepository,
  extractConnectionCardsFromPage,
  normalizeConnectionCards,
  syncLinkedInConnections
} from "../src/linkedin/connectionSync.js";

test("normalizeConnectionCards dedupes and maps raw LinkedIn card data to inventory records", () => {
  const records = normalizeConnectionCards([
    {
      profileHref: "https://www.linkedin.com/in/jane-smith/?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAA123",
      text: "Jane Smith\nFounder at Acme AI\nSydney, New South Wales",
      companyHref: "https://www.linkedin.com/company/acme-ai/"
    },
    {
      profileHref: "https://www.linkedin.com/in/jane-smith/?trackingId=duplicate",
      text: "Jane Smith\nFounder at Acme AI"
    }
  ]);

  assert.deepEqual(records, [
    {
      linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith",
      fullName: "Jane Smith",
      headline: "Founder at Acme AI",
      currentCompanyName: null,
      currentCompanyUrl: null,
      account: null,
      processingSource: "connection_sync",
      dedupeStatus: "dedupe_pending",
      workflowStatus: "discovered"
    }
  ]);
});

test("syncLinkedInConnections dry-run returns extracted records without writing inventory", async () => {
  let wrote = false;
  const result = await syncLinkedInConnections({
    extractConnections: async () =>
      normalizeConnectionCards([
        {
          profileHref: "https://www.linkedin.com/in/jane-smith/",
          text: "Jane Smith\nFounder at Acme AI"
        }
      ]),
    inventoryRepository: {
      upsertMany: async () => {
        wrote = true;
      }
    },
    dryRun: true
  });

  assert.equal(wrote, false);
  assert.equal(result.status, "dry_run");
  assert.equal(result.connections.length, 1);
});

test("syncLinkedInConnections writes normalized records in live mode", async () => {
  const writes = [];
  const result = await syncLinkedInConnections({
    extractConnections: async () =>
      normalizeConnectionCards([
        {
          profileHref: "https://www.linkedin.com/in/jane-smith/",
          text: "Jane Smith\nFounder at Acme AI"
        }
      ]),
    inventoryRepository: {
      upsertMany: async (records) => {
        writes.push(records);
        return { upserted: records.length };
      }
    },
    dryRun: false
  });

  assert.equal(result.status, "synced");
  assert.equal(result.upserted, 1);
  assert.equal(writes[0][0].linkedinProfileUrl, "https://www.linkedin.com/in/jane-smith");
  assert.equal(writes[0][0].processingSource, "connection_sync");
});

test("syncLinkedInConnections stamps the selected LinkedIn account on records", async () => {
  const writes = [];
  const result = await syncLinkedInConnections({
    extractConnections: async () =>
      normalizeConnectionCards([
        {
          profileHref: "https://www.linkedin.com/in/jane-smith/",
          text: "Jane Smith\nFounder at Acme AI"
        }
      ]),
    inventoryRepository: {
      upsertMany: async (records) => {
        writes.push(records);
        return { upserted: records.length };
      }
    },
    account: "Kirk"
  });

  assert.equal(result.connections[0].account, "Kirk");
  assert.equal(writes[0][0].account, "Kirk");
});

test("syncLinkedInConnections uses existing eligible inventory before scraping LinkedIn", async () => {
  let extracted = false;
  let wrote = false;
  const result = await syncLinkedInConnections({
    limit: 2,
    extractConnections: async () => {
      extracted = true;
      return [];
    },
    inventoryRepository: {
      listEligibleForEnrichment: async ({ limit }) => [
        {
          id: "inventory_1",
          linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith"
        },
        {
          id: "inventory_2",
          linkedinProfileUrl: "https://www.linkedin.com/in/john-smith"
        }
      ].slice(0, limit),
      upsertMany: async () => {
        wrote = true;
      }
    }
  });

  assert.equal(extracted, false);
  assert.equal(wrote, false);
  assert.deepEqual(result.summary, {
    requested: 2,
    batchSize: 2,
    existingSelected: 2,
    discovered: 0,
    upserted: 0,
    remaining: 0,
    exhausted: false,
    scanAttempts: 0
  });
  assert.deepEqual(result.profileUrls, [
    "https://www.linkedin.com/in/jane-smith",
    "https://www.linkedin.com/in/john-smith"
  ]);
  assert.deepEqual(result.inventoryIds, ["inventory_1", "inventory_2"]);
});

test("syncLinkedInConnections tops up existing eligible inventory from new LinkedIn connections", async () => {
  const writes = [];
  const result = await syncLinkedInConnections({
    limit: 3,
    extractConnections: async ({ limit }) => {
      assert.equal(limit, 2);
      return normalizeConnectionCards([
        {
          profileHref: "https://www.linkedin.com/in/processed-person/",
          text: "Processed Person\nFounder at Old Co"
        },
        {
          profileHref: "https://www.linkedin.com/in/new-person/",
          text: "New Person\nFounder at New Co"
        },
        {
          profileHref: "https://www.linkedin.com/in/another-new-person/",
          text: "Another New Person\nCTO at New Co"
        }
      ]);
    },
    inventoryRepository: {
      listEligibleForEnrichment: async () => [
        {
          id: "inventory_1",
          linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith"
        }
      ],
      findByProfileUrls: async (profileUrls) =>
        profileUrls
          .filter((url) => url === "https://www.linkedin.com/in/processed-person")
          .map((url) => ({
            id: "processed_1",
            linkedinProfileUrl: url,
            workflowStatus: "submitted",
            dedupeStatus: "dedupe_pending"
          })),
      upsertMany: async (records) => {
        writes.push(records);
        return { upserted: records.length };
      }
    },
    account: "Kirk"
  });

  assert.equal(result.summary.batchSize, 3);
  assert.equal(result.summary.existingSelected, 1);
  assert.equal(result.summary.discovered, 2);
  assert.equal(result.summary.upserted, 2);
  assert.deepEqual(writes[0].map((record) => record.linkedinProfileUrl), [
    "https://www.linkedin.com/in/new-person",
    "https://www.linkedin.com/in/another-new-person"
  ]);
  assert.equal(writes[0][0].account, "Kirk");
  assert.deepEqual(result.profileUrls, [
    "https://www.linkedin.com/in/jane-smith",
    "https://www.linkedin.com/in/new-person",
    "https://www.linkedin.com/in/another-new-person"
  ]);
});

test("syncLinkedInConnections keeps scanning until the requested limit is filled", async () => {
  const scanLimits = [];
  const scrollPasses = [];
  const writes = [];
  const knownUrls = new Set([
    "https://www.linkedin.com/in/already-submitted-1",
    "https://www.linkedin.com/in/already-submitted-2",
    "https://www.linkedin.com/in/already-submitted-3",
    "https://www.linkedin.com/in/already-submitted-4",
    "https://www.linkedin.com/in/already-submitted-5"
  ]);

  const result = await syncLinkedInConnections({
    limit: 20,
    extractConnections: async ({ scanLimit, scrollPasses: requestedScrollPasses }) => {
      scanLimits.push(scanLimit);
      scrollPasses.push(requestedScrollPasses);
      const cards = [];
      for (let index = 1; index <= 5; index += 1) {
        cards.push({
          profileHref: `https://www.linkedin.com/in/already-submitted-${index}/`,
          text: `Already Submitted ${index}\nFounder at Old Co`
        });
      }
      for (let index = 1; index <= Math.max(0, scanLimit - 5); index += 1) {
        if (index > 15 && requestedScrollPasses < 6) continue;
        cards.push({
          profileHref: `https://www.linkedin.com/in/new-person-${index}/`,
          text: `New Person ${index}\nFounder at New Co`
        });
      }
      return normalizeConnectionCards(cards);
    },
    inventoryRepository: {
      listEligibleForEnrichment: async () => [],
      findByProfileUrls: async (profileUrls) =>
        profileUrls
          .filter((url) => knownUrls.has(url))
          .map((url) => ({
            id: `known_${url.split("-").at(-1)}`,
            linkedinProfileUrl: url,
            workflowStatus: "submitted",
            dedupeStatus: "dedupe_pending"
          })),
      upsertMany: async (records) => {
        writes.push(records);
        return { upserted: records.length };
      }
    },
    account: "Haydn"
  });

  assert.deepEqual(scanLimits, [80, 80]);
  assert.deepEqual(scrollPasses, [3, 6]);
  assert.equal(result.summary.requested, 20);
  assert.equal(result.summary.batchSize, 20);
  assert.equal(result.summary.discovered, 20);
  assert.equal(result.summary.remaining, 0);
  assert.equal(result.summary.exhausted, false);
  assert.equal(result.summary.scanAttempts, 2);
  assert.equal(writes[0].length, 20);
  assert.equal(writes[0][0].linkedinProfileUrl, "https://www.linkedin.com/in/new-person-1");
  assert.equal(writes[0][19].linkedinProfileUrl, "https://www.linkedin.com/in/new-person-20");
});

test("syncLinkedInConnections keeps scanning while LinkedIn reveals more cards even if many are already known", async () => {
  const scanRequests = [];
  const writes = [];
  const knownUrls = new Set(
    Array.from({ length: 15 }, (_, index) => `https://www.linkedin.com/in/already-known-${index + 1}`)
  );

  const result = await syncLinkedInConnections({
    limit: 10,
    extractConnections: async ({ scanLimit, scrollPasses }) => {
      scanRequests.push({ scanLimit, scrollPasses });
      const cards = [];
      for (let index = 1; index <= 15; index += 1) {
        cards.push({
          profileHref: `https://www.linkedin.com/in/already-known-${index}/`,
          text: `Known ${index}\nFounder at Old Co`
        });
      }
      const newVisible = scrollPasses >= 6 ? 10 : 4;
      for (let index = 1; index <= newVisible; index += 1) {
        cards.push({
          profileHref: `https://www.linkedin.com/in/new-person-${index}/`,
          text: `New Person ${index}\nFounder at New Co`
        });
      }
      return normalizeConnectionCards(cards);
    },
    inventoryRepository: {
      listEligibleForEnrichment: async () => [],
      findByProfileUrls: async (profileUrls) =>
        profileUrls
          .filter((url) => knownUrls.has(url))
          .map((url) => ({
            id: `known-${url}`,
            linkedinProfileUrl: url,
            workflowStatus: "submitted",
            dedupeStatus: "dedupe_pending"
          })),
      upsertMany: async (records) => {
        writes.push(records);
        return { upserted: records.length };
      }
    }
  });

  assert.deepEqual(scanRequests.map((request) => request.scrollPasses), [3, 6]);
  assert.equal(result.summary.batchSize, 10);
  assert.equal(result.summary.discovered, 10);
  assert.equal(result.summary.exhausted, false);
  assert.equal(writes[0].length, 10);
});

test("syncLinkedInConnections does not report exhaustion while the page keeps growing even if cards are already known", async () => {
  const knownUrls = new Set(
    Array.from({ length: 100 }, (_, index) => `https://www.linkedin.com/in/known-${index + 1}`)
  );

  const result = await syncLinkedInConnections({
    limit: 10,
    extractConnections: async ({ scrollPasses }) => {
      const visible = scrollPasses >= 9 ? 55 : scrollPasses >= 6 ? 40 : 20;
      return normalizeConnectionCards(
        Array.from({ length: visible }, (_, index) => ({
          profileHref: `https://www.linkedin.com/in/known-${index + 1}/`,
          text: `Known ${index + 1}\nFounder at Old Co`
        }))
      );
    },
    inventoryRepository: {
      listEligibleForEnrichment: async () => [],
      findByProfileUrls: async (profileUrls) =>
        profileUrls
          .filter((url) => knownUrls.has(url))
          .map((url) => ({
            id: `known-${url}`,
            linkedinProfileUrl: url,
            workflowStatus: "submitted",
            dedupeStatus: "dedupe_pending"
          })),
      upsertMany: async () => ({ upserted: 0 })
    }
  });

  assert.equal(result.summary.batchSize, 0);
  assert.equal(result.summary.discovered, 0);
  assert.equal(result.summary.exhausted, false);
  assert.equal(result.summary.scanAttempts, 3);
});

test("syncLinkedInConnections reports exhaustion only after LinkedIn stops yielding additional cards", async () => {
  const result = await syncLinkedInConnections({
    limit: 8,
    extractConnections: async ({ scrollPasses }) => {
      const visible = scrollPasses >= 6 ? 5 : 4;
      return normalizeConnectionCards(
        Array.from({ length: visible }, (_, index) => ({
          profileHref: `https://www.linkedin.com/in/person-${index + 1}/`,
          text: `Person ${index + 1}\nFounder at Company ${index + 1}`
        }))
      );
    },
    inventoryRepository: {
      listEligibleForEnrichment: async () => [],
      findByProfileUrls: async () => [],
      upsertMany: async (records) => ({ upserted: records.length })
    }
  });

  assert.equal(result.summary.batchSize, 5);
  assert.equal(result.summary.remaining, 3);
  assert.equal(result.summary.exhausted, true);
  assert.equal(result.summary.scanAttempts, 3);
});

test("extractConnectionCardsFromPage scrolls until requested connections are loaded", async () => {
  let scrolls = 0;
  const page = {
    async goto(url, options) {
      assert.equal(url, "https://www.linkedin.com/mynetwork/invite-connect/connections/");
      assert.equal(options.waitUntil, "domcontentloaded");
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async evaluate(fn, scanLimit) {
      if (typeof scanLimit === "undefined") {
        scrolls += 1;
        return null;
      }

      const loaded = Math.min(20, scrolls * 4);
      return Array.from({ length: loaded }, (_, index) => ({
        profileHref: `https://www.linkedin.com/in/person-${index + 1}/`,
        text: `Person ${index + 1}\nFounder at Company ${index + 1}`
      }));
    }
  };

  const connections = await extractConnectionCardsFromPage(page, {
    limit: 20,
    scanLimit: 80,
    scrollPasses: 3,
    maxScrollPasses: 8,
    stableScrollPasses: 2
  });

  assert.equal(connections.length, 20);
  assert.equal(scrolls >= 5, true);
});

test("extractConnectionCardsFromPage keeps scanning past the requested useful limit when scanLimit is higher", async () => {
  let scrolls = 0;
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    async evaluate(fn, scanLimit) {
      if (typeof scanLimit === "undefined") {
        scrolls += 1;
        return null;
      }

      const loaded = Math.min(80, scrolls * 10);
      return Array.from({ length: loaded }, (_, index) => ({
        profileHref: `https://www.linkedin.com/in/person-${index + 1}/`,
        text: `Person ${index + 1}\nFounder at Company ${index + 1}`
      }));
    }
  };

  const connections = await extractConnectionCardsFromPage(page, {
    limit: 20,
    scanLimit: 80,
    scrollPasses: 3,
    maxScrollPasses: 8,
    stableScrollPasses: 2
  });

  assert.equal(connections.length, 80);
  assert.equal(scrolls >= 8, true);
});

test("syncLinkedInConnections dry-run reports top-up batch without writing inventory", async () => {
  let wrote = false;
  const result = await syncLinkedInConnections({
    limit: 1,
    extractConnections: async () =>
      normalizeConnectionCards([
        {
          profileHref: "https://www.linkedin.com/in/new-person/",
          text: "New Person\nFounder at New Co"
        }
      ]),
    inventoryRepository: {
      listEligibleForEnrichment: async () => [],
      findByProfileUrls: async () => [],
      upsertMany: async () => {
        wrote = true;
      }
    },
    dryRun: true
  });

  assert.equal(wrote, false);
  assert.equal(result.status, "dry_run");
  assert.deepEqual(result.summary, {
    requested: 1,
    batchSize: 1,
    existingSelected: 0,
    discovered: 1,
    upserted: 0,
    remaining: 0,
    exhausted: false,
    scanAttempts: 1
  });
});

test("ConnectionInventoryRepository upserts by normalized profile URL", async () => {
  const queries = [];
  const repository = new ConnectionInventoryRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      return { rowCount: 1 };
    }
  });

  const result = await repository.upsertMany([
    {
      linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith",
      fullName: "Jane Smith",
      headline: "Founder at Acme AI",
      currentCompanyName: "Acme AI",
      currentCompanyUrl: "https://www.linkedin.com/company/acme-ai",
      account: "Kirk",
      dedupeStatus: "dedupe_pending",
      workflowStatus: "discovered"
    }
  ]);

  assert.equal(result.upserted, 1);
  assert.match(queries[0].sql, /on conflict \(lower\(linkedin_profile_url\)\)/i);
  assert.match(queries[0].sql, /account/i);
  assert.match(queries[0].sql, /processing_source = coalesce\(linkedin_connection_inventory\.processing_source, excluded\.processing_source\)/i);
  assert.deepEqual(queries[0].params.slice(0, 3), [
    "https://www.linkedin.com/in/jane-smith",
    "Jane Smith",
    "Founder at Acme AI"
  ]);
  assert.equal(queries[0].params[5], "Kirk");
  assert.equal(queries[0].params[6], "connection_sync");
});
