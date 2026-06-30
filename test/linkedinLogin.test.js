import test from "node:test";
import assert from "node:assert/strict";

import { waitForLinkedInBlockersToClear } from "../src/linkedin/browser.js";
import { openLinkedInLoginSession, waitForLinkedInLogin } from "../src/linkedin/login.js";

test("openLinkedInLoginSession waits for LinkedIn login with the persistent profile before closing", async () => {
  const calls = [];
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
      return waitForLinkedInLogin(pageForLogin, { pollIntervalMs: 1, log: () => undefined });
    }
  });

  assert.deepEqual(result, { status: "session_ready" });
  assert.deepEqual(calls, [
    ["createSession", ".linkedin-browser-profile"],
    ["waitForLogin", true],
    ["goto", "https://www.linkedin.com/login", "domcontentloaded"],
    ["textContent", "body"],
    ["close"]
  ]);
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
    ["goto", "https://www.linkedin.com/login", "domcontentloaded"],
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
      return responses.shift();
    }
  };

  const result = await waitForLinkedInLogin(page, {
    timeoutMs: 1000,
    pollIntervalMs: 1,
    log: () => undefined
  });

  assert.deepEqual(result, { status: "session_ready" });
  assert.deepEqual(calls, [
    ["goto", "https://www.linkedin.com/login", "domcontentloaded"],
    ["textContent", "body"],
    ["textContent", "body"],
    ["textContent", "body"]
  ]);
});
