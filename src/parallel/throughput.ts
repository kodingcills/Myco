/**
 * Track L (safe parallelism) — the throughput harness: trials/hour versus N, with
 * verified-result counts, at $0 (scripted agents only; no model, no API).
 *
 * For each N it runs one pool of `trialsPerN` trials with `maxConcurrent = N`, all on the
 * same task with a fixed mix of agent behaviours, and records wall time, trials/hour,
 * counted-verified results/hour, verdict correctness against each behaviour's expected
 * verdict, contamination, and the peak concurrency the pool observed.
 *
 * The report is `simulated: true` and `evidence: false` by construction: scripted agents
 * measure the harness (isolation overhead, scaling), never an agent's capability. It
 * carries no cost (`costEstimate: null`), so it can never enter R7.
 */

import { join } from "node:path";
import { buildRegistry, type TaskRegistry } from "../gate/gate.ts";
import type { AgentBehaviour, CalcSpec, ScriptedDesktopAgent } from "./agents.ts";
import type { DesktopBackend, IsolationRequirements } from "./backend.ts";
import type { ResourceCapsInput } from "./caps.ts";
import { type PoolReport, runPool, type TrialSpec } from "./pool.ts";

export const THROUGHPUT_SCHEMA = "myco.parallel-throughput/1";

const ROOT = join(import.meta.dirname, "..", "..");

/** The calc-record-edit oracle's sources, hashed into every trial's seal. */
export const CALC_ORACLE_SOURCES: readonly string[] = [
  "src/gate/families.ts",
  "src/gate/calc-document.ts",
  "src/tasks/fixture.ts",
  "src/tasks/intent.ts",
].map((rel) => join(ROOT, rel));

export const L_TASK_ID = "l-calc-edit";
export const L_TASK_SPEC: CalcSpec = {
  fixtureSeed: "safe-parallelism",
  rowKey: "EMP-0007",
  column: "name",
  newValue: "PARALLEL-L",
};

export function lTaskRegistry(spec: CalcSpec = L_TASK_SPEC): TaskRegistry {
  return buildRegistry([
    { id: L_TASK_ID, family: "calc-record-edit", stateFile: "sheet.csv", spec: { ...spec } },
  ]);
}

export const EXPECTED_VERDICT: Readonly<Record<AgentBehaviour, "verified" | "refuted">> = {
  honest: "verified",
  "skips-save": "refuted",
  "wrong-row": "refuted",
};

/** The behaviour mix: mostly honest, with a false completion and a slip every 4 trials. */
export function behaviourFor(i: number): AgentBehaviour {
  const cycle: readonly AgentBehaviour[] = ["honest", "skips-save", "honest", "wrong-row"];
  return cycle[i % cycle.length] as AgentBehaviour;
}

export interface ThroughputOptions {
  readonly backend: DesktopBackend;
  readonly requirements: IsolationRequirements;
  readonly runRoot: string;
  readonly ns: readonly number[];
  readonly trialsPerN: number;
  readonly agent: (behaviour: AgentBehaviour) => ScriptedDesktopAgent;
  readonly caps: Omit<ResourceCapsInput, "maxConcurrent">;
  readonly label?: string;
  readonly extraHide?: readonly string[];
}

export interface ThroughputPoint {
  readonly n: number;
  readonly trials: number;
  readonly wallMs: number;
  readonly trialsPerHour: number;
  readonly countedVerified: number;
  readonly countedVerifiedPerHour: number;
  /** Trials whose gate verdict matched the behaviour's expected verdict, with no disqualifier. */
  readonly correct: number;
  readonly mismatches: readonly string[];
  readonly contaminated: number;
  readonly disqualified: number;
  readonly peakConcurrent: number;
  readonly speedupVsFirst: number;
}

export interface ThroughputReport {
  readonly schema: typeof THROUGHPUT_SCHEMA;
  readonly simulated: true;
  readonly evidence: false;
  readonly costEstimate: null;
  readonly backend: string;
  readonly label: string | null;
  readonly trialsPerN: number;
  readonly points: readonly ThroughputPoint[];
  /** Every trial at every N got its expected verdict and no disqualifier. */
  readonly allCorrect: boolean;
}

const perHour = (count: number, ms: number) =>
  ms > 0 ? Math.round((count * 3_600_000 * 10) / ms) / 10 : 0;

export async function runThroughput(opts: ThroughputOptions): Promise<ThroughputReport> {
  if (!Number.isSafeInteger(opts.trialsPerN) || opts.trialsPerN <= 0)
    throw new Error("trialsPerN must be a positive integer");
  const tasks = lTaskRegistry();
  const points: ThroughputPoint[] = [];
  let firstRate = 0;
  for (const n of opts.ns) {
    const behaviours = Array.from({ length: opts.trialsPerN }, (_, i) => behaviourFor(i));
    const trials: TrialSpec[] = behaviours.map((b, i) => ({
      runId: `l-n${n}-t${i}`,
      taskId: L_TASK_ID,
      agent: opts.agent(b),
    }));
    const report: PoolReport = await runPool(
      {
        backend: opts.backend,
        caps: { ...opts.caps, maxConcurrent: n },
        requirements: opts.requirements,
        runRoot: join(opts.runRoot, `n${n}`),
        tasks,
        oracleSources: CALC_ORACLE_SOURCES,
        ...(opts.extraHide ? { extraHide: opts.extraHide } : {}),
      },
      trials,
    );
    const mismatches: string[] = [];
    let correct = 0;
    report.trials.forEach((t, i) => {
      const expected = EXPECTED_VERDICT[behaviours[i] as AgentBehaviour];
      const got = t.gate?.verdict ?? "none";
      if (got === expected && t.disqualifiers.length === 0) correct++;
      else
        mismatches.push(
          `${t.runId} (${behaviours[i]}): expected ${expected}, got ${got}${t.disqualifiers.length ? ` [${t.disqualifiers.join(",")}]` : ""}`,
        );
    });
    const rate = perHour(report.trials.length, report.wallMs);
    if (points.length === 0) firstRate = rate;
    points.push({
      n,
      trials: report.trials.length,
      wallMs: report.wallMs,
      trialsPerHour: rate,
      countedVerified: report.verifiedCount,
      countedVerifiedPerHour: perHour(report.verifiedCount, report.wallMs),
      correct,
      mismatches,
      contaminated: report.contaminatedCount,
      disqualified: report.trials.filter((t) => t.disqualifiers.length > 0).length,
      peakConcurrent: report.peakConcurrent,
      speedupVsFirst: firstRate > 0 ? Math.round((rate / firstRate) * 100) / 100 : 0,
    });
  }
  return {
    schema: THROUGHPUT_SCHEMA,
    simulated: true,
    evidence: false,
    costEstimate: null,
    backend: opts.backend.id,
    label: opts.label ?? null,
    trialsPerN: opts.trialsPerN,
    points,
    allCorrect: points.every((p) => p.mismatches.length === 0),
  };
}
