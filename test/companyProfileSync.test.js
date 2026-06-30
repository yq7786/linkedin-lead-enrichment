import test from "node:test";
import assert from "node:assert/strict";

import {
  CompanyProfileRepository,
  extractCompanyProfileFromPage,
  normalizeCompanyProfileCapture,
  syncCompanyProfiles
} from "../src/linkedin/companyProfileSync.js";

test("normalizeCompanyProfileCapture extracts LinkedIn about facts without markdown", () => {
  const company = normalizeCompanyProfileCapture({
    sourceUrl: "https://www.linkedin.com/company/acme-ai/about/",
    html: "<main><h1 title=\"Acme AI\">Acme AI</h1></main>",
    text: [
      "Acme AI",
      "Overview",
      "Acme AI builds workflow automation software.",
      "Website",
      "https://acme.ai",
      "Phone",
      "+61 2 1234 5678",
      "Industry",
      "Software Development",
      "Company size",
      "2-10 employees",
      "Headquarters",
      "Sydney, NSW",
      "Founded",
      "2024",
      "Specialties",
      "AI, Automation, SaaS"
    ].join("\n"),
    links: ["https://acme.ai", "https://www.linkedin.com/company/acme-ai/"]
  });

  assert.equal(company.source, "linkedin_company_profile");
  assert.equal(company.sourceUrl, "https://www.linkedin.com/company/acme-ai");
  assert.equal(company.facts.name, "Acme AI");
  assert.equal(company.facts.website, "https://acme.ai");
  assert.equal(company.facts.phone, "+61 2 1234 5678");
  assert.equal(company.facts.industry, "Software Development");
  assert.equal(company.facts.companySize, "2-10 employees");
  assert.equal(company.facts.headquarters, "Sydney, NSW");
  assert.equal(company.facts.founded, "2024");
  assert.deepEqual(company.facts.specialties, ["AI", "Automation", "SaaS"]);
  assert.equal("markdown" in company, false);
});

test("extractCompanyProfileFromPage opens LinkedIn company about page", async () => {
  const calls = [];
  const page = {
    async goto(url, options) {
      calls.push(["goto", url, options.waitUntil]);
    },
    async waitForLoadState(state, options) {
      calls.push(["waitForLoadState", state, options.timeout]);
    },
    async evaluate() {
      calls.push(["evaluate"]);
      return {
        sourceUrl: "https://www.linkedin.com/company/acme-ai/about/",
        html: "<main><h1>Acme AI</h1><a href=\"https://acme.ai\">Website</a></main>",
        text: "Acme AI\nWebsite\nhttps://acme.ai",
        links: ["https://acme.ai"]
      };
    }
  };

  const company = await extractCompanyProfileFromPage(page, {
    companyUrl: "https://www.linkedin.com/company/acme-ai"
  });

  assert.equal(company.facts.website, "https://acme.ai");
  assert.deepEqual(calls, [
    ["goto", "https://www.linkedin.com/company/acme-ai/about/", "domcontentloaded"],
    ["waitForLoadState", "networkidle", 10000],
    ["evaluate"]
  ]);
});

test("syncCompanyProfiles dry-run captures company profiles without writing", async () => {
  const writes = [];
  const result = await syncCompanyProfiles({
    repository: {
      listCompanyCandidates: async () => [
        {
          inventoryId: "inventory_1",
          companyId: 20,
          currentCompanyName: "Acme AI",
          currentCompanyUrl: "https://www.linkedin.com/company/acme-ai"
        }
      ],
      saveCompanyFacts: async (...args) => writes.push(args)
    },
    extractCompany: async () => ({
      source: "linkedin_company_profile",
      sourceUrl: "https://www.linkedin.com/company/acme-ai",
      facts: {
        overview: "Acme AI builds workflow automation software.",
        website: "https://acme.ai"
      }
    }),
    dryRun: true
  });

  assert.equal(result.status, "dry_run");
  assert.deepEqual(result.summary, { companiesProcessed: 1, failed: 0 });
  assert.deepEqual(writes, []);
});

test("syncCompanyProfiles updates candidate file and inventory workflow status", async () => {
  const writes = [];
  const result = await syncCompanyProfiles({
    repository: {
      listCompanyCandidates: async () => [
        { inventoryId: "inventory_1", currentCompanyUrl: "https://www.linkedin.com/company/acme-ai" }
      ],
      saveCompanyFacts: async (item, company) => writes.push(["company_facts", item.inventoryId, company.facts.name]),
      markCompanyCaptured: async (inventoryId) => writes.push(["status", inventoryId])
    },
    candidateRepository: {
      upsertCandidate: async (input) => writes.push(["candidate", input.inventoryId, input.patch.companyCapture.facts.website, input.status])
    },
    extractCompany: async () => ({
      source: "linkedin_company_profile",
      sourceUrl: "https://www.linkedin.com/company/acme-ai",
      facts: {
        name: "Acme AI Pty Ltd",
        overview: "Acme AI builds workflow automation software.",
        website: "https://acme.ai",
        phone: null,
        industry: "Software Development",
        companySize: "2-10 employees",
        headquarters: "Sydney, NSW",
        founded: "2024",
        specialties: ["AI", "Automation"]
      }
    })
  });

  assert.equal(result.summary.companiesProcessed, 1);
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", "https://acme.ai", "company_captured"],
    ["company_facts", "inventory_1", "Acme AI Pty Ltd"],
    ["status", "inventory_1"]
  ]);
});

test("CompanyProfileRepository saves company profile h1 name back to inventory", async () => {
  const queries = [];
  const repository = new CompanyProfileRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
  });

  await repository.saveCompanyFacts(
    { inventoryId: "inventory_1", currentCompanyName: "Old Name" },
    { facts: { name: "SimplifyQA Sdn Bhd" } }
  );

  assert.match(queries[0].sql, /current_company_name = coalesce\(\$1, current_company_name\)/i);
  assert.deepEqual(queries[0].params, ["SimplifyQA Sdn Bhd", "inventory_1"]);
});

test("CompanyProfileRepository lists company candidates without reading or writing snapshots", async () => {
  const queries = [];
  const repository = new CompanyProfileRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("from linkedin_connection_inventory")) {
        return {
          rows: [
            {
              inventory_id: "inventory_1",
              company_id: 20,
              current_company_name: "Acme AI",
              current_company_url: "https://www.linkedin.com/company/acme-ai"
            }
          ]
        };
      }
      return { rows: [], rowCount: 1 };
    }
  });

  const candidates = await repository.listCompanyCandidates({ limit: 1 });

  assert.equal(candidates[0].currentCompanyName, "Acme AI");
  assert.match(queries[0].sql, /workflow_status = 'linkedin_extracted'/);
  assert.match(queries[0].sql, /dedupe_status = 'dedupe_pending'/);
  assert.deepEqual(queries[0].params, [1]);
  assert.equal(queries.some((query) => /lead_enrichment_snapshots/i.test(query.sql)), false);
});

test("CompanyProfileRepository marks company profile captured", async () => {
  const queries = [];
  const repository = new CompanyProfileRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
  });

  await repository.markCompanyCaptured("inventory_1");

  assert.match(queries[0].sql, /workflow_status = 'company_captured'/i);
  assert.match(queries[0].sql, /current_step = 'linkedin_company_profile_extracted'/i);
  assert.deepEqual(queries[0].params, ["inventory_1"]);
});
