/**
 * TIF-58 EF-005 — the live arm executor, behind a transport interface.
 *
 * A live arm needs three things the Foundry has never been able to test: a screen to read, a
 * way to send input, and a way to read the persisted store afterwards. Each of those is a
 * guest round-trip today. This module puts all three behind `LiveTransport` and drives the
 * recorder, so the whole arm harness can be exercised offline against a fake transport and
 * the only thing a VM adds is the transport's implementation.
 *
 * The split matters for the operating rule that VM time is scarce: everything here — budget
 * accounting, screen-vs-state evidence, recovery detection, the trace the grader reconciles —
 * runs against the model today. Swapping in a real transport is the VM task, and it is one
 * class.
 *
 * Transport failures are *evidence*, not exceptions. A transport that throws mid-trial
 * produces a trial recorded as `incomplete`, which the scorer excludes — never a trial that
 * looks finished because the harness swallowed an error.
 */

import type { GuardTraceEvent, ScreenView, TraceAct } from "../types.ts";
import type { ArmRecorder, RecordedTrialEvidence } from "./recorder.ts";

/** What a live arm needs from a guest. Every method may throw; the executor records it. */
export interface LiveTransport {
  /** Screen text an agent could read, plus whether the app is still up. */
  screen(): Promise<ScreenView>;
  /** Binary persistence files, keyed by the fixture's relative paths. */
  readPersistence(paths: readonly string[]): Promise<Record<string, Uint8Array>>;
  /** Deliver one GUI action. Returns nothing: success is judged from state, not the ack. */
  act(action: TraceAct): Promise<void>;
  /**
   * Run a non-GUI tool call (file read/write, shell). Returns what it touched, so the
   * recorder can declare accesses the scorer audits. A transport that cannot prove what a
   * call touched must throw, which marks the trial incomplete.
   */
  tool(
    via: "file-io" | "shell-exec",
    request: ToolRequest,
  ): Promise<readonly RecordedAccessShape[]>;
}

export interface ToolRequest {
  readonly operation: "read" | "write" | "exec";
  readonly path?: string;
  readonly command?: string;
}

export interface RecordedAccessShape {
  readonly operation: "read" | "write";
  readonly path: string;
}

export interface ExecutorOptions {
  readonly armId: string;
  readonly taskId: string;
  readonly promptHash: string;
  /** Actions allowed before the arm is considered to have exhausted its budget. */
  readonly budget: number;
  readonly persistencePaths: readonly string[];
  readonly planner?: RecordedTrialEvidence["planner"];
}

export interface ExecutedTrial {
  readonly evidence: RecordedTrialEvidence;
  readonly trace: readonly GuardTraceEvent[];
  readonly screen: ScreenView;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly steps: number;
  readonly selfReport: { readonly claimsSuccess: boolean; readonly text: string };
  readonly budgetExhausted: boolean;
  /** True when the transport failed; the trial is recorded incomplete and is excluded. */
  readonly transportFailed: boolean;
  readonly failure?: string;
}

/**
 * Runs one arm against one transport, recording everything it does.
 *
 * `policy` is the arm. It receives a narrow `ArmSurface` — read the screen, send an action,
 * call a tool — and returns its self-report. It cannot reach the grader, the oracle, or the
 * recorder, so it cannot describe its own success in a way the scorer would believe.
 */
export async function executeTrial(
  recorder: ArmRecorder,
  transport: LiveTransport,
  policy: (surface: ArmSurface) => Promise<{ claimsSuccess: boolean; text: string }>,
  options: ExecutorOptions,
): Promise<ExecutedTrial> {
  let steps = 0;
  let budgetExhausted = false;
  let transportFailed = false;
  let failure: string | undefined;
  let currentGuiCall: string | null = null;
  let callSeq = 0;
  const nextCallId = () => `${options.armId}-${++callSeq}`;

  /** Open a GUI call for the duration of one action, so the trace can attribute it. */
  const withGuiCall = async <T>(run: (callId: string) => Promise<T>): Promise<T> => {
    const callId = recorder.begin("gui", nextCallId());
    try {
      return await run(callId);
    } finally {
      // A transport failure inside the call leaves the audit incomplete, not absent.
      recorder.end(callId, transportFailed ? "incomplete" : "complete");
      currentGuiCall = null;
    }
  };

  const fail = (error: unknown) => {
    transportFailed = true;
    failure = error instanceof Error ? error.message : String(error);
  };

  const surface: ArmSurface = {
    async screen() {
      try {
        return await transport.screen();
      } catch (error) {
        fail(error);
        return { visibleText: [], reachable: false };
      }
    },
    async act(action) {
      if (steps >= options.budget) {
        budgetExhausted = true;
        throw new Error(`step budget of ${options.budget} exhausted`);
      }
      steps += 1;
      await withGuiCall(async (callId) => {
        currentGuiCall = callId;
        try {
          await transport.act(action);
        } catch (error) {
          fail(error);
        }
        if (currentGuiCall) recorder.act(callId, action, steps);
      });
    },
    async tool(via, request) {
      const callId = recorder.begin(via, nextCallId());
      let accesses: readonly RecordedAccessShape[] = [];
      try {
        accesses = await transport.tool(via, request);
      } catch (error) {
        fail(error);
      }
      for (const access of accesses) recorder.access(callId, access.operation, access.path);
      recorder.end(callId, transportFailed ? "incomplete" : "complete");
      return accesses;
    },
  };

  let selfReport = { claimsSuccess: false, text: "" };
  try {
    selfReport = await policy(surface);
  } catch (error) {
    fail(error);
  }

  let files: Record<string, Uint8Array> = {};
  let screen: ScreenView = { visibleText: [], reachable: false };
  try {
    files = await transport.readPersistence(options.persistencePaths);
    screen = await transport.screen();
  } catch (error) {
    fail(error);
  }

  const evidence = recorder.evidence({
    armId: options.armId,
    taskId: options.taskId,
    promptHash: options.promptHash,
    ...(options.planner ? { planner: options.planner } : {}),
  });
  const closed = recorder.close();
  return {
    evidence,
    trace: closed.trace,
    screen,
    files,
    steps,
    // The arm's own claim travels with the trial but is never the scored input; the caller
    // passes it to scoreTrial as `selfReport`, which is attached after the state verdict.
    selfReport,
    budgetExhausted,
    transportFailed,
    ...(failure ? { failure } : {}),
  };
}

/** The narrow surface an arm policy is given. No grader, no oracle, no recorder. */
export interface ArmSurface {
  screen(): Promise<ScreenView>;
  act(action: TraceAct): Promise<void>;
  tool(
    via: "file-io" | "shell-exec",
    request: ToolRequest,
  ): Promise<readonly RecordedAccessShape[]>;
}
