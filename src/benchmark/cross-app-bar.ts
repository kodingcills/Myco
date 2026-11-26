/**
 * Capability track P (tier 2): the pre-registered measurement bar for cross-app workflows,
 * as code, so the bar `docs/gate/cross-app.md` states is the bar a run is judged by.
 *
 * Design (fixed before any run):
 * - Task set: xa-v1, pinned by `sha256(manifest.json)` (`XA_BAR.manifestSha256`). The 12
 *   task ids are frozen here (`XA_BAR.taskIds`), not supplied by the caller;
 *   `test/cross-app/bar.test.ts` proves they are exactly the ids of the committed
 *   `tasks.jsonl` that the pinned manifest hashes. A trial on any other id is `incomplete`.
 * - Arms: `baseline` (the agent alone: no gate, no retry) and `myco` (gate per trial, one
 *   retry from the gate's last verified checkpoint).
 * - Sample: every xa-v1 task run `XA_BAR.repetitions` times in each arm, so n per arm is
 *   12 x 10 = 120. A run that does not fill every (task, repetition) cell exactly once per
 *   arm is `incomplete`, never a pass.
 * - Primary metric: the independent grader's `pass` rate (`src/benchmark/grade/`). The
 *   grade alone decides it, in both arms; `fail` and `ungradable` count as not passed. The
 *   gate's verdict is not part of the primary metric (the baseline arm has none).
 * - Test: the Newcombe hybrid-score 95% interval (Newcombe 1998, method 10) on
 *   p(myco) - p(baseline), built from each arm's Wilson interval.
 * - Margin and decision: `pass` iff the interval's lower bound is above 0 AND the observed
 *   difference is at least `XA_BAR.margin` (0.10) AND the myco arm has zero false-verified
 *   trials (gate `verified` while the grade is not `pass`). Anything else is `fail`.
 * - Fail closed on the record: every myco-arm trial must carry its gate verdict, and every
 *   arm, grade and verdict must be one of the known values. A missing or unknown value makes
 *   the run `incomplete`, so "zero false-verified" is never claimed without the verdicts.
 * - False-verified is a separate property of the myco arm: one is a fail outright, and the
 *   report carries the 95% upper bound for zero events in n.
 *
 * This module only reads counts; it imports nothing from the gate or the grader.
 */
import { wilson, zeroEventUpperBound } from "../foundry/stats.ts";

const XA_TASK_IDS = Object.freeze(
  Array.from({ length: 12 }, (_, i) => `xa-v1-${String(i + 1).padStart(3, "0")}`),
);
const XA_REPETITIONS = 10;

export const XA_BAR = {
  taskSet: "xa-v1",
  manifestSha256: "d740ed0434c664cc79fa9517562ba7c540489ffc39f7f24a58a6cc758975c79c",
  /** The frozen xa-v1 task ids (the ids in the manifest-pinned `tasks.jsonl`). */
  taskIds: XA_TASK_IDS as readonly string[],
  tasks: XA_TASK_IDS.length,
  repetitions: XA_REPETITIONS,
  /** Trials per arm: tasks x repetitions. */
  perArm: XA_TASK_IDS.length * XA_REPETITIONS,
  /** Minimum observed improvement in grader pass rate, myco minus baseline. */
  margin: 0.1,
  confidence: 0.95,
} as const;

export type XaArm = "baseline" | "myco";
export type XaGrade = "pass" | "fail" | "ungradable";

export interface XaBarTrial {
  readonly arm: XaArm;
  readonly taskId: string;
  /** 1-based repetition index, 1..XA_BAR.repetitions. */
  readonly repetition: number;
  /** The independent grader's status for the trial's final evidence. */
  readonly grade: XaGrade;
  /** The gate's final verdict (myco arm only; ignored for the baseline arm). */
  readonly gateVerdict?: "verified" | "refuted" | "uncertain";
}

export interface XaArmSummary {
  readonly n: number;
  readonly passed: number;
  readonly rate: number;
  readonly interval: readonly [number, number];
}

export interface XaBarResult {
  readonly decision: "pass" | "fail" | "incomplete";
  readonly reasons: readonly string[];
  readonly baseline?: XaArmSummary;
  readonly myco?: XaArmSummary;
  readonly difference?: number;
  readonly differenceInterval?: readonly [number, number];
  readonly falseVerified?: number;
  /** 95% upper bound on the false-verified rate when zero were observed. */
  readonly falseVerifiedUpper95?: number;
}

/**
 * Newcombe's hybrid-score interval (1998, method 10) for p1 - p2 of two independent
 * proportions, at 95%. Throws on empty arms.
 */
export function newcombeDifference(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
): readonly [number, number] {
  const w1 = wilson(x1, n1);
  const w2 = wilson(x2, n2);
  if (!w1 || !w2) throw new Error("newcombeDifference needs at least one trial per arm");
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const d = p1 - p2;
  const low = d - Math.sqrt((p1 - w1[0]) ** 2 + (w2[1] - p2) ** 2);
  const high = d + Math.sqrt((w1[1] - p1) ** 2 + (p2 - w2[0]) ** 2);
  return [Math.max(-1, low), Math.min(1, high)];
}

function summarize(trials: readonly XaBarTrial[]): XaArmSummary {
  const passed = trials.filter((t) => t.grade === "pass").length;
  const interval = wilson(passed, trials.length) ?? [0, 1];
  return { n: trials.length, passed, rate: passed / trials.length, interval };
}

const ARMS: ReadonlySet<unknown> = new Set(["baseline", "myco"]);
const GRADES: ReadonlySet<unknown> = new Set(["pass", "fail", "ungradable"]);
const VERDICTS: ReadonlySet<unknown> = new Set(["verified", "refuted", "uncertain"]);

/**
 * Problems with the record and the design: known values only, a gate verdict on every
 * myco-arm trial, and every frozen (task, repetition) cell exactly once per arm.
 */
function designProblems(trials: readonly XaBarTrial[]): string[] {
  const problems: string[] = [];
  const known = new Set(XA_BAR.taskIds);
  const seen = { baseline: new Map<string, number>(), myco: new Map<string, number>() };
  for (const t of trials) {
    if (!ARMS.has(t.arm)) {
      problems.push(`unknown arm ${String(t.arm)}`);
      continue;
    }
    const arm = t.arm;
    if (!known.has(t.taskId)) {
      problems.push(`${arm}: ${String(t.taskId)} is not in ${XA_BAR.taskSet}`);
      continue;
    }
    if (!Number.isInteger(t.repetition) || t.repetition < 1 || t.repetition > XA_BAR.repetitions) {
      problems.push(`${arm}: ${t.taskId} repetition ${t.repetition} is out of range`);
      continue;
    }
    if (!GRADES.has(t.grade))
      problems.push(`${arm}: ${t.taskId} repetition ${t.repetition} has no valid grade`);
    if (arm === "myco" && !VERDICTS.has(t.gateVerdict))
      problems.push(`myco: ${t.taskId} repetition ${t.repetition} has no gate verdict`);
    const cell = `${t.taskId}#${t.repetition}`;
    seen[arm].set(cell, (seen[arm].get(cell) ?? 0) + 1);
  }
  for (const arm of ["baseline", "myco"] as const)
    for (const id of XA_BAR.taskIds)
      for (let r = 1; r <= XA_BAR.repetitions; r++) {
        const count = seen[arm].get(`${id}#${r}`) ?? 0;
        if (count !== 1) problems.push(`${arm}: ${id} repetition ${r} ran ${count} times`);
      }
  return problems;
}

/**
 * Judge a completed cross-app run against the pre-registered bar. The task set is the frozen
 * xa-v1 list (`XA_BAR.taskIds`); the caller cannot substitute another.
 */
export function evaluateXaBar(trials: readonly XaBarTrial[]): XaBarResult {
  const problems = designProblems(trials);
  if (problems.length > 0) return { decision: "incomplete", reasons: problems };
  const baselineTrials = trials.filter((t) => t.arm === "baseline");
  const mycoTrials = trials.filter((t) => t.arm === "myco");
  const baseline = summarize(baselineTrials);
  const myco = summarize(mycoTrials);
  const difference = myco.rate - baseline.rate;
  const differenceInterval = newcombeDifference(myco.passed, myco.n, baseline.passed, baseline.n);
  const falseVerified = mycoTrials.filter(
    (t) => t.gateVerdict === "verified" && t.grade !== "pass",
  ).length;
  const reasons: string[] = [];
  if (falseVerified > 0) reasons.push(`${falseVerified} false-verified trial(s) in the myco arm`);
  if (!(differenceInterval[0] > 0))
    reasons.push("the 95% Newcombe interval on the difference does not exclude 0");
  if (!(difference >= XA_BAR.margin - 1e-12))
    reasons.push(`the observed difference is below the ${XA_BAR.margin} margin`);
  return {
    decision: reasons.length === 0 ? "pass" : "fail",
    reasons,
    baseline,
    myco,
    difference,
    differenceInterval,
    falseVerified,
    ...(falseVerified === 0 ? { falseVerifiedUpper95: zeroEventUpperBound(myco.n) } : {}),
  };
}
