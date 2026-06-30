import test from "node:test";
import assert from "node:assert/strict";

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

test("openLinkedInLoginSession reports LinkedIn checkpoint blockers after operator confirmation", async () => {
  const context = {
    pages: () => [
      {
        async goto() {},
        async textContent() {
          return "Security verification checkpoint";
        }
      }
    ],
    async close() {}
  };

  const result = await openLinkedInLoginSession({
    profilePath: ".linkedin-browser-profile",
    createSession: async () => context,
    waitForLogin: async (pageForLogin) => waitForLinkedInLogin(pageForLogin, { pollIntervalMs: 1, log: () => undefined })
  });

  assert.deepEqual(result, { status: "blocked", blocker: "linkedin_checkpoint" });
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
