import test from "node:test";
import assert from "node:assert/strict";

import { openLinkedInLoginSession } from "../src/linkedin/login.js";

test("openLinkedInLoginSession opens LinkedIn login with the persistent profile and closes after operator confirmation", async () => {
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
    waitForOperator: async () => {
      calls.push(["waitForOperator"]);
    }
  });

  assert.deepEqual(result, { status: "session_ready" });
  assert.deepEqual(calls, [
    ["createSession", ".linkedin-browser-profile"],
    ["goto", "https://www.linkedin.com/login", "domcontentloaded"],
    ["waitForOperator"],
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
    waitForOperator: async () => undefined
  });

  assert.deepEqual(result, { status: "blocked", blocker: "linkedin_checkpoint" });
});
