/**
 * TIF-58 EF-005 — the arm recorder: the producer side of the recorded-evidence schema.
 *
 * `src/foundry/grader/discovery.ts` already reconciles and scores a recorded arm run: it
 * demands `recordedCalls`, `recordedCallCount` and `toolCallAudits` that agree with the
 * trace, refuses any run whose audit is incomplete, and treats a non-GUI write to a
 * persistence path as a file-I/O shortcut. Nothing produced those three artefacts. This
 * module does, so a live arm becomes gradeable by calling one recording API instead of
 * hand-assembling evidence per arm.
 *
 * It is deliberately arm-agnostic: a screenshot arm, an accessibility arm and a scripted
 * reference policy all emit the same three things — a tool call happened (`record()`), what
 * it touched (`audit()`), and any GUI action it caused (`act()`). The scorer then decides
 * what that means, and the arm never grades itself.
 *
 * Everything here runs offline against synthetic inputs; no guest is required.
 */

import type { GuardTraceEvent, TraceAct } from "../types.ts";

export type CallVia = "gui" | "file-io" | "shell-exec";
export type AccessOperation = "read" | "write";

export interface RecordedCall {
  readonly callId: string;
  readonly via: CallVia;
}

export interface RecordedAccess {
  readonly operation: AccessOperation;
  readonly path: string;
}

export interface RecordedAudit {
  readonly callId: string;
  readonly via: CallVia;
  readonly status: "complete" | "incomplete";
  readonly accesses: readonly RecordedAccess[];
}

/** The evidence one finished trial hands to the grader. */
export interface RecordedTrialEvidence {
  readonly armId: string;
  readonly taskId: string;
  readonly promptHash: string;
  /**
   * The fixture the row was actually run against, and its hash. The attestation gate
   * compares these to the fixture it resolved from the hidden commitment, so evidence
   * gathered on one fixture cannot vouch for a row scored against another (TIF-125).
   */
  readonly fixtureId?: string;
  readonly fixtureHash?: string;
  readonly status: "finished" | "quota-exhausted";
  readonly planner?: {
    readonly model: string;
    readonly settings: Readonly<Record<string, unknown>>;
  };
  readonly recordedCalls: readonly RecordedCall[];
  readonly recordedCallCount: number;
  readonly toolCallAudits: readonly RecordedAudit[];
}

export interface RecorderOptions {
  /** Monotonic clock, so a recording is reproducible in a test. Defaults to a fixed step clock. */
  readonly now?: () => string;
  /** Hard ceiling on tool calls; exceeding it closes the recording as incomplete. */
  readonly maxCalls?: number;
}

/**
 * Records one trial's calls, accesses and resulting GUI actions.
 *
 * The contract the grader relies on, and the reason this is a class rather than loose
 * helpers: `recordedCalls.length` must equal `recordedCallCount`, every call must have
 * exactly one audit, and every GUI action must belong to a call already recorded. Breaking
 * any of those makes the run `excluded` in the scorer rather than silently scored, which is
 * the behaviour we want from an arm that cannot prove what it did.
 */
export class ArmRecorder {
  readonly #options: RecorderOptions;
  readonly #calls: RecordedCall[] = [];
  readonly #audits: RecordedAudit[] = [];
  readonly #trace: GuardTraceEvent[] = [];
  readonly #open = new Map<string, { via: CallVia; accesses: RecordedAccess[] }>();
  #closed = false;
  #limitHit = false;
  #tick = 0;

  constructor(options: RecorderOptions = {}) {
    this.#options = options;
  }

  get callCount(): number {
    return this.#calls.length;
  }

  /** True once the arm hit its tool-call ceiling; the trial is then not a clean trial. */
  get callLimitExceeded(): boolean {
    return this.#limitHit;
  }

  #timestamp(): string {
    if (this.#options.now) return this.#options.now();
    this.#tick += 1;
    return new Date(Date.UTC(2026, 10, 22, 0, 0, this.#tick)).toISOString();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("recording is closed; open a new recorder per trial");
  }

  /** Start a tool call. Returns its id so the caller can audit and attribute actions to it. */
  begin(via: CallVia, callId: string): string {
    this.#assertOpen();
    if (callId.trim() === "") throw new Error("callId must not be empty");
    if (this.#calls.some((call) => call.callId === callId))
      throw new Error(`callId ${callId} is already recorded`);
    if (this.#options.maxCalls !== undefined && this.#calls.length >= this.#options.maxCalls) {
      // Refuse rather than record: an arm that ignores its ceiling must not produce evidence
      // that reconciles cleanly, or the ceiling is decorative.
      this.#limitHit = true;
      throw new Error(`tool-call ceiling of ${this.#options.maxCalls} reached`);
    }
    this.#calls.push({ callId, via });
    this.#open.set(callId, { via, accesses: [] });
    this.#trace.push({ type: "tool-call", timestamp: this.#timestamp(), callId, via });
    return callId;
  }

  /** Declare a path this call read or wrote. Indirect effects must be declared too. */
  access(callId: string, operation: AccessOperation, path: string): void {
    this.#assertOpen();
    const call = this.#open.get(callId);
    if (!call) throw new Error(`cannot declare access for unknown or closed call ${callId}`);
    if (path.trim() === "") throw new Error("path must not be empty");
    call.accesses.push({ operation, path });
  }

  /** Record a GUI action taken during a call. The scorer requires it to cite a live call. */
  act(callId: string, action: TraceAct, step: number): void {
    this.#assertOpen();
    const call = this.#open.get(callId);
    if (!call) throw new Error(`cannot attribute an action to unknown or closed call ${callId}`);
    if (call.via !== "gui")
      throw new Error(`call ${callId} is ${call.via}; only gui calls may drive actions`);
    this.#trace.push({
      type: "action",
      timestamp: this.#timestamp(),
      step,
      callId,
      action,
    });
  }

  /**
   * Close a call. `incomplete` keeps the record and marks it, so the scorer excludes the
   * trial rather than assuming the unaudited part did nothing.
   */
  end(callId: string, status: "complete" | "incomplete" = "complete"): void {
    this.#assertOpen();
    const call = this.#open.get(callId);
    if (!call) throw new Error(`cannot close unknown call ${callId}`);
    this.#audits.push({
      callId,
      via: call.via,
      status,
      accesses: [...call.accesses],
    });
    this.#open.delete(callId);
  }

  /**
   * Close every still-open call as incomplete, then freeze the recording.
   *
   * `evidence()` reports `quota-exhausted` when the call ceiling was hit, which the grader
   * already routes to a paused trial — the ceiling and the pause are the same condition seen
   * from two sides.
   */
  close(): {
    trace: readonly GuardTraceEvent[];
    calls: readonly RecordedCall[];
    audits: readonly RecordedAudit[];
  } {
    for (const callId of [...this.#open.keys()]) this.end(callId, "incomplete");
    this.#closed = true;
    return { trace: [...this.#trace], calls: [...this.#calls], audits: [...this.#audits] };
  }

  /** The evidence object the grader consumes. Refuses to hand over an open recording. */
  evidence(meta: {
    armId: string;
    taskId: string;
    promptHash: string;
    /** The fixture the row ran against. Required: the gate refuses evidence that omits it. */
    fixtureId: string;
    fixtureHash: string;
    status?: "finished" | "quota-exhausted";
    planner?: RecordedTrialEvidence["planner"];
  }): RecordedTrialEvidence {
    const { calls, audits } = this.close();
    return {
      armId: meta.armId,
      taskId: meta.taskId,
      promptHash: meta.promptHash,
      fixtureId: meta.fixtureId,
      fixtureHash: meta.fixtureHash,
      status: meta.status ?? (this.#limitHit ? "quota-exhausted" : "finished"),
      ...(meta.planner ? { planner: meta.planner } : {}),
      recordedCalls: calls,
      recordedCallCount: calls.length,
      toolCallAudits: audits,
    };
  }
}
