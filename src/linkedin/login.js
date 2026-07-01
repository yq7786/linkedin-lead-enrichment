import { createLinkedInBrowserSession, detectLinkedInBlockers, waitForLinkedInBlockersToClear } from "./browser.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_LOGIN_POLL_INTERVAL_MS = 2000;
const LINKEDIN_SESSION_CHECK_URL = "https://www.linkedin.com/feed/";

export async function openLinkedInLoginSession({
  profilePath,
  playwright,
  createSession = (path) => createLinkedInBrowserSession({ profilePath: path, playwright }),
  waitForLogin = waitForLinkedInLogin
}) {
  const context = await createSession(profilePath);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    return await waitForLogin(page);
  } finally {
    await context.close();
  }
}

export async function waitForLinkedInLogin(
  page,
  {
    timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_LOGIN_POLL_INTERVAL_MS,
    log = console.log
  } = {}
) {
  const startedAt = Date.now();
  let loginNoticeShown = false;
  await page.goto(LINKEDIN_SESSION_CHECK_URL, { waitUntil: "domcontentloaded" });

  while (true) {
    const pageText = (await page.textContent("body").catch(() => "")) ?? "";
    const blocker = detectLinkedInBlockers(pageText, { url: page.url?.() });
    if (blocker.blocked && blocker.kind !== "linkedin_login_expired") {
      await waitForLinkedInBlockersToClear(page, { pollIntervalMs, log });
      continue;
    }
    if (!blocker.blocked) {
      return { status: "session_ready" };
    }
    if (!loginNoticeShown) {
      log("Log in to LinkedIn in the opened browser. This command will wait until the session is ready.");
      loginNoticeShown = true;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { status: "login_required" };
    }
    await delay(pollIntervalMs);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
