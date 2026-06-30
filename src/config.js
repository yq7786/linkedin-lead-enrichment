import fs from "node:fs";
import path from "node:path";

const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_LINKEDIN_BROWSER_PROFILE_DIR = ".linkedin-browser-profile";
const DEFAULT_PORTAL_QUALIFIED_INGEST_URL =
  "https://portal.leapsheep.com/api/webhooks/lead-enrichment/qualified-ingest";
let dotenvLoaded = false;

export function validateConfig(env = process.env, options = {}) {
  if (env === process.env) {
    loadDotenv();
  }

  const dryRun = Boolean(options.dryRun);
  const requireDatabase = options.requireDatabase ?? true;
  const requireOpenAI = options.requireOpenAI ?? true;
  const linkedinBrowserProfilePath =
    env.LINKEDIN_BROWSER_PROFILE_PATH || path.join(process.cwd(), DEFAULT_LINKEDIN_BROWSER_PROFILE_DIR);
  env.LINKEDIN_BROWSER_PROFILE_PATH = linkedinBrowserProfilePath;
  const missing = [];

  if (requireDatabase && !env.DATABASE_URL) missing.push("DATABASE_URL");
  if (requireOpenAI && !env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  if (!dryRun) {
    for (const key of ["PORTAL_CALLBACK_SECRET"]) {
      if (!env[key]) missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }

  const databaseUrl = env.DATABASE_URL ? normalizeDatabaseUrl(env.DATABASE_URL) : null;

  return {
    databaseUrl,
    openaiApiKey: env.OPENAI_API_KEY,
    linkedinBrowserProfilePath,
    portalQualifiedIngestUrl: env.PORTAL_QUALIFIED_INGEST_URL ?? DEFAULT_PORTAL_QUALIFIED_INGEST_URL,
    portalCallbackSecret: env.PORTAL_CALLBACK_SECRET ?? null,
    defaultBatchLimit: parsePositiveInteger(env.DEFAULT_BATCH_LIMIT, DEFAULT_BATCH_LIMIT),
    dryRun
  };
}

function normalizeDatabaseUrl(value) {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.searchParams.get("sslmode") === "require"
    ) {
      url.searchParams.set("sslmode", "verify-full");
      return url.toString();
    }
  } catch {
    return value;
  }

  return value;
}

function parsePositiveInteger(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`DEFAULT_BATCH_LIMIT must be a positive integer; received ${value}`);
  }
  return parsed;
}

export function loadDotenv(env = process.env, cwd = process.cwd()) {
  if (env === process.env && dotenvLoaded) return;

  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) {
    if (env === process.env) dotenvLoaded = true;
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = stripOptionalQuotes(trimmed.slice(equalsIndex + 1).trim());
    if (key && env[key] === undefined) {
      env[key] = value;
    }
  }

  if (env === process.env) dotenvLoaded = true;
}

function stripOptionalQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
