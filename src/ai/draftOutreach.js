export function draftOutreach({ leadName, evidence, offer = "connect" }) {
  const firstName = (leadName ?? "there").split(" ")[0];
  const hook = evidence?.[0] ?? "your recent work";
  return `Hi ${firstName}, noticed ${hook}. Thought it might be worth comparing notes on ${offer}. Open to a quick chat?`;
}
