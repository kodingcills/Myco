/**
 * The live `launch` of the R1 pilot and of the corrections A/B (TIF-274), shared by
 * `scripts/m2-r1-pilot.ts` and `scripts/m2-corrections-ab-run.ts`. A launch starts real trials
 * only when every precondition holds; otherwise it refuses (exit 3) with each reason, before
 * any VM, guest channel or `claude` process is touched.
 *
 * Preconditions, both runners:
 *  - the subscription preflight: no API-path credential NAME in the environment (values are
 *    never read), and none in the agent's environment allowlist (`claudeDriver` refuses too);
 *  - the explicit `--launch-real-trials` flag and the sha256 the runner's `plan` printed;
 *  - the VM session lock is held by an ancestor (`scripts/vm-session.sh -- node --import tsx
 *    ...`), so the per-trial reset accepts it and nothing else drives the VM meanwhile;
 *  - concurrency 1 (one trial VM).
 * The A/B adds every `liveAbRefusals` precondition (pre-registration committed, the lead's GO
 * file, the gate can read the tasks' format, #518's vocabulary, #546's cold-boot guard), and
 * `runAbStage` / `runPilot` re-check them inside the runner, so this module cannot skip them.
 *
 * A live run keeps the runner's semantics: the durable ledger and `--resume` by re-running the
 * same command, PAUSE files, the #563 sticky halts. It writes a watchdog-friendly heartbeat,
 * `<out>/live-status.json` (atomic rewrite; `pid`, `state`, `updatedAt` refreshed every
 * `heartbeatMs` and on every log line), so a detached run (`nohup ... &`) can be watched.
 *
 * Exit codes: 0 complete, 3 refused, 4 paused / incomplete / halted, 5 fail-closed stop on the
 * subscription (`auth`, `billing`, `api-key`), 6 two identical harness failures in a row.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import {
  type AbRunResult,
  type AbStage,
  checkedArmConfigs,
  type LoadedPrereg,
  liveAbRefusals,
  runAbStage,
  stageRoot,
} from "./ab.ts";
import { apiKeyPathRefusal, type SpawnFn } from "./claude-transport.ts";
import { configSha256, type PilotConfig } from "./config.ts";
import { COST_BASIS } from "./cost.ts";
import { preflightRefusal, subscriptionPreflight } from "./launch.ts";
import { loadLedger, PROGRESS_FILE, pilotStatus } from "./ledger.ts";
import { type PilotRunResult, runPilot, type StopCode } from "./runner.ts";
import { liveVmDriver, type VmBackend } from "./vm-capture.ts";

export const LIVE_STATUS_FILE = "live-status.json";
export const LIVE_STATUS_SCHEMA = "myco.pilot.live-status/1" as const;

export const EXIT = {
  complete: 0,
  refused: 3,
  paused: 4,
  subscriptionStop: 5,
  repeatFailure: 6,
} as const;

/** The CLI exit code for a run result (see the header). */
export function exitCodeFor(r: {
  readonly status: string;
  readonly stopCode: StopCode | null;
}): number {
  if (r.stopCode === "repeat-failure") return EXIT.repeatFailure;
  if (r.stopCode !== null) return EXIT.subscriptionStop;
  return r.status === "complete" ? EXIT.complete : EXIT.paused;
}

/** Everything a live launch reaches outside the process. The CLIs pass the real ones. */
export interface LiveDeps {
  /** The parent environment; only NAMES are checked, and it is passed to `claude` by allowlist. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether an ancestor holds the VM lock (`lockOwnedByAncestor`). */
  readonly vmLockOwned: () => boolean;
  /** Built only after every precondition holds. */
  readonly vmBackend: () => VmBackend;
  readonly spawn: SpawnFn;
  readonly claudeCommand: string;
  readonly log: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly heartbeatMs?: number;
}

export interface LiveLaunchResult {
  readonly exitCode: number;
  readonly refusals: readonly string[];
  readonly result: PilotRunResult | AbRunResult | null;
}

/** The preconditions this module adds (lock, concurrency, the allowlist); [] when all hold. */
export function vmLaunchRefusals(
  deps: Pick<LiveDeps, "env" | "vmLockOwned">,
  config: Pick<PilotConfig, "pacing" | "childEnvAllowlist">,
): string[] {
  const out: string[] = [];
  const pre = subscriptionPreflight(Object.keys(deps.env));
  if (!pre.ok) out.push(preflightRefusal(pre));
  const allow = apiKeyPathRefusal({ envAllowlist: config.childEnvAllowlist });
  if (allow !== null) out.push(allow);
  if (!deps.vmLockOwned())
    out.push(
      "the VM session lock is not held: run the launch under scripts/vm-session.sh -- node --import tsx <runner> launch ... (FD 9 must reach the runner)",
    );
  if (config.pacing.concurrency !== 1)
    out.push(`a live VM run needs concurrency 1 (one trial VM), not ${config.pacing.concurrency}`);
  return out;
}

/** The heartbeat file: rewritten atomically, so a watcher never reads half a file. */
export class LiveStatus {
  private readonly path: string;
  private readonly startedAt: string;
  private lastLog: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    dir: string,
    private readonly runner: "r1-pilot" | "corrections-ab",
    private readonly now: () => number,
    heartbeatMs: number,
  ) {
    this.path = join(resolve(dir), LIVE_STATUS_FILE);
    this.startedAt = new Date(now()).toISOString();
    this.write({ state: "running" });
    this.timer = setInterval(() => this.write({ state: "running" }), heartbeatMs);
    this.timer.unref?.();
  }

  log(line: string): void {
    this.lastLog = line;
    this.write({ state: "running" });
  }

  finish(fields: Record<string, unknown>): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.write({ state: "finished", ...fields });
  }

  private write(fields: Record<string, unknown>): void {
    const body = {
      schema: LIVE_STATUS_SCHEMA,
      runner: this.runner,
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: new Date(this.now()).toISOString(),
      lastLog: this.lastLog,
      costBasis: COST_BASIS,
      ...fields,
    };
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}

function driverFor(config: PilotConfig, repoRoot: string, deps: LiveDeps) {
  return liveVmDriver(
    {
      spawn: deps.spawn,
      command: deps.claudeCommand,
      env: deps.env,
      envAllowlist: config.childEnvAllowlist,
    },
    { backend: deps.vmBackend(), repoRoot, ...(deps.now ? { now: deps.now } : {}) },
  );
}

export interface R1LaunchOptions {
  readonly config: PilotConfig;
  readonly published: readonly BenchmarkTask[];
  readonly outDir: string;
  readonly repoRoot: string;
  readonly oracleSources: readonly string[];
  readonly launchRealTrials: boolean;
  readonly planSha256: string | undefined;
}

/** The R1 pilot's live launch. */
export async function launchR1Live(
  opts: R1LaunchOptions,
  deps: LiveDeps,
): Promise<LiveLaunchResult> {
  const refusals: string[] = [];
  if (!opts.launchRealTrials || opts.planSha256 !== configSha256(opts.config))
    refusals.push(
      "a real launch needs --launch-real-trials and --plan-sha256 <the configSha256 printed above>",
    );
  refusals.push(...vmLaunchRefusals(deps, opts.config));
  if (refusals.length > 0) return { exitCode: EXIT.refused, refusals, result: null };

  const now = deps.now ?? Date.now;
  const status = new LiveStatus(opts.outDir, "r1-pilot", now, deps.heartbeatMs ?? 60_000);
  let result: PilotRunResult | null = null;
  try {
    result = await runPilot({
      config: opts.config,
      published: opts.published,
      outDir: opts.outDir,
      repoRoot: opts.repoRoot,
      oracleSources: opts.oracleSources,
      driver: driverFor(opts.config, opts.repoRoot, deps),
      plannerModelId: opts.config.model,
      liveLaunchSha256: configSha256(opts.config),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      now,
      log: (l) => {
        status.log(l);
        deps.log(l);
      },
    });
    const exitCode = exitCodeFor(result);
    const progress = pilotStatus(loadLedger(join(opts.outDir, PROGRESS_FILE)));
    status.finish({ exitCode, result, costEstimate: progress.costEstimate });
    return { exitCode, refusals: [], result };
  } catch (error) {
    status.finish({ exitCode: 1, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export interface AbLaunchOptions {
  readonly loaded: LoadedPrereg;
  readonly stage: AbStage;
  readonly published: readonly BenchmarkTask[];
  readonly outRoot: string;
  readonly repoRoot: string;
  readonly oracleSources: readonly string[];
  readonly launchRealTrials: boolean;
  readonly planSha256: string | undefined;
}

/** Test seams for the A/B launch; the CLI passes none. */
export interface AbLaunchSeams {
  readonly refusals?: typeof liveAbRefusals;
  readonly runStage?: typeof runAbStage;
}

/** The corrections A/B's live launch (one stage). */
export async function launchAbLive(
  opts: AbLaunchOptions,
  deps: LiveDeps,
  seams: AbLaunchSeams = {},
): Promise<LiveLaunchResult> {
  const { on } = checkedArmConfigs(opts.loaded, opts.stage, opts.published, opts.repoRoot);
  const refusals = (seams.refusals ?? liveAbRefusals)({
    repoRoot: opts.repoRoot,
    loaded: opts.loaded,
    stage: opts.stage,
    published: opts.published,
    launchRealTrials: opts.launchRealTrials,
    ...(opts.planSha256 === undefined ? {} : { liveLaunchSha256: opts.planSha256 }),
  });
  refusals.push(...vmLaunchRefusals(deps, on));
  if (refusals.length > 0) return { exitCode: EXIT.refused, refusals, result: null };

  const now = deps.now ?? Date.now;
  const root = stageRoot(opts.outRoot, opts.stage);
  mkdirSync(root, { recursive: true });
  const status = new LiveStatus(root, "corrections-ab", now, deps.heartbeatMs ?? 60_000);
  try {
    const result = await (seams.runStage ?? runAbStage)({
      repoRoot: opts.repoRoot,
      published: opts.published,
      loaded: opts.loaded,
      stage: opts.stage,
      outRoot: opts.outRoot,
      driver: driverFor(on, opts.repoRoot, deps),
      plannerModelId: on.model,
      oracleSources: opts.oracleSources,
      ...(opts.planSha256 === undefined ? {} : { liveLaunchSha256: opts.planSha256 }),
      launchRealTrials: true,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      now,
      log: (l) => {
        status.log(l);
        deps.log(l);
      },
    });
    const exitCode = exitCodeFor(result);
    status.finish({ exitCode, result });
    return { exitCode, refusals: [], result };
  } catch (error) {
    status.finish({ exitCode: 1, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
