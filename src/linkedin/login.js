import { createLinkedInBrowserSession, detectLinkedInBlockers } from "./browser.js";

export async function openLinkedInLoginSession({
  profilePath,
  playwright,
  createSession = (path) => createLinkedInBrowserSession({ profilePath: path, playwright }),
  waitForOperator = waitForEnter
}) {
  const context = await createSession(profilePath);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });
    await waitForOperator();

    const pageText = (await page.textContent("body")) ?? "";
    const blocker = detectLinkedInBlockers(pageText);
    if (blocker.blocked && blocker.kind !== "linkedin_login_expired") {
      return { status: "blocked", blocker: blocker.kind };
    }
    if (blocker.kind === "linkedin_login_expired") {
      return { status: "login_required" };
    }

    return { status: "session_ready" };
  } finally {
    await context.close();
  }
}

function waitForEnter() {
  console.log("Log in to LinkedIn in the opened browser, then press Enter here to continue.");
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}
