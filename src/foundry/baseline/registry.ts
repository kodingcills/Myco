export const armRegistry = [
  {
    id: "screenshot-only",
    channel: "screenshot-only",
    plannerName: "unknown",
    status: "not-run",
    blocker: "Cua Driver C1 pixel arm needs coordinated VM time and a named planner",
  },
  {
    id: "hcu",
    channel: "gui",
    plannerName: "unknown",
    status: "not-run",
    blocker:
      "Microsoft Hybrid Computer Use GUI channel needs coordinated VM time and a named planner",
  },
  {
    id: "orgo",
    channel: "gui",
    plannerName: "unknown",
    status: "blocked",
    blocker: "account creation + card/credit",
  },
  {
    id: "simular-sai",
    channel: "gui",
    plannerName: "unknown",
    status: "blocked",
    blocker:
      "Google sign-in + API key + phone verification; hosted cloud computer is not our fixture host",
  },
] as const;
export const escalations = armRegistry.map(({ id, blocker }) => ({ id, blocker }));
export function baselineStatusMarkdown(): string {
  return `# Baseline status\n\nThe host harness runs scripted reference policies over the myco-todo model. It uses the Foundry fixture's initial bytes and isolates the injected save faults. Control saves and recovery saves use the model's healthy save path. These runs exercise the grader and provide no live desktop performance measurements. Setup time, manual interventions, and economics remain unknown.\n\nLive arms queued for the outer loop.\n\n${armRegistry.map((a) => `- **${a.id}** — ${a.status}: ${a.blocker}; planner: ${a.plannerName}.`).join("\n")}\n`;
}
