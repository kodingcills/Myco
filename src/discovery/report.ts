/**
 * Head-to-head report (MVD-004 / TIF-59).
 *
 * Renders the pre-registered decision and the per-arm evidence as Markdown. It
 * computes nothing beyond counts and intervals over the rows it is given: the
 * decision comes from `evaluateDecision`, and every number in the output is
 * traceable to a row or to that decision.
 *
 * Deliberate omissions: no pooled prompt variants, no leaderboard claim, no
 * "success rate" that folds `uncertain` into either side.
 */
import { type Decision, type ScoredTrial, wilson } from "./decision.ts";

export interface ReportArm {
  readonly armId: string;
  readonly label?: string;
  readonly trials: readonly ScoredTrial[];
}

export interface NotRunArm {
  readonly armId: string;
  readonly blocker: string;
}

export interface HeadToHeadReportInput {
  readonly decision: Decision;
  readonly provenance?: {
    readonly kind: "live" | "simulated" | "mixed" | "unknown";
    readonly note?: string;
  };
  readonly arms: readonly ReportArm[];
  readonly notRun?: readonly NotRunArm[];
  readonly evidence?: readonly string[];
  readonly generatedAt?: string;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function interval(bounds: readonly [number, number] | null): string {
  return bounds === null ? "n/a" : `${percent(bounds[0])}–${percent(bounds[1])}`;
}

export function renderHeadToHeadReport(input: HeadToHeadReportInput): string {
  const { decision } = input;
  const lines: string[] = [];
  lines.push("# Head-to-head — pre-registered decision");
  lines.push("");
  if (input.generatedAt) lines.push(`Generated: ${input.generatedAt}`);
  lines.push(
    `Task: \`${decision.taskId}\` · prompt variant: \`${decision.promptVariant}\` · paired refutable trials: **${decision.pairs}**`,
  );
  lines.push("");
  const provenance = input.provenance ?? { kind: "unknown" as const };
  lines.push(
    `Provenance: **${provenance.kind}**${provenance.kind === "live" ? "" : " — not live guest evidence"}`,
  );
  if (provenance.note) lines.push(provenance.note);
  lines.push("");
  lines.push("## Decision");
  lines.push("");
  lines.push(`- Status: **${decision.status}**${decision.reason ? ` (${decision.reason})` : ""}`);
  if (decision.row) lines.push(`- Rule row: **${decision.row}**`);
  lines.push(
    `- Myco false successes: **${decision.mycoFalseSuccesses}** (95% CI ${interval(decision.mycoFalseSuccessInterval)})`,
  );
  lines.push(
    `- Comparator false successes: **${decision.comparatorFalseSuccesses}** (95% CI ${interval(decision.comparatorFalseSuccessInterval)})`,
  );
  lines.push(
    `- Discordant pairs: **${decision.discordantFavouringMyco}** favour Myco, **${decision.discordantFavouringComparator}** favour the comparator`,
  );
  lines.push(`- Exact two-sided sign test: p = ${decision.signTestP ?? "n/a"}`);
  lines.push(`- Ineligible rows in scope: ${decision.ineligibleRows}`);
  const descriptive = input.arms
    .flatMap((arm) => arm.trials)
    .filter((trial) => !trial.decisionEligible).length;
  lines.push(`- Descriptive rows (not decision-eligible): ${descriptive}`);
  for (const note of decision.notes) lines.push(`- ${note}`);
  lines.push("");

  lines.push("## Arms");
  lines.push("");
  lines.push("| Arm | Trials | Verified | Refuted | Uncertain | False successes | 95% CI |");
  lines.push("|---|---:|---:|---:|---:|---:|---|");
  for (const arm of input.arms) {
    const falseSuccesses = arm.trials.filter((trial) => trial.falseSuccess).length;
    const unknown = arm.trials.some((trial) => trial.falseSuccessKnown === false);
    lines.push(
      `| ${cell(arm.label ?? arm.armId)} | ${arm.trials.length} | ${arm.trials.filter((trial) => trial.verdict === "verified").length} | ${arm.trials.filter((trial) => trial.verdict === "refuted").length} | ${arm.trials.filter((trial) => trial.verdict === "uncertain").length} | ${unknown ? "n/a (unknown)" : falseSuccesses} | ${unknown ? "n/a" : interval(wilson(falseSuccesses, arm.trials.length))} |`,
    );
  }
  if (input.arms.length === 0) lines.push("| (no arms) | 0 | 0 | 0 | 0 | 0 | n/a |");
  lines.push("");

  if (decision.pairRows.length > 0) {
    lines.push("## Paired trials");
    lines.push("");
    lines.push("| Seed | Fault | Myco false success | Comparator false success |");
    lines.push("|---:|---|---|---|");
    for (const row of decision.pairRows) {
      lines.push(
        `| ${row.seed} | ${cell(row.faultClass)} | ${row.mycoFalseSuccess ? "yes" : "no"} | ${row.comparatorFalseSuccess ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }

  if (input.notRun && input.notRun.length > 0) {
    lines.push("## Not run");
    lines.push("");
    lines.push("| Arm | Blocker |");
    lines.push("|---|---|");
    for (const arm of input.notRun) lines.push(`| ${cell(arm.armId)} | ${cell(arm.blocker)} |`);
    lines.push("");
  }

  if (input.evidence && input.evidence.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    for (const path of input.evidence) lines.push(`- \`${path}\``);
    lines.push("");
  }

  lines.push("## What this report does not say");
  lines.push("");
  lines.push(
    "- It does not pool prompt variants: `ef-t01` (verify) and `ef-t01b` (no-verify) are separate decisions.",
  );
  lines.push(
    "- It does not treat `uncertain` as success or failure; those trials are counted separately and excluded from the false-success rate.",
  );
  lines.push(
    "- It is not a leaderboard entry. The task set, initial state, and planner are the ones named above.",
  );
  lines.push(
    "- A `refused` decision is a result: it means the pre-registered sample or the trusted ingest is not there yet.",
  );
  if (decision.status === "refused") {
    lines.push(
      "- The decision counts are zero because there are no paired trials; the arm rows above are descriptive and are not a decision.",
    );
  }
  return `${lines.join("\n")}\n`;
}
