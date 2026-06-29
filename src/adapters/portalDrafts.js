export class PortalDraftAdapter {
  constructor({ baseUrl, apiKey, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async createDraft(draft) {
    if (!this.baseUrl || !this.apiKey) {
      throw new Error("Portal API configuration is missing.");
    }

    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/drafts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(draft)
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Portal draft save failed with HTTP ${response.status}: ${text}`);
      error.httpStatus = response.status;
      throw error;
    }

    const json = await response.json();
    return { portalDraftId: json.portalDraftId ?? json.id };
  }
}
