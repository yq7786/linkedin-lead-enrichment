import test from "node:test";
import assert from "node:assert/strict";

import { validateConfig } from "../src/config.js";

test("validateConfig accepts required local workflow env", () => {
  const config = validateConfig({
    DATABASE_URL: "postgres://user:pass@example.test/db",
    OPENAI_API_KEY: "sk-test",
    LINKEDIN_BROWSER_PROFILE_PATH: "/tmp/linkedin-profile",
    PORTAL_CALLBACK_SECRET: "portal-test",
    DEFAULT_BATCH_LIMIT: "25"
  });

  assert.equal(config.defaultBatchLimit, 25);
  assert.equal(
    config.portalQualifiedIngestUrl,
    "https://portal.leapsheep.com/api/webhooks/lead-enrichment/qualified-ingest"
  );
  assert.equal(config.portalCallbackSecret, "portal-test");
});

test("validateConfig allows missing portal config in dry-run mode", () => {
  const config = validateConfig(
    {
      DATABASE_URL: "postgres://user:pass@example.test/db",
      OPENAI_API_KEY: "sk-test",
      LINKEDIN_BROWSER_PROFILE_PATH: "/tmp/linkedin-profile"
    },
    { dryRun: true }
  );

  assert.equal(config.dryRun, true);
  assert.equal(config.defaultBatchLimit, 50);
});

test("validateConfig defaults LinkedIn browser profile path when omitted", () => {
  const env = {
    DATABASE_URL: "postgres://user:pass@example.test/db",
    OPENAI_API_KEY: "sk-test"
  };
  const config = validateConfig(env, { dryRun: true });

  assert.match(config.linkedinBrowserProfilePath, /\.linkedin-browser-profile$/);
  assert.equal(env.LINKEDIN_BROWSER_PROFILE_PATH, config.linkedinBrowserProfilePath);
});

test("validateConfig normalizes Neon sslmode=require to verify-full", () => {
  const config = validateConfig(
    {
      DATABASE_URL: "postgresql://user:pass@example.test/db?sslmode=require",
      OPENAI_API_KEY: "sk-test"
    },
    { dryRun: true }
  );

  assert.match(config.databaseUrl, /sslmode=verify-full/);
});

test("validateConfig rejects missing portal config outside dry-run mode", () => {
  assert.throws(
    () =>
      validateConfig({
        DATABASE_URL: "postgres://user:pass@example.test/db",
        OPENAI_API_KEY: "sk-test",
        LINKEDIN_BROWSER_PROFILE_PATH: "/tmp/linkedin-profile"
      }),
    /PORTAL_CALLBACK_SECRET/
  );
});
