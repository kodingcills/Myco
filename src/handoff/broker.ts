/**
 * The handoff broker (capability track N): the host-side state machine for one trial.
 *
 * One broker is bound to one `{ runId, taskId }`, like the gate. It hands out three channels,
 * each a separate object with only its own verbs, so a component holding one cannot use another:
 *
 *  - `agentChannel()`    request a handoff, await its resolution. No resolve verb. This is what
 *                        the agent's MCP server (`agent-server.ts`) is built on.
 *  - `policyTrigger()`   a host-side policy forces a pause (track O's interface), and the
 *                        `PauseGate` an actuator path consults before forwarding an agent action.
 *  - `operatorChannel()` list pending handoffs and resolve them. Handed out ONCE: the operator
 *                        endpoint takes it; a second call throws, so nothing else in the process
 *                        can obtain a resolve capability later.
 *
 * At most one handoff is pending at a time. A second agent request while one is pending is
 * refused with `HANDOFF_PENDING`. A policy pause while one is pending is QUEUED as its own
 * handoff (recorded at once with a `queued` event): it never inherits the open handoff's human
 * outcome, because that human answered a different question. When the open handoff is resolved
 * by a human, the next queued policy handoff opens before the pause gate clears, so no action is
 * forwarded in between; when it ends any other way (timeout, close), every queued policy request
 * is recorded `cancelled` and its waiter gets `ended`. Every pending
 * handoff has a deadline: when it passes, the handoff resolves `timeout`, the broker ENDS
 * (`attemptEnd: "handoff-timeout"`), and every later request or pause returns `ended`. A timeout
 * never approves anything (docs/handoff/security.md §5).
 *
 * The broker has no reference to the gate, the vault or the grader, and nothing it records is an
 * input to any of them: a handoff never changes a verdict.
 */
import {
  AGENT_NOTE_LIMIT,
  assistanceOf,
  DEFAULT_HANDOFF_TIMEOUT_MS,
  HANDOFF_ID,
  HANDOFF_OUTCOMES,
  HANDOFF_REASONS,
  HANDOFF_TIMEOUT_END,
  type HandoffAttemptEnd,
  type HandoffEntry,
  type HandoffLog,
  type HandoffReason,
  type HandoffResolution,
  type HandoffSource,
  HUMAN_NOTE_LIMIT,
  type HumanOutcome,
  MAX_HANDOFF_TIMEOUT_MS,
  MIN_HANDOFF_TIMEOUT_MS,
  type NoteRejection,
  noteRejection,
  OPERATOR_LABEL,
  OPERATOR_VIAS,
  type OperatorVia,
  POLICY_ID,
  type ResolvedBy,
} from "./protocol.ts";

/** Injected time, so tests drive deadlines without sleeping. */
export interface HandoffClock {
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
}

export const systemClock: HandoffClock = {
  now: () => Date.now(),
  setTimer: (ms, fn) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** What the operator is told when a handoff opens. Implementations: `notifier.ts`. */
export interface HandoffNotice {
  readonly handoffId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly source: HandoffSource;
  readonly policyId: string | null;
  readonly reason: HandoffReason;
  readonly note: string;
  readonly deadlineAt: string;
}

export interface HandoffNotifier {
  notify(notice: HandoffNotice): Promise<void> | void;
}

/**
 * Trial events next to the attempt ledger (#518). Written as each handoff opens and closes, so
 * a crash mid-handoff still leaves the request on disk. `events.ts` has the JSONL default.
 */
export type HandoffEvent =
  | {
      readonly schema: "myco.handoff.event/1";
      readonly event: "requested";
      readonly runId: string;
      readonly taskId: string;
      readonly handoffId: string;
      readonly source: HandoffSource;
      readonly policyId: string | null;
      readonly reason: HandoffReason;
      readonly note: string;
      readonly at: string;
      readonly deadlineAt: string;
    }
  | {
      /** A policy pause arrived while another handoff was open: recorded now, opened later. */
      readonly schema: "myco.handoff.event/1";
      readonly event: "queued";
      readonly runId: string;
      readonly taskId: string;
      readonly handoffId: string;
      readonly source: "policy";
      readonly policyId: string;
      readonly reason: HandoffReason;
      readonly note: string;
      readonly behind: string;
      readonly at: string;
    }
  | {
      readonly schema: "myco.handoff.event/1";
      readonly event: "resolved";
      readonly runId: string;
      readonly taskId: string;
      readonly handoffId: string;
      readonly entry: HandoffEntry;
      readonly at: string;
    }
  | {
      readonly schema: "myco.handoff.event/1";
      readonly event: "attempt-ended";
      readonly runId: string;
      readonly taskId: string;
      readonly attemptEnd: typeof HANDOFF_TIMEOUT_END;
      readonly handoffId: string;
      readonly at: string;
    };

export interface HandoffEventSink {
  append(event: HandoffEvent): void;
}

export interface HandoffBrokerOptions {
  readonly runId: string;
  readonly taskId: string;
  /** Fail-closed deadline per handoff. Default 15 min; bounded 1 s .. 24 h. */
  readonly timeoutMs?: number;
  readonly clock?: HandoffClock;
  readonly notifier?: HandoffNotifier;
  readonly events?: HandoffEventSink;
  /**
   * Called once when a handoff times out: the harness must stop the agent (the attempt ends as
   * `handoff-timeout`). The broker has already refused every later request by then.
   */
  readonly onAttemptEnd?: (end: typeof HANDOFF_TIMEOUT_END) => void;
  /** Operator-side diagnostics (a notifier that threw, a sink that failed). Never agent-facing. */
  readonly onDiagnostic?: (message: string) => void;
}

/** What the agent (or a policy) learns about a handoff. Codes only; no host data. */
export type HandoffStatus =
  | { readonly status: "paused"; readonly handoffId: string }
  | {
      readonly status: "resumed";
      readonly handoffId: string;
      readonly outcome: "approve" | "fixed-it";
      readonly humanNote: string | null;
    }
  | { readonly status: "rejected"; readonly handoffId: string; readonly humanNote: string | null }
  | { readonly status: "ended"; readonly code: "HANDOFF_TIMEOUT" | "HANDOFF_CANCELLED" }
  | { readonly status: "refused"; readonly code: RefusalCode };

export type RefusalCode =
  | "INVALID_REASON"
  | NoteRejection
  | "HANDOFF_PENDING"
  | "UNKNOWN_HANDOFF"
  | "INVALID_POLICY_ID";

/** A pending handoff, as the operator surfaces show it. */
export interface PendingHandoff extends HandoffNotice {
  readonly requestedAt: string;
}

export type ResolveError =
  | "UNKNOWN_HANDOFF"
  | "ALREADY_RESOLVED"
  | "INVALID_OUTCOME"
  | "INVALID_VIA"
  | "INVALID_OPERATOR_LABEL"
  | NoteRejection;

export interface ResolveInput {
  readonly handoffId: unknown;
  readonly outcome: unknown;
  readonly note?: unknown;
  readonly via: unknown;
  readonly operatorLabel?: unknown;
}

export type ResolveResult =
  | { readonly ok: true; readonly entry: HandoffEntry }
  | { readonly ok: false; readonly code: ResolveError };

export interface AgentHandoffChannel {
  /** Open a handoff. Waits up to `waitMs` for it to resolve, else returns `paused`. */
  request(input: { reason: unknown; note: unknown }, waitMs: number): Promise<HandoffStatus>;
  /** Wait up to `waitMs` on an open handoff. */
  await(handoffId: unknown, waitMs: number): Promise<HandoffStatus>;
}

/** Track O's side: force a pause from a host policy. */
export interface PolicyPauseRequest {
  readonly policyId: string;
  readonly reason: HandoffReason;
  readonly note: string;
}

export interface PolicyTrigger {
  /**
   * Force a pause and wait for it to resolve (or time out). If a handoff is already pending, the
   * policy's pause is queued as its own handoff and opens once the pending one is resolved by a
   * human; it never takes that handoff's outcome. Returns the final status, never `paused`.
   */
  forcePause(request: PolicyPauseRequest): Promise<HandoffStatus>;
}

/**
 * Consulted by the actuator path before it forwards an agent action: resolves `clear` when no
 * handoff is pending (at once, or when the pending one is resolved by a human), `ended` when the
 * attempt ended. The agent cannot act on the desktop while a handoff is open.
 */
export interface PauseGate {
  awaitClear(): Promise<"clear" | "ended">;
}

export interface OperatorChannel {
  pending(): readonly PendingHandoff[];
  resolve(input: ResolveInput): ResolveResult;
}

interface QueuedPolicy {
  readonly handoffId: string;
  readonly request: PolicyPauseRequest;
  readonly requestedAtMs: number;
  readonly waiter: (status: HandoffStatus) => void;
}

interface Open {
  readonly notice: PendingHandoff;
  readonly requestedAtMs: number;
  readonly timer: unknown;
  readonly waiters: Set<(entry: HandoffEntry) => void>;
}

function bounded(ms: number | undefined): number {
  const v = ms ?? DEFAULT_HANDOFF_TIMEOUT_MS;
  if (!Number.isInteger(v) || v < MIN_HANDOFF_TIMEOUT_MS || v > MAX_HANDOFF_TIMEOUT_MS)
    throw new RangeError(
      `handoff timeoutMs must be an integer in [${MIN_HANDOFF_TIMEOUT_MS}, ${MAX_HANDOFF_TIMEOUT_MS}]`,
    );
  return v;
}

/** The status a closed entry gives the agent. */
export function statusOf(entry: HandoffEntry): HandoffStatus {
  switch (entry.resolution) {
    case "approve":
    case "fixed-it":
      return {
        status: "resumed",
        handoffId: entry.handoffId,
        outcome: entry.resolution,
        humanNote: entry.humanNote,
      };
    case "reject":
      return { status: "rejected", handoffId: entry.handoffId, humanNote: entry.humanNote };
    case "timeout":
      return { status: "ended", code: "HANDOFF_TIMEOUT" };
    case "cancelled":
      return { status: "ended", code: "HANDOFF_CANCELLED" };
  }
}

export class HandoffBroker {
  readonly runId: string;
  readonly taskId: string;
  readonly timeoutMs: number;
  private readonly clock: HandoffClock;
  private readonly opts: HandoffBrokerOptions;
  private readonly entries: HandoffEntry[] = [];
  private readonly byId = new Map<string, HandoffEntry>();
  private open: Open | undefined;
  private policyQueue: QueuedPolicy[] = [];
  private seq = 0;
  private ended: HandoffAttemptEnd = null;
  private closed = false;
  private operatorIssued = false;
  private clearWaiters = new Set<(v: "clear" | "ended") => void>();

  constructor(opts: HandoffBrokerOptions) {
    this.runId = opts.runId;
    this.taskId = opts.taskId;
    this.timeoutMs = bounded(opts.timeoutMs);
    this.clock = opts.clock ?? systemClock;
    this.opts = opts;
  }

  /** The run record's `handoffs` field. */
  log(): HandoffLog {
    return {
      schema: "myco.handoff.log/1",
      assistance: assistanceOf(this.entries),
      attemptEnd: this.ended,
      timeoutMs: this.timeoutMs,
      entries: [...this.entries],
    };
  }

  /** Whether the attempt was ended by a handoff timeout. */
  get attemptEnd(): HandoffAttemptEnd {
    return this.ended;
  }

  agentChannel(): AgentHandoffChannel {
    return {
      request: (input, waitMs) => this.agentRequest(input, waitMs),
      await: (handoffId, waitMs) => this.agentAwait(handoffId, waitMs),
    };
  }

  policyTrigger(): PolicyTrigger & PauseGate {
    return {
      forcePause: (req) => this.policyPause(req),
      awaitClear: () => this.awaitClear(),
    };
  }

  /** The resolve capability. Issued once; the operator endpoint holds it. */
  operatorChannel(): OperatorChannel {
    if (this.operatorIssued) throw new Error("the operator channel was already issued");
    this.operatorIssued = true;
    return {
      pending: () => (this.open ? [this.open.notice] : []),
      resolve: (input) => this.resolve(input),
    };
  }

  /**
   * The trial ended (the agent stopped): a handoff still pending is closed `cancelled` by the
   * harness, and later requests are refused. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.open) this.finish(this.open, "cancelled", "host:harness", null, null);
    this.releaseClear("ended");
  }

  private diag(message: string): void {
    this.opts.onDiagnostic?.(message);
  }

  private emit(event: HandoffEvent): void {
    try {
      this.opts.events?.append(event);
    } catch (error) {
      this.diag(`handoff event sink failed: ${String(error)}`);
    }
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private terminal(): HandoffStatus | undefined {
    if (this.ended !== null) return { status: "ended", code: "HANDOFF_TIMEOUT" };
    if (this.closed) return { status: "ended", code: "HANDOFF_CANCELLED" };
    return undefined;
  }

  private nextId(): string {
    this.seq += 1;
    return `ho-${this.seq}`;
  }

  private openHandoff(
    source: HandoffSource,
    policyId: string | null,
    reason: HandoffReason,
    note: string,
    queued?: { readonly handoffId: string; readonly requestedAtMs: number },
  ): Open {
    const handoffId = queued?.handoffId ?? this.nextId();
    const openedAt = this.clock.now();
    // A queued policy request keeps the time it was made; its deadline runs from when it opens
    // (when a human can first see it).
    const now = queued?.requestedAtMs ?? openedAt;
    const deadline = openedAt + this.timeoutMs;
    const notice: PendingHandoff = {
      handoffId,
      runId: this.runId,
      taskId: this.taskId,
      source,
      policyId,
      reason,
      note,
      requestedAt: this.iso(now),
      deadlineAt: this.iso(deadline),
    };
    const timer = this.clock.setTimer(this.timeoutMs, () => this.timeout(handoffId));
    const open: Open = { notice, requestedAtMs: now, timer, waiters: new Set() };
    this.open = open;
    this.emit({
      schema: "myco.handoff.event/1",
      event: "requested",
      runId: this.runId,
      taskId: this.taskId,
      handoffId,
      source,
      policyId,
      reason,
      note,
      at: notice.requestedAt,
      deadlineAt: notice.deadlineAt,
    });
    void this.notify(notice);
    return open;
  }

  private async notify(notice: PendingHandoff): Promise<void> {
    const { requestedAt: _requestedAt, ...rest } = notice;
    try {
      await this.opts.notifier?.notify(rest);
    } catch (error) {
      // A notifier failure never fails or resolves the handoff; the deadline still runs.
      this.diag(`handoff notifier failed: ${String(error)}`);
    }
  }

  private finish(
    open: Open,
    resolution: HandoffResolution,
    resolvedBy: ResolvedBy,
    operatorLabel: string | null,
    humanNote: string | null,
  ): HandoffEntry {
    this.clock.clearTimer(open.timer);
    const now = this.clock.now();
    const n = open.notice;
    const entry: HandoffEntry = {
      handoffId: n.handoffId,
      runId: n.runId,
      taskId: n.taskId,
      source: n.source,
      policyId: n.policyId,
      reason: n.reason,
      note: n.note,
      requestedAt: n.requestedAt,
      resolvedAt: this.iso(now),
      durationMs: Math.max(0, now - open.requestedAtMs),
      resolution,
      resolvedBy,
      operatorLabel,
      humanNote,
    };
    this.open = undefined;
    this.entries.push(entry);
    this.byId.set(entry.handoffId, entry);
    this.emit({
      schema: "myco.handoff.event/1",
      event: "resolved",
      runId: this.runId,
      taskId: this.taskId,
      handoffId: entry.handoffId,
      entry,
      at: entry.resolvedAt,
    });
    for (const w of open.waiters) w(entry);
    const human = resolution !== "timeout" && resolution !== "cancelled";
    if (human && !this.closed && this.ended === null) {
      const next = this.policyQueue.shift();
      if (next) {
        // The pause gate stays shut: the queued policy handoff opens before anything clears.
        const r = next.request;
        const opened = this.openHandoff("policy", r.policyId, r.reason, r.note, next);
        opened.waiters.add((e) => next.waiter(statusOf(e)));
        return entry;
      }
      this.releaseClear("clear");
    } else if (!human) {
      this.dropQueuedPolicies();
    }
    return entry;
  }

  /**
   * The attempt is over (timeout or close) with policy pauses still queued: none of them was
   * shown to a human, so each is recorded `cancelled` by the host and its caller gets `ended`.
   * Nothing is forwarded on any of them.
   */
  private dropQueuedPolicies(): void {
    const queued = this.policyQueue;
    this.policyQueue = [];
    for (const q of queued) {
      const now = this.clock.now();
      const entry: HandoffEntry = {
        handoffId: q.handoffId,
        runId: this.runId,
        taskId: this.taskId,
        source: "policy",
        policyId: q.request.policyId,
        reason: q.request.reason,
        note: q.request.note,
        requestedAt: this.iso(q.requestedAtMs),
        resolvedAt: this.iso(now),
        durationMs: Math.max(0, now - q.requestedAtMs),
        resolution: "cancelled",
        resolvedBy: "host:harness",
        operatorLabel: null,
        humanNote: null,
      };
      this.entries.push(entry);
      this.byId.set(entry.handoffId, entry);
      this.emit({
        schema: "myco.handoff.event/1",
        event: "resolved",
        runId: this.runId,
        taskId: this.taskId,
        handoffId: entry.handoffId,
        entry,
        at: entry.resolvedAt,
      });
      q.waiter(this.terminal() ?? statusOf(entry));
    }
  }

  private timeout(handoffId: string): void {
    const open = this.open;
    if (!open || open.notice.handoffId !== handoffId) return;
    // Fail closed: end the attempt first, so nothing that races the waiters sees an open broker.
    this.ended = HANDOFF_TIMEOUT_END;
    this.finish(open, "timeout", "host:timeout", null, null);
    this.emit({
      schema: "myco.handoff.event/1",
      event: "attempt-ended",
      runId: this.runId,
      taskId: this.taskId,
      attemptEnd: HANDOFF_TIMEOUT_END,
      handoffId,
      at: this.iso(this.clock.now()),
    });
    this.releaseClear("ended");
    try {
      this.opts.onAttemptEnd?.(HANDOFF_TIMEOUT_END);
    } catch (error) {
      this.diag(`onAttemptEnd threw: ${String(error)}`);
    }
  }

  private releaseClear(v: "clear" | "ended"): void {
    const waiters = this.clearWaiters;
    this.clearWaiters = new Set();
    for (const w of waiters) w(v);
  }

  /** Wait on `open` for at most `waitMs`; `paused` when it is still open after that. */
  private wait(open: Open, waitMs: number): Promise<HandoffStatus> {
    const handoffId = open.notice.handoffId;
    return new Promise((resolve) => {
      let timer: unknown;
      const done = (entry: HandoffEntry) => {
        if (timer !== undefined) this.clock.clearTimer(timer);
        resolve(statusOf(entry));
      };
      open.waiters.add(done);
      if (Number.isFinite(waitMs)) {
        timer = this.clock.setTimer(Math.max(0, waitMs), () => {
          open.waiters.delete(done);
          resolve({ status: "paused", handoffId });
        });
      }
    });
  }

  private async agentRequest(
    input: { reason: unknown; note: unknown },
    waitMs: number,
  ): Promise<HandoffStatus> {
    const term = this.terminal();
    if (term) return term;
    if (
      typeof input.reason !== "string" ||
      !(HANDOFF_REASONS as readonly string[]).includes(input.reason)
    )
      return { status: "refused", code: "INVALID_REASON" };
    const noteCode = noteRejection(input.note, AGENT_NOTE_LIMIT);
    if (noteCode) return { status: "refused", code: noteCode };
    if (this.open) return { status: "refused", code: "HANDOFF_PENDING" };
    const open = this.openHandoff(
      "agent",
      null,
      input.reason as HandoffReason,
      input.note as string,
    );
    return this.wait(open, waitMs);
  }

  private async agentAwait(handoffId: unknown, waitMs: number): Promise<HandoffStatus> {
    if (typeof handoffId !== "string" || !HANDOFF_ID.test(handoffId))
      return { status: "refused", code: "UNKNOWN_HANDOFF" };
    const closedEntry = this.byId.get(handoffId);
    if (closedEntry) return statusOf(closedEntry);
    if (this.open?.notice.handoffId === handoffId) return this.wait(this.open, waitMs);
    return { status: "refused", code: "UNKNOWN_HANDOFF" };
  }

  private async policyPause(req: PolicyPauseRequest): Promise<HandoffStatus> {
    const term = this.terminal();
    if (term) return term;
    if (typeof req.policyId !== "string" || !POLICY_ID.test(req.policyId))
      return { status: "refused", code: "INVALID_POLICY_ID" };
    if (!(HANDOFF_REASONS as readonly string[]).includes(req.reason))
      return { status: "refused", code: "INVALID_REASON" };
    const noteCode = noteRejection(req.note, AGENT_NOTE_LIMIT);
    if (noteCode) return { status: "refused", code: noteCode };
    const pending = this.open;
    if (!pending) {
      const open = this.openHandoff("policy", req.policyId, req.reason, req.note);
      return this.wait(open, Number.POSITIVE_INFINITY);
    }
    // Another handoff is open. Never join it: its human answered a different question. Record
    // this request now and queue it as its own handoff.
    const request: PolicyPauseRequest = {
      policyId: req.policyId,
      reason: req.reason,
      note: req.note,
    };
    const handoffId = this.nextId();
    const requestedAtMs = this.clock.now();
    this.emit({
      schema: "myco.handoff.event/1",
      event: "queued",
      runId: this.runId,
      taskId: this.taskId,
      handoffId,
      source: "policy",
      policyId: request.policyId,
      reason: request.reason,
      note: request.note,
      behind: pending.notice.handoffId,
      at: this.iso(requestedAtMs),
    });
    return new Promise((resolve) =>
      this.policyQueue.push({ handoffId, request, requestedAtMs, waiter: resolve }),
    );
  }

  private awaitClear(): Promise<"clear" | "ended"> {
    if (this.ended !== null || this.closed) return Promise.resolve("ended");
    if (!this.open) return Promise.resolve("clear");
    return new Promise((resolve) => this.clearWaiters.add(resolve));
  }

  private resolve(input: ResolveInput): ResolveResult {
    if (typeof input.handoffId !== "string" || !HANDOFF_ID.test(input.handoffId))
      return { ok: false, code: "UNKNOWN_HANDOFF" };
    if (this.byId.has(input.handoffId)) return { ok: false, code: "ALREADY_RESOLVED" };
    const open = this.open;
    if (!open || open.notice.handoffId !== input.handoffId)
      return { ok: false, code: "UNKNOWN_HANDOFF" };
    if (
      typeof input.outcome !== "string" ||
      !(HANDOFF_OUTCOMES as readonly string[]).includes(input.outcome)
    )
      return { ok: false, code: "INVALID_OUTCOME" };
    if (typeof input.via !== "string" || !(OPERATOR_VIAS as readonly string[]).includes(input.via))
      return { ok: false, code: "INVALID_VIA" };
    const label = input.operatorLabel ?? "operator";
    if (typeof label !== "string" || !OPERATOR_LABEL.test(label))
      return { ok: false, code: "INVALID_OPERATOR_LABEL" };
    let humanNote: string | null = null;
    if (input.note !== undefined && input.note !== null && input.note !== "") {
      const code = noteRejection(input.note, HUMAN_NOTE_LIMIT);
      if (code) return { ok: false, code };
      humanNote = input.note as string;
    }
    const entry = this.finish(
      open,
      input.outcome as HumanOutcome,
      `operator:${input.via as OperatorVia}`,
      label,
      humanNote,
    );
    return { ok: true, entry };
  }
}
