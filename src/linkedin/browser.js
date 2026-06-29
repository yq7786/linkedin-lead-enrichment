export async function createLinkedInBrowserSession({ profilePath, playwright }) {
  if (!profilePath) throw new Error("LINKEDIN_BROWSER_PROFILE_PATH is required.");
  if (!playwright?.chromium) {
    throw new Error("Playwright is not installed or was not provided to createLinkedInBrowserSession.");
  }
  return playwright.chromium.launchPersistentContext(profilePath, { headless: false });
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
