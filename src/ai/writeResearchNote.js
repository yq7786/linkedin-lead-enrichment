export function writeResearchNote({ profile, company, activities, fit }) {
  return [
    `# ${profile.fullName ?? "Unknown Lead"}`,
    "",
    `## Fit`,
    `Score: ${fit.fitScore}`,
    fit.fitReasoning ?? "",
    "",
    "## Profile Evidence",
    profile.headline ?? "No headline captured.",
    "",
    "## Company Evidence",
    company?.markdownSummary ?? "No company website summary captured.",
    "",
    "## Recent Activity",
    activities?.length ? activities.map((item) => `- ${item.content}`).join("\n") : "No recent activity captured."
  ].join("\n");
}
