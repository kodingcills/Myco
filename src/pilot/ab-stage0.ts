/**
 * Corrections A/B **Stage 0** as one gated, resumable command (#676; tracks B/E, TIF-274).
 * Runbook: docs/benchmark/pilot-runbook.md, "Stage 0: the one command". The pre-registration
 * (docs/benchmark/corrections-ab-prereg.md) is not changed: this module only adds operator
 * guards around the existing live launch (`launchAbLive`, which it wraps and never edits).
 *
 * What it adds to `launch --stage 0`, in order, before any VM, guest channel or trial:
 *  1. **Never from 0.** The first invocation needs `--start-new`, on a missing or empty
 *     directory. Every later invocation resumes the same directory and refuses `--start-new`.
 *     Without `--start-new`, a directory with no Stage 0 run is refused, so a mistyped `--out`
 *     never starts Stage 0 again from its first trial. A simulated directory is refused.
 *  2. **Nothing pending.** A PAUSE file (the stage's or the A/B root's) or an unacknowledged
 *     incident refuses the launch. An abort record left by rule 5 below is named as such.
 *  3. **Every `launch` precondition** (`liveAbRefusals` + `vmLaunchRefusals`), unchanged,
 *     checked here first so the auth preflight never runs when they fail; `launchAbLive` and
 *     the runner check them again.
 *  4. **`claude auth status`** (#604 F1), run with the agent's allowlisted environment and a
 *     timeout. Anything but exit 0 with JSON `loggedIn: true` refuses. Its output is never
 *     printed or stored; the refusal carries a code only.
 *  5. **The first fault of class `transport-error`, `auth` or `billing` aborts** (an
 *     `ApiKeyPathFault` is class `auth`). The driver is wrapped: on such a fault it writes an
 *     abort record as the stage's PAUSE file (atomically, first fault wins) before the runner
 *     sees the fault. The runner records the faulted attempt as usual (the pre-registered
 *     harness-fault rule: kept, linked by `supersedes`, counted against the trial's budget)
 *     and, finding the PAUSE file, starts nothing more. This is the pre-registration's PAUSE,
 *     not a new stop. Exit 5. The operator investigates, removes the PAUSE file and re-runs the
 *     same command; the trial then re-runs in place.
 *  6. The subscription's usage limit is a pause for the lead (exit 7); a gate miss or a
 *     non-cold boot halts (exit 4), exactly as `launch`.
 *
 * Exit codes: 0 complete (or already complete: nothing is launched), 3 refused, 4 paused /
 * incomplete / halted, 5 aborted (rule 5, or the runner's `auth` / `billing` / `api-key` stop),
 * 6 two identical failures in a row, 7 the usage limit.
 */
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import {
  checkedArmConfigs,
  incidentStatus,
  type LoadedPrereg,
  liveAbRefusals,
  runAbStage,
  stageProgress,
  stageRoot,
} from "./ab.ts";
import { childEnv } from "./launch.ts";
import {
  type AbLaunchSeams,
  EXIT,
  exitCodeFor,
  type LiveDeps,
  type LiveLaunchResult,
  launchAbLive,
  vmLaunchRefusals,
} from "./live-launch.ts";
import { HarnessFault, PAUSE_FILE, type PilotDriver } from "./runner.ts";

export const STAGE0_ABORT_SCHEMA = "myco.pilot.ab-stage0-abort/1" as const;
/** The fault classes whose first occurrence aborts Stage 0 (rule 5). */
export const STAGE0_ABORT_CLASSES: readonly string[] = ["transport-error", "auth", "billing"];
export const AUTH_STATUS_TIMEOUT_MS = 10_000;
const AUTH_STATUS_MAX_BYTES = 64 * 1024;

/** The abort record, written as `<stage0>/PAUSE`. Codes only: no fault message. */
export interface Stage0Abort {
  readonly schema: typeof STAGE0_ABORT_SCHEMA;
  readonly trialKey: string;
  readonly harnessClass: string;
  readonly at: string;
  readonly rule: string;
}

const ABORT_RULE =
  "Stage 0 aborts on the first transport-error, auth or billing fault: investigate, then remove this PAUSE file and re-run the same stage0 command (the trial re-runs in place)";

/** The abort record at `pauseFile`, or null when absent or not an abort record. */
export function readStage0Abort(pauseFile: string): Stage0Abort | null {
  if (!existsSync(pauseFile)) return null;
  try {
    const v = JSON.parse(readFileSync(pauseFile, "utf8")) as Partial<Stage0Abort>;
    if (
      v.schema === STAGE0_ABORT_SCHEMA &&
      typeof v.trialKey === "string" &&
      typeof v.harnessClass === "string"
    )
      return v as Stage0Abort;
  } catch {
    // A hand-made PAUSE file (any content) is a plain pause.
  }
  return null;
}

/**
 * Rule 5: wrap a driver so the first `STAGE0_ABORT_CLASSES` fault writes the abort record as
 * `pauseFile` before the fault reaches the runner. The fault itself is re-thrown unchanged.
 * Every other outcome, and `simulated`, pass through.
 */
export function abortOnFirstFault(
  inner: PilotDriver,
  pauseFile: string,
  now: () => number = Date.now,
): PilotDriver {
  const abort = (error: unknown, trialKey: string) => {
    if (
      error instanceof HarnessFault &&
      STAGE0_ABORT_CLASSES.includes(error.harnessClass) &&
      !existsSync(pauseFile)
    ) {
      const record: Stage0Abort = {
        schema: STAGE0_ABORT_SCHEMA,
        trialKey,
        harnessClass: error.harnessClass,
        at: new Date(now()).toISOString(),
        rule: ABORT_RULE,
      };
      const tmp = `${pauseFile}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(tmp, pauseFile);
    }
    throw error;
  };
  return {
    simulated: inner.simulated,
    transport(ctx) {
      const t = inner.transport(ctx);
      return {
        runAgent: (p, g) => t.runAgent(p, g).catch((e: unknown) => abort(e, ctx.trialKey)),
        captureAfterStop: () => t.captureAfterStop().catch((e: unknown) => abort(e, ctx.trialKey)),
        report: () => t.report(),
      };
    },
  };
}

/** Rule 1 (never from 0): why this invocation may not start or resume `outRoot`; [] if it may. */
export function stage0StartRefusals(outRoot: string, startNew: boolean): string[] {
  const root = stageRoot(outRoot, 0);
  const headerPath = join(root, "ab-run.json");
  if (!existsSync(headerPath)) {
    if (!startNew)
      return [
        `STAGE0_NOT_STARTED: ${outRoot} holds no Stage 0 run; pass --start-new on the first invocation only (check --out: a resume must name the same directory)`,
      ];
    if (existsSync(outRoot) && readdirSync(outRoot).length > 0)
      return [
        `STAGE0_DIR_NOT_EMPTY: --start-new needs a missing or empty directory, and ${outRoot} is not empty`,
      ];
    return [];
  }
  const out: string[] = [];
  if (startNew)
    out.push(
      `STAGE0_ALREADY_STARTED: ${outRoot} already holds a Stage 0 run; re-run without --start-new to resume it (Stage 0 never restarts from its first trial)`,
    );
  let simulated: unknown = true;
  try {
    simulated = (JSON.parse(readFileSync(headerPath, "utf8")) as { simulated?: unknown }).simulated;
  } catch {
    // Unreadable: treated as not live, refused below.
  }
  if (simulated !== false)
    out.push(
      `STAGE0_NOT_LIVE: ${headerPath} is not a live run header (simulated or unreadable); a live Stage 0 needs its own directory`,
    );
  return out;
}

/** Rule 2: PAUSE files and unacknowledged incidents; [] when nothing is pending. */
export function stage0PendingRefusals(outRoot: string): string[] {
  const root = stageRoot(outRoot, 0);
  const out: string[] = [];
  for (const p of [join(root, PAUSE_FILE), join(resolve(outRoot), PAUSE_FILE)]) {
    if (!existsSync(p)) continue;
    const abort = readStage0Abort(p);
    out.push(
      abort === null
        ? `STAGE0_PAUSED: ${p} is present; remove it to resume`
        : `STAGE0_ABORTED: the first ${abort.harnessClass} fault (${abort.trialKey}) aborted Stage 0; investigate it, then remove ${p} and re-run the same command`,
    );
  }
  const pending = incidentStatus(root).filter((i) => !i.acknowledged);
  if (pending.length > 0)
    out.push(
      `STAGE0_INCIDENT_PENDING: ${pending.length} unacknowledged incident(s) (${pending.map((i) => i.id).join(", ")}); see the runbook's integrity-incident steps`,
    );
  return out;
}

/**
 * #604 F1: `claude auth status` before the first trial, with the agent's allowlisted
 * environment. Resolves null when logged in (exit 0 and JSON `loggedIn: true`), else a code.
 * The output is parsed and dropped: never logged, never stored.
 */
export function claudeAuthPreflight(
  deps: Pick<LiveDeps, "spawn" | "claudeCommand" | "env">,
  envAllowlist: readonly string[],
  timeoutMs: number = AUTH_STATUS_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((done) => {
    let settled = false;
    const finish = (r: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    let child: ChildProcess;
    try {
      child = deps.spawn(deps.claudeCommand, ["auth", "status"], {
        env: childEnv(deps.env, envAllowlist),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      done("AUTH_STATUS_SPAWN_FAILED");
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("AUTH_STATUS_TIMEOUT");
    }, timeoutMs);
    timer.unref?.();
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < AUTH_STATUS_MAX_BYTES) stdout += d.toString("utf8");
    });
    child.on("error", () => finish("AUTH_STATUS_SPAWN_FAILED"));
    child.on("close", (code) => {
      if (code !== 0) return finish(`AUTH_STATUS_NOT_LOGGED_IN (exit ${String(code)})`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return finish("AUTH_STATUS_UNPARSEABLE");
      }
      const loggedIn =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { loggedIn?: unknown }).loggedIn
          : undefined;
      finish(loggedIn === true ? null : "AUTH_STATUS_NOT_LOGGED_IN");
    });
  });
}

export interface Stage0Options {
  readonly loaded: LoadedPrereg;
  readonly published: readonly BenchmarkTask[];
  readonly outRoot: string;
  readonly repoRoot: string;
  readonly oracleSources: readonly string[];
  readonly launchRealTrials: boolean;
  readonly planSha256: string | undefined;
  /** `--start-new`: the first invocation only (rule 1). */
  readonly startNew: boolean;
}

/** Test seams; the CLI passes none. */
export interface Stage0Seams extends AbLaunchSeams {
  readonly authPreflight?: typeof claudeAuthPreflight;
}

export interface Stage0Result extends LiveLaunchResult {
  /** The abort record when rule 5 stopped this invocation. */
  readonly abort: Stage0Abort | null;
  /** True when Stage 0 was already complete and nothing was launched. */
  readonly alreadyComplete: boolean;
}

/** The one Stage 0 command (see the header for the rules and exit codes). */
export async function runStage0(
  opts: Stage0Options,
  deps: LiveDeps,
  seams: Stage0Seams = {},
): Promise<Stage0Result> {
  const refused = (refusals: string[]): Stage0Result => ({
    exitCode: EXIT.refused,
    refusals,
    result: null,
    abort: null,
    alreadyComplete: false,
  });
  const start = stage0StartRefusals(opts.outRoot, opts.startNew);
  if (start.length > 0) return refused(start);
  if (!opts.startNew && stageProgress(opts.outRoot, 0).complete)
    return {
      exitCode: EXIT.complete,
      refusals: [],
      result: null,
      abort: null,
      alreadyComplete: true,
    };
  const pending = stage0PendingRefusals(opts.outRoot);
  if (pending.length > 0) return refused(pending);

  const { on } = checkedArmConfigs(opts.loaded, 0, opts.published, opts.repoRoot);
  const launch = (seams.refusals ?? liveAbRefusals)({
    repoRoot: opts.repoRoot,
    loaded: opts.loaded,
    stage: 0,
    published: opts.published,
    launchRealTrials: opts.launchRealTrials,
    ...(opts.planSha256 === undefined ? {} : { liveLaunchSha256: opts.planSha256 }),
  });
  launch.push(...vmLaunchRefusals(deps, on));
  if (launch.length > 0) return refused(launch);

  const auth = await (seams.authPreflight ?? claudeAuthPreflight)(deps, on.childEnvAllowlist);
  if (auth !== null) return refused([`${auth}: claude is not logged in to the subscription`]);

  const pauseFile = join(stageRoot(opts.outRoot, 0), PAUSE_FILE);
  const runStage = seams.runStage ?? runAbStage;
  const r = await launchAbLive(
    {
      loaded: opts.loaded,
      stage: 0,
      published: opts.published,
      outRoot: opts.outRoot,
      repoRoot: opts.repoRoot,
      oracleSources: opts.oracleSources,
      launchRealTrials: opts.launchRealTrials,
      planSha256: opts.planSha256,
    },
    deps,
    {
      ...(seams.refusals === undefined ? {} : { refusals: seams.refusals }),
      runStage: (o) => runStage({ ...o, driver: abortOnFirstFault(o.driver, pauseFile, deps.now) }),
    },
  );
  const abort = readStage0Abort(pauseFile);
  if (r.result === null || abort === null) return { ...r, abort: null, alreadyComplete: false };
  // A halt or the usage limit keeps its own code; otherwise the abort is a fail-closed stop.
  const base = exitCodeFor(r.result);
  const exitCode =
    r.result.status === "halted" || base === EXIT.usageLimit ? base : EXIT.subscriptionStop;
  return { ...r, exitCode, abort, alreadyComplete: false };
}
