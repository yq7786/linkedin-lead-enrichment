import test from "node:test";
import assert from "node:assert/strict";

import { detectLinkedInBlockers, waitForLinkedInBlockersToClear } from "../src/linkedin/browser.js";
import { openLinkedInLoginSession, waitForLinkedInLogin } from "../src/linkedin/login.js";

test("openLinkedInLoginSession recognizes an already logged-in persistent profile before closing", async () => {
  const calls = [];
  const logs = [];
  const page = {
    async goto(url, options) {
      calls.push(["goto", url, options.waitUntil]);
    },
    async textContent(selector) {
      calls.push(["textContent", selector]);
      return "LinkedIn Feed";
    }
  };
  const context = {
    pages: () => [page],
    async close() {
      calls.push(["close"]);
    }
  };

  const result = await openLinkedInLoginSession({
    profilePath: ".linkedin-browser-profile",
    createSession: async (profilePath) => {
      calls.push(["createSession", profilePath]);
      return context;
    },
    waitForLogin: async (pageForLogin) => {
      calls.push(["waitForLogin", pageForLogin === page]);
      return waitForLinkedInLogin(pageForLogin, { pollIntervalMs: 1, log: (message) => logs.push(message) });
    }
  });

  assert.deepEqual(result, { status: "session_ready" });
  assert.deepEqual(calls, [
    ["createSession", ".linkedin-browser-profile"],
    ["waitForLogin", true],
    ["goto", "https://www.linkedin.com/feed/", "domcontentloaded"],
    ["textContent", "body"],
    ["close"]
  ]);
  assert.deepEqual(logs, []);
});

test("openLinkedInLoginSession keeps browser open while checkpoint is cleared", async () => {
  const calls = [];
  const responses = [
    "Security verification checkpoint",
    "Security verification checkpoint",
    "LinkedIn Feed"
  ];
  const context = {
    pages: () => [
      {
        async goto(url, options) {
          calls.push(["goto", url, options.waitUntil]);
        },
        async textContent() {
          calls.push(["textContent"]);
          return responses.shift();
        }
      }
    ],
    async close() {
      calls.push(["close"]);
    }
  };
  const logs = [];

  const result = await openLinkedInLoginSession({
    profilePath: ".linkedin-browser-profile",
    createSession: async () => context,
    waitForLogin: async (pageForLogin) => waitForLinkedInLogin(pageForLogin, {
      pollIntervalMs: 1,
      log: (message) => logs.push(message)
    })
  });

  assert.deepEqual(result, { status: "session_ready" });
  assert.deepEqual(calls, [
    ["goto", "https://www.linkedin.com/feed/", "domcontentloaded"],
    ["textContent"],
    ["textContent"],
    ["textContent"],
    ["textContent"],
    ["close"]
  ]);
  assert.match(logs.join("\n"), /Please clear the challenge in the open browser/);
});

test("waitForLinkedInBlockersToClear keeps polling the same page until checkpoint clears", async () => {
  const calls = [];
  const logs = [];
  const responses = [
    "Security verification checkpoint",
    "Security verification checkpoint",
    "LinkedIn Feed"
  ];
  const page = {
    async textContent(selector) {
      calls.push(["textContent", selector]);
      return responses.shift();
    },
    async waitForTimeout(ms) {
      calls.push(["waitForTimeout", ms]);
    }
  };

  const result = await waitForLinkedInBlockersToClear(page, {
    pollIntervalMs: 1,
    log: (message) => logs.push(message)
  });

  assert.deepEqual(result, { status: "session_ready" });
  assert.deepEqual(calls, [
    ["textContent", "body"],
    ["waitForTimeout", 1],
    ["textContent", "body"],
    ["waitForTimeout", 1],
    ["textContent", "body"]
  ]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Please clear the challenge in the open browser/);
});

test("waitForLinkedInLogin keeps polling while login is expired", async () => {
  const calls = [];
  const logs = [];
  let currentIndex = 0;
  const responses = [
    "LinkedIn Sign in",
    "LinkedIn Sign in",
    "LinkedIn Feed"
  ];
  const page = {
    async goto(url, options) {
      calls.push(["goto", url, options.waitUntil]);
    },
    async textContent(selector) {
      calls.push(["textContent", selector]);
      const response = responses[currentIndex];
      currentIndex += 1;
      return response;
    },
    url() {
      return currentIndex < 3
        ? "https://www.linkedin.com/login"
        : "https://www.linkedin.com/feed/";
    }
  };

  const result = await waitForLinkedInLogin(page, {
    timeoutMs: 1000,
    pollIntervalMs: 1,
    log: (message) => logs.push(message)
  });

  assert.deepEqual(result, { status: "session_ready" });
  assert.deepEqual(calls, [
    ["goto", "https://www.linkedin.com/feed/", "domcontentloaded"],
    ["textContent", "body"],
    ["textContent", "body"],
    ["textContent", "body"]
  ]);
  assert.match(logs.join("\n"), /Log in to LinkedIn in the opened browser/);
});

test("detectLinkedInBlockers does not treat profile chrome sign-in text as expired auth", () => {
  const blocker = detectLinkedInBlockers(
    [
      "Jane Smith",
      "Founder at Acme AI",
      "LinkedIn",
      "Sign in to follow company updates"
    ].join("\n"),
    { url: "https://www.linkedin.com/in/jane-smith/" }
  );

  assert.deepEqual(blocker, { blocked: false });
});

test("detectLinkedInBlockers treats LinkedIn authwall URL as expired auth", () => {
  const blocker = detectLinkedInBlockers(
    "LinkedIn",
    { url: "https://www.linkedin.com/authwall?trk=gf&original_referer=" }
  );

  assert.deepEqual(blocker, { blocked: true, kind: "linkedin_login_expired" });
});
