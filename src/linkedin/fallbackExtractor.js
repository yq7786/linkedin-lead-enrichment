export class LinkedInFallbackExtractor {
  async extract() {
    throw new Error("Computer Use fallback is intentionally not enabled until live LinkedIn selector failures are observed.");
  }
}
