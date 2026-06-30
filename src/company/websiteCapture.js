import TurndownService from "turndown";

const CHROME_SELECTORS = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "nav",
  "header",
  "footer",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']"
];

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced"
});

turndown.addRule("skipImages", {
  filter: "img",
  replacement: () => ""
});

turndown.addRule("unwrapLinks", {
  filter: "a",
  replacement: (content) => content.trim()
});

export function normalizeCompanyWebsiteCapture(value) {
  const rootUrl = value.rootUrl ?? value.url ?? value.sourceUrl;
  const pages = Array.isArray(value.pages)
    ? value.pages
    : [{
        pageName: value.pageName ?? "Home",
        pageURL: value.pageURL ?? value.sourceUrl ?? rootUrl,
        contentMarkdown: value.contentMarkdown ?? value.markdown ?? ""
      }];

  return {
    source: value.source ?? "playwright",
    rootUrl,
    pages: pages
      .filter((page) => page.pageURL && page.contentMarkdown)
      .slice(0, 5)
      .map((page) => ({
        pageName: page.pageName ?? inferPageName(page.pageURL),
        pageURL: page.pageURL,
        contentMarkdown: cleanWebsiteMarkdown(page.contentMarkdown)
      }))
  };
}

export function cleanWebsiteMarkdown(markdown) {
  return String(markdown ?? "")
    .replace(/\r/g, "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^-{4,}$/gm, "")
    .replace(/^={4,}$/gm, "")
    .replace(/^[*_]{4,}$/gm, "")
    .replace(/^\s*Open main menu\s*$/gim, "")
    .replace(/^\s*©.*$/gim, "")
    .replace(/^\s*Business Hours:.*$/gim, "")
    .replace(/^\s*All rights reserved\s*$/gim, "")
    .replace(/window\.__[A-Z0-9_]+__[\s\S]*$/i, "")
    .replace(/(\d)\s*(Let's|Contact Us|Book consultation|Book a session|See More|Our Work|View Our Impact)/gi, "$1\n\n$2")
    .replace(/([.!?])\s*([A-Z])/g, "$1\n\n$2")
    .replace(/([a-z])([A-Z][a-z])/g, "$1\n\n$2")
    .replace(/^\s*-\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToWebsiteMarkdown(html) {
  const stripped = stripChromeFromHtml(stripNonContentHtml(html));
  return cleanWebsiteMarkdown(turndown.turndown(stripped));
}

export async function captureCompanyWebsiteWithPlaywright(page, url, options = {}) {
  await gotoWithRetries(page, url, options);
  await waitForWebsiteBodyContent(page, options);
  const pageName = await page.title().catch(() => "Home");
  const html = await page.evaluate((selectors) => {
    const clone = document.body.cloneNode(true);
    for (const selector of selectors) {
      clone.querySelectorAll(selector).forEach((element) => element.remove());
    }
    return clone.innerHTML;
  }, CHROME_SELECTORS);
  const contentMarkdown = htmlToWebsiteMarkdown(html);
  const pageURL = page.url();

  return normalizeCompanyWebsiteCapture({
    source: "playwright",
    rootUrl: url,
    pages: [{
      pageName: pageName || "Home",
      pageURL,
      contentMarkdown
    }]
  });
}

async function gotoWithRetries(page, url, options = {}) {
  const baseTimeout = options.timeout ?? 30_000;
  const retryCount = options.retries ?? 3;
  let lastError;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      await page.goto(url, {
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: baseTimeout * (attempt + 1)
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function waitForWebsiteBodyContent(page, options = {}) {
  if (typeof page.waitForFunction !== "function") return;

  const minBodyTextLength = options.minBodyTextLength ?? 200;
  const timeout = options.contentTimeout ?? 10_000;

  await page.waitForFunction(
    (minimumLength) => {
      const text = document.body?.innerText || document.body?.textContent || "";
      return text.trim().length >= minimumLength;
    },
    minBodyTextLength,
    { timeout }
  ).catch(() => {});
}

function stripNonContentHtml(html) {
  return String(html ?? "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");
}

function stripChromeFromHtml(html) {
  return String(html ?? "")
    .replace(/<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*\srole=(["'])(?:navigation|banner|contentinfo)\1[^>]*>[\s\S]*?<\/[^>]+>/gi, "");
}

function inferPageName(url) {
  try {
    const pathname = new URL(url).pathname.replace(/^\/|\/$/g, "");
    return pathname ? pathname.split("/").at(-1).replace(/[-_]+/g, " ") : "Home";
  } catch {
    return "Page";
  }
}
