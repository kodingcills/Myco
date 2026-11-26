/**
 * Handoffs and evidence (capability track N): a trial with any handoff is never unassisted R1
 * evidence.
 *
 * A human who answers `fixed-it` changed the desktop: the trial is `assisted`. A human who
 * approved or rejected still had the live desktop while the agent was paused, so that trial is
 * `human-gated`. R1 measures the gate on agents working alone, so only `unassisted` rows count
 * (docs/handoff/measurement.md). The label is always RECOMPUTED from the entries
 * (`assistanceOf`); a row whose declared label disagrees is an error, so a log cannot claim
 * `unassisted` while carrying a `fixed-it`.
 *
 * Wiring: `checkBenchmarkWithHandoffs` wraps `checkBenchmark` (src/benchmark/check.ts, unchanged)
 * for a ledger that has a `handoffs.jsonl` beside it. The M2 pack check (src/m2/evidence.ts) is
 * owned by #518 and not touched here.
 * TO FILE (Linear limit): after #518 merges, read an optional `handoffs.jsonl` in `readPack` and
 * apply `handoffEvidenceError` in `checkPack` for R1 packs; and pass `--handoffs` through
 * scripts/benchmark-check.ts.
 *
 * Nothing here changes a verdict: the gate and the independent grader decide from persisted
 * bytes; this only decides whether a row may be COUNTED as unassisted evidence.
 */
import { handoffTrialSchema } from "../../schemas/handoff.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  type BenchmarkArmRow,
  type CheckOptions,
  type CheckResult,
  checkBenchmark,
} from "../benchmark/check.ts";
import {
  AGENT_NOTE_LIMIT,
  type AssistanceLabel,
  assistanceOf,
  type HandoffLog,
  HUMAN_NOTE_LIMIT,
  noteRejection,
} from "./protocol.ts";

export interface HandoffTrialRow {
  readonly schema: "myco.handoff.trial/1";
  readonly trialKey: string;
  readonly log: HandoffLog;
}

export interface ParsedHandoffRows {
  readonly byTrial: ReadonlyMap<string, AssistanceLabel>;
  readonly errors: readonly string[];
}

/** Validate `myco.handoff.trial/1` rows and recompute each trial's label. */
export function parseHandoffRows(input: readonly unknown[]): ParsedHandoffRows {
  const errors: string[] = [];
  const byTrial = new Map<string, AssistanceLabel>();
  input.forEach((row, i) => {
    const issues = validateSchema(row, handoffTrialSchema);
    if (issues.length > 0) {
      errors.push(...issues.map((s) => `handoff row ${i}: ${s.path} ${s.message}`));
      return;
    }
    const r = row as HandoffTrialRow;
    if (byTrial.has(r.trialKey)) errors.push(`duplicate handoff row for trialKey ${r.trialKey}`);
    const label = assistanceOf(r.log.entries);
    if (label !== r.log.assistance)
      errors.push(
        `${r.trialKey}: declared assistance ${r.log.assistance} but its handoffs imply ${label}`,
      );
    const timedOut = r.log.entries.some((e) => e.resolution === "timeout");
    if (timedOut !== (r.log.attemptEnd === "handoff-timeout"))
      errors.push(`${r.trialKey}: attemptEnd disagrees with its handoff entries`);
    for (const e of r.log.entries) {
      if (noteRejection(e.note, AGENT_NOTE_LIMIT) !== null)
        errors.push(`${r.trialKey}: ${e.handoffId} agent note fails note hygiene`);
      if (e.humanNote !== null && noteRejection(e.humanNote, HUMAN_NOTE_LIMIT) !== null)
        errors.push(`${r.trialKey}: ${e.handoffId} human note fails note hygiene`);
      const human = e.resolvedBy.startsWith("operator:");
      if (human !== ["approve", "reject", "fixed-it"].includes(e.resolution))
        errors.push(
          `${r.trialKey}: ${e.handoffId} resolvedBy ${e.resolvedBy} with ${e.resolution}`,
        );
      if ((e.source === "policy") !== (e.policyId !== null))
        errors.push(
          `${r.trialKey}: ${e.handoffId} policyId must be set exactly for policy handoffs`,
        );
    }
    // The stricter of the two, so a row that fails a consistency check never reads unassisted.
    byTrial.set(r.trialKey, label === "unassisted" ? r.log.assistance : label);
  });
  return { byTrial, errors };
}

/**
 * Null when no arm row is assisted or human-gated, else the error R1 evidence refuses with.
 * Mirrors `correctionsOnError`: these rows ran with a human in the loop, so they are never
 * unassisted evidence.
 */
export function handoffEvidenceError(
  rows: readonly BenchmarkArmRow[],
  byTrial: ReadonlyMap<string, AssistanceLabel>,
): string | null {
  const helped = rows.filter((r) => (byTrial.get(r.trialKey) ?? "unassisted") !== "unassisted");
  if (helped.length === 0) return null;
  const keys = helped
    .slice(0, 5)
    .map((r) => `${r.trialKey}=${byTrial.get(r.trialKey)}`)
    .join(", ");
  return `${helped.length} row(s) with a human handoff (${keys}${helped.length > 5 ? ", ..." : ""}): assisted and human-gated trials are never unassisted R1 evidence`;
}

/** The R1 reason every handoff-refused check carries. */
export const HANDOFF_R1 = "not R1 evidence: rows include assisted or human-gated trials";

/**
 * `checkBenchmark`, plus the handoff ledger. Every handoff row must name an arm row. Any
 * assisted or human-gated arm row fails R1 (whatever `evidence` says: R1 is unassisted by
 * definition) and, under `evidence: true`, is a ledger error, like corrections-on rows.
 */
export function checkBenchmarkWithHandoffs(
  armInput: readonly unknown[],
  gradeInput: readonly unknown[],
  handoffInput: readonly unknown[],
  options: CheckOptions,
): CheckResult {
  const base = checkBenchmark(armInput, gradeInput, options);
  const parsed = parseHandoffRows(handoffInput);
  const errors = [...base.errors, ...parsed.errors];
  const armKeys = new Set(
    armInput.flatMap((r) =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as { trialKey?: unknown }).trialKey === "string"
        ? [(r as { trialKey: string }).trialKey]
        : [],
    ),
  );
  for (const key of parsed.byTrial.keys())
    if (!armKeys.has(key)) errors.push(`handoff row ${key} has no arm row`);
  const rows = armInput.filter(
    (r): r is BenchmarkArmRow =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as { trialKey?: unknown }).trialKey === "string",
  );
  const helped = handoffEvidenceError(rows, parsed.byTrial);
  if (helped !== null && options.evidence === true) errors.push(helped);
  const r1 =
    base.r1 === null
      ? null
      : helped === null && parsed.errors.length === 0
        ? base.r1
        : {
            ...base.r1,
            pass: false,
            reasons: [...base.r1.reasons, helped === null ? "handoff ledger invalid" : HANDOFF_R1],
          };
  return { ...base, ok: errors.length === 0, errors, r1 };
}
