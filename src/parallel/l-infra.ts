/**
 * Track L — L-infra: the zero-contamination run on the Linux path (capability-spec §L,
 * measurement stage 1; §5: L's measurement needs this result first).
 *
 * No model. The Linux path's deterministic scripted agent runs every satisfiable fc-v1 task
 * once per concurrency level through the unchanged `runPool`. Each desktop carries a unique
 * canary: the pool's per-trial marker (128 random bits, known only to the harness and that
 * trial), which the pool scans for in every other trial's workspace, evidence, vault and
 * gate records. A contamination event is a trial in which another trial's canary was found,
 * or whose canary was found elsewhere (`contaminated` / `leaked`).
 *
 * Rows are SIMULATED (scripted agent) and never evidence of agent capability (§3 item 5).
 *
 * - The task set is read from fc-v1's committed bundle, without importing `src/benchmark`
 *   (the grader's tree stays out of `src/parallel`). The manifest's hash of `tasks.jsonl`, each
 *   committed fixture's hash, and the fixture the pool lays down (`generateFixture`) must all
 *   agree, or the run is refused before it starts.
 * - A level whose caps the host refuses (`resolveCaps`, for example N = 8 on a 4-CPU runner)
 *   is recorded as not admitted. It is never forced: the cap checks are not weakened.
 * - A positive control in the same run plants one trial's canary in another trial's
 *   workspace at N = 2, so "0 events" is shown to come from a scan that detects a leak.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { buildRegistry, type TaskRegistry } from "../gate/gate.ts";
import { generateFixture } from "../tasks/fixture.ts";
import {
  type AgentContext,
  type AgentRun,
  type CalcSpec,
  claimFor,
  editedCsv,
  type ScriptedDesktopAgent,
} from "./agents.ts";
import type { DesktopBackend, IsolationReport, IsolationRequirements } from "./backend.ts";
import { type ResourceCapsInput, resolveCaps } from "./caps.ts";
import { MARKER_ENV, runPool, type TrialRecord } from "./pool.ts";
import { CALC_ORACLE_SOURCES } from "./throughput.ts";

export const L_INFRA_ROW_SCHEMA = "myco.parallel-l-infra-row/1";
export const L_INFRA_RUN_SCHEMA = "myco.parallel-l-infra-run/1";

/** capability-spec §L stage 1: N = 1, 2, 4 and 8. */
export const L_INFRA_LEVELS: readonly number[] = [1, 2, 4, 8];

export const FC_V1_BUNDLE = join(
  import.meta.dirname,
  "..",
  "..",
  "benchmark",
  "false-completion",
  "fc-v1",
);

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------------------
// the task set
// ---------------------------------------------------------------------------------------

export interface LInfraTask {
  readonly taskId: string;
  readonly fixtureSeed: string;
  readonly fixtureSha256: string;
  readonly intent: { readonly rowKey: string; readonly column: string; readonly newValue: string };
}

export interface LInfraTaskSet {
  readonly version: string;
  /** SHA-256 of the bundle's `manifest.json` bytes. */
  readonly manifestSha256: string;
  /** SHA-256 of `tasks.jsonl`, as the manifest pins it. */
  readonly tasksSha256: string;
  /** The satisfiable tasks, in bundle order. */
  readonly tasks: readonly LInfraTask[];
}

export class LInfraRefused extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`l-infra refused: ${problems.join("; ")}`);
    this.name = "LInfraRefused";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * fc-v1's satisfiable tasks, checked against the committed bundle. Refuses (`LInfraRefused`)
 * when the manifest does not pin `tasks.jsonl`'s bytes, when a committed fixture does not hash
 * to its task's `fixtureSha256`, or when the fixture the pool would lay down differs from it.
 */
export function loadSatisfiableTasks(bundleDir: string = FC_V1_BUNDLE): LInfraTaskSet {
  const problems: string[] = [];
  const manifestBytes = readFileSync(join(bundleDir, "manifest.json"));
  const tasksBytes = readFileSync(join(bundleDir, "tasks.jsonl"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  if (!isRecord(manifest) || !isRecord(manifest.files) || !str(manifest.taskSetVersion))
    throw new LInfraRefused(["manifest.json: not a bundle manifest"]);
  const tasksSha256 = sha256(tasksBytes);
  if (manifest.files["tasks.jsonl"] !== tasksSha256)
    problems.push("tasks.jsonl: does not match the manifest's hash");
  const tasks: LInfraTask[] = [];
  const lines = tasksBytes.toString("utf8").split("\n").filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const t = JSON.parse(line) as unknown;
    if (
      !isRecord(t) ||
      !str(t.taskId) ||
      !str(t.fixtureSeed) ||
      !str(t.fixtureSha256) ||
      !str(t.fixtureFile) ||
      typeof t.satisfiable !== "boolean" ||
      !isRecord(t.intent) ||
      !str(t.intent.rowKey) ||
      !str(t.intent.column) ||
      typeof t.intent.newValue !== "string"
    ) {
      problems.push(`tasks.jsonl line ${i + 1}: malformed`);
      continue;
    }
    if (t.taskSetVersion !== manifest.taskSetVersion)
      problems.push(`${t.taskId}: task set version differs from the manifest`);
    if (!t.satisfiable) continue;
    const committed = sha256(readFileSync(join(bundleDir, t.fixtureFile)));
    if (committed !== t.fixtureSha256) problems.push(`${t.taskId}: committed fixture hash differs`);
    if (sha256(generateFixture(t.fixtureSeed).csv) !== t.fixtureSha256)
      problems.push(`${t.taskId}: generated fixture differs from the committed one`);
    tasks.push({
      taskId: t.taskId,
      fixtureSeed: t.fixtureSeed,
      fixtureSha256: t.fixtureSha256,
      intent: { rowKey: t.intent.rowKey, column: t.intent.column, newValue: t.intent.newValue },
    });
  }
  if (tasks.length === 0) problems.push("no satisfiable task");
  if (problems.length > 0) throw new LInfraRefused(problems);
  return {
    version: manifest.taskSetVersion,
    manifestSha256: sha256(manifestBytes),
    tasksSha256,
    tasks,
  };
}

export function specOf(task: LInfraTask): CalcSpec {
  return { fixtureSeed: task.fixtureSeed, ...task.intent };
}

export function lInfraRegistry(set: LInfraTaskSet): TaskRegistry {
  return buildRegistry(
    set.tasks.map((t) => ({
      id: t.taskId,
      family: "calc-record-edit",
      stateFile: "sheet.csv",
      spec: { ...specOf(t) },
    })),
  );
}

// ---------------------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------------------

export interface LInfraRow {
  readonly schema: typeof L_INFRA_ROW_SCHEMA;
  /** `trial`: an L-infra trial. `control`: the positive control (never in the event count). */
  readonly kind: "trial" | "control";
  readonly n: number;
  readonly runId: string;
  readonly taskId: string;
  /** SHA-256 of the fixture the harness laid down for this trial. */
  readonly fixtureSha256: string;
  readonly agent: string;
  readonly simulated: true;
  /** For a control row: what the trial did (`leaker` plants its canary, `victim` receives it). */
  readonly role: "trial" | "leaker" | "victim";
  readonly verdict: string | null;
  readonly disqualifiers: readonly string[];
  /** Run ids whose canaries were found in THIS trial. */
  readonly foreignMarkers: readonly string[];
  readonly ownMarkerSeen: boolean;
  readonly teardown: { readonly processesGone: boolean; readonly rootRemoved: boolean } | null;
  readonly isolation: IsolationReport | null;
  /** Start, relative to the level's pool start. */
  readonly startOffsetMs: number;
  readonly elapsedMs: number;
}

export interface LInfraLevel {
  readonly n: number;
  readonly admitted: boolean;
  /** Why the caps refused this level (empty when admitted). */
  readonly problems: readonly string[];
  readonly wallMs: number | null;
  readonly peakConcurrent: number | null;
}

export interface LInfraRun {
  readonly schema: typeof L_INFRA_RUN_SCHEMA;
  readonly simulated: true;
  readonly evidence: false;
  readonly costEstimate: null;
  readonly backend: string;
  readonly agent: string;
  readonly display: string;
  readonly requirements: IsolationRequirements;
  readonly host: { readonly cpus: number; readonly memoryMb: number; readonly platform: string };
  readonly taskSet: Omit<LInfraTaskSet, "tasks"> & { readonly satisfiable: number };
  readonly levelsPlanned: readonly number[];
  readonly levels: readonly LInfraLevel[];
  readonly control: {
    readonly n: number;
    readonly ran: boolean;
    readonly problems: readonly string[];
  };
  /** Where the run came from (CI provenance when set; null fields locally). */
  readonly provenance: {
    readonly commit: string | null;
    readonly runUrl: string | null;
    readonly workflow: string | null;
  };
  readonly startedAt: string;
}

function rowOf(
  t: TrialRecord,

  n: number,
  kind: LInfraRow["kind"],
  role: LInfraRow["role"],
  fixtureSha256: string,
  poolStart: number,
): LInfraRow {
  return {
    schema: L_INFRA_ROW_SCHEMA,
    kind,
    n,
    runId: t.runId,
    taskId: t.taskId,
    fixtureSha256,
    agent: t.agent,
    simulated: true,
    role,
    verdict: t.gate?.verdict ?? null,
    disqualifiers: [...t.disqualifiers],
    foreignMarkers: [...t.foreignMarkers].sort(),
    ownMarkerSeen: t.ownMarkerSeen,
    teardown: t.destroy
      ? { processesGone: t.destroy.processesGone, rootRemoved: t.destroy.rootRemoved }
      : null,
    isolation: t.isolation,
    startOffsetMs: Math.max(0, t.startedAt - poolStart),
    elapsedMs: t.elapsedMs,
  };
}

// ---------------------------------------------------------------------------------------
// the positive control
// ---------------------------------------------------------------------------------------

function barrier(n: number): () => Promise<void> {
  let waiting = 0;
  let release: () => void = () => {};
  const done = new Promise<void>((r) => {
    release = r;
  });
  return async () => {
    waiting++;
    if (waiting >= n) release();
    await done;
  };
}

async function honestSave(ctx: AgentContext): Promise<AgentRun> {
  const r = await ctx.desktop.exec("sh", ["-c", 'cat > "$1"', "sh", ctx.stateFile], {
    input: editedCsv(ctx.spec, "honest"),
  });
  if (r.code !== 0) throw new Error(`save failed (exit ${String(r.code)})`);
  const claim = claimFor(ctx.spec);
  await ctx.callGate(claim);
  return { claim, output: "" };
}

/**
 * Two trials at N = 2: the leaker writes its own canary (from its env, as any process in its
 * desktop could) into the victim's workspace while both run. The scan must flag the victim
 * `contaminated` and the leaker `leaked`. The file agent saves; no Calc is needed.
 */
export function controlPair(
  taskId: string,
  victimWorkspace: () => string,
): { leaker: ScriptedDesktopAgent; victim: ScriptedDesktopAgent } {
  const ready = barrier(2);
  const leaked = barrier(2);
  return {
    leaker: {
      id: "l-infra-control:leaker",
      simulated: true,
      async run(ctx) {
        await ready();
        const r = await ctx.desktop.exec("sh", [
          "-c",
          `printf %s "$${MARKER_ENV}" > "$1/leak.txt"`,
          "sh",
          victimWorkspace(),
        ]);
        await leaked();
        const out = await honestSave(ctx);
        return { ...out, output: `plant exit ${String(r.code)} (${taskId})` };
      },
    },
    victim: {
      id: "l-infra-control:victim",
      simulated: true,
      async run(ctx) {
        await ready();
        await leaked();
        return honestSave(ctx);
      },
    },
  };
}

// ---------------------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------------------

export interface LInfraOptions {
  readonly backend: DesktopBackend;
  readonly requirements: IsolationRequirements;
  readonly runRoot: string;
  readonly levels?: readonly number[];
  readonly taskSet?: LInfraTaskSet;
  /** The scripted agent every L-infra trial runs (honest: it does the task). */
  readonly agent: () => ScriptedDesktopAgent;
  readonly agentLabel: string;
  readonly caps: Omit<ResourceCapsInput, "maxConcurrent">;
  readonly provenance?: LInfraRun["provenance"];
  /** Called after each level (progress). */
  readonly onLevel?: (level: LInfraLevel) => void;
}

export const CONTROL_N = 2;

export async function runLInfra(
  opts: LInfraOptions,
): Promise<{ run: LInfraRun; rows: LInfraRow[] }> {
  const set = opts.taskSet ?? loadSatisfiableTasks();
  const tasks = lInfraRegistry(set);
  const generatedSha = (taskId: string): string => {
    const t = set.tasks.find((x) => x.taskId === taskId);
    return t ? sha256(generateFixture(t.fixtureSeed).csv) : "";
  };
  const levelsPlanned = opts.levels ?? L_INFRA_LEVELS;
  const startedAt = new Date().toISOString();
  const rows: LInfraRow[] = [];
  const levels: LInfraLevel[] = [];
  const poolOpts = (runRoot: string, n: number) => ({
    backend: opts.backend,
    caps: { ...opts.caps, maxConcurrent: n },
    requirements: opts.requirements,
    runRoot,
    tasks,
    oracleSources: CALC_ORACLE_SOURCES,
  });

  for (const n of levelsPlanned) {
    const caps = resolveCaps({ ...opts.caps, maxConcurrent: n });
    if (!caps.ok) {
      const level = {
        n,
        admitted: false,
        problems: [...caps.problems],
        wallMs: null,
        peakConcurrent: null,
      };
      levels.push(level);
      opts.onLevel?.(level);
      continue;
    }
    const t0 = Date.now();
    const report = await runPool(
      poolOpts(join(opts.runRoot, `n${n}`), n),
      set.tasks.map((t) => ({
        runId: `li-n${n}-${t.taskId}`,
        taskId: t.taskId,
        agent: opts.agent(),
      })),
    );
    for (const t of report.trials)
      rows.push(rowOf(t, n, "trial", "trial", generatedSha(t.taskId), t0));
    const level = {
      n,
      admitted: true,
      problems: [],
      wallMs: report.wallMs,
      peakConcurrent: report.peakConcurrent,
    };
    levels.push(level);
    opts.onLevel?.(level);
  }

  // The positive control.
  const first = set.tasks[0] as LInfraTask;
  const controlCaps = resolveCaps({ ...opts.caps, maxConcurrent: CONTROL_N });
  let controlRan = false;
  const controlProblems: string[] = controlCaps.ok ? [] : [...controlCaps.problems];
  if (controlCaps.ok) {
    let victimWs = "";
    const pair = controlPair(first.taskId, () => victimWs);
    const t0 = Date.now();
    const report = await runPool(
      {
        ...poolOpts(join(opts.runRoot, "control"), CONTROL_N),
        onDesktop: (runId, d) => {
          if (runId === "li-control-victim") victimWs = d.paths.workspace;
        },
      },
      [
        { runId: "li-control-leaker", taskId: first.taskId, agent: pair.leaker },
        { runId: "li-control-victim", taskId: first.taskId, agent: pair.victim },
      ],
    );
    controlRan = true;
    for (const t of report.trials)
      rows.push(
        rowOf(
          t,
          CONTROL_N,
          "control",
          t.runId === "li-control-leaker" ? "leaker" : "victim",
          generatedSha(t.taskId),
          t0,
        ),
      );
  }

  const run: LInfraRun = {
    schema: L_INFRA_RUN_SCHEMA,
    simulated: true,
    evidence: false,
    costEstimate: null,
    backend: opts.backend.id,
    agent: opts.agentLabel,
    display: opts.requirements.display,
    requirements: opts.requirements,
    host: {
      cpus: availableParallelism(),
      memoryMb: Math.floor(totalmem() / (1024 * 1024)),
      platform: process.platform,
    },
    taskSet: {
      version: set.version,
      manifestSha256: set.manifestSha256,
      tasksSha256: set.tasksSha256,
      satisfiable: set.tasks.length,
    },
    levelsPlanned: [...levelsPlanned],
    levels,
    control: { n: CONTROL_N, ran: controlRan, problems: controlProblems },
    provenance: opts.provenance ?? { commit: null, runUrl: null, workflow: null },
    startedAt,
  };
  return { run, rows };
}
