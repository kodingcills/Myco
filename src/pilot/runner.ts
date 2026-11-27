/**
 * The 30-trial R1 pilot runner. One entry point for the simulated dry run and the later live
 * pilot: the only difference is the driver (the transport factory) and the planner label.
 *
 * Per trial attempt, in order (each step fails closed):
 *  1. Build the launch plan from the reviewed config and audit it (`auditAgentLaunch`). A
 *     refused plan stops the whole run before any attempt is recorded: a wrong config is not a
 *     harness fault to retry.
 *  2. Append the attempt's `start` line to the ledger.
 *  3. Run the trial through the existing gated harness (`runGatedTrial`: seal, launch with
 *     the frozen audited plan, stop, capture, the harness's own post-stop check), or, for a
 *     task the gate registry rejects, run the agent and record it `unregistrable`.
 *  4. Map it to the arm row with `gatedArmRow` (all its binding checks) and append the `end`.
 *
 * Retries: never for an agent-side outcome. Any attempt that reached the gate's post-stop
 * check (any verdict), or is unregistrable, is final. Only a `HarnessFault` thrown by the
 * transport before a decision (rate limit, lost login, unclassified error result, timeout,
 * spawn failure, transport error) is re-run, in place, as the next attempt of the same trial, linked by `supersedes`; the faulted
 * attempt stays in the ledger with its arm row (cause `harness`) and its cost estimate, which
 * counts toward R7. Any other exception is a harness bug: the run stops and the open `start`
 * is closed as a `crash` on the next resume.
 *
 * Pacing: at most `concurrency` trials in flight; trial starts are spaced by
 * `interTrialDelayS` across all workers; a rate-limit fault holds every worker for the backoff,
 * and after `maxConsecutiveRateLimits` in a row the run pauses (exit, resumable). An `auth`
 * fault (lost login), a `billing` fault (credit, billing or quota) and an `ApiKeyPathFault`
 * stop the run at once with a `stopCode` (fail closed, no retry loop). None of these spends
 * the trial's `maxAttemptsPerTrial` budget (`BUDGET_EXEMPT_CLASSES`), so a resume re-runs the
 * trial. The subscription's usage quota (class `usage-limit`) stops the run at once with its
 * own code, for the lead (PR #598 round 2, D3); only a transient rate limit (429 / 529 /
 * overloaded) backs off, and on a live run a trial re-runs after at most one of them per
 * invocation (`maxTransientRetriesPerTrial`), so a limit spell costs at most one extra cold
 * reset per trial. On a live run, two identical harness faults in a row (same class and
 * message, no decided trial between) stop it too (`stopCode` `repeat-failure`,
 * `abortOnRepeatedFailure`); the last fault's message is in the ledger (`faultMessage`), so the
 * rule holds across `--resume`.
 *
 * A live (non-simulated) driver also needs `liveLaunchSha256` equal to the config's sha256:
 * the same explicit acknowledgement the CLI demands, enforced here so no caller can start a
 * real trial by calling `runPilot` directly. A `PAUSE` file in the
 * run directory, or `requestStop()`, stops new starts after in-flight trials finish.
 *
 * Corrections A/B mode (`src/pilot/ab.ts`) uses the same runner through optional hooks, all
 * absent for the R1 pilot: a trial-key prefix, a chunk of task ids to run this invocation
 * (`only`), the #518 attempt ledger (`attemptSink`), an experiment label on every arm row,
 * extra PAUSE files, and `afterDecided`, called after each decided trial before the next
 * start: a non-null reason HALTS the whole run (status `halted`; the gate-miss rule). The
 * config's `corrections` key turns the gate's corrections on for the harness's own check.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BenchmarkArmRow } from "../benchmark/check.ts";
import { gatedArmRow, gateEntryFor, registerTask } from "../benchmark/gated-rows.ts";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import type { Gate } from "../gate/gate.ts";
import { GATE_SERVER_CLASS, runGatedTrial } from "../gate/gated-trial.ts";
import { type AgentLaunchPlan, auditAgentLaunch } from "../integrity/launch.ts";
import type { CaptureInput } from "../integrity/vault.ts";
import { newVaultKey, VerdictVault } from "../integrity/vault.ts";
import { AB_EXPERIMENT, loadPrereg, realRunRefusals } from "./ab-prereg.ts";
import { backoffS, configSha256, correctionPolicy, type PilotConfig } from "./config.ts";
import { estimateCost, type TokenUsage } from "./cost.ts";
import { trialLaunchPlan } from "./launch.ts";
import {
  AttemptLedger,
  type AttemptRecord,
  faultSignature,
  loadLedger,
  type PilotHarnessClass,
  PROGRESS_FILE,
  resumeFaultSignature,
  taskStatus,
} from "./ledger.ts";

/**
 * Why a run stopped fail-closed, with no retry loop (TIF-274 live driver). `auth`: the CLI's
 * login is lost or refused; `billing`: a credit, billing or quota error; `api-key`: the CLI
 * would bill an API key instead of the subscription; `repeat-failure`: two identical harness
 * failures in a row; `usage-limit`: the subscription's own usage quota ("usage limit reached",
 * "5-hour limit", "Weekly limit reached", "resets at ..."), which goes to the lead (lead ruling,
 * PR #598 round 2, D3). The CLIs exit 5 for the first three, 6 for `repeat-failure` and 7 for
 * `usage-limit`.
 */
export type StopCode = "auth" | "billing" | "api-key" | "repeat-failure" | "usage-limit";

/** A fault of the harness, not the agent: the only kind of attempt that is ever re-run. */
export class HarnessFault extends Error {
  readonly harnessClass: PilotHarnessClass;
  /** Tokens the agent used before the fault, when the transport measured them. */
  readonly usage: TokenUsage | null;
  constructor(harnessClass: PilotHarnessClass, message: string, usage: TokenUsage | null = null) {
    super(message);
    this.name = "HarnessFault";
    this.harnessClass = harnessClass;
    this.usage = usage;
  }
}

/**
 * The CLI ran (or would run) on an API key instead of the operator's subscription. Recorded as
 * an `auth` fault, and it stops the run at once with code `api-key`: never retried, never an
 * agent outcome.
 */
export class ApiKeyPathFault extends HarnessFault {
  constructor(message: string, usage: TokenUsage | null = null) {
    super("auth", message, usage);
    this.name = "ApiKeyPathFault";
  }
}

/** The fail-closed stop a fault demands, or null when the fault is re-run in place. */
export function stopCodeOf(fault: HarnessFault): Exclude<StopCode, "repeat-failure"> | null {
  if (fault instanceof ApiKeyPathFault) return "api-key";
  if (fault.harnessClass === "auth") return "auth";
  if (fault.harnessClass === "billing") return "billing";
  if (fault.harnessClass === "usage-limit") return "usage-limit";
  return null;
}

export interface AttemptContext {
  readonly task: BenchmarkTask;
  readonly runId: string;
  readonly trialKey: string;
  /** Absolute; the transport writes `mcp.json` here and keeps its transcript here. */
  readonly trialDir: string;
  /** Stop the agent and throw `HarnessFault("timeout")` once this signal aborts. */
  readonly signal: AbortSignal;
}

export interface AgentReport {
  /** The agent's final claim, read from its transcript by the harness. */
  readonly claim: "done" | "not-done" | "no-claim";
  readonly usage: TokenUsage | null;
  /**
   * The trial reset's boot class, as #546's cold-boot guard measures it (`cold`: a full cold
   * boot; `fast`: the first start after a UTM config write). Absent when the transport does
   * not measure it (the pilot). The corrections A/B records it for every decided trial.
   */
  readonly resetBootClass?: "cold" | "fast";
}

/**
 * One attempt's transport. `runAgent` resolves only after the agent process and its servers
 * exited, or throws `HarnessFault`. `gate` is null for an unregistrable task.
 */
export interface PilotTransport {
  runAgent(plan: AgentLaunchPlan, gate: Gate | null): Promise<void>;
  captureAfterStop(): Promise<CaptureInput>;
  report(): AgentReport;
}

export interface PilotDriver {
  /** `simulated` drivers may only write simulated runs, live drivers only live ones. */
  readonly simulated: boolean;
  transport(ctx: AttemptContext): PilotTransport;
}

/**
 * #518's attempt ledger, as the runner sees it (`src/pilot/ab.ts` wraps
 * `AttemptLedgerWriter` and its host-side anchor). Every attempt start and end is written
 * through it as the attempt runs; `recoverCrash` closes an attempt the runner died in.
 */
export interface AttemptSink {
  start(a: { readonly trialKey: string; readonly taskId: string }): void;
  end(
    trialKey: string,
    result: { outcome: "completed" } | { outcome: "harness-fault"; harnessClass: string },
  ): void;
  recoverCrash(a: { readonly trialKey: string; readonly taskId: string }): void;
}

/** What `afterDecided` sees: one decided trial, after its ledger end was appended. */
export interface DecidedTrial {
  readonly task: BenchmarkTask;
  readonly trialKey: string;
  readonly armRow: BenchmarkArmRow;
  /** The captured persisted bytes the gate decided on, or null if none were captured. */
  readonly persisted: Uint8Array | null;
  readonly report: AgentReport;
}

export interface PilotRunOptions {
  readonly config: PilotConfig;
  /** The published task set (the pilot's tasks are looked up in it by id). */
  readonly published: readonly BenchmarkTask[];
  readonly outDir: string;
  readonly repoRoot: string;
  readonly oracleSources: readonly string[];
  readonly driver: PilotDriver;
  /** The arm rows' planner: a `simulated:` label for a dry run, the model id for a live run. */
  readonly plannerModelId: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Required for a live driver: the `configSha256` of the plan the operator approved. */
  readonly liveLaunchSha256?: string;
  /** Trial keys are `<prefix>-<taskId>-a<n>`. Default `r1p`. */
  readonly trialKeyPrefix?: string;
  /** Run only these trials this invocation, in this order (an A/B chunk). Default: all. */
  readonly only?: readonly string[];
  /** #518's attempt ledger. Absent for the R1 pilot (it writes its own progress file only). */
  readonly attemptSink?: AttemptSink;
  /** Merged into every arm row the runner writes (the A/B's experiment-only label). */
  readonly armRowLabel?: Pick<BenchmarkArmRow, "experiment">;
  /** More PAUSE files honoured like `<outDir>/PAUSE`. */
  readonly pauseFiles?: readonly string[];
  /**
   * Called after each decided trial, before the worker takes another: a non-null return
   * halts the whole run (no new starts; status `halted`). A throw is a harness bug (fatal).
   */
  readonly afterDecided?: (d: DecidedTrial) => string | null;
  /**
   * Stop the run (code `repeat-failure`) when two harness faults in a row, with no decided
   * trial between them, have the same class and message: the same failure twice is not going
   * to clear by itself, and a third attempt only spends subscription time. Rate limits are
   * excluded (they have their own back-off and pause), as are the immediate stops (`auth`,
   * `billing`, `api-key`). Default: on for a live driver, off for a simulated one.
   */
  readonly abortOnRepeatedFailure?: boolean;
  /**
   * Transient rate-limit faults (HTTP 429 / 529, "overloaded") one trial may re-run after in
   * this invocation, each after the bounded back-off. Every re-run is a fresh attempt and so a
   * fresh cold VM reset; the next transient fault on the same trial pauses the run (resumable)
   * instead of resetting again (lead ruling, PR #598 round 2, D3: at most one extra cold reset
   * per trial). Default: 1 for a live driver; unbounded for a simulated one (no VM, the
   * dry-run's pacing semantics as reviewed). Never spends the trial's attempt budget.
   */
  readonly maxTransientRetriesPerTrial?: number;
}

export interface PilotRunResult {
  /** `halted`: `afterDecided` stopped the run (the A/B's gate-miss rule). */
  readonly status: "complete" | "paused" | "incomplete" | "halted";
  readonly reason: string | null;
  /** Trials decided by this invocation and skipped as already recorded. */
  readonly ran: number;
  readonly skipped: number;
  readonly faulted: number;
  readonly exhausted: readonly string[];
  /** Set when the run stopped fail-closed (status `paused`); null otherwise. */
  readonly stopCode: StopCode | null;
}

export const SIMULATED_PLANNER_PREFIX = "simulated:";
export const PAUSE_FILE = "PAUSE";
export const LOCK_FILE = "pilot.lock";
export const SIMULATED_FILE = "SIMULATED";

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the run directory's lock with an exclusive create (`O_EXCL`, flag `wx`), so two runners
 * started at the same instant cannot both hold it. A lock left by a dead runner is removed and
 * the exclusive create retried once; a lock held by a live process is refused.
 * `beforeCreate` is a test seam: it runs just before each create attempt.
 */
export function acquireLock(outDir: string, beforeCreate?: () => void): () => void {
  const path = join(outDir, LOCK_FILE);
  for (let attempt = 0; ; attempt++) {
    beforeCreate?.();
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let pid = Number.NaN;
    try {
      pid = Number(readFileSync(path, "utf8").trim());
    } catch {
      // Removed between the create and the read: retry the create.
    }
    if (pidAlive(pid))
      throw new Error(`${path}: another pilot runner (pid ${pid}) holds this run directory`);
    if (attempt >= 1) throw new Error(`${path}: could not take the run directory's lock`);
    rmSync(path, { force: true }); // A dead runner's stale lock.
  }
}

/** The arm row for an attempt lost to a harness fault: no claim, no gate, cause harness. */
export function harnessFaultRow(
  task: BenchmarkTask,
  trialKey: string,
  plannerModelId: string,
  harnessClass: PilotHarnessClass,
  cost: BenchmarkArmRow["cost"],
): BenchmarkArmRow {
  return {
    schema: "myco.benchmark.arm-row/1",
    taskSetVersion: task.taskSetVersion,
    arm: "myco-gate",
    trialKey,
    taskId: task.taskId,
    faultClass: task.faultClass,
    fixtureSha256: task.fixtureSha256,
    instructionSha256: task.instructionSha256,
    plannerModelId,
    outputCeiling: null,
    claim: "no-claim",
    gate: { called: false, verdict: null },
    accepted: false,
    persistedSha256: null,
    cause: { kind: "harness", detail: `harness fault: ${harnessClass}` },
    cost,
  };
}

export async function runPilot(opts: PilotRunOptions): Promise<PilotRunResult> {
  const { config, driver } = opts;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const outDir = resolve(opts.outDir);
  const simulated = opts.plannerModelId.startsWith(SIMULATED_PLANNER_PREFIX);
  if (simulated !== driver.simulated)
    throw new Error(
      simulated
        ? "a simulated planner label needs a simulated driver"
        : "a live driver needs a real model id as the planner, and a simulated driver a simulated: label",
    );
  if (!simulated && opts.plannerModelId !== config.model)
    throw new Error(`planner ${opts.plannerModelId} is not the config's model ${config.model}`);
  if (!simulated && opts.liveLaunchSha256 !== configSha256(config))
    throw new Error(
      "a live pilot run needs liveLaunchSha256 equal to the approved plan's configSha256 (the CLI's --plan-sha256)",
    );
  // A live A/B arm (any config carrying corrections or an experiment) is a real A/B trial:
  // the A/B's real-run preconditions are re-checked here from the committed files, so a
  // caller that hands `runPilot` an arm config and its own sha256 still cannot start one.
  if (!simulated && (config.experiment !== undefined || config.corrections !== undefined)) {
    const problems = liveExperimentRefusals(config, opts.repoRoot, opts.published);
    if (problems.length > 0)
      throw new Error(`refusing a live corrections A/B trial: ${problems.join("; ")}`);
  }
  if (/docs[\\/]research[\\/]experiments/.test(outDir))
    throw new Error(
      "a pilot run directory is never under docs/research/experiments (evidence packs are assembled there by review, not written by the runner)",
    );

  const byId = new Map(opts.published.map((t) => [t.taskId, t]));
  const tasks = config.trials.map((id) => {
    const t = byId.get(id);
    if (t === undefined) throw new Error(`pilot task ${id} is not in the published task set`);
    return t;
  });
  const prefix = opts.trialKeyPrefix ?? "r1p";
  if (!/^[a-z0-9-]{1,32}$/.test(prefix)) throw new Error(`bad trial-key prefix ${prefix}`);
  const label = (row: BenchmarkArmRow): BenchmarkArmRow =>
    opts.armRowLabel === undefined ? row : { ...row, ...opts.armRowLabel };
  const inConfig = new Set(config.trials);
  for (const id of opts.only ?? [])
    if (!inConfig.has(id)) throw new Error(`chunk task ${id} is not one of the config's trials`);
  const runnable =
    opts.only === undefined ? tasks : opts.only.map((id) => byId.get(id) as BenchmarkTask);
  const policy = correctionPolicy(config);

  mkdirSync(join(outDir, "trials"), { recursive: true });
  const release = acquireLock(outDir);
  try {
    if (simulated && !existsSync(join(outDir, SIMULATED_FILE)))
      writeFileSync(
        join(outDir, SIMULATED_FILE),
        "SIMULATED pilot dry run (track E). Fake transport, no model, no VM, $0. Never evidence.\n",
      );
    if (!simulated && existsSync(join(outDir, SIMULATED_FILE)))
      throw new Error(`${outDir} holds a simulated run; a live pilot needs its own directory`);

    const ledgerPath = join(outDir, PROGRESS_FILE);
    const state = loadLedger(ledgerPath);
    const sha = configSha256(config);
    if (state.header !== null) {
      if (state.header.configSha256 !== sha)
        throw new Error(
          `${ledgerPath} was written under config ${state.header.configSha256}, not ${sha}: a changed plan is a new run directory`,
        );
      if (
        state.header.simulated !== simulated ||
        state.header.plannerModelId !== opts.plannerModelId
      )
        throw new Error(`${ledgerPath} was written by a different run mode or planner`);
    }
    const ledger = new AttemptLedger(ledgerPath, state.torn);
    if (state.header === null)
      ledger.header({ configSha256: sha, simulated, plannerModelId: opts.plannerModelId });

    const attempts = new Map<string, AttemptRecord[]>();
    for (const [k, v] of state.byTask) attempts.set(k, [...v]);

    // Close attempts the runner crashed in (appended, never rewritten).
    for (const task of tasks) {
      const st = taskStatus(attempts.get(task.taskId), config.pacing.maxAttemptsPerTrial);
      if (st.kind !== "crashed") continue;
      const cost = estimateCost(config.model, null);
      const armRow = label(
        harnessFaultRow(task, st.attempt.start.trialKey, opts.plannerModelId, "crash", {
          modelUsd: null,
          wallClockS: null,
          vmS: null,
        }),
      );
      const end = {
        trialKey: st.attempt.start.trialKey,
        outcome: "harness-fault" as const,
        harnessClass: "crash" as const,
        recovered: true,
        armRow,
        cost,
      };
      ledger.end(end);
      opts.attemptSink?.recoverCrash({ trialKey: st.attempt.start.trialKey, taskId: task.taskId });
      const list = attempts.get(task.taskId) as AttemptRecord[];
      list[list.length - 1] = {
        start: st.attempt.start,
        end: {
          schema: "myco.pilot.attempt/1",
          event: "end",
          at: new Date(now()).toISOString(),
          ...end,
        },
      };
      log(
        `${st.attempt.start.trialKey}: closed as a crash (runner died mid-trial); re-running in place`,
      );
    }

    const vault = new VerdictVault({
      root: join(outDir, "vault"),
      key: newVaultKey(),
      agentRoots: [join(outDir, "trials")],
    });

    let skipped = 0;
    let ran = 0;
    let faulted = 0;
    const exhausted: string[] = [];
    const queue: BenchmarkTask[] = [];
    for (const task of runnable) {
      const st = taskStatus(attempts.get(task.taskId), config.pacing.maxAttemptsPerTrial);
      if (st.kind === "done") skipped++;
      else if (st.kind === "exhausted") exhausted.push(task.taskId);
      else queue.push(task);
    }

    let nextStartAt = 0;
    let consecutiveRateLimits = 0;
    let stop: string | null = null;
    let halted: string | null = null;
    let fatal: unknown = null;
    let stopCode: StopCode | null = null;
    const abortOnRepeat = opts.abortOnRepeatedFailure ?? !simulated;
    // Seeded from the ledger, so a resume keeps the rule: a fault before the crash or stop plus
    // the identical fault after resume still aborts (PR #598 round 2, D1).
    let lastFaultSignature: string | null = resumeFaultSignature(state.ends);
    const maxTransient =
      opts.maxTransientRetriesPerTrial ?? (simulated ? Number.POSITIVE_INFINITY : 1);
    const transientByTask = new Map<string, number>();
    const pauseRequested = () =>
      [join(outDir, PAUSE_FILE), ...(opts.pauseFiles ?? [])].some((p) => existsSync(p));

    const runAttempt = async (
      task: BenchmarkTask,
    ): Promise<"decided" | "faulted" | "exhausted"> => {
      const st = taskStatus(attempts.get(task.taskId), config.pacing.maxAttemptsPerTrial);
      if (st.kind !== "open") return "exhausted";
      const trialKey = `${prefix}-${task.taskId}-a${st.nextAttempt}`;
      const runId = trialKey;
      const trialDir = join(outDir, "trials", trialKey);
      mkdirSync(trialDir, { recursive: true });
      mkdirSync(join(trialDir, "gate-evidence"), { recursive: true });
      writeFileSync(
        join(trialDir, "gate-tasks.json"),
        `${JSON.stringify({ tasks: [gateEntryFor(task)] }, null, 2)}\n`,
      );
      const plan = trialLaunchPlan(config, task, { runId, trialKey }, trialDir, opts.repoRoot);
      const audit = auditAgentLaunch(plan, { runId, extraServers: GATE_SERVER_CLASS });
      if (!audit.ok)
        throw new Error(
          `${trialKey}: the launch audit refused the pilot plan: ${audit.violations.map((v) => `${v.tool}: ${v.detail}`).join("; ")}`,
        );

      const startLine = {
        taskId: task.taskId,
        attempt: st.nextAttempt,
        trialKey,
        runId,
        supersedes: st.supersedes,
      };
      ledger.start(startLine);
      opts.attemptSink?.start({ trialKey, taskId: task.taskId });
      const record: AttemptRecord = {
        start: {
          schema: "myco.pilot.attempt/1",
          event: "start",
          at: new Date(now()).toISOString(),
          ...startLine,
        },
        end: null,
      };
      const list = attempts.get(task.taskId) ?? [];
      list.push(record);
      attempts.set(task.taskId, list);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.pacing.trialTimeoutS * 1000);
      timer.unref?.();
      const inner = driver.transport({
        task,
        runId,
        trialKey,
        trialDir,
        signal: controller.signal,
      });
      let captured: CaptureInput | null = null;
      const transport = {
        runAgent: (p: AgentLaunchPlan, gate: Gate | null) => inner.runAgent(p, gate),
        captureAfterStop: async () => {
          captured = await inner.captureAfterStop();
          return captured;
        },
      };
      const t0 = now();
      const common = {
        taskId: task.taskId,
        trialKey,
        runId,
        instruction: task.instruction,
        persistedFormat: "csv" as const,
        plannerModelId: opts.plannerModelId,
        outputCeiling: null,
      };
      const persistedOf = () => {
        const c = captured as CaptureInput | null;
        const bytes = c?.["persisted/doc.csv"];
        return bytes === undefined ? null : bytes;
      };
      try {
        const reg = registerTask(task);
        let armRow: BenchmarkArmRow;
        if (!reg.ok) {
          await transport.runAgent(plan, null);
          await transport.captureAfterStop();
          const rep = inner.report();
          const cost = estimateCost(config.model, rep.usage);
          armRow = label(
            gatedArmRow(
              {
                ...common,
                outcome: { status: "unregistrable", reason: reg.reason },
                agentClaim: rep.claim,
                persisted: persistedOf(),
                cost: {
                  modelUsd: cost.estimatedModelUsd,
                  wallClockS: (now() - t0) / 1000,
                  vmS: null,
                },
              },
              opts.published,
            ),
          );
          ledger.end({
            trialKey,
            outcome: "decided",
            harnessClass: null,
            recovered: false,
            armRow,
            cost,
          });
        } else {
          const outcome = await runGatedTrial({
            vault,
            runId,
            taskId: task.taskId,
            tasks: reg.registry,
            plan,
            oracleSources: opts.oracleSources,
            transport,
            ...(policy === undefined ? {} : { corrections: policy }),
          });
          if (outcome.status === "refused")
            throw new Error(`${trialKey}: the launch audit refused the plan inside runGatedTrial`);
          const rep = inner.report();
          const cost = estimateCost(config.model, rep.usage);
          armRow = label(
            gatedArmRow(
              {
                ...common,
                outcome,
                agentClaim: rep.claim,
                persisted: persistedOf(),
                cost: {
                  modelUsd: cost.estimatedModelUsd,
                  wallClockS: (now() - t0) / 1000,
                  vmS: null,
                },
              },
              opts.published,
            ),
          );
          ledger.end({
            trialKey,
            outcome: "decided",
            harnessClass: null,
            recovered: false,
            armRow,
            cost,
          });
        }
        opts.attemptSink?.end(trialKey, { outcome: "completed" });
        const doc = persistedOf();
        if (doc !== null) writeFileSync(join(trialDir, "doc.csv"), doc);
        list[list.length - 1] = {
          start: record.start,
          end: {
            schema: "myco.pilot.attempt/1",
            event: "end",
            trialKey,
            outcome: "decided",
            harnessClass: null,
            recovered: false,
            armRow,
            cost: null,
            at: new Date(now()).toISOString(),
          },
        };
        const why = opts.afterDecided?.({
          task,
          trialKey,
          armRow,
          persisted: doc,
          report: inner.report(),
        });
        if (why !== undefined && why !== null) {
          halted ??= why;
          stop ??= why;
        }
        return "decided";
      } catch (error) {
        const fault =
          error instanceof HarnessFault
            ? error
            : controller.signal.aborted
              ? new HarnessFault("timeout", `trial exceeded ${config.pacing.trialTimeoutS}s`)
              : null;
        if (fault === null) throw error; // A harness bug: stop; resume closes it as a crash.
        const cost = estimateCost(config.model, fault.usage);
        const armRow = label(
          harnessFaultRow(task, trialKey, opts.plannerModelId, fault.harnessClass, {
            modelUsd: cost.estimatedModelUsd,
            wallClockS: (now() - t0) / 1000,
            vmS: null,
          }),
        );
        const end = {
          trialKey,
          outcome: "harness-fault" as const,
          harnessClass: fault.harnessClass,
          recovered: false,
          armRow,
          cost,
          faultMessage: fault.message,
        };
        ledger.end(end);
        opts.attemptSink?.end(trialKey, {
          outcome: "harness-fault",
          harnessClass: fault.harnessClass,
        });
        list[list.length - 1] = {
          start: record.start,
          end: {
            schema: "myco.pilot.attempt/1",
            event: "end",
            at: new Date(now()).toISOString(),
            ...end,
          },
        };
        log(
          `${trialKey}: harness fault (${fault.harnessClass}); the attempt is kept and the trial re-runs in place`,
        );
        const code = stopCodeOf(fault);
        if (code !== null) {
          // Fail closed: stop at once, no back-off, no retry loop. Resume is the operator's call.
          stopCode ??= code;
          stop =
            code === "auth"
              ? `stopped (auth): the agent's Claude Code session is not authenticated (${trialKey}); log in to the subscription and re-run the same command to resume`
              : code === "billing"
                ? `stopped (billing): the CLI reported a credit, billing or quota error (${trialKey}); fix the subscription account, then re-run the same command to resume`
                : code === "usage-limit"
                  ? `stopped (usage-limit): the subscription's usage limit was reached (${trialKey}); no retry, no attempt spent. This must go to the lead: do not resume until the lead decides when the run continues`
                  : `stopped (api-key): the CLI would run on an API key, not the subscription (${trialKey}); remove the API-key path, then re-run the same command to resume`;
        } else if (abortOnRepeat && fault.harnessClass !== "rate-limit") {
          const signature = faultSignature(fault.harnessClass, fault.message);
          if (signature === lastFaultSignature) {
            stopCode ??= "repeat-failure";
            stop = `stopped (repeat-failure): two identical harness failures in a row (${fault.harnessClass}, last ${trialKey}); find the cause, then re-run the same command to resume`;
          }
          lastFaultSignature = signature;
        }
        if (fault.harnessClass === "rate-limit") {
          consecutiveRateLimits++;
          const transient = (transientByTask.get(task.taskId) ?? 0) + 1;
          transientByTask.set(task.taskId, transient);
          if (transient > maxTransient)
            stop = `paused: a transient rate limit hit ${task.taskId} again (${trialKey}) after its re-run; no further cold reset this run. Re-run the same command later to resume`;
          else if (consecutiveRateLimits >= config.pacing.maxConsecutiveRateLimits)
            stop = `paused after ${consecutiveRateLimits} rate limits in a row; re-run the same command later to resume`;
          else
            nextStartAt = Math.max(
              nextStartAt,
              now() + backoffS(config.pacing, consecutiveRateLimits) * 1000,
            );
        }
        return "faulted";
      } finally {
        clearTimeout(timer);
      }
    };

    const worker = async () => {
      while (stop === null && fatal === null) {
        const task = queue.shift();
        if (task === undefined) return;
        for (;;) {
          if (stop !== null || fatal !== null) {
            queue.unshift(task);
            return;
          }
          if (pauseRequested()) {
            stop = `paused: ${PAUSE_FILE} file present in the run directory; remove it and re-run to resume`;
            queue.unshift(task);
            return;
          }
          const wait = nextStartAt - now();
          if (wait > 0) {
            await sleep(wait);
            continue; // Re-check pause and the (possibly moved) start time.
          }
          nextStartAt = now() + config.pacing.interTrialDelayS * 1000;
          let r: "decided" | "faulted" | "exhausted";
          try {
            r = await runAttempt(task);
          } catch (error) {
            fatal ??= error;
            return;
          }
          if (r === "decided") {
            ran++;
            consecutiveRateLimits = 0;
            lastFaultSignature = null;
            break;
          }
          if (r === "faulted") {
            faulted++;
            const st = taskStatus(attempts.get(task.taskId), config.pacing.maxAttemptsPerTrial);
            if (st.kind === "exhausted") {
              exhausted.push(task.taskId);
              break;
            }
            continue;
          }
          exhausted.push(task.taskId);
          break;
        }
      }
    };

    await Promise.allSettled(
      Array.from({ length: Math.min(config.pacing.concurrency, Math.max(queue.length, 1)) }, () =>
        worker(),
      ),
    );
    if (fatal !== null) throw fatal;
    const status =
      halted !== null
        ? "halted"
        : stop !== null
          ? "paused"
          : exhausted.length > 0
            ? "incomplete"
            : "complete";
    return {
      status,
      reason:
        stop ??
        (exhausted.length > 0
          ? `${exhausted.length} trial(s) hit maxAttemptsPerTrial on harness faults (rate limits and auth faults not counted): ${exhausted.join(", ")}`
          : null),
      ran,
      skipped,
      faulted,
      exhausted,
      stopCode,
    };
  } finally {
    release();
  }
}

/**
 * Export a run for grading and checking: `<exportDir>/arm.jsonl` (one row per decided trial),
 * `<exportDir>/faulted-attempts.jsonl` (each faulted attempt's arm row, linked to the attempt
 * that replaced it; the input for a pack's `superseded.jsonl` once the pack is assembled with
 * its trial-ops rows) and `<exportDir>/docs/<trialKey>.csv`. Refuses an existing `exportDir`: an
 * export is a new directory, never an overwrite. A simulated run's export carries `SIMULATED`.
 */
export function exportRun(
  outDir: string,
  exportDir: string,
): { readonly armRows: BenchmarkArmRow[] } {
  if (existsSync(exportDir)) throw new Error(`${exportDir} exists: an export never overwrites`);
  const state = loadLedger(join(outDir, PROGRESS_FILE));
  if (state.header === null) throw new Error(`${outDir} has no pilot ledger`);
  mkdirSync(join(exportDir, "docs"), { recursive: true });
  if (state.header.simulated)
    writeFileSync(join(exportDir, SIMULATED_FILE), readFileSync(join(outDir, SIMULATED_FILE)));
  const armRows: BenchmarkArmRow[] = [];
  const superseded: { replacedBy: string; reason: string; arm: BenchmarkArmRow }[] = [];
  for (const list of state.byTask.values()) {
    for (let i = 0; i < list.length; i++) {
      const rec = list[i] as AttemptRecord;
      if (rec.end === null || rec.end.armRow === null) continue;
      if (rec.end.outcome === "decided") {
        armRows.push(rec.end.armRow);
        const doc = join(outDir, "trials", rec.start.trialKey, "doc.csv");
        if (existsSync(doc))
          writeFileSync(join(exportDir, "docs", `${rec.start.trialKey}.csv`), readFileSync(doc));
      } else {
        const next = list[i + 1];
        if (next !== undefined)
          superseded.push({
            replacedBy: next.start.trialKey,
            reason: `harness fault: ${rec.end.harnessClass}`,
            arm: rec.end.armRow,
          });
      }
    }
  }
  const jsonl = (rows: readonly unknown[]) =>
    rows.length === 0 ? "" : `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  writeFileSync(join(exportDir, "arm.jsonl"), jsonl(armRows));
  writeFileSync(join(exportDir, "faulted-attempts.jsonl"), jsonl(superseded));
  return { armRows };
}

/**
 * Why a live run of an A/B arm config cannot start: the config must name the corrections A/B
 * of the committed pre-registration, and `realRunRefusals` (pre-registration committed, the
 * lead's GO, the gate can read the format, #518's vocabulary, #546) must be empty.
 */
export function liveExperimentRefusals(
  config: PilotConfig,
  repoRoot: string,
  published: readonly BenchmarkTask[],
): string[] {
  const exp = config.experiment;
  if (exp === undefined)
    return ["a config with corrections set is an A/B arm and needs its experiment"];
  if (exp.name !== AB_EXPERIMENT) return [`unknown experiment ${String(exp.name)}`];
  if (exp.stage !== 0 && exp.stage !== 1) return [`unknown A/B stage ${String(exp.stage)}`];
  let loaded: ReturnType<typeof loadPrereg>;
  try {
    loaded = loadPrereg(repoRoot);
  } catch (error) {
    return [(error as Error).message];
  }
  if (exp.preregSha256 !== loaded.markdownSha256)
    return ["the config names another pre-registration than the committed one"];
  return realRunRefusals(repoRoot, loaded, exp.stage, published);
}
