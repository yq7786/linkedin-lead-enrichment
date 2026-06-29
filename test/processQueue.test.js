import assert from "node:assert/strict";
import test from "node:test";

import {
  ProcessQueueRepository,
  createPlaywrightProfileExtractor,
  extractCurrentCompanyFromProfileHtml,
  extractProfileMainText,
  processQueuedProfiles,
  refreshProfileCaptures
} from "../src/workflow/processQueue.js";

test("processQueuedProfiles dry-run extracts queued profiles without writing snapshots or status", async () => {
  const writes = [];
  const result = await processQueuedProfiles({
    queueRepository: {
      listQueued: async () => [
        { id: "inventory_1", linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith" }
      ],
      saveProfileFacts: async (...args) => writes.push(["facts", args]),
      markLinkedInExtracted: async (...args) => writes.push(["status", args])
    },
    extractProfile: async (item) => ({
      source: "linkedin_profile",
      sourceUrl: item.linkedinProfileUrl,
      identity: { firstName: "Jane", lastName: "Smith" },
      facts: {
        about: null,
        currentCompanyName: "Acme AI",
        currentCompanyLinkedInUrl: null,
        currentRoleTitle: "Founder",
        currentRoleStartDate: null,
        jobHistory: [],
        contact: { email: null, mobile: null, tel: null }
      }
    }),
    dryRun: true
  });

  assert.deepEqual(result.summary, { extracted: 1, failed: 0 });
  assert.equal(result.items[0].status, "extracted");
  assert.equal(result.items[0].currentCompanyName, "Acme AI");
  assert.deepEqual(writes, []);
});

test("processQueuedProfiles saves candidate file and marks linkedin_extracted in live mode", async () => {
  const writes = [];
  const result = await processQueuedProfiles({
    queueRepository: {
      listQueued: async () => [
        { id: "inventory_1", linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith" }
      ],
      markLinkedInExtracted: async (id) => writes.push(["status", id])
    },
    candidateRepository: {
      upsertCandidate: async (input) =>
        writes.push(["candidate", input.inventoryId, input.patch.profileCapture.facts.currentCompanyName, input.status])
    },
    extractProfile: async (item) => ({
      source: "linkedin_profile",
      sourceUrl: item.linkedinProfileUrl,
      identity: { firstName: "Jane", lastName: "Smith", linkedinProfileUrl: item.linkedinProfileUrl },
      facts: {
        about: null,
        currentCompanyName: "Acme AI",
        currentCompanyLinkedInUrl: null,
        currentRoleTitle: "Founder",
        currentRoleStartDate: null,
        jobHistory: [],
        contact: { email: null, mobile: null, tel: null }
      }
    })
  });

  assert.deepEqual(result.summary, { extracted: 1, failed: 0 });
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", "Acme AI", "profile_captured"],
    ["status", "inventory_1"]
  ]);
});

test("processQueuedProfiles writes profile facts to candidate file and marks extracted", async () => {
  const writes = [];
  const result = await processQueuedProfiles({
    queueRepository: {
      listQueued: async () => [
        { id: "inventory_1", fullName: "Jane Smith", linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith" }
      ],
      markLinkedInExtracted: async (id) => writes.push(["status", id])
    },
    candidateRepository: {
      upsertCandidate: async (input) =>
        writes.push(["candidate", input.inventoryId, input.patch.profileCapture.facts.currentCompanyName, input.status])
    },
    extractProfile: async (item) => ({
      source: "linkedin_profile",
      sourceUrl: item.linkedinProfileUrl,
      identity: {
        firstName: "Jane",
        lastName: "Smith",
        linkedinProfileUrl: item.linkedinProfileUrl,
        linkedinMemberId: null,
        headline: "Founder at Acme AI",
        location: null
      },
      facts: {
        about: "Building useful automation.",
        currentCompanyName: "Acme AI",
        currentCompanyLinkedInUrl: "https://www.linkedin.com/company/acme-ai",
        currentRoleTitle: "Founder",
        currentRoleStartDate: null,
        jobHistory: [],
        contact: { email: null, mobile: null, tel: null }
      }
    })
  });

  assert.deepEqual(result.summary, { extracted: 1, failed: 0 });
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", "Acme AI", "profile_captured"],
    ["status", "inventory_1"]
  ]);
});

test("refreshProfileCaptures rewrites candidate profile facts and preserves candidate status", async () => {
  const writes = [];
  const result = await refreshProfileCaptures({
    repository: {
      listProfilesForRefresh: async () => [
        { id: "inventory_1", fullName: "Redmond Riddell", linkedinProfileUrl: "https://www.linkedin.com/in/redr" }
      ],
      updateInventoryCompanyFromFacts: async (item, capture) =>
        writes.push(["inventory", item.id, capture.facts.currentCompanyName])
    },
    candidateRepository: {
      findByInventoryId: async () => ({
        candidate: {
          inventoryId: "inventory_1",
          status: "website_captured"
        }
      }),
      upsertCandidate: async (input) =>
        writes.push([
          "candidate",
          input.inventoryId,
          input.patch.profileCapture.facts.jobHistory[1].companyName,
          input.status
        ])
    },
    extractProfile: async (item) => ({
      source: "linkedin_profile",
      sourceUrl: item.linkedinProfileUrl,
      identity: {
        firstName: "Redmond",
        lastName: "Riddell",
        linkedinProfileUrl: item.linkedinProfileUrl
      },
      facts: {
        about: "Work across Computer Vision, AI/AR, and creative technology.",
        currentCompanyName: "Vello Technologies",
        currentCompanyLinkedInUrl: "https://www.linkedin.com/company/vello-technologies",
        currentRoleTitle: "Chief Technology Officer",
        currentRoleStartDate: "Jan 2025",
        jobHistory: [
          { title: "Chief Technology Officer", companyName: "Vello Technologies" },
          { title: "Head of Software Engineering", companyName: "Defence Australia" }
        ],
        contact: { email: null, mobile: null, tel: null }
      }
    })
  });

  assert.deepEqual(result.summary, { profilesRefreshed: 1 });
  assert.deepEqual(writes, [
    ["candidate", "inventory_1", "Defence Australia", "website_captured"],
    ["inventory", "inventory_1", "Vello Technologies"]
  ]);
});

test("refreshProfileCaptures dry-run extracts profiles without writing candidate files or inventory", async () => {
  const writes = [];
  const result = await refreshProfileCaptures({
    repository: {
      listProfilesForRefresh: async () => [
        { id: "inventory_1", linkedinProfileUrl: "https://www.linkedin.com/in/redr" }
      ],
      updateInventoryCompanyFromFacts: async (...args) => writes.push(["inventory", args])
    },
    candidateRepository: {
      upsertCandidate: async (...args) => writes.push(["candidate", args])
    },
    extractProfile: async (item) => ({
      source: "linkedin_profile",
      sourceUrl: item.linkedinProfileUrl,
      identity: { firstName: "Redmond", lastName: "Riddell" },
      facts: {
        currentCompanyName: "Vello Technologies",
        jobHistory: []
      }
    }),
    dryRun: true
  });

  assert.equal(result.status, "dry_run");
  assert.deepEqual(result.summary, { profilesRefreshed: 1 });
  assert.deepEqual(writes, []);
});

test("ProcessQueueRepository lists queued rows and updates status without writing snapshots", async () => {
  const queries = [];
  const repository = new ProcessQueueRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("from linkedin_connection_inventory")) {
        return {
          rows: [
            {
              id: "inventory_1",
              linkedin_profile_url: "https://www.linkedin.com/in/jane-smith"
            }
          ]
        };
      }
      return { rows: [], rowCount: 1 };
    }
  });

  const queued = await repository.listQueued({ limit: 1 });
  await repository.markLinkedInExtracted("inventory_1");

  assert.equal(queued[0].linkedinProfileUrl, "https://www.linkedin.com/in/jane-smith");
  assert.match(queries[0].sql, /workflow_status = 'discovered'/);
  assert.match(queries[0].sql, /dedupe_status = 'dedupe_pending'/);
  assert.deepEqual(queries[0].params, [1]);
  assert.match(queries[1].sql, /workflow_status = 'linkedin_extracted'/);
  assert.equal(queries.some((query) => /lead_enrichment_snapshots/i.test(query.sql)), false);
});

test("ProcessQueueRepository refresh selector includes qualified inventory", async () => {
  const queries = [];
  const repository = new ProcessQueueRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
  });

  await repository.listProfilesForRefresh({ limit: 3 });

  assert.match(queries[0].sql, /'qualified'/);
  assert.deepEqual(queries[0].params, [3]);
});

test("ProcessQueueRepository backfills inventory company fields from profile facts", async () => {
  const queries = [];
  const repository = new ProcessQueueRepository({
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
  });

  await repository.saveProfileFacts(
    { id: "inventory_1" },
    {
      source: "linkedin_profile",
      sourceUrl: "https://www.linkedin.com/in/jane-smith",
      facts: {
        about: null,
        currentCompanyName: "Acme AI",
        currentCompanyLinkedInUrl: "https://www.linkedin.com/company/acme-ai",
        currentRoleTitle: "Founder",
        currentRoleStartDate: null,
        jobHistory: [],
        contact: { email: null, mobile: null, tel: null }
      }
    }
  );

  assert.match(queries[0].sql, /update linkedin_connection_inventory/i);
  assert.deepEqual(queries[0].params, [
    "Acme AI",
    "https://www.linkedin.com/company/acme-ai",
    "inventory_1"
  ]);
});

test("createPlaywrightProfileExtractor captures Jitendra-style profile sections", async () => {
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async evaluate() {
      return {
        sections: [
          {
            text: [
              "Jitendra Taldar",
              "",
              "· 1st",
              "",
              "Results-Driven | Building Strategic Partnerships & Market Expansion for Growth | Connecting Opportunities for Success | Partner Management | END-To-END Sales cycle",
              "",
              "Gujarat, India",
              "",
              "·",
              "",
              "Contact info",
              "",
              "Radixweb",
              "",
              "500+ connections"
            ].join("\n"),
            html: "<section><h1>Jitendra Taldar</h1><a href=\"https://www.linkedin.com/company/radixweb/\">Radixweb</a></section>"
          },
          {
            text: [
              "About",
              "",
              "Over the years, I’ve had the opportunity to work across multiple regions.",
              "",
              "Currently, I’m working as a Sr. Business Development Executive @ Radixweb.",
              "",
              "Top skills",
              "",
              "Sales • Customer Satisfaction"
            ].join("\n"),
            html: "<section><h2>About</h2></section>"
          },
          {
            text: [
              "Jitendra Taldar",
              "",
              "1mo • Edited •",
              "",
              "Great perspective!",
              "",
              "Radixweb",
              "",
              "Your legacy app is not just slowing you down."
            ].join("\n"),
            html: "<section><a href=\"https://www.linkedin.com/company/radixweb/\">Radixweb. 💫</a></section>"
          },
          {
            text: [
              "Experience",
              "",
              "Sr. Business Developer",
              "",
              "Radixweb · Full-time",
              "",
              "Sep 2024 - Present · 1 yr 10 mos",
              "",
              "Ahmedabad, Gujarat, India · On-site",
              "",
              "At Radixweb, I work as a Sr. Business Developer, helping the company grow.",
              "… more",
              "",
              "Communication, Client Relations and +17 skills",
              "",
              "Sr. Business Development Executive",
              "",
              "HoduSoft · Full-time",
              "",
              "Aug 2022 - May 2024 · 1 yr 10 mos",
              "",
              "Ahmedabad, Gujarat, India · On-site",
              "",
              "As a Sr. Business Development Executive, I play a crucial role in driving a company's growth."
            ].join("\n"),
            html: "<section><h2>Experience</h2><a href=\"https://www.linkedin.com/company/radixweb/\">Radixweb</a><a href=\"https://www.linkedin.com/company/hodusoft/\">HoduSoft</a></section>"
          }
        ],
        rawHtml: "<main></main>"
      };
    }
  };

  const capture = await createPlaywrightProfileExtractor(page)({
    linkedinProfileUrl: "https://www.linkedin.com/in/jitendra-taldar-6566917a",
    fullName: "Jitendra Taldar"
  });

  assert.equal(capture.identity.location, "Gujarat, India");
  assert.equal(capture.identity.headline, "Results-Driven | Building Strategic Partnerships & Market Expansion for Growth | Connecting Opportunities for Success | Partner Management | END-To-END Sales cycle");
  assert.equal(capture.facts.about, "Over the years, I’ve had the opportunity to work across multiple regions.\n\nCurrently, I’m working as a Sr. Business Development Executive @ Radixweb.");
  assert.equal(capture.facts.currentCompanyName, "Radixweb");
  assert.equal(capture.facts.currentRoleTitle, "Sr. Business Developer");
  assert.equal(capture.facts.currentRoleStartDate, "Sep 2024");
  assert.deepEqual(capture.facts.jobHistory.slice(0, 2), [
    {
      title: "Sr. Business Developer",
      companyName: "Radixweb",
      startDate: "Sep 2024",
      endDate: null,
      description: "At Radixweb, I work as a Sr. Business Developer, helping the company grow."
    },
    {
      title: "Sr. Business Development Executive",
      companyName: "HoduSoft",
      startDate: "Aug 2022",
      endDate: "May 2024",
      description: "As a Sr. Business Development Executive, I play a crucial role in driving a company's growth."
    }
  ]);
});

test("createPlaywrightProfileExtractor expands grouped company roles in job history", async () => {
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async evaluate() {
      return {
        sections: [
          {
            text: [
              "Redmond Riddell",
              "",
              "· 1st",
              "",
              "AI & Vision Systems",
              "",
              "Sydney, New South Wales, Australia",
              "",
              "Contact info",
              "",
              "Vello Technologies"
            ].join("\n"),
            html: "<section><h1>Redmond Riddell</h1><a href=\"https://www.linkedin.com/company/vello-technologies/\">Vello Technologies</a></section>"
          },
          {
            text: [
              "Experience",
              "",
              "Chief Technology Officer",
              "",
              "Vello Technologies · Full-time",
              "",
              "Jan 2025 - Present · 1 yr 6 mos",
              "",
              "Australia",
              "",
              "Defence Australia",
              "",
              "Full-time · 2 yrs 3 mos",
              "",
              "Australia",
              "",
              "Head of Software Engineering",
              "",
              "Mar 2023 - Dec 2024 · 1 yr 10 mos",
              "",
              "Led software engineering for the Royal Australian Air Force’s mixed-reality flight simulation and optical tracking innovation program.",
              "… more",
              "",
              "Senior Software Engineer",
              "",
              "Oct 2022 - Mar 2023 · 6 mos",
              "",
              "StockPay",
              "",
              "Full-time · 1 yr 1 mo",
              "",
              "Principal Engineer",
              "",
              "Mar 2022 - Oct 2022 · 8 mos",
              "",
              "Sydney, New South Wales, Australia",
              "",
              "Led the end-to-end development of a full stock-trading platform.",
              "… more",
              "",
              "Senior Software Engineer",
              "",
              "Oct 2021 - Mar 2022 · 6 mos",
              "",
              "Australia"
            ].join("\n"),
            html: "<section><h2>Experience</h2><a href=\"https://www.linkedin.com/company/vello-technologies/\">Vello Technologies</a></section>"
          }
        ],
        rawHtml: "<main></main>"
      };
    }
  };

  const capture = await createPlaywrightProfileExtractor(page)({
    linkedinProfileUrl: "https://www.linkedin.com/in/redr/",
    fullName: "Redmond Riddell"
  });

  assert.equal(capture.facts.currentCompanyName, "Vello Technologies");
  assert.equal(capture.facts.currentRoleTitle, "Chief Technology Officer");
  assert.deepEqual(capture.facts.jobHistory.slice(0, 5), [
    {
      title: "Chief Technology Officer",
      companyName: "Vello Technologies",
      startDate: "Jan 2025",
      endDate: null,
      description: null
    },
    {
      title: "Head of Software Engineering",
      companyName: "Defence Australia",
      startDate: "Mar 2023",
      endDate: "Dec 2024",
      description: "Led software engineering for the Royal Australian Air Force’s mixed-reality flight simulation and optical tracking innovation program."
    },
    {
      title: "Senior Software Engineer",
      companyName: "Defence Australia",
      startDate: "Oct 2022",
      endDate: "Mar 2023",
      description: null
    },
    {
      title: "Principal Engineer",
      companyName: "StockPay",
      startDate: "Mar 2022",
      endDate: "Oct 2022",
      description: "Led the end-to-end development of a full stock-trading platform."
    },
    {
      title: "Senior Software Engineer",
      companyName: "StockPay",
      startDate: "Oct 2021",
      endDate: "Mar 2022",
      description: null
    }
  ]);
});

test("createPlaywrightProfileExtractor navigates to profile and captures structured facts", async () => {
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
        sectionTexts: ["Jane Smith\nFounder at Acme AI"],
        rawHtml: "<main><section><a href=\"https://www.linkedin.com/in/jane-smith\"></a><img src=\"cover.jpg\" alt=\"cover photo\"><a href=\"https://www.linkedin.com/in/jane-smith\"><h1>Jane Smith</h1></a><p>Founder at Acme AI</p></section></main>"
      };
    }
  };

  const extractProfile = createPlaywrightProfileExtractor(page);
  const capture = await extractProfile({
    linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith"
  });

  assert.equal(capture.source, "linkedin_profile");
  assert.equal(capture.sourceUrl, "https://www.linkedin.com/in/jane-smith");
  assert.deepEqual(capture.identity, {
    firstName: "Jane",
    lastName: "Smith",
    linkedinProfileUrl: "https://www.linkedin.com/in/jane-smith",
    headline: "Founder at Acme AI",
    location: null
  });
  assert.equal(capture.facts.currentCompanyName, "Acme AI");
  assert.equal(capture.facts.currentRoleTitle, "Founder");
  assert.equal("rawText" in capture, false);
  assert.equal("rawHtml" in capture, false);
  assert.deepEqual(calls, [
    ["goto", "https://www.linkedin.com/in/jane-smith", "domcontentloaded"],
    ["waitForLoadState", "networkidle", 10000],
    ["evaluate"]
  ]);
});

test("createPlaywrightProfileExtractor falls back to raw profile text for header location", async () => {
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async evaluate() {
      return {
        sections: [
          {
            text: [
              "Richard Kwan",
              "",
              "Solving the world’s most impactful challenges by empowering the next generation of leaders and entrepreneurs.",
              "",
              "Contact info"
            ].join("\n"),
            html: "<section><h1>Richard Kwan</h1><p>Solving the world’s most impactful challenges by empowering the next generation of leaders and entrepreneurs.</p></section>"
          },
          {
            text: [
              "About",
              "",
              "An executive in the IT, health care, automotive, waste management, logistics, commercial real estate, asset and funds management industries."
            ].join("\n"),
            html: "<section><h2>About</h2></section>"
          }
        ],
        rawHtml: [
          "<main>",
          "<section>",
          "<h1>Richard Kwan</h1>",
          "<p>Solving the world’s most impactful challenges by empowering the next generation of leaders and entrepreneurs.</p>",
          "<span>Adelaide, South Australia, Australia</span>",
          "<a>Contact info</a>",
          "</section>",
          "</main>"
        ].join("")
      };
    }
  };

  const capture = await createPlaywrightProfileExtractor(page)({
    linkedinProfileUrl: "https://www.linkedin.com/in/globalceorichard",
    fullName: "Richard Kwan"
  });

  assert.equal(capture.identity.location, "Adelaide, South Australia, Australia");
});

test("createPlaywrightProfileExtractor captures LinkedIn area-style profile locations", async () => {
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async evaluate() {
      return {
        sections: [
          {
            text: [
              "Richard Kwan",
              "",
              "· 1st",
              "",
              "Solving the world’s most impactful challenges by empowering the next generation of leaders and entrepreneurs.",
              "",
              "Greater Adelaide Area",
              "",
              "·",
              "",
              "Contact info",
              "",
              "Kiratech"
            ].join("\n"),
            html: "<section><h1>Richard Kwan</h1><a href=\"https://www.linkedin.com/company/kiratechnologies/\">Kiratech</a></section>"
          }
        ],
        rawHtml: "<main></main>"
      };
    }
  };

  const capture = await createPlaywrightProfileExtractor(page)({
    linkedinProfileUrl: "https://www.linkedin.com/in/globalceorichard",
    fullName: "Richard Kwan"
  });

  assert.equal(capture.identity.location, "Greater Adelaide Area");
});

test("extractCurrentCompanyFromProfileHtml prefers experience company links", () => {
  const company = extractCurrentCompanyFromProfileHtml(`
    <main>
      <section>
        <h2>Experience</h2>
        <a href="https://www.linkedin.com/company/acme-ai/">Acme AI</a>
        <span>Founder</span>
      </section>
    </main>
  `, "Founder at Acme AI");

  assert.deepEqual(company, {
    name: "Acme AI",
    linkedinCompanyUrl: "https://www.linkedin.com/company/acme-ai"
  });
});

test("extractCurrentCompanyFromProfileHtml uses headline fallback when company link text is empty", () => {
  const company = extractCurrentCompanyFromProfileHtml(
    `<main><a href="https://www.linkedin.com/company/acme-ai/posts/"><img alt="Acme logo"></a></main>`,
    "Founder at Acme AI"
  );

  assert.deepEqual(company, {
    name: "Acme AI",
    linkedinCompanyUrl: "https://www.linkedin.com/company/acme-ai"
  });
});

test("extractProfileMainText keeps profile sections and removes navigation, ads, footer, and scripts", () => {
  const text = extractProfileMainText([
    "0 notifications\nSkip to main content\nHome\nMessaging",
    "Jane Smith\n\n· 1st\n\nFounder at Acme AI\n\nSydney, New South Wales, Australia\n\nContact info",
    "Sales Insights\n\nKey signals\n\nViewed your profile\n\nRetry Premium for A$0\n\n1-month free trial with 24/7 support.\n\nAbout\n\nBuilder of useful tools",
    "Sales Insights\n\nKey signals\n\nRetry Premium for A$0",
    "Activity\n\nJane Smith posted this\n\n2mo\n\nBuilding something useful",
    "Experience\n\nFounder\n\nAcme AI",
    "Interests\nTop Voices\nCompanies\nSteven Bartlett\nFollow",
    "More profiles for you\n\nSomeone Else\nConnect",
    "About\nAccessibility\nTalent Solutions\nLinkedIn Corporation © 2026",
    "window.__como_module_cache__ = new Map();"
  ]);

  assert.match(text, /Jane Smith/);
  assert.match(text, /Builder of useful tools/);
  assert.match(text, /Activity/);
  assert.match(text, /Experience/);
  assert.doesNotMatch(text, /0 notifications/);
  assert.doesNotMatch(text, /Sales Insights/);
  assert.doesNotMatch(text, /More profiles for you/);
  assert.doesNotMatch(text, /window\.__como_module_cache__/);
});
