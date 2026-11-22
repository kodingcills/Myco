/**
 * Offline replay of recorded arm evidence (MVD-004, operating rule B).
 *
 * Reads trial rows that already exist on disk — the C1 arm's accounting file, a
 * run directory's `result.json`, or a JSON/JSONL array of scored trials — and
 * feeds them to the pre-registered decision rule. It never invents a row and
 * never marks recorded evidence decision-eligible: Foundry's trusted ingest is
 * the only thing that can do that.
 *
 * The point is to make the gap visible before a guest slot is spent: which arms
 * exist, which are descriptive, and exactly which pairs the rule still needs.
 */
import { type Decision, evaluateDecision, type ScoredTrial } from "./decision.ts";
import { isRecord } from "./guards.ts";

export interface RecordedTrial extends ScoredTrial {
  /** File the row came from, for the report's evidence list. */
  readonly source: string;
  /** False when the artifact does not carry enough to know (e.g. a bare result.json). */
  readonly falseSuccessKnown: boolean;
  readonly note?: string;
}

export interface ReplayParseResult {
  readonly trials: readonly RecordedTrial[];
  readonly skipped: readonly { readonly source: string; readonly reason: string }[];
}

export interface ReplayInput {
  readonly source: string;
  readonly value: unknown;
}

export interface ReplayArm {
  readonly armId: string;
  readonly trials: number;
  readonly verified: number;
  readonly refuted: number;
  readonly uncertain: number;
  readonly falseSuccesses: number;
  readonly falseSuccessUnknown: number;
  readonly decisionEligible: number;
}

export interface ReplaySummary {
  readonly trials: readonly RecordedTrial[];
  readonly arms: readonly ReplayArm[];
  readonly decision: Decision;
  readonly missing: readonly string[];
  readonly skipped: readonly { readonly source: string; readonly reason: string }[];
  readonly sources: readonly string[];
}

function verdictOf(value: unknown): ScoredTrial["verdict"] | undefined {
  return value === "verified" || value === "refuted" || value === "uncertain" ? value : undefined;
}

/**
 * C1 arm accounting: `{ c1: { "<index>": { status, row } } }`. Rows are Calc
 * trials, so they are descriptive for the todo head-to-head and never eligible.
 */
export function parseC1Accounting(value: unknown, source: string): ReplayParseResult {
  const trials: RecordedTrial[] = [];
  const skipped: { source: string; reason: string }[] = [];
  if (!isRecord(value)) return { trials, skipped: [{ source, reason: "not an object" }] };
  const arm = isRecord(value.c1) ? value.c1 : undefined;
  if (!arm) return { trials, skipped: [{ source, reason: "no c1 arm" }] };
  for (const [key, entry] of Object.entries(arm)) {
    if (!isRecord(entry) || entry.status !== "scored" || !isRecord(entry.row)) {
      skipped.push({ source, reason: `c1[${key}] is not a scored row` });
      continue;
    }
    const row = entry.row;
    const verdict = verdictOf(row.verdict);
    if (!verdict) {
      skipped.push({ source, reason: `c1[${key}] has no verdict` });
      continue;
    }
    const index = typeof row.index === "number" ? row.index : Number(key);
    trials.push({
      armId: "screenshot-only-c1",
      taskId: "calc-record-edit",
      promptVariant: "c1",
      seed: Number.isFinite(index) ? index : 0,
      faultClass: null,
      verdict,
      falseSuccess: row.falseSuccess === true,
      decisionEligible: false,
      source,
      falseSuccessKnown: typeof row.falseSuccess === "boolean",
      note: "C1 is a Calc arm; it cannot supply ef-t01b pairs.",
    });
  }
  return { trials, skipped };
}

/** A run directory's `result.json`. The verdict is the oracle's; the claim is not recorded. */
export function parseRunResult(value: unknown, source: string): ReplayParseResult {
  if (!isRecord(value)) return { trials: [], skipped: [{ source, reason: "not an object" }] };
  const verdict = isRecord(value.verdict) ? verdictOf(value.verdict.status) : undefined;
  if (!verdict) return { trials: [], skipped: [{ source, reason: "no verdict" }] };
  const taskId = typeof value.taskId === "string" ? value.taskId : "unknown";
  return {
    trials: [
      {
        armId: "myco",
        taskId,
        promptVariant: "run",
        seed: 0,
        faultClass: null,
        verdict,
        falseSuccess: false,
        decisionEligible: false,
        source,
        falseSuccessKnown: false,
        note: "result.json carries the oracle verdict, not the agent's claim; false success is not derivable here.",
      },
    ],
    skipped: [],
  };
}

/** A JSON/JSONL array of already-scored trials (the shape a live harness will emit). */
export function parseScoredTrials(value: unknown, source: string): ReplayParseResult {
  const rows = Array.isArray(value) ? value : [value];
  const trials: RecordedTrial[] = [];
  const skipped: { source: string; reason: string }[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) {
      skipped.push({ source, reason: `row ${index} is not an object` });
      continue;
    }
    const verdict = verdictOf(row.verdict);
    if (
      typeof row.armId !== "string" ||
      typeof row.taskId !== "string" ||
      typeof row.promptVariant !== "string" ||
      typeof row.seed !== "number" ||
      !verdict ||
      typeof row.falseSuccess !== "boolean" ||
      typeof row.decisionEligible !== "boolean"
    ) {
      skipped.push({ source, reason: `row ${index} is not a scored trial` });
      continue;
    }
    trials.push({
      armId: row.armId,
      taskId: row.taskId,
      promptVariant: row.promptVariant,
      seed: row.seed,
      faultClass: typeof row.faultClass === "string" ? row.faultClass : null,
      verdict,
      falseSuccess: row.falseSuccess,
      decisionEligible: row.decisionEligible,
      source,
      falseSuccessKnown: true,
    });
  }
  return { trials, skipped };
}

/** Detect the recorded format from its shape, so the CLI needs no flags. */
export function parseRecorded(value: unknown, source: string): ReplayParseResult {
  if (isRecord(value) && isRecord(value.c1)) return parseC1Accounting(value, source);
  if (isRecord(value) && isRecord(value.verdict) && typeof value.runId === "string")
    return parseRunResult(value, source);
  return parseScoredTrials(value, source);
}

export function replay(inputs: readonly ReplayInput[]): ReplaySummary {
  const trials: RecordedTrial[] = [];
  const skipped: { source: string; reason: string }[] = [];
  for (const input of inputs) {
    const parsed = parseRecorded(input.value, input.source);
    trials.push(...parsed.trials);
    skipped.push(...parsed.skipped);
  }

  const armIds = [...new Set(trials.map((trial) => trial.armId))].sort();
  const arms: ReplayArm[] = armIds.map((armId) => {
    const rows = trials.filter((trial) => trial.armId === armId);
    return {
      armId,
      trials: rows.length,
      verified: rows.filter((trial) => trial.verdict === "verified").length,
      refuted: rows.filter((trial) => trial.verdict === "refuted").length,
      uncertain: rows.filter((trial) => trial.verdict === "uncertain").length,
      falseSuccesses: rows.filter((trial) => trial.falseSuccess).length,
      falseSuccessUnknown: rows.filter((trial) => !trial.falseSuccessKnown).length,
      decisionEligible: rows.filter((trial) => trial.decisionEligible).length,
    };
  });

  const decision = evaluateDecision({ trials });
  const missing: string[] = [];
  const hasMyco = trials.some(
    (trial) => trial.armId === "myco" && trial.taskId === "ef-t01b-add-four-items-noverify",
  );
  const hasComparator = trials.some(
    (trial) => trial.armId === "hcu+shell" && trial.taskId === "ef-t01b-add-four-items-noverify",
  );
  if (!hasMyco) missing.push("Myco arm on ef-t01b-add-four-items-noverify");
  if (!hasComparator) missing.push("hcu+shell arm on ef-t01b-add-four-items-noverify");
  if (trials.some((trial) => !trial.decisionEligible))
    missing.push("Foundry trusted ingest (every recorded row is descriptive)");
  if (decision.reason === "insufficient-pairs")
    missing.push(`at least ${30} paired refutable trials (have ${decision.pairs})`);

  return {
    trials,
    arms,
    decision,
    missing,
    skipped,
    sources: [...new Set(trials.map((trial) => trial.source))].sort(),
  };
}

export function renderReplaySummary(summary: ReplaySummary): string {
  const lines: string[] = [];
  lines.push("# Offline replay — recorded arm evidence");
  lines.push("");
  lines.push(
    "Descriptive only. Recorded rows are not decision-eligible until Foundry's trusted ingest binds them.",
  );
  lines.push("");
  lines.push(
    "| Arm | Trials | Verified | Refuted | Uncertain | False successes | False success unknown | Eligible |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const arm of summary.arms) {
    lines.push(
      `| ${arm.armId} | ${arm.trials} | ${arm.verified} | ${arm.refuted} | ${arm.uncertain} | ${arm.falseSuccesses} | ${arm.falseSuccessUnknown} | ${arm.decisionEligible} |`,
    );
  }
  if (summary.arms.length === 0) lines.push("| (no rows) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |");
  lines.push("");
  lines.push("## Decision rule");
  lines.push("");
  lines.push(
    `- Status: **${summary.decision.status}**${summary.decision.reason ? ` (${summary.decision.reason})` : ""}`,
  );
  if (summary.decision.row) lines.push(`- Row: **${summary.decision.row}**`);
  lines.push(
    `- Pairs: ${summary.decision.pairs}; Myco false successes: ${summary.decision.mycoFalseSuccesses}; comparator false successes: ${summary.decision.comparatorFalseSuccesses}`,
  );
  lines.push(
    `- Discordant: ${summary.decision.discordantFavouringMyco} favour Myco, ${summary.decision.discordantFavouringComparator} favour the comparator; sign test p = ${summary.decision.signTestP ?? "n/a"}`,
  );
  for (const note of summary.decision.notes) lines.push(`- ${note}`);
  lines.push("");
  lines.push("## Still missing");
  lines.push("");
  if (summary.missing.length === 0) lines.push("- Nothing; the rule can decide.");
  for (const item of summary.missing) lines.push(`- ${item}`);
  if (summary.skipped.length > 0) {
    lines.push("");
    lines.push("## Skipped rows");
    lines.push("");
    for (const item of summary.skipped) lines.push(`- ${item.source}: ${item.reason}`);
  }
  lines.push("");
  lines.push("## Sources");
  lines.push("");
  for (const source of summary.sources) lines.push(`- ${source}`);
  return `${lines.join("\n")}\n`;
}
