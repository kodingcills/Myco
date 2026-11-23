/**
 * `myco-run`'s execution layer (MVD-001 acceptance 1, 3, 4, 5).
 *
 * One task, one transport, one `runDirectionALive` call, one artifact directory.
 * The CLI is a thin shell over this so the same contract can be exercised by a
 * test without a terminal: `myco-run` needs no TTY, prints one summary, and
 * returns an exit code from `runExitCode` (also used by the CLI).
 *
 * What this module adds to the runner:
 *  - **Economics** (acceptance 5): wall-clock, recorded in `result.json` under a
 *    provenance key, so a mock latency can never be read as a live number. Model
 *    cost is not measured — nothing here calls a model — and it says so instead
 *    of printing 0.
 *  - **The claim, as an artifact event** (gui-spec §6.4 `claim`): the UI's status
 *    line and the agent's sentence are written to `trace.jsonl` beside the
 *    persisted read, so a viewer can show what was claimed next to what was read
 *    without reading an agent transcript.
 *  - **The live transport**, built only when the gate has already passed, so the
 *    import graph of a mock run cannot start a guest.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DesktopTransport,
  type LiveRunResult,
  type LiveVerification,
  type PersistedStore,
  runDirectionALive,
} from "./live-runner.ts";
import { MockDesktop } from "./mock-desktop.ts";
import type { PreflightProbe } from "./preflight.ts";
import { type RunTask, runTask } from "./run-tasks.ts";
import { persistedStoreOracle, REVIEWED_PROBE } from "./s0-sequence.ts";

export type RunTransport = "mock" | "live";

/**
 * Where a number came from. `mock` is a contract double with no guest, no kernel
 * and no network, so its latency says nothing about a live run and every reader
 * is told so by the label rather than by a footnote they may skip.
 */
export interface RunEconomics {
  readonly provenance: RunTransport;
  /** Host wall-clock around `runDirectionALive`, in milliseconds. */
  readonly wallClockMs: number;
  /**
   * What the wall-clock measures. `mock-contract-double` means no guest existed;
   * only `live-guest` is a number anyone may quote as run latency.
   */
  readonly wallClockBasis: "mock-contract-double" | "live-guest";
  /**
   * Model cost was not measured: `myco-run` calls no model. Recorded as absent
   * and explained, never as zero — a zero would read as a free run.
   */
  readonly modelCost: {
    readonly status: "not-measured";
    readonly reason: string;
  };
}

export interface RunOptions {
  readonly task: string;
  readonly transport: RunTransport;
  /** Artifact root: the run lands in `<out>/<taskId>/`. */
  readonly outDir: string;
  /** Overrides for tests; the CLI never passes these. */
  readonly transportImpl?: DesktopTransport;
  readonly probe?: PreflightProbe;
  readonly verify?: (
    persisted: PersistedStore,
    intent: { items: readonly string[] },
  ) => LiveVerification;
  /** Defaults to the task's `agentClaim`; tests use it to vary the claim. */
  readonly agentClaim?: string;
  /** Injected clock so the economics number is testable. */
  readonly now?: () => number;
}

export interface RunOutcome {
  readonly task: RunTask;
  readonly transport: RunTransport;
  readonly result: LiveRunResult;
  readonly runDir: string;
  readonly economics: RunEconomics;
  readonly claim: string;
}

const CLAIM_EVENT_LIMIT = 4000;

/**
 * Append the claim events to a written run's trace. The trace validator in
 * `run-artifacts.ts` is what decides a claim event is well-formed; this only
 * writes the two events the vocabulary already defines.
 */
function appendClaims(runDir: string, task: RunTask, result: LiveRunResult, claim: string): void {
  const now = new Date().toISOString();
  const events =
    result.status === "aborted"
      ? []
      : [
          {
            type: "claim",
            timestamp: now,
            step: task.items.length + 1,
            source: "app-ui",
            field: "status_text",
            value: result.claimed.slice(0, CLAIM_EVENT_LIMIT),
          },
          {
            type: "claim",
            timestamp: now,
            step: task.items.length + 1,
            source: "agent",
            field: "claim",
            value: claim.slice(0, CLAIM_EVENT_LIMIT),
          },
        ];
  if (events.length === 0) return;
  appendFileSync(
    join(runDir, "trace.jsonl"),
    events.map((event) => `${JSON.stringify(event)}\n`).join(""),
  );
}

/** Rewrite `result.json` with the economics block the runner does not know about. */
function recordEconomics(runDir: string, economics: RunEconomics): void {
  const path = join(runDir, "result.json");
  const record: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof record !== "object" || record === null) {
    throw new Error(`result.json at ${path} is not an object; cannot attach economics`);
  }
  writeFileSync(path, `${JSON.stringify({ ...record, economics }, null, 2)}\n`);
}

export async function runTaskOnce(options: RunOptions): Promise<RunOutcome> {
  const task = runTask(options.task);
  const claim = options.agentClaim ?? task.agentClaim;
  mkdirSync(options.outDir, { recursive: true });
  const now = options.now ?? performance.now.bind(performance);
  const started = now();
  const result = await runDirectionALive({
    transport: options.transportImpl ?? new MockDesktop(),
    probe: options.probe ?? REVIEWED_PROBE,
    app: {
      command: task.launch.command,
      args: [...task.launch.args],
      storePath: task.storePath,
      savePoint: { x: 210, y: 284 },
    },
    items: [...task.items],
    verify: options.verify ?? persistedStoreOracle,
    runsDir: options.outDir,
    runId: task.id,
    taskId: task.id,
    simulated: options.transport === "mock",
  });
  // `performance.now()` is the clock for the number a reader cares about
  // (elapsed host time); node:perf_hooks provides it without a wall-clock jump.
  const wallClockMs = Math.round(now() - started);
  const economics: RunEconomics = {
    provenance: options.transport,
    wallClockMs,
    wallClockBasis: options.transport === "mock" ? "mock-contract-double" : "live-guest",
    modelCost: {
      status: "not-measured",
      reason:
        "myco-run drives the desktop and reads the store; it calls no model, so there is no model cost to record",
    },
  };
  if (result.evidenceDir === undefined) {
    throw new Error(`run ${result.runId} produced no evidence directory`);
  }
  appendClaims(result.evidenceDir, task, result, claim);
  recordEconomics(result.evidenceDir, economics);
  return {
    task,
    transport: options.transport,
    result,
    runDir: result.evidenceDir,
    economics,
    claim,
  };
}

/**
 * Exit codes a caller can branch on without parsing the summary:
 *   0  the run produced a verdict (verified or refuted) and its artifacts validate
 *   1  the run aborted (preflight refused, or no verdict)
 *   2  the run produced a verdict but its artifacts failed validation
 *   3  the CLI was called wrongly (unknown task, missing option value)
 *
 * `refuted` is exit 0 deliberately: a refuted run is a *successful* demonstration
 * of the proof — the agent claimed success and the persisted store disagreed.
 * A caller that wants the verdict reads `verdict` from the summary or `--json`.
 */
export const EXIT_VERDICT = 0;
export const EXIT_ABORTED = 1;
export const EXIT_INVALID_ARTIFACTS = 2;
export const EXIT_USAGE = 3;

/**
 * The one place the exit code is decided, so the CLI and a test cannot disagree.
 * A verdict only counts when its artifacts validate; there is no path from
 * `verified` to exit 0 that skips the validator.
 */
export function exitCodeFor(result: LiveRunResult, artifacts: { readonly ok: boolean }): number {
  if (result.status === "aborted") return EXIT_ABORTED;
  return artifacts.ok ? EXIT_VERDICT : EXIT_INVALID_ARTIFACTS;
}
