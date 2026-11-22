export const discoveryPlanner = "claude-sonnet-5-5";

/**
 * What an arm costs to run, as far as it can be known before it runs.
 *
 * EF-005's acceptance requires the economics column to state the marginal cost **or**
 * "blocked: account required" — "unknown" for everything is neither, and it hides the one
 * distinction a reader needs: an arm that is merely unrun versus an arm that cannot be run
 * without someone opening an account.
 */
export type ArmEconomics =
  /** No marginal spend: open-source tooling plus a planner we already pay for. */
  | { readonly kind: "free"; readonly basis: string }
  /** Spend is possible but not yet measured; the basis says what would be measured. */
  | { readonly kind: "unmeasured"; readonly basis: string }
  /** Cannot run at all without an account or payment the Foundry may not create. */
  | { readonly kind: "blocked"; readonly reason: string };

/** The one-line form the report prints. */
export function economicsLine(economics: ArmEconomics): string {
  switch (economics.kind) {
    case "free":
      return `$0 marginal (${economics.basis})`;
    case "unmeasured":
      return `unmeasured (${economics.basis})`;
    case "blocked":
      return `blocked: ${economics.reason}`;
  }
}

export const armRegistry = [
  {
    id: "screenshot-only",
    channel: "screenshot-only",
    plannerName: discoveryPlanner,
    status: "not-run",
    blocker: "Cua Driver C1 pixel arm needs coordinated VM time",
    economics: {
      kind: "unmeasured",
      basis:
        "driver is MIT and free; planner is a paid Anthropic API key (Sonnet 5.5), " +
        "$1.13-$5.58 per 30 trials per docs/baseline/screenshot-agent.md §8.4",
    },
  },
  {
    id: "hcu",
    channel: "gui",
    plannerName: discoveryPlanner,
    status: "not-run",
    blocker: "Microsoft Hybrid Computer Use GUI channel needs coordinated VM time",
    economics: {
      kind: "unmeasured",
      basis:
        "repo is MIT and free; planner is a paid Anthropic API key (Sonnet 5.5), " +
        "$1.13-$5.58 per 30 trials per docs/baseline/screenshot-agent.md §8.4",
    },
  },
  {
    id: "hcu+shell",
    channel: "gui+shell",
    plannerName: discoveryPlanner,
    status: "not-run",
    blocker:
      "Needs coordinated VM time, trusted live evidence ingestion, complete tool-call audits, and independently observed save snapshots",
    economics: {
      kind: "unmeasured",
      basis:
        "repo is MIT and free; planner is a paid Anthropic API key (Sonnet 5.5), " +
        "$1.13-$5.58 per 30 trials per docs/baseline/screenshot-agent.md §8.4",
    },
  },
  {
    id: "orgo",
    channel: "gui",
    plannerName: "unknown",
    status: "blocked",
    blocker: "account creation + card/credit",
    economics: { kind: "blocked", reason: "account required (sign-up plus card or credit)" },
  },
  {
    id: "simular-sai",
    channel: "gui",
    plannerName: "unknown",
    status: "blocked",
    blocker:
      "Google sign-in + API key + phone verification; hosted cloud computer is not our fixture host",
    economics: {
      kind: "blocked",
      reason:
        "account required (Google sign-in, phone verification, API key) AND its hosted " +
        "computer is not our fixture host, so an account alone would not give a comparable run",
    },
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
