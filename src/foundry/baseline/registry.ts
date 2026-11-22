export const discoveryPlanner = "claude-sonnet-5-5";

export const armRegistry = [
  {
    id: "screenshot-only",
    channel: "screenshot-only",
    plannerName: discoveryPlanner,
    status: "not-run",
    blocker: "Cua Driver C1 pixel arm needs coordinated VM time",
  },
  {
    id: "hcu",
    channel: "gui",
    plannerName: discoveryPlanner,
    status: "not-run",
    blocker: "Microsoft Hybrid Computer Use GUI channel needs coordinated VM time",
  },
  {
    id: "hcu+shell",
    channel: "gui+shell",
    plannerName: discoveryPlanner,
    status: "not-run",
    blocker:
      "Needs coordinated VM time, trusted live evidence ingestion, complete tool-call audits, and independently observed save snapshots",
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
/**
 * The generated part of docs/foundry/baseline-status.md: the header and the arm table.
 * The offline-inventory and guest-queue sections are prose the doc owns, so this function
 * renders only what the arm registry actually knows — a test asserts equality with the
 * committed doc, which is how the two stay in step.
 */
/** The arm table only: the part of the status doc the registry determines. */
export function baselineArmTable(): string {
  return [
    "## Live arms queued for the outer loop.",
    "",
    ...armRegistry.map(
      (a) => `- **${a.id}** — ${a.status}: ${a.blocker}; planner: ${a.plannerName}.`,
    ),
  ].join("\n");
}

export function baselineStatusMarkdown(): string {
  const header =
    "# Baseline status\n\n" +
    "The host harness runs scripted reference policies over the myco-todo model. It uses the " +
    "Foundry fixture's initial bytes and isolates the injected save faults. Control saves and " +
    "recovery saves use the model's healthy save path. These runs exercise the grader and " +
    "provide no live desktop performance measurements. Setup time, manual interventions, and " +
    "economics remain unknown.\n\n";
  return `${header}${baselineArmTable()}\n`;
}
