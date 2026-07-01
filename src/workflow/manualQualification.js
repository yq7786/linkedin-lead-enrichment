export function buildManualSingleProfileFit(now = new Date()) {
  return {
    mode: "manual_single_profile",
    manuallyQualified: true,
    qualifiedAt: now.toISOString(),
    fitReasoning: "Operator supplied this LinkedIn profile directly; automated fit scoring was skipped."
  };
}

export function isManualSingleProfileFit(fit) {
  return fit?.mode === "manual_single_profile" && fit.manuallyQualified === true;
}
