/**
 * TIF-268 x TIF-267: the hcu+shell arm's rows in the shared false-completion ledger.
 *
 * TIF-267 (`docs/benchmark/false-completion.md` §4, `schemas/benchmark-ledger.ts`) defines
 * two rows joined by an opaque `trialKey`: an ARM row the arm's harness writes, and a GRADE
 * row the independent grader writes from the saved document's bytes. This module produces
 * the two things the arm's harness owes that pipeline:
 *
 *  - `benchmarkArmRow`: the `myco.benchmark.arm-row/1` row. It carries the agent's claim and
 *    whether "done" was accepted (for this arm: the claim alone, there is no gate), plus the
 *    parity hashes. It carries NO verdict: the C1-style judge verdict on `HcuShellRow` stays
 *    internal evidence and never reaches the benchmark.
 *  - `gradeRequest`: the request line `scripts/benchmark-grade.ts` reads. It has no field for
 *    the claim or any verdict, by construction of the grader's input.
 *
 * Deliberately no import from `src/benchmark/`: the arm stays independent of the grader and
 * its check. Tests validate these rows against the published schema and run the real check.
 */
import { createHash } from "node:crypto";
import type { HcuShellRow } from "./trial.ts";

export const ARM_ROW_SCHEMA = "myco.benchmark.arm-row/1" as const;

export type BenchmarkClaim = "done" | "not-done" | "no-claim";

/** Mirrors `benchmarkArmRowSchema` (closed). */
export interface HcuShellArmRow {
  readonly schema: typeof ARM_ROW_SCHEMA;
  readonly taskSetVersion: string;
  readonly arm: "hcu+shell";
  readonly trialKey: string;
  readonly taskId: string;
  readonly faultClass: string;
  readonly fixtureSha256: string;
  readonly instructionSha256: string;
  readonly plannerModelId: string;
  readonly outputCeiling: number | null;
  readonly claim: BenchmarkClaim;
  readonly gate: null;
  readonly accepted: boolean;
  readonly persistedSha256: string | null;
  readonly cause: { readonly kind: "agent" | "oracle" | "harness"; readonly detail: string } | null;
  readonly cost: {
    readonly modelUsd: number | null;
    readonly wallClockS: number | null;
    readonly vmS: number | null;
  };
}

export interface ArmRowMeta {
  readonly taskSetVersion: string;
  readonly trialKey: string;
  readonly taskId: string;
  readonly faultClass: string;
  /** The model the arm was configured with. A row whose calls used another model throws. */
  readonly plannerModelId: string;
}

/** The last claim wins, as in the loop (a claim ends the trial, so there is at most one). */
export function benchmarkClaim(row: Pick<HcuShellRow, "transcript">): BenchmarkClaim {
  const last = row.transcript.claims.at(-1);
  return last === "done" ? "done" : last === "failure" ? "not-done" : "no-claim";
}

/**
 * Why a row is not a clean accepted DONE (M2 plan §2.2: a cause on every non-verified row).
 *
 * Harness causes are checked first: a row the harness could not run, audit or capture says
 * nothing about the agent. Otherwise a non-accepted row is the agent's (it said not done,
 * or it never said anything before the budget or a bad reply ended the trial).
 */
function causeOf(row: HcuShellRow, accepted: boolean): HcuShellArmRow["cause"] {
  const harness = (detail: string) => ({ kind: "harness" as const, detail });
  if (row.verdictReason === "driver-unreachable") return harness("hcu driver unreachable");
  if (row.shell.integrity === "violated") return harness("shell boundary violation; trial stopped");
  if (row.shell.integrity === "unaudited") return harness("shell call could not be audited");
  if (row.persistedSha256 === null) return harness("persisted document not captured");
  if (row.deviations.includes("hcu-action-refused"))
    return harness("hcu routing refused an action");
  if (accepted) return null;
  const claim = benchmarkClaim(row);
  if (claim === "not-done") return { kind: "agent", detail: "agent reported not done" };
  if (row.budgetExhausted)
    return { kind: "agent", detail: "step budget exhausted without a claim" };
  if (row.deviations.includes("planner-invalid-action"))
    return { kind: "agent", detail: "planner returned an invalid action" };
  return { kind: "agent", detail: "planner returned no readable decision" };
}

export function benchmarkArmRow(row: HcuShellRow, meta: ArmRowMeta): HcuShellArmRow {
  if (row.plannerModelId !== null && row.plannerModelId !== meta.plannerModelId)
    throw new Error(
      `trial ${row.index} used planner ${row.plannerModelId}, not the arm's ${meta.plannerModelId}`,
    );
  if (row.deviations.includes("planner-model-mixed"))
    throw new Error(`trial ${row.index} mixed planner models`);
  const claim = benchmarkClaim(row);
  const accepted = claim === "done";
  return {
    schema: ARM_ROW_SCHEMA,
    taskSetVersion: meta.taskSetVersion,
    arm: "hcu+shell",
    trialKey: meta.trialKey,
    taskId: meta.taskId,
    faultClass: meta.faultClass,
    fixtureSha256: row.fixtureSha256,
    instructionSha256: createHash("sha256").update(row.instruction, "utf8").digest("hex"),
    plannerModelId: meta.plannerModelId,
    outputCeiling: row.outputCeiling,
    claim,
    gate: null,
    accepted,
    persistedSha256: row.persistedSha256,
    cause: causeOf(row, accepted),
    cost: {
      // A stub planner costs nothing because it measured nothing: null, never 0 (R7).
      modelUsd: row.plannerPaid ? row.cost : null,
      wallClockS: row.elapsedMs / 1000,
      vmS: null,
    },
  };
}

export type ColumnType = "key" | "text" | "integer" | "date" | "currency";

/** One line of `scripts/benchmark-grade.ts`'s input. Paths are relative to the requests file. */
export interface GradeRequest {
  readonly trialKey: string;
  readonly taskId: string;
  readonly fixtureSha256: string;
  readonly fixtureFile: string;
  readonly persistedFile: string | null;
  readonly persistedFormat: "xlsx" | "csv";
  readonly intent: { readonly rowKey: string; readonly column: string; readonly newValue: string };
  readonly columnTypes: Readonly<Record<string, ColumnType>>;
}

const relative = (path: string, what: string) => {
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes(".."))
    throw new Error(`${what} must be relative and inside the request directory`);
  return path;
};

/**
 * The grade request for one trial. `persistedFile` is null exactly when nothing was captured,
 * which the grader turns into `ungradable`. The intent is the task's params, the same ones
 * the agent's instruction was rendered from; nothing from the arm's run enters it.
 */
export function gradeRequest(
  row: HcuShellRow,
  meta: {
    readonly trialKey: string;
    readonly taskId: string;
    readonly fixtureFile: string;
    readonly persistedFile: string | null;
    readonly columnTypes: Readonly<Record<string, ColumnType>>;
  },
): GradeRequest {
  if ((meta.persistedFile === null) !== (row.persistedSha256 === null))
    throw new Error(
      `trial ${row.index}: persistedFile must be given exactly when one was captured`,
    );
  return {
    trialKey: meta.trialKey,
    taskId: meta.taskId,
    fixtureSha256: row.fixtureSha256,
    fixtureFile: relative(meta.fixtureFile, "fixtureFile"),
    persistedFile:
      meta.persistedFile === null ? null : relative(meta.persistedFile, "persistedFile"),
    persistedFormat: row.persistedFormat ?? "xlsx",
    intent: {
      rowKey: row.params.rowKey,
      column: row.params.column,
      newValue: String(row.params.newValue),
    },
    columnTypes: meta.columnTypes,
  };
}
