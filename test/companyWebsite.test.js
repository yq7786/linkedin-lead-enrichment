import test from "node:test";
import assert from "node:assert/strict";

import {
  captureCompanyWebsiteWithPlaywright,
  cleanWebsiteMarkdown,
  htmlToWebsiteMarkdown,
  normalizeCompanyWebsiteCapture
} from "../src/company/websiteCapture.js";
import { CompanyWebsiteRepository, syncCompanyWebsites } from "../src/workflow/syncCompanyWebsites.js";

test("cleanWebsiteMarkdown removes image paths and unwraps link URLs", () => {
  const cleaned = cleanWebsiteMarkdown(
    "[![logo](/img/logo.svg)](/)\n\n[About Us](/about)\n\n![partner](/_ipx/f_webp/img/partner.png)\n\nReal content here."
  );

  assert.doesNotMatch(cleaned, /\/img\//);
  assert.doesNotMatch(cleaned, /!\[/);
  assert.match(cleaned, /About Us/);
  assert.match(cleaned, /Real content here/);
});

test("cleanWebsiteMarkdown removes decorative rules and embedded script blobs", () => {
  const cleaned = cleanWebsiteMarkdown(
    "Headline\n----------------------------------------\n\nBody text.\n\nwindow.__NUXT__={public:{siteUrl:\"https://acme.ai\"}};"
  );

  assert.doesNotMatch(cleaned, /^-{4,}$/m);
  assert.doesNotMatch(cleaned, /window\.__NUXT__/);
  assert.match(cleaned, /Headline/);
  assert.match(cleaned, /Body text/);
});

test("htmlToWebsiteMarkdown skips images, chrome, and keeps readable text", () => {
  const markdown = htmlToWebsiteMarkdown(`
    <nav><a href="/about">About</a></nav>
    <header><a href="/contact">Contact</a></header>
    <main>
      <h1>Acme AI</h1>
      <p>Workflow automation for startups.</p>
      <img src="/img/hero.png" alt="hero">
    </main>
    <footer>© 2026 Acme. All rights reserved</footer>
    <script>window.__NUXT__={}</script>
  `);

  assert.match(markdown, /Acme AI/);
  assert.match(markdown, /Workflow automation/);
  assert.doesNotMatch(markdown, /About/);
  assert.doesNotMatch(markdown, /Contact/);
  assert.doesNotMatch(markdown, /\/img\//);
  assert.doesNotMatch(markdown, /window\.__NUXT__/);
  assert.doesNotMatch(markdown, /All rights reserved/);
});

test("cleanWebsiteMarkdown fixes run-on spacing and removes empty list items", () => {
  const cleaned = cleanWebsiteMarkdown(
    "(+61) 1300 169 219Let's Chat\n\nApp DevelopmentWe're experienced.\n\n-\n-\n\n© 2026 Acme"
  );

  assert.match(cleaned, /219\n\nLet's Chat/);
  assert.match(cleaned, /App Development\n\nWe're experienced/);
  assert.doesNotMatch(cleaned, /^\s*-\s*$/m);
  assert.doesNotMatch(cleaned, /© 2026/);
});

test("normalizeCompanyWebsiteCapture supports multi-page output", () => {
  const capture = normalizeCompanyWebsiteCapture({
    rootUrl: "https://acme.ai",
    pages: [
      { pageName: "Home", pageURL: "https://acme.ai", contentMarkdown: "# Home" },
      { pageName: "About", pageURL: "https://acme.ai/about", contentMarkdown: "# About" }
    ]
  });

  assert.equal(capture.source, "playwright");
  assert.equal(capture.rootUrl, "https://acme.ai");
  assert.equal(capture.pages.length, 2);
  assert.equal(capture.pages[1].pageName, "About");
});

test("captureCompanyWebsiteWithPlaywright waits for JS-rendered body content", async () => {
  let hydrated = false;
  const page = {
    async goto() {},
    async title() {
      return "Acme AI";
    },
    url() {
      return "https://acme.ai/";
    },
    async waitForFunction() {
      hydrated = true;
    },
    async evaluate(fn, selectors) {
      const previousDocument = globalThis.document;
      globalThis.document = {
        body: {
          cloneNode() {
            return {
              querySelectorAll() {
                return [];
              },
              innerHTML: hydrated
                ? "<main><h1>Acme AI</h1><p>AI workflow automation for startups.</p></main>"
                : "<div id=\"app\"><img src=\"/loader.gif\" alt=\"loading\"></div>"
            };
          }
        }
      };
      try {
        return fn(selectors);
      } finally {
        globalThis.document = previousDocument;
      }
    }
  };

  const capture = await captureCompanyWebsiteWithPlaywright(page, "https://acme.ai");

  assert.equal(capture.pages.length, 1);
  assert.match(capture.pages[0].contentMarkdown, /AI workflow automation/);
});

test("syncCompanyWebsites updates candidate companyWebsite and inventory workflow status", async () => {
  const writes = [];
  const result = await syncCompanyWebsites({
    candidateRepository: {
      listByStatus: async () => [
        {
          candidate: { inventoryId: "inventory_1", status: "qualified" },
          companyCapture: { facts: { website: "https://acme.ai" } }
        }
      ],
      upsertCandidate: async (input) => writes.push(["candidate", input.inventoryId, input.patch.companyWebsite.pages.length, input.status])
    },
    repository: {
      markWebsiteCaptured: async (inventoryId) => writes.push(["status", inventoryId])
    },
    captureWebsite: async () => ({
      source: "playwright",
      rootUrl: "https://acme.ai",
      pages: [{ pageName: "Home", pageURL: "https://acme.ai", contentMarkdown: "# Home" }]
    })
  });

  assert.deepEqual(result.summary, { websitesProcessed: 1, failed: 0 });
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", 1, "website_captured"],
    ["status", "inventory_1"]
  ]);
});

test("CompanyWebsiteRepository marks website captured", async () => {
  const queries = [];
  const repository = new CompanyWebsiteRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
  });

  await repository.markWebsiteCaptured("inventory_1");

  assert.match(queries[0].sql, /workflow_status = 'website_captured'/i);
  assert.match(queries[0].sql, /current_step = 'company_website_captured'/i);
  assert.deepEqual(queries[0].params, ["inventory_1"]);
});
