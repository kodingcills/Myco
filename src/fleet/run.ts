/**
 * Linux desktop fleet (workstream 2, track U): K desktops in parallel, each running the
 * Myco gate on one trial, with an independent grade and an attempt ledger, measured as
 * trials per hour versus K. $0: scripted agents only, no model, no VM, no network.
 *
 * Per level K, in order (each step fails closed):
 *
 *  1. Hard caps (`src/fleet/caps.ts`): every K and the memory per desktop are checked
 *     before ANY desktop starts; one level over a cap refuses the whole measurement.
 *  2. The trials run through the track L pool, unchanged (`runPool`): one fresh desktop
 *     per trial, its own vault, its own gate bound to that trial's run id, the marker scan,
 *     teardown checks and the count rule. The pool is handed `maxConcurrent = K` and a
 *     memory budget of exactly K × memory per desktop.
 *  3. Attempt ledger, with the R1 runner's semantics (`src/pilot/ledger.ts`, used as is):
 *     a header stamped `simulated: true` with a `simulated:` planner, a `start` line
 *     written once the trial's desktop exists and BEFORE its agent runs (the pool's
 *     `onDesktop` hook), and one `end` line after the trial is decided or faulted. One
 *     task per trial, attempt 1. The ledger is loaded back with `loadLedger`, which refuses
 *     a duplicate start or end, an end without a start, or a second decided attempt.
 *  4. The independent grader grades the bytes the trial's gate read, from the trial's
 *     vault (`gradeTrial`), and never sees the claim or the verdict.
 *  5. The pool's observed peak must not exceed K (`FLEET_PEAK_OVER_CAP`).
 *
 * The result is a `myco.linux-fleet.measurement/1` artifact whose summary is recomputed
 * from its rows (`checkFleetMeasurement`) before it is returned. It is simulated and never
 * evidence; on a backend that leaves other trials' roots visible (`linux-plain`) no trial
 * is ever counted (`shared-host-dirs`), and the artifact says so (`hostDirsHidden: false`).
 */

import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { availableParallelism, platform, totalmem } from "node:os";
import { join } from "node:path";
import type { BenchmarkArmRow } from "../benchmark/check.ts";
import type { ColumnType } from "../benchmark/grade/grade.ts";
import { buildRegistry } from "../gate/gate.ts";
import type { AgentBehaviour, CalcSpec, ScriptedDesktopAgent } from "../parallel/agents.ts";
import type { DesktopBackend, IsolationRequirements } from "../parallel/backend.ts";
import { type Disqualifier, runPool, type TrialSpec } from "../parallel/pool.ts";
import { behaviourFor, CALC_ORACLE_SOURCES, EXPECTED_VERDICT } from "../parallel/throughput.ts";
import {
  AttemptLedger,
  loadLedger,
  type PilotHarnessClass,
  PROGRESS_FILE,
} from "../pilot/ledger.ts";
import { FIXTURE_COLUMNS, generateFixture } from "../tasks/fixture.ts";
import { pacedFileAgent } from "./agents.ts";
import {
  analyzeFleet,
  checkFleetMeasurement,
  FLEET_MEASUREMENT_SCHEMA,
  type FleetLevel,
  type FleetMeasurement,
  type FleetTrialRow,
} from "./analysis.ts";
import {
  assertFleetCaps,
  FLEET_MAX_DESKTOPS,
  FLEET_MAX_MEMORY_MB_PER_DESKTOP,
  FLEET_MAX_TOTAL_MEMORY_MB,
  type FleetCapCode,
  FleetCapRefused,
  fleetCapProblems,
} from "./caps.ts";
import { gradeTrial } from "./grade-trial.ts";

export const FLEET_TASK_SET_VERSION = "linux-fleet-sim/1";
export const FLEET_FIXTURE_SEED = "linux-fleet";
export const FLEET_STATE_FILE = "sheet.csv";
/**
 * The R1 runner's prefix for a simulated planner id (`SIMULATED_PLANNER_PREFIX` in
 * `src/pilot/runner.ts`; equality pinned by `test/fleet/run.test.ts`). Not imported, so the
 * fleet does not load the live runner.
 */
export const SIMULATED_PLANNER_PREFIX = "simulated:";
/** Most trials one level may run (keeps a CI run bounded). */
export const FLEET_MAX_TRIALS_PER_LEVEL = 256;

const COLUMN_TYPES: Record<string, ColumnType> = Object.fromEntries(
  FIXTURE_COLUMNS.map((c) => [c.name, c.type]),
);

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The task one trial of a level runs: same fixture, a value of its own. */
export function fleetTaskSpec(index: number): CalcSpec {
  return {
    fixtureSeed: FLEET_FIXTURE_SEED,
    rowKey: "EMP-0007",
    column: "name",
    newValue: `FLEET-${index}`,
  };
}

/**
 * Disqualifiers that mean the HARNESS failed the trial (no agent outcome exists), and the
 * ledger class each is recorded under. Every other outcome is an agent outcome: decided,
 * final, never re-run (the R1 runner's rule).
 */
export const HARNESS_FAULTS: Readonly<Partial<Record<Disqualifier, PilotHarnessClass>>> = {
  isolation: "spawn-failed",
  "run-id": "spawn-failed",
  "harness-error": "crash",
  teardown: "crash",
  timeout: "timeout",
};

export interface FleetMeasureOptions {
  readonly backend: DesktopBackend;
  readonly requirements: IsolationRequirements;
  /** An empty host dir this measurement owns. */
  readonly runRoot: string;
  readonly ks: readonly number[];
  readonly trialsPerK: number;
  readonly memoryMbPerDesktop: number;
  readonly cpuSecondsPerTrial?: number;
  readonly trialTimeoutMs?: number;
  /** Think time of the default paced scripted agent (ms, default 0). */
  readonly agentThinkMs?: number;
  /** Test hook: another scripted agent (the label then names it). */
  readonly agent?: (behaviour: AgentBehaviour) => ScriptedDesktopAgent;
  readonly agentLabel?: string;
  readonly provenance?: { readonly gitSha: string | null; readonly ciRunUrl: string | null };
}

/** Refuse the whole measurement, before any desktop exists, if any level breaks a cap. */
export function planProblems(opts: {
  ks: readonly number[];
  trialsPerK: number;
  memoryMbPerDesktop: number;
}): FleetCapCode[] {
  if (
    opts.ks.length === 0 ||
    new Set(opts.ks).size !== opts.ks.length ||
    !Number.isSafeInteger(opts.trialsPerK) ||
    opts.trialsPerK <= 0 ||
    opts.trialsPerK > FLEET_MAX_TRIALS_PER_LEVEL
  )
    return ["FLEET_BAD_CAP"];
  const codes = new Set<FleetCapCode>();
  for (const k of opts.ks)
    for (const c of fleetCapProblems({ desktops: k, memoryMbPerDesktop: opts.memoryMbPerDesktop }))
      codes.add(c);
  return [...codes];
}

export async function measureFleet(opts: FleetMeasureOptions): Promise<FleetMeasurement> {
  const problems = planProblems(opts);
  if (problems.length > 0) throw new FleetCapRefused(problems);
  const thinkMs = opts.agentThinkMs ?? 0;
  const agentFor = opts.agent ?? ((b: AgentBehaviour) => pacedFileAgent(b, thinkMs));
  const agentLabel = opts.agentLabel ?? "scripted-file";
  const planner = `${SIMULATED_PLANNER_PREFIX}fleet-${agentLabel}`;
  const fixtureCsv = Buffer.from(generateFixture(FLEET_FIXTURE_SEED).csv);
  const fixtureSha256 = sha256(fixtureCsv);
  const levels: FleetLevel[] = [];
  const rows: FleetTrialRow[] = [];
  let hostDirsHidden = true;

  for (const k of opts.ks) {
    assertFleetCaps({ desktops: k, memoryMbPerDesktop: opts.memoryMbPerDesktop });
    const levelDir = join(opts.runRoot, `k${k}`);
    const poolRoot = join(levelDir, "pool");
    mkdirSync(poolRoot, { recursive: true, mode: 0o700 });
    const ids = Array.from({ length: opts.trialsPerK }, (_, i) => {
      const taskId = `fleet-k${k}-t${i}`;
      return { i, taskId, runId: `${taskId}-a1`, behaviour: behaviourFor(i) };
    });
    const byRun = new Map(ids.map((t) => [t.runId, t]));
    const tasks = buildRegistry(
      ids.map((t) => ({
        id: t.taskId,
        family: "calc-record-edit",
        stateFile: FLEET_STATE_FILE,
        spec: { ...fleetTaskSpec(t.i) },
      })),
    );
    const ledgerPath = join(levelDir, PROGRESS_FILE);
    const ledger = new AttemptLedger(ledgerPath, false);
    ledger.header({
      configSha256: sha256(
        JSON.stringify({ k, trials: opts.trialsPerK, mem: opts.memoryMbPerDesktop, planner }),
      ),
      simulated: true,
      plannerModelId: planner,
    });
    const started = new Set<string>();
    const start = (runId: string) => {
      const t = byRun.get(runId);
      if (!t || started.has(runId)) return;
      started.add(runId);
      ledger.start({
        taskId: t.taskId,
        attempt: 1,
        trialKey: runId,
        runId,
        supersedes: null,
      });
    };
    const trials: TrialSpec[] = ids.map((t) => ({
      runId: t.runId,
      taskId: t.taskId,
      agent: agentFor(t.behaviour),
    }));
    const report = await runPool(
      {
        backend: opts.backend,
        caps: {
          maxConcurrent: k,
          memoryMbPerTrial: opts.memoryMbPerDesktop,
          cpusPerTrial: 1,
          cpuSecondsPerTrial: opts.cpuSecondsPerTrial ?? 60,
          trialTimeoutMs: opts.trialTimeoutMs ?? 60_000,
          memoryBudgetMb: k * opts.memoryMbPerDesktop,
          cpuBudget: k,
        },
        requirements: opts.requirements,
        runRoot: poolRoot,
        tasks,
        oracleSources: CALC_ORACLE_SOURCES,
        onDesktop: (runId) => start(runId),
      },
      trials,
    );
    if (report.peakConcurrent > k) throw new FleetCapRefused(["FLEET_PEAK_OVER_CAP"]);
    const poolReal = realpathSync(poolRoot);
    const t0 = Math.min(...report.trials.map((t) => t.startedAt));
    for (const t of report.trials) {
      const id = byRun.get(t.runId);
      if (!id) throw new Error(`pool returned an unknown trial ${t.runId}`);
      if (t.isolation?.hostDirsHidden !== true) hostDirsHidden = false;
      const g = gradeTrial({
        vaultRunDir: join(poolReal, "vaults", t.runId, t.runId),
        stateFile: FLEET_STATE_FILE,
        fixtureCsv,
        fixtureSha256,
        intent: fleetTaskSpec(id.i),
        columnTypes: COLUMN_TYPES,
      });
      const fault = t.disqualifiers
        .map((d) => HARNESS_FAULTS[d])
        .find((c): c is PilotHarnessClass => c !== undefined);
      start(t.runId); // a trial whose desktop never came up still gets its start line
      if (fault) {
        ledger.end({
          trialKey: t.runId,
          outcome: "harness-fault",
          harnessClass: fault,
          recovered: false,
          armRow: null,
          cost: null,
          faultMessage: `fleet: ${t.disqualifiers.join(",")}`,
        });
      } else {
        const armRow: BenchmarkArmRow = {
          schema: "myco.benchmark.arm-row/1",
          taskSetVersion: FLEET_TASK_SET_VERSION,
          arm: "myco-gate",
          trialKey: t.runId,
          taskId: id.taskId,
          faultClass: "none",
          fixtureSha256,
          instructionSha256: sha256(JSON.stringify(fleetTaskSpec(id.i))),
          plannerModelId: planner,
          outputCeiling: null,
          claim: t.claim === null ? "no-claim" : "done",
          gate: t.gate
            ? { called: true, verdict: t.gate.verdict }
            : { called: false, verdict: null },
          accepted: t.gate?.accepted === true,
          persistedSha256: g.persistedSha256,
          cause: null,
          cost: { modelUsd: null, wallClockS: Math.round(t.elapsedMs) / 1000, vmS: null },
        };
        ledger.end({
          trialKey: t.runId,
          outcome: "decided",
          harnessClass: null,
          recovered: false,
          armRow,
          cost: null,
        });
      }
      rows.push({
        k,
        index: id.i,
        taskId: id.taskId,
        runId: t.runId,
        trialKey: t.runId,
        behaviour: id.behaviour,
        expectedVerdict: EXPECTED_VERDICT[id.behaviour],
        startOffsetMs: Math.round(t.startedAt - t0),
        elapsedMs: Math.round(t.elapsedMs),
        gate: { verdict: t.gate?.verdict ?? null, accepted: t.gate?.accepted === true },
        grade: { status: g.status, binding: g.binding },
        disqualifiers: [...t.disqualifiers].sort(),
        foreignMarkers: t.foreignMarkers.length,
        countedVerified: t.countedVerified,
        ledger: fault ? "harness-fault" : "decided",
      });
    }
    // The ledger must load back under the R1 runner's own rules: one attempt per task.
    const state = loadLedger(ledgerPath);
    const attempts = [...state.byTask.values()];
    if (
      state.header?.simulated !== true ||
      attempts.length !== opts.trialsPerK ||
      attempts.some((a) => a.length !== 1 || a[0]?.end === null)
    )
      throw new Error(
        `fleet: the attempt ledger for k=${k} does not hold one closed attempt per trial`,
      );
    levels.push({
      k,
      trials: report.trials.length,
      wallMs: Math.round(report.wallMs),
      peakConcurrent: report.peakConcurrent,
    });
  }

  const m: FleetMeasurement = {
    schema: FLEET_MEASUREMENT_SCHEMA,
    simulated: true,
    evidence: false,
    r1Evidence: false,
    windowsRow: false,
    costEstimate: null,
    backend: opts.backend.id,
    hostDirsHidden,
    agent: agentLabel,
    agentThinkMs: thinkMs,
    caps: {
      maxDesktops: FLEET_MAX_DESKTOPS,
      maxMemoryMbPerDesktop: FLEET_MAX_MEMORY_MB_PER_DESKTOP,
      maxTotalMemoryMb: FLEET_MAX_TOTAL_MEMORY_MB,
      memoryMbPerDesktop: opts.memoryMbPerDesktop,
    },
    host: {
      platform: platform(),
      cpus: availableParallelism(),
      memoryMb: Math.floor(totalmem() / (1024 * 1024)),
      node: process.version,
    },
    provenance: opts.provenance ?? { gitSha: null, ciRunUrl: null },
    trialsPerK: opts.trialsPerK,
    levels,
    rows,
    summary: analyzeFleet(levels, rows),
  };
  const self = checkFleetMeasurement(m);
  if (self.length > 0)
    throw new Error(`fleet: the measurement fails its own check: ${self.join("; ")}`);
  return m;
}
