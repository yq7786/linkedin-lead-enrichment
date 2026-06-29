import TurndownService from "turndown";

const turndownService = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-"
});

turndownService.addRule("skipImages", {
  filter: "img",
  replacement: () => ""
});

turndownService.addRule("unwrapLinks", {
  filter: "a",
  replacement: (content) => content.trim()
});

export function extractVisibleProfileText(pageText, sourceUrl, options = {}) {
  return {
    source: "linkedin_profile",
    sourceUrl,
    rawText: pageText,
    rawHtml: options.rawHtml,
    structuredJson: options.structuredJson ?? {
      extractionStatus: "pending_extraction"
    }
  };
}

export function htmlToMarkdown(html, fallbackText = "") {
  const source = String(html ?? "").trim();
  if (!source) return normalizeMarkdown(fallbackText);
  return normalizeMarkdown(turndownService.turndown(source));
}

function normalizeMarkdown(markdown) {
  return String(markdown ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
