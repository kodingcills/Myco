/**
 * The 30-trial R1 pilot (TIF-265 scope add, track E): which trials run, how they are paced,
 * and the headless Claude Code launch they use. This module is pure data and arithmetic; it
 * starts nothing. The reviewed, committed copy of the config is
 * `benchmark/pilot/r1/config.json`; `test/pilot/config.test.ts` pins it to `pilotConfig()`
 * so the file a reviewer reads is the file the runner uses.
 *
 * Trials: 30 of fc-v1's 100 published tasks, in fc-v1's own proportions (60% none, 10% each
 * of kill-app, delayed-save, focus-change and invalid-target): the first 18 `none` tasks and
 * the first 3 of each faulted class, by task id. Three are invalid-target, so they come back
 * `unregistrable`. The pilot is a launch-readiness run: its 30 rows are not R1 evidence on
 * their own (R1 binds the rows to every fc-v1 task run k times; `src/benchmark/taskset-binding.ts`,
 * unchanged).
 *
 * Pacing default, and why (Tiffany runs builder and verifier Claude Code sessions on the same
 * subscription while the pilot runs): one trial at a time (`concurrency` 1) and a 90 s pause
 * between trial starts, so the pilot holds at most one of the subscription's concurrent
 * sessions and leaves the rest of its rate window to the builder and the verifier. On a
 * rate-limit signal the runner waits 5 min, doubling to at most 60 min, and pauses the whole
 * run (resumable) after 4 rate limits in a row. These are knobs, not guarantees: the
 * subscription's limits are not published per minute, so the runbook says how to tune them.
 */
import { createHash } from "node:crypto";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import { GATE_TOOL, SERVER_NAME } from "../gate/mcp-server.ts";

export const PILOT_CONFIG_SCHEMA = "myco.pilot.r1-config/1" as const;
export const PILOT_TASK_SET = "fc-v1";
export const PILOT_TRIALS = 30;
/** Per fault class: how many of fc-v1's tasks (first by task id) the pilot runs. */
export const PILOT_STRATA: Readonly<Record<string, number>> = {
  none: 18,
  "kill-app": 3,
  "delayed-save": 3,
  "focus-change": 3,
  "invalid-target": 3,
};

/**
 * The planner. Sonnet 5.5 because the hcu+shell arm (R2's other side, TIF-268) runs it, so a
 * later paired run keeps the same model, and because the repo's frozen token rates price it.
 */
export const PILOT_MODEL = "claude-sonnet-5-5";

export interface PacingConfig {
  /** Trials in flight at once. */
  readonly concurrency: number;
  /** Seconds between one trial start and the next (per worker slot). */
  readonly interTrialDelayS: number;
  /** First wait after a rate-limit signal, seconds; doubles each time in a row. */
  readonly rateLimitBackoffS: number;
  /** Ceiling for the doubling wait, seconds. */
  readonly rateLimitBackoffMaxS: number;
  /** After this many rate limits in a row the run pauses (resume by re-running). */
  readonly maxConsecutiveRateLimits: number;
  /** A trial running longer than this is stopped and recorded as a harness timeout. */
  readonly trialTimeoutS: number;
  /** Attempts per trial (the first plus harness-fault re-runs); then the trial is left open. */
  readonly maxAttemptsPerTrial: number;
}

export const DEFAULT_PACING: PacingConfig = {
  concurrency: 1,
  interTrialDelayS: 90,
  rateLimitBackoffS: 300,
  rateLimitBackoffMaxS: 3600,
  maxConsecutiveRateLimits: 4,
  trialTimeoutS: 1800,
  maxAttemptsPerTrial: 3,
};

/** Upper bound on `concurrency`: more than this leaves no headroom on one subscription. */
export const MAX_CONCURRENCY = 3;

/** Validate pacing; throws with every problem named. */
export function checkPacing(p: PacingConfig): PacingConfig {
  const problems: string[] = [];
  const int = (name: keyof PacingConfig, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const v = p[name];
    if (!Number.isInteger(v) || v < min || v > max)
      problems.push(`${name} must be an integer in [${min}, ${max}], got ${String(v)}`);
  };
  int("concurrency", 1, MAX_CONCURRENCY);
  int("interTrialDelayS", 0);
  int("rateLimitBackoffS", 1);
  int("rateLimitBackoffMaxS", 1);
  int("maxConsecutiveRateLimits", 1);
  int("trialTimeoutS", 1);
  int("maxAttemptsPerTrial", 1, 10);
  if (p.rateLimitBackoffMaxS < p.rateLimitBackoffS)
    problems.push("rateLimitBackoffMaxS must be >= rateLimitBackoffS");
  if (problems.length > 0) throw new Error(`invalid pilot pacing: ${problems.join("; ")}`);
  return p;
}

/** The wait after the n-th rate limit in a row (n >= 1). */
export function backoffS(p: PacingConfig, consecutive: number): number {
  return Math.min(p.rateLimitBackoffMaxS, p.rateLimitBackoffS * 2 ** Math.max(0, consecutive - 1));
}

/** The pilot's tasks, stratified from the published task set (see the module doc). */
export function selectPilotTasks(tasks: readonly BenchmarkTask[]): BenchmarkTask[] {
  const out: BenchmarkTask[] = [];
  for (const [cls, n] of Object.entries(PILOT_STRATA)) {
    const pick = tasks
      .filter((t) => t.taskSetVersion === PILOT_TASK_SET && t.faultClass === cls)
      .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))
      .slice(0, n);
    if (pick.length !== n)
      throw new Error(`${PILOT_TASK_SET} has ${pick.length} ${cls} task(s); the pilot needs ${n}`);
    out.push(...pick);
  }
  if (out.length !== PILOT_TRIALS) throw new Error(`pilot selected ${out.length} trials`);
  return out.sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
}

/** The one tool the agent is granted: the gate. */
export const GATE_GRANT = `mcp__${SERVER_NAME}__${GATE_TOOL}`;

/**
 * The headless Claude Code argv, with `{PROMPT}`, `{MCP_CONFIG}` and `{SYSTEM}` filled per
 * trial. Every flag here is one the launch audit (`src/integrity/launch.ts`) recognises:
 *  - `-p` with the task's exact instruction as the prompt (R2 parity: the instruction text);
 *  - `--strict-mcp-config` and one `--mcp-config` (the trial's file): no user, project or
 *    local MCP server loads;
 *  - `--tools ""`: no built-in tool at all; `--allowedTools` grants the gate tool only;
 *  - `--permission-mode dontAsk`: nothing outside the grant runs;
 *  - `--setting-sources ""`: no user / project / local settings file, so no permission rule,
 *    hook, `apiKeyHelper` or MCP server from settings reaches the trial (the audit's stated
 *    blind spot);
 *  - `--output-format json`: the harness reads the final message and token usage from it.
 */
export const ARGV_TEMPLATE: readonly string[] = [
  "-p",
  "{PROMPT}",
  "--model",
  PILOT_MODEL,
  "--output-format",
  "json",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  "{MCP_CONFIG}",
  "--tools",
  "",
  "--allowedTools",
  GATE_GRANT,
  "--permission-mode",
  "dontAsk",
  "--append-system-prompt",
  "{SYSTEM}",
];

/**
 * The trial's gate server: `myco-gate mcp`, bound to this trial's one task and run
 * (any other is ASSIGNMENT_MISMATCH), reading an evidence root the harness never writes while
 * the agent runs, so every mid-run gate call is `uncertain` (STATE_MISSING). The trial's
 * verdict is the harness's own post-stop check on the sealed capture (`runGatedTrial`).
 */
export const GATE_SERVER_TEMPLATE = {
  command: "node",
  args: [
    "--import",
    "tsx",
    "{REPO}/scripts/myco-gate.ts",
    "mcp",
    "--no-builtin",
    "--tasks",
    "{TRIAL_DIR}/gate-tasks.json",
    "--task",
    "{TASK_ID}",
    "--run",
    "{RUN_ID}",
    "--evidence-root",
    "{TRIAL_DIR}/gate-evidence",
  ],
} as const;

/** The system-prompt addition: how to call the gate and how to end. Codes only come back. */
export const SYSTEM_TEMPLATE =
  `When you believe the task is complete, call ${GATE_GRANT} with taskId "{TASK_ID}" and runId "{RUN_ID}". ` +
  "End your final message with one line: DONE if you completed the task, NOT DONE otherwise.";

export interface PilotConfig {
  readonly schema: typeof PILOT_CONFIG_SCHEMA;
  readonly taskSetVersion: string;
  readonly model: string;
  readonly trials: readonly string[];
  readonly pacing: PacingConfig;
  readonly argvTemplate: readonly string[];
  readonly gateServerTemplate: typeof GATE_SERVER_TEMPLATE;
  readonly systemTemplate: string;
  /** Child-process environment: only these variable NAMES are passed to `claude`. */
  readonly childEnvAllowlist: readonly string[];
}

/** Names passed through to the agent process (values are never read by the harness). */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "TERM",
  "TMPDIR",
];

export function pilotConfig(
  tasks: readonly BenchmarkTask[],
  pacing: PacingConfig = DEFAULT_PACING,
): PilotConfig {
  return {
    schema: PILOT_CONFIG_SCHEMA,
    taskSetVersion: PILOT_TASK_SET,
    model: PILOT_MODEL,
    trials: selectPilotTasks(tasks).map((t) => t.taskId),
    pacing: checkPacing(pacing),
    argvTemplate: ARGV_TEMPLATE,
    gateServerTemplate: GATE_SERVER_TEMPLATE,
    systemTemplate: SYSTEM_TEMPLATE,
    childEnvAllowlist: CHILD_ENV_ALLOWLIST,
  };
}

/** Canonical JSON (sorted keys) and its sha256: the plan identity resume and launch check. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function configSha256(config: PilotConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}
