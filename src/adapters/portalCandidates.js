export class PortalCandidateAdapter {
  constructor({ endpointUrl, callbackSecret, fetchImpl = fetch }) {
    this.endpointUrl = endpointUrl;
    this.callbackSecret = callbackSecret;
    this.fetchImpl = fetchImpl;
  }

  async submitCandidate(candidate) {
    if (!this.endpointUrl || !this.callbackSecret) {
      throw new Error("Portal API configuration is missing.");
    }

    const response = await this.fetchImpl(this.endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-make-callback-secret": this.callbackSecret
      },
      body: JSON.stringify(candidate)
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Portal candidate submission failed with HTTP ${response.status}: ${text}`);
      error.httpStatus = response.status;
      throw error;
    }

    const json = await response.json();
    return { portalCandidateId: json.portalCandidateId ?? json.id };
  }
}
