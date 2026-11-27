/**
 * TIF-268 - the `hcu+shell` head-to-head RUNNER: R2's other arm, over fc-v1's 30-task demo
 * subset, on the Claude subscription. CLI: `scripts/m2-hcu-shell-run.ts`. Runbook:
 * `docs/benchmark/hcu-shell-runbook.md`.
 *
 * What this module owns (the live VM wiring is `./live-vm.ts`, behind `TrialEnvironment`):
 *  - **The plan and its hash.** Everything that defines the arm (task ids, model, planner
 *    argv and environment, step budget, ceiling, snapshot, the guest helper's hash) is one
 *    canonical JSON object; `planSha256` is what the operator passes back, what the lead's GO
 *    names, and what a resume must match.
 *  - **A durable ledger** (`ledger.jsonl`, fsync'd appends): a header (plan hash, simulated or
 *    live), then per trial `start` and `decided` / `failed`, and a final `halt` or `abort`.
 *    Resume (`resume: true`) skips decided trials and refuses a ledger written for another
 *    plan or the other mode (simulated rows never enter a live run, or the reverse).
 *  - **Pacing, the myco-gate arm's (#598, `DEFAULT_PACING`).** One trial at a time, trial
 *    starts 90 s apart, a 1800 s deadline per trial attempt (reset, agent, capture), the host
 *    load gate (no attempt starts at host 1-minute load >= 10, `LOAD_GATE` of the M2 evidence
 *    rules) and a `PAUSE` file. A harness failure re-runs the trial in place, up to 3 attempts
 *    (then the trial is exhausted for this run directory), as #598's runner does.
 *  - **Stop rules.** A `PlannerHalt` (auth, billing, the subscription's usage limit, API-key
 *    path, model mismatch) or a non-cold reset boot (#546) halts the run at once with its code,
 *    spending no attempt. Two failed attempts in a row with the same fault signature (no
 *    decided trial between) abort it; the signature is persisted in the ledger and restored on
 *    `--resume` (round-2 verifier D2). A transient 429 / 529 / overloaded backs off (300 s,
 *    doubling to 3600 s) and re-runs the trial at most once per invocation, so it costs at most
 *    one extra cold reset per trial and never spends an attempt; then the run pauses.
 *  - **Watchdog files.** `progress.json` (status, pid, counts, the current trial, the last
 *    failure, the stop code) and `live-status.json` (#598's heartbeat shape) are replaced
 *    atomically on every event AND on a 60 s timer, so a hang is told from progress.
 *  - **The pack** (`exportHcuPack`): `arm.jsonl` and `requests.jsonl` for TIF-267's grader,
 *    keyed to fc-v1 by `armRowForTask` / `gradeRequestForTask` (#491), with the host-captured
 *    document bytes under `docs/` and the published fixtures under `fixtures/`. The runner
 *    computes NO verdict: ground truth is `scripts/benchmark-grade.ts` over `requests.jsonl`.
 *    Cost is the planner's token-derived estimate, null (never 0) when any call is unpriced.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CalcRecordEditParams } from "../../tasks/intent.ts";
import { OUTPUT_CEILING } from "../hcu-shell/decision.ts";
import {
  armRowForTask,
  gradeRequestForTask,
  type HcuShellArmRow,
  type PublishedTask,
} from "../hcu-shell/ledger.ts";
import {
  type HcuShellPlanner,
  type HcuShellRow,
  isHcuShellRow,
  type PreparedHcuShell,
  runHcuShellTrial,
  STEP_BUDGET,
} from "../hcu-shell/trial.ts";
import type { BaselineRow } from "../index.ts";
import {
  type CancellablePlanner,
  HCU_PLANNER_MODEL,
  PLANNER_ARGV,
  PLANNER_DIFFERENCES,
  PLANNER_FIXED_ENV,
  PlannerHalt,
  PlannerTransient,
} from "./planner.ts";

/**
 * The myco-gate arm's pacing (`DEFAULT_PACING` in `src/pilot/config.ts`, the values #598's
 * live runs use), matched field for field. It is not imported because `config.ts` loads
 * Myco's gate (`src/gate/mcp-server.ts`), which this arm must never reach
 * (`import-boundary.test.ts`); `runner.test.ts` asserts the two are equal.
 */
export interface HcuPacing {
  readonly concurrency: number;
  readonly interTrialDelayS: number;
  readonly rateLimitBackoffS: number;
  readonly rateLimitBackoffMaxS: number;
  readonly maxConsecutiveRateLimits: number;
  readonly trialTimeoutS: number;
  readonly maxAttemptsPerTrial: number;
}

export const HCU_PACING: HcuPacing = {
  concurrency: 1,
  interTrialDelayS: 90,
  rateLimitBackoffS: 300,
  rateLimitBackoffMaxS: 3600,
  maxConsecutiveRateLimits: 4,
  trialTimeoutS: 1800,
  maxAttemptsPerTrial: 3,
};

/** #598's `maxTransientRetriesPerTrial` on a live run: at most one extra cold reset per trial. */
export const MAX_TRANSIENT_RETRIES_PER_TRIAL = 1;
/** The M2 guest load gate (`LOAD_GATE` in `src/m2/evidence.ts`; a test asserts equality). */
export const LOAD_GATE = 10;
export const LOAD_GATE_POLL_S = 30;
/** Waiting longer than this for the load to fall pauses the run (resumable). */
export const LOAD_GATE_MAX_WAIT_S = 1800;
/** #598's heartbeat period (`heartbeatMs` default in `src/pilot/live-launch.ts`). */
export const HEARTBEAT_MS = 60_000;
/** The pilot runner's pause file name (`PAUSE_FILE` in `src/pilot/runner.ts`). */
export const PAUSE_FILE = "PAUSE";
export const LIVE_STATUS_FILE = "live-status.json";
export const LIVE_STATUS_SCHEMA = "myco.hcu-shell.live-status/1" as const;
export const HOST_CAPTURE_SCHEMA = "myco.hcu-shell.host-capture/1" as const;
const COST_LABEL = "token-derived estimate at frozen rates; not billed USD";

/** Canonical JSON (sorted keys), the same encoding the pilot hashes its plan with. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export const RUN_PLAN_SCHEMA = "myco.hcu-shell.run-plan/1" as const;
export const LEDGER_FILE = "ledger.jsonl";
export const PROGRESS_FILE = "progress.json";
export const TASK_BUNDLE = "benchmark/false-completion/fc-v1";
export const DEMO_TRIALS = 30;
/** The snapshot every trial resets to (`scripts/reset-trial-vm.sh` default, TIF-98). */
export const TRIAL_SNAPSHOT = "trial-base-v3";
/** The planner id on simulated rows: never a Claude model id, so `--evidence` refuses it. */
export const SIMULATED_PLANNER = "simulated:hcu-shell-dry-run";

/** One published fc-v1 task row (`myco.benchmark.task/1`), as the runner reads it. */
export interface FcTask extends PublishedTask {
  readonly family: string;
  readonly instruction: string;
  readonly fixtureSeed: string;
  readonly inDemo: boolean;
  readonly satisfiable: boolean;
  readonly persistedFormat: string;
}

export function loadFcV1(repoRoot: string): FcTask[] {
  return readFileSync(join(repoRoot, TASK_BUNDLE, "tasks.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l) as FcTask);
}

/** R2's paired set: fc-v1's demo subset, by task id. Exactly 30 or it throws. */
export function demoTasks(tasks: readonly FcTask[]): FcTask[] {
  const demo = tasks
    .filter((t) => t.taskSetVersion === "fc-v1" && t.inDemo)
    .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  if (demo.length !== DEMO_TRIALS)
    throw new Error(`fc-v1 has ${demo.length} demo tasks; R2 needs ${DEMO_TRIALS}`);
  return demo;
}

export interface HcuRunPlan {
  readonly schema: typeof RUN_PLAN_SCHEMA;
  readonly arm: "hcu+shell";
  readonly taskSetVersion: "fc-v1";
  readonly taskIds: readonly string[];
  readonly plannerModel: string;
  readonly plannerCommand: "claude";
  readonly plannerArgv: readonly string[];
  readonly plannerFixedEnv: Readonly<Record<string, string>>;
  readonly plannerDifferences: readonly string[];
  readonly billing: "claude-subscription; no API key path";
  readonly stepBudget: number;
  readonly outputCeiling: number;
  readonly snapshot: string;
  readonly hcuGuestCommand: string;
  readonly guestShellSha256: string;
  readonly faults: "recorded, not injected (as the myco-gate pilot runner)";
  readonly cost: "token-derived estimate at frozen rates; not billed USD";
  /** Live-run pacing (#598's `DEFAULT_PACING`); part of the plan, so the GO names it. */
  readonly pacing: HcuPacing;
  readonly maxTransientRetriesPerTrial: number;
  readonly loadGate: number;
}

export function hcuRunPlan(
  tasks: readonly FcTask[],
  guest: { readonly hcuGuestCommand: string; readonly guestShellSha256: string },
  pacing: HcuPacing = HCU_PACING,
): HcuRunPlan {
  return {
    schema: RUN_PLAN_SCHEMA,
    arm: "hcu+shell",
    taskSetVersion: "fc-v1",
    taskIds: tasks.map((t) => t.taskId),
    plannerModel: HCU_PLANNER_MODEL,
    plannerCommand: "claude",
    plannerArgv: PLANNER_ARGV,
    plannerFixedEnv: PLANNER_FIXED_ENV,
    plannerDifferences: PLANNER_DIFFERENCES,
    billing: "claude-subscription; no API key path",
    stepBudget: STEP_BUDGET,
    outputCeiling: OUTPUT_CEILING,
    snapshot: TRIAL_SNAPSHOT,
    hcuGuestCommand: guest.hcuGuestCommand,
    guestShellSha256: guest.guestShellSha256,
    faults: "recorded, not injected (as the myco-gate pilot runner)",
    cost: "token-derived estimate at frozen rates; not billed USD",
    pacing,
    maxTransientRetriesPerTrial: MAX_TRANSIENT_RETRIES_PER_TRIAL,
    loadGate: LOAD_GATE,
  };
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const planSha256 = (plan: HcuRunPlan) => sha256(canonicalJson(plan));

/** What one trial's environment hands the loop. */
export interface PreparedTrial {
  readonly prepared: PreparedHcuShell;
  /** The params the instruction is rendered from: the task's intent and fixture seed. */
  readonly params: CalcRecordEditParams;
  /** The arm's internal judge target (a stand-in cell for an unsatisfiable task). */
  readonly target: Pick<BaselineRow, "cellRef" | "expected" | "previousValue">;
  /** #546's boot class of this trial's reset; null when not measured. */
  readonly bootClass: "cold" | "fast" | null;
  /**
   * Where the harness seeded the document and what it read back before the agent ran (the
   * host-capture provenance, #598's `host-capture.json` fields). Null fields when unknown.
   */
  readonly capture?: { readonly guestPath: string | null; readonly seededSha256: string | null };
  /** Reap the guest after the trial (best effort). */
  release(): Promise<void>;
}

export interface TrialEnvironment {
  /** A simulated environment may only write simulated runs; a live one only live runs. */
  readonly simulated: boolean;
  prepare(task: FcTask, trialKey: string): Promise<PreparedTrial>;
}

export class HcuRunRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "HcuRunRefusal";
  }
}

export type HcuRunStatus = "running" | "complete" | "incomplete" | "halted" | "aborted" | "paused";

export interface HcuRunOptions {
  readonly outDir: string;
  readonly repoRoot: string;
  readonly tasks: readonly FcTask[];
  readonly plan: HcuRunPlan;
  readonly env: TrialEnvironment;
  readonly planner: CancellablePlanner;
  /** The model id the arm row records: `HCU_PLANNER_MODEL` live, `SIMULATED_PLANNER` simulated. */
  readonly plannerModelId: string;
  /** Continue an existing run directory (`--resume`); without it an existing ledger refuses. */
  readonly resume?: boolean;
  /** Stop after this many trials in this invocation (practice pause/resume). */
  readonly maxTrials?: number;
  readonly now?: () => number;
  /** Waits (pacing, back-off, the load gate). Default: a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The host's 1-minute load average. Default: `os.loadavg()[0]`. */
  readonly load1m?: () => number;
  /** The heartbeat period. Default `HEARTBEAT_MS`. */
  readonly heartbeatMs?: number;
  readonly log?: (line: string) => void;
}

export interface HcuRunResult {
  readonly status: Exclude<HcuRunStatus, "running">;
  readonly code: string | null;
  readonly decided: number;
  /** Failed attempts in this invocation (transient limits not counted). */
  readonly failed: number;
  readonly total: number;
  /** Trials that spent `maxAttemptsPerTrial` attempts: closed for this run directory. */
  readonly exhausted: readonly string[];
}

export const trialKeyFor = (task: FcTask, simulated: boolean) =>
  `${simulated ? "sim-" : ""}hcu-shell-${task.taskId}`;

type LedgerRecord =
  | { type: "header"; schema: typeof RUN_PLAN_SCHEMA; planSha256: string; simulated: boolean }
  | { type: "start"; trialKey: string; taskId: string; attempt?: number; at: number }
  | {
      type: "decided";
      trialKey: string;
      taskId: string;
      rowSha256: string;
      persistedSha256: string | null;
      bootClass: "cold" | "fast" | null;
      /** sha256 of `captures/<trialKey>.json`; null when nothing was captured. */
      hostCaptureSha256?: string | null;
      at: number;
    }
  | {
      type: "failed";
      trialKey: string;
      taskId: string;
      code: string;
      /**
       * The repeat-failure rule's identity of this fault (round-2 verifier D2), persisted so a
       * resumed run restores the rule. Absent on a transient limit, which the rule ignores.
       */
      signature?: string;
      /** A transient 429 / 529 / overloaded: backs off, spends no attempt, ignored by the rule. */
      transient?: true;
      at: number;
    }
  | { type: "halt"; code: string; trialKey: string | null; at: number }
  | { type: "abort"; code: string; trialKey: string; at: number }
  | { type: "pause"; code: string; trialKey: string | null; at: number };

/** Append one ledger line and fsync it: a decided trial survives a crash right after. */
function appendDurable(path: string, record: LedgerRecord): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readLedger(outDir: string): LedgerRecord[] {
  const path = join(outDir, LEDGER_FILE);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const out: LedgerRecord[] = [];
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as LedgerRecord);
    } catch {
      // A torn final line (crash mid-append) is dropped; anything earlier is corruption.
      if (i === lines.length - 1 || lines.slice(i + 1).every((l) => l.trim() === "")) continue;
      throw new HcuRunRefusal("ledger-corrupt", `${path} line ${i + 1} is not JSON`);
    }
  }
  return out;
}

/**
 * The repeat-failure signature a resumed run starts from (round-2 verifier D2; the lead's
 * 02:18Z ruling): the last counted failure in the ledger, unless a decided trial came after it.
 * Transient limits neither set nor clear it, nor do halts, aborts or pauses (as #598's
 * `resumeFaultSignature`).
 */
export function resumeFaultSignature(ledger: readonly LedgerRecord[]): string | null {
  let sig: string | null = null;
  for (const r of ledger) {
    if (r.type === "decided") sig = null;
    else if (r.type === "failed" && r.transient !== true) sig = r.signature ?? r.code;
  }
  return sig;
}

/** Counted (non-transient) failed attempts per task, from the ledger. */
export function attemptsSpent(ledger: readonly LedgerRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of ledger)
    if (r.type === "failed" && r.transient !== true) out.set(r.taskId, (out.get(r.taskId) ?? 0) + 1);
  return out;
}

export interface Progress {
  readonly schema: "myco.hcu-shell.progress/1";
  readonly status: HcuRunStatus;
  readonly code: string | null;
  readonly planSha256: string;
  readonly simulated: boolean;
  readonly pid: number;
  readonly updatedAt: string;
  readonly total: number;
  readonly decided: number;
  readonly failed: number;
  readonly current: string | null;
  readonly lastFailure: string | null;
}

/** Replace a JSON file atomically (write a sibling, then rename). */
function writeAtomic(path: string, body: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Replace `progress.json` atomically (write a sibling, then rename). */
export function writeProgress(outDir: string, progress: Progress): void {
  writeAtomic(join(outDir, PROGRESS_FILE), progress);
}

const CODE = /^[a-z][a-z0-9-]{0,63}$/;
/** The failure code of a trial-level error: its own `code` when it carries one, else generic. */
export function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODE.test(code) ? code : "trial-error";
}

/** How one attempt ended. */
type Outcome =
  | { readonly kind: "decided" }
  | { readonly kind: "halt"; readonly code: string }
  | { readonly kind: "transient" }
  | { readonly kind: "failed"; readonly code: string };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runHcuShell(opts: HcuRunOptions): Promise<HcuRunResult> {
  const outDir = resolve(opts.outDir);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const load1m = opts.load1m ?? (() => loadavg()[0] ?? 0);
  const simulated = opts.env.simulated;
  if (simulated !== opts.plannerModelId.startsWith("simulated:"))
    throw new HcuRunRefusal(
      "simulated-mismatch",
      "a simulated environment needs a simulated planner id, and a live one a real model id",
    );
  if (!simulated && opts.plannerModelId !== HCU_PLANNER_MODEL)
    throw new HcuRunRefusal("planner-model-mismatch", `live rows must use ${HCU_PLANNER_MODEL}`);
  const ids = opts.tasks.map((t) => t.taskId);
  if (canonicalJson(ids) !== canonicalJson(opts.plan.taskIds))
    throw new HcuRunRefusal("plan-tasks-mismatch", "the tasks are not the plan's tasks");
  const pacing = opts.plan.pacing;
  if (pacing.concurrency !== 1)
    throw new HcuRunRefusal("concurrency-not-one", "a VM run needs concurrency 1 (one trial VM)");
  const plan = planSha256(opts.plan);
  mkdirSync(join(outDir, "rows"), { recursive: true });
  mkdirSync(join(outDir, "docs"), { recursive: true });
  mkdirSync(join(outDir, "captures"), { recursive: true });
  const ledgerPath = join(outDir, LEDGER_FILE);
  const existing = readLedger(outDir);
  if (existing.length > 0 && opts.resume !== true)
    throw new HcuRunRefusal(
      "run-exists",
      `${ledgerPath} exists; pass --resume to continue it, or use a new --out`,
    );
  if (existing.length === 0 && opts.resume === true)
    throw new HcuRunRefusal("nothing-to-resume", `${ledgerPath} does not exist`);
  if (existing.length > 0) {
    const header = existing[0];
    if (header?.type !== "header")
      throw new HcuRunRefusal("ledger-corrupt", "the ledger has no header");
    if (header.planSha256 !== plan)
      throw new HcuRunRefusal("resume-plan-mismatch", "the ledger was written for another plan");
    if (header.simulated !== simulated)
      throw new HcuRunRefusal(
        "resume-mode-mismatch",
        "simulated and live trials never share a run directory",
      );
  } else
    appendDurable(ledgerPath, {
      type: "header",
      schema: RUN_PLAN_SCHEMA,
      planSha256: plan,
      simulated,
    });

  const decidedKeys = new Set(
    existing.filter((r) => r.type === "decided").map((r) => (r as { trialKey: string }).trialKey),
  );
  const spent = attemptsSpent(existing);
  const starts = new Map<string, number>();
  for (const r of existing) if (r.type === "start") starts.set(r.trialKey, (starts.get(r.trialKey) ?? 0) + 1);
  const exhausted: string[] = [];
  let failed = 0;
  // Seeded from the ledger, so the repeat rule survives --resume (round-2 verifier D2).
  let lastFailure: string | null = resumeFaultSignature(existing);
  let current: string | null = null;
  let lastLog: string | null = null;
  let state: HcuRunStatus = "running";
  let stopCode: string | null = null;
  const startedAt = new Date(now()).toISOString();
  const heartbeat = (extra: Record<string, unknown> = {}) => {
    const updatedAt = new Date(now()).toISOString();
    writeProgress(outDir, {
      schema: "myco.hcu-shell.progress/1",
      status: state,
      code: stopCode,
      planSha256: plan,
      simulated,
      pid: process.pid,
      updatedAt,
      total: opts.tasks.length,
      decided: decidedKeys.size,
      failed,
      current,
      lastFailure,
    });
    // #598's heartbeat shape (`src/pilot/live-launch.ts` `LiveStatus`), runner "hcu-shell".
    writeAtomic(join(outDir, LIVE_STATUS_FILE), {
      schema: LIVE_STATUS_SCHEMA,
      runner: "hcu-shell",
      pid: process.pid,
      startedAt,
      updatedAt,
      lastLog,
      costBasis: COST_LABEL,
      state: state === "running" ? "running" : "finished",
      ...(state === "running" ? {} : { status: state, code: stopCode }),
      ...extra,
    });
  };
  const log = (line: string) => {
    lastLog = line;
    heartbeat();
    opts.log?.(line);
  };
  const finish = (status: HcuRunResult["status"], code: string | null): HcuRunResult => {
    current = null;
    state = status;
    stopCode = code;
    heartbeat();
    return {
      status,
      code,
      decided: decidedKeys.size,
      failed,
      total: opts.tasks.length,
      exhausted,
    };
  };
  const pause = (code: string, trialKey: string | null, why: string): HcuRunResult => {
    appendDurable(ledgerPath, { type: "pause", code, trialKey, at: now() });
    log(`PAUSED (${code}): ${why}. Re-run the same command with --resume to continue.`);
    return finish("paused", code);
  };
  heartbeat();
  const timer = setInterval(() => heartbeat(), opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref?.();

  /** One attempt of one trial, under the trial deadline. Writes the row only if decided. */
  const runAttempt = async (task: FcTask, trialKey: string): Promise<Outcome> => {
    let fenced = false;
    let timedOut = false;
    let trial: PreparedTrial | undefined;
    // After the deadline the trial's planner refuses every further call, so an attempt that is
    // still unwinding in the background can never spend the subscription.
    const planner: HcuShellPlanner = {
      paid: opts.planner.paid,
      act(turn) {
        if (fenced)
          return Promise.reject(
            Object.assign(new Error("the trial deadline passed"), { code: "trial-timeout" }),
          );
        return opts.planner.act(turn);
      },
    };
    const body = async (): Promise<Outcome> => {
      trial = await opts.env.prepare(task, trialKey);
      if (timedOut) return { kind: "failed", code: "trial-timeout" };
      // #546's cold-boot guard: a live trial on anything but a recorded cold boot stops the run.
      if (!simulated && trial.bootClass !== "cold") {
        log(`HALTED: ${trialKey} reset boot class is ${String(trial.bootClass)}, not cold (#546)`);
        return { kind: "halt", code: "boot-class-not-cold" };
      }
      let captured: Uint8Array | null = null;
      const inner = trial.prepared;
      const prepared: PreparedHcuShell = {
        ...inner,
        async capturePersisted() {
          const doc = await inner.capturePersisted();
          captured = doc?.bytes ?? null;
          return doc;
        },
      };
      const row = await runHcuShellTrial(
        { index: opts.tasks.indexOf(task), params: trial.params, ...trial.target },
        prepared,
        planner,
      );
      // Everything below is synchronous: the deadline cannot fire between this check and the
      // decided line, so a timed-out attempt never writes a row.
      if (timedOut) return { kind: "failed", code: "trial-timeout" };
      if (!isHcuShellRow(row))
        throw new HcuRunRefusal("row-invalid", "the trial row did not validate");
      // Refuses a trial that did not run the published task (fixture, instruction, intent).
      armRowForTask(row, task, { trialKey, plannerModelId: opts.plannerModelId });
      const rowJson = `${JSON.stringify(row)}\n`;
      writeFileSync(join(outDir, "rows", `${trialKey}.json`), rowJson);
      let hostCaptureSha256: string | null = null;
      const bytes = captured as Uint8Array | null;
      if (bytes !== null && row.persistedSha256 !== null) {
        writeFileSync(join(outDir, "docs", `${trialKey}.${row.persistedFormat ?? "xlsx"}`), bytes);
        const provenance = `${JSON.stringify({
          schema: HOST_CAPTURE_SCHEMA,
          trialKey,
          source: "host read of the guest file the harness created (in-guest agent read_file)",
          guestPath: trial.capture?.guestPath ?? null,
          persistedSha256: row.persistedSha256,
          persistedBytes: bytes.length,
          seededSha256: trial.capture?.seededSha256 ?? null,
          resetBootClass: trial.bootClass,
          capturedAt: new Date(now()).toISOString(),
        })}\n`;
        writeFileSync(join(outDir, "captures", `${trialKey}.json`), provenance);
        hostCaptureSha256 = sha256(provenance);
      }
      appendDurable(ledgerPath, {
        type: "decided",
        trialKey,
        taskId: task.taskId,
        rowSha256: sha256(rowJson),
        persistedSha256: row.persistedSha256,
        bootClass: trial.bootClass,
        hostCaptureSha256,
        at: now(),
      });
      decidedKeys.add(trialKey);
      log(`trial ${trialKey}: decided (claim ${row.claimedDone ? "done" : "not done"})`);
      return { kind: "decided" };
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const attempt = body();
    try {
      const raced = await Promise.race([
        attempt.then(
          (outcome) => ({ outcome }),
          (error: unknown) => ({ error }),
        ),
        new Promise<"timeout">((r) => {
          deadline = setTimeout(() => r("timeout"), pacing.trialTimeoutS * 1000);
        }),
      ]);
      if (raced === "timeout") {
        timedOut = true;
        fenced = true;
        opts.planner.cancel?.();
        // The attempt unwinds in the background; its guest is released when it gets one.
        attempt
          .catch(() => undefined)
          .then(() => trial?.release())
          .catch(() => undefined);
        log(`trial ${trialKey}: deadline of ${pacing.trialTimeoutS}s passed`);
        return { kind: "failed", code: "trial-timeout" };
      }
      if ("outcome" in raced) return raced.outcome;
      const error = raced.error;
      if (error instanceof PlannerHalt) return { kind: "halt", code: error.code };
      if (error instanceof PlannerTransient) return { kind: "transient" };
      return { kind: "failed", code: failureCode(error) };
    } finally {
      clearTimeout(deadline);
      if (!timedOut)
        try {
          await trial?.release();
        } catch {
          log(`trial ${trialKey}: guest release failed (the next reset clears it)`);
        }
    }
  };

  try {
    let ran = 0;
    let nextStartAt = 0;
    let consecutiveRateLimits = 0;
    for (const task of opts.tasks) {
      const trialKey = trialKeyFor(task, simulated);
      if (decidedKeys.has(trialKey)) continue;
      if ((spent.get(task.taskId) ?? 0) >= pacing.maxAttemptsPerTrial) {
        exhausted.push(task.taskId);
        continue;
      }
      if (opts.maxTrials !== undefined && ran >= opts.maxTrials) break;
      ran++;
      let transient = 0;
      for (;;) {
        // Gates before every attempt: the pause file, the spacing, the host load gate.
        if (existsSync(join(outDir, PAUSE_FILE)))
          return pause("pause-file", null, `${PAUSE_FILE} file present; remove it`);
        const wait = nextStartAt - now();
        if (wait > 0) await sleep(wait);
        if (!simulated) {
          let waitedS = 0;
          while (load1m() >= LOAD_GATE) {
            if (waitedS >= LOAD_GATE_MAX_WAIT_S)
              return pause(
                "host-load-high",
                null,
                `host 1-minute load stayed >= ${LOAD_GATE} for ${LOAD_GATE_MAX_WAIT_S}s`,
              );
            log(`waiting: host 1-minute load >= ${LOAD_GATE} (guest load gate)`);
            await sleep(LOAD_GATE_POLL_S * 1000);
            waitedS += LOAD_GATE_POLL_S;
          }
        }
        if (!simulated) nextStartAt = now() + pacing.interTrialDelayS * 1000;
        const attemptNo = (starts.get(trialKey) ?? 0) + 1;
        starts.set(trialKey, attemptNo);
        current = trialKey;
        appendDurable(ledgerPath, {
          type: "start",
          trialKey,
          taskId: task.taskId,
          attempt: attemptNo,
          at: now(),
        });
        log(`trial ${trialKey}: start (attempt ${attemptNo})`);
        const outcome = await runAttempt(task, trialKey);
        if (outcome.kind === "decided") {
          lastFailure = null;
          consecutiveRateLimits = 0;
          break;
        }
        if (outcome.kind === "halt") {
          // No retry, no attempt spent: the operator (and, for a usage limit, the lead) decides.
          appendDurable(ledgerPath, { type: "halt", code: outcome.code, trialKey, at: now() });
          log(`HALTED: ${outcome.code} on ${trialKey}; no retry. Fix the cause, then --resume.`);
          return finish("halted", outcome.code);
        }
        if (outcome.kind === "transient") {
          appendDurable(ledgerPath, {
            type: "failed",
            trialKey,
            taskId: task.taskId,
            code: "planner-rate-limit",
            transient: true,
            at: now(),
          });
          consecutiveRateLimits++;
          transient++;
          const cap = simulated ? Number.POSITIVE_INFINITY : opts.plan.maxTransientRetriesPerTrial;
          if (transient > cap)
            return pause(
              "rate-limit-repeat",
              trialKey,
              `a transient rate limit hit ${task.taskId} again after its re-run; no further cold reset this run`,
            );
          if (consecutiveRateLimits >= pacing.maxConsecutiveRateLimits)
            return pause(
              "rate-limit-pause",
              trialKey,
              `${consecutiveRateLimits} transient rate limits in a row`,
            );
          const backoffS = Math.min(
            pacing.rateLimitBackoffS * 2 ** (consecutiveRateLimits - 1),
            pacing.rateLimitBackoffMaxS,
          );
          nextStartAt = Math.max(nextStartAt, now() + backoffS * 1000);
          log(`trial ${trialKey}: transient rate limit; backing off ${backoffS}s, then re-running`);
          continue;
        }
        const code = outcome.code;
        failed++;
        spent.set(task.taskId, (spent.get(task.taskId) ?? 0) + 1);
        appendDurable(ledgerPath, {
          type: "failed",
          trialKey,
          taskId: task.taskId,
          code,
          signature: code,
          at: now(),
        });
        log(`trial ${trialKey}: failed (${code})`);
        if (code === lastFailure) {
          lastFailure = code;
          appendDurable(ledgerPath, { type: "abort", code, trialKey, at: now() });
          log(`ABORTED: two failures in a row with ${code}; no retry. Fix the cause, then --resume.`);
          return finish("aborted", code);
        }
        lastFailure = code;
        if ((spent.get(task.taskId) ?? 0) >= pacing.maxAttemptsPerTrial) {
          exhausted.push(task.taskId);
          log(`trial ${trialKey}: exhausted after ${pacing.maxAttemptsPerTrial} attempts`);
          break;
        }
      }
    }
    const complete = opts.tasks.every((t) => decidedKeys.has(trialKeyFor(t, simulated)));
    return finish(complete ? "complete" : "incomplete", null);
  } finally {
    clearInterval(timer);
  }
}

/** #598's CLI exit codes (`EXIT` in `src/pilot/live-launch.ts`), plus 1 failed and 2 usage. */
export const EXIT = {
  complete: 0,
  refused: 3,
  paused: 4,
  subscriptionStop: 5,
  repeatFailure: 6,
  usageLimit: 7,
} as const;

/** Halts that are a fail-closed stop on the subscription (exit 5, as #598's auth/billing/api-key). */
export const SUBSCRIPTION_STOP_CODES: ReadonlySet<string> = new Set([
  "planner-auth",
  "planner-billing",
  "planner-api-key-path",
  "planner-auth-source-unknown",
  "planner-model-mismatch",
  "planner-fault-unknown",
]);

/** What the operator sees on a usage-limit stop, besides exit 7 (#598's `USAGE_LIMIT_REPORT`). */
export const USAGE_LIMIT_REPORT =
  "USAGE LIMIT: the subscription's usage limit stopped the run (exit 7; no retry, no attempt spent). This must go to the lead: do not resume until the lead decides.";

/** The CLI exit code for a run result. */
export function exitCodeFor(r: Pick<HcuRunResult, "status" | "code">): number {
  if (r.status === "halted" && r.code === "planner-usage-limit") return EXIT.usageLimit;
  if (r.status === "halted" && r.code !== null && SUBSCRIPTION_STOP_CODES.has(r.code))
    return EXIT.subscriptionStop;
  if (r.status === "aborted") return EXIT.repeatFailure;
  return r.status === "complete" ? EXIT.complete : EXIT.paused;
}

export interface HcuPack {
  readonly armRows: number;
  readonly requests: number;
  readonly simulated: boolean;
  readonly unmeasuredCost: number;
}

/** A row's cost is measured only when every planner call priced its tokens (R7: never 0). */
export function rowCostMeasured(row: HcuShellRow): boolean {
  return row.usage.length > 0 && row.usage.every((u) => typeof u.cost === "number");
}

/**
 * Build the grader's input from the decided trials: `arm.jsonl` + `requests.jsonl` (sorted by
 * task id), `fixtures/` copied from the published bundle. Every row is re-checked from disk:
 * its hash against the ledger, `isHcuShellRow`, the captured bytes against the row's hash,
 * and task parity (`armRowForTask`). Any mismatch throws; nothing partial is written.
 */
export function exportHcuPack(outDir: string, repoRoot: string, tasks: readonly FcTask[]): HcuPack {
  const dir = resolve(outDir);
  const ledger = readLedger(dir);
  const header = ledger[0];
  if (header?.type !== "header") throw new HcuRunRefusal("ledger-corrupt", "no ledger header");
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const decided = new Map<string, Extract<LedgerRecord, { type: "decided" }>>();
  for (const r of ledger) if (r.type === "decided") decided.set(r.trialKey, r);
  const armRows: HcuShellArmRow[] = [];
  const requests: ReturnType<typeof gradeRequestForTask>[] = [];
  const fixtures = new Set<string>();
  let unmeasured = 0;
  for (const rec of [...decided.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1))) {
    const task = byId.get(rec.taskId);
    if (task === undefined) throw new HcuRunRefusal("unknown-task", rec.taskId);
    const text = readFileSync(join(dir, "rows", `${rec.trialKey}.json`), "utf8");
    if (sha256(text) !== rec.rowSha256)
      throw new HcuRunRefusal("row-tampered", `${rec.trialKey}: row differs from the ledger`);
    const row = JSON.parse(text) as unknown;
    if (!isHcuShellRow(row)) throw new HcuRunRefusal("row-invalid", rec.trialKey);
    let persistedFile: string | null = null;
    if (row.persistedSha256 !== null) {
      persistedFile = `docs/${rec.trialKey}.${row.persistedFormat ?? "xlsx"}`;
      if (sha256(readFileSync(join(dir, persistedFile))) !== row.persistedSha256)
        throw new HcuRunRefusal("document-tampered", `${rec.trialKey}: captured bytes changed`);
      // The host-capture provenance must be the one the ledger recorded, for these bytes.
      const capturePath = join(dir, "captures", `${rec.trialKey}.json`);
      const capture = existsSync(capturePath) ? readFileSync(capturePath, "utf8") : null;
      if (
        capture === null ||
        sha256(capture) !== rec.hostCaptureSha256 ||
        (JSON.parse(capture) as { persistedSha256?: unknown }).persistedSha256 !==
          row.persistedSha256
      )
        throw new HcuRunRefusal(
          "capture-provenance-mismatch",
          `${rec.trialKey}: captures/${rec.trialKey}.json is missing or differs from the ledger`,
        );
    }
    const plannerModelId = header.simulated ? SIMULATED_PLANNER : HCU_PLANNER_MODEL;
    const arm = armRowForTask(row, task, { trialKey: rec.trialKey, plannerModelId });
    const measured = rowCostMeasured(row);
    if (!measured) unmeasured++;
    armRows.push(measured ? arm : { ...arm, cost: { ...arm.cost, modelUsd: null } });
    requests.push(gradeRequestForTask(row, task, { trialKey: rec.trialKey, persistedFile }));
    fixtures.add(task.fixtureFile);
  }
  for (const f of fixtures) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(repoRoot, TASK_BUNDLE, f), join(dir, f));
  }
  const jsonl = (rows: readonly unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");
  writeFileSync(join(dir, "arm.jsonl"), jsonl(armRows));
  writeFileSync(join(dir, "requests.jsonl"), jsonl(requests));
  return {
    armRows: armRows.length,
    requests: requests.length,
    simulated: header.simulated,
    unmeasuredCost: unmeasured,
  };
}

/**
 * Summary for `status`. Counts and the cost ESTIMATE only: no success or false-done rate,
 * because ground truth comes only from the independent grader over the exported pack.
 */
export function hcuStatus(outDir: string): Record<string, unknown> {
  const dir = resolve(outDir);
  const ledger = readLedger(dir);
  const progressPath = join(dir, PROGRESS_FILE);
  const progress = existsSync(progressPath)
    ? (JSON.parse(readFileSync(progressPath, "utf8")) as unknown)
    : null;
  const decided = ledger.filter((r) => r.type === "decided") as Extract<
    LedgerRecord,
    { type: "decided" }
  >[];
  let total: number | null = 0;
  for (const d of decided) {
    const row = JSON.parse(
      readFileSync(join(dir, "rows", `${d.trialKey}.json`), "utf8"),
    ) as HcuShellRow;
    total = total === null || !rowCostMeasured(row) ? null : total + row.cost;
  }
  return {
    progress,
    decided: decided.length,
    failedAttempts: ledger.filter((r) => r.type === "failed").length,
    stop: ledger.filter((r) => r.type === "halt" || r.type === "abort").at(-1) ?? null,
    cost: {
      basis: "token-derived estimate at frozen rates; not billed USD",
      estimatedModelUsd: decided.length === 0 ? null : total,
    },
    groundTruth:
      "not computed here: run scripts/benchmark-grade.ts on the exported requests.jsonl, then scripts/benchmark-check.ts",
  };
}
