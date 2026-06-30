export async function createLinkedInBrowserSession({ profilePath, playwright }) {
  if (!profilePath) throw new Error("LINKEDIN_BROWSER_PROFILE_PATH is required.");
  if (!playwright?.chromium) {
    throw new Error("Playwright is not installed or was not provided to createLinkedInBrowserSession.");
  }
  return playwright.chromium.launchPersistentContext(profilePath, { headless: false });
}

export async function waitForLinkedInBlockersToClear(
  page,
  { pollIntervalMs = 2000, log = () => undefined } = {}
) {
  let blockerNotice = null;

  while (true) {
    const pageText = (await page.textContent?.("body").catch(() => "")) ?? "";
    const blocker = detectLinkedInBlockers(pageText);
    if (!blocker.blocked) {
      return { status: "session_ready" };
    }

    if (blockerNotice !== blocker.kind) {
      const action = blocker.kind === "linkedin_login_expired" ? "sign in" : "clear the challenge";
      log(`LinkedIn shows ${blocker.kind}. Please ${action} in the open browser; this command will keep waiting.`);
      blockerNotice = blocker.kind;
    }

    if (page.waitForTimeout) {
      await page.waitForTimeout(pollIntervalMs);
    } else {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

export function detectLinkedInBlockers(pageText) {
  const text = pageText.toLowerCase();
  if (text.includes("security verification") || text.includes("checkpoint") || text.includes("captcha")) {
    return { blocked: true, kind: "linkedin_checkpoint" };
  }
  if (text.includes("sign in") && text.includes("linkedin")) {
    return { blocked: true, kind: "linkedin_login_expired" };
  }
  return { blocked: false };
}
