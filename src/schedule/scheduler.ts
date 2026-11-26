/**
 * Track S: scheduled and triggered runs.
 *
 * A trigger (a cron slot, a file arriving in an inbox, a signed loopback webhook, a manual
 * request) names a schedule; the schedule fixes the task. The trigger never supplies a task,
 * a run id, a claim or any oracle input: the run goes through the executor (production:
 * `runGatedTrial`, the same gated path as any run) and the gate's agent-facing contract is
 * unchanged (`myco.gate/v1`: taskId/runId/claim from the agent, nothing from the trigger).
 *
 * The admission order is the contract; every step fails closed:
 *  1. the schedule exists and has this source enabled;
 *  2. the global pause / kill switch is off (`<stateDir>/PAUSED` absent);
 *  3. the trigger key was never claimed (idempotency: no double runs, across restarts);
 *  4. the schedule's runs/day budget has room (else the key is claimed as refused);
 *  5. the schedule's concurrency budget has room;
 *  6. the claim is written durably (fsync) — a claim not on disk does not run;
 *  then, asynchronously:
 *  7. every policy allows it (a throwing or malformed policy denies);
 *  8. the kill and pause switches are re-checked (killed meanwhile: `killed`; paused: `skipped`);
 *  9. the run executes under the wall-time budget (over it: aborted, `timeout`). The
 *     concurrency slot is held until the executor's promise settles, even after the row;
 * 10. the outcome is mapped to a verdict: `accepted` is true only for a decided gate result
 *     that says `verified`, `accepted: true` and `ORACLE_PASS` for this exact run id.
 *     Anything else — a throw, a refusal, a timeout, a kill, a malformed or inconsistent
 *     result — is not verified;
 * 11. one row is appended to the MAC-chained ledger (src/integrity/ledger.ts). If that
 *     write fails, the run is reported `error` / `LEDGER_FAILED`, never verified;
 * 12. any outcome other than `verified` notifies (except duplicates and pause skips).
 *
 * Rows are operational records: `evidence` is always false, and `simulated` is true unless
 * the executor explicitly says otherwise. Scheduled rows never count as benchmark evidence.
 */

import type { ReasonCode } from "../gate/api.ts";
import { errorCode } from "../gate/reasons.ts";
import { appendChainedRow } from "../integrity/ledger.ts";
import type { ScheduleSpec, TriggerSource } from "./config.ts";
import { cronSlotsBetween } from "./cron.ts";
import { scanInbox } from "./inbox.ts";
import { drainSpool } from "./manual.ts";
import type { Clock, Notifier, RunPolicy } from "./runtime.ts";
import { type ScheduleState, sha256, triggerKeySha256 } from "./state.ts";

export const RUN_ROW_KIND = "myco.schedule.run/v1";

export type RunStatus =
  | "verified"
  | "refuted"
  | "uncertain"
  | "refused"
  | "denied"
  | "error"
  | "timeout"
  | "killed"
  | "skipped";

export interface TriggerRequest {
  readonly scheduleId: string;
  readonly source: TriggerSource;
  /**
   * Idempotency key material, unique per real-world event: the cron slot, the inbox file's
   * name and digest, the webhook delivery id, the manual request id. Stored only as a digest.
   */
  readonly key: string;
  /** Inbox triggers: the arriving file's name and digest (never its contents). */
  readonly inboxFile?: { readonly name: string; readonly sha256: string };
}

export interface RunRequest {
  readonly scheduleId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly source: TriggerSource;
  readonly inboxFile?: { readonly name: string; readonly sha256: string };
  /** Aborted on timeout or kill. The executor must stop the agent when it fires. */
  readonly signal: AbortSignal;
}

/** What an executor returns: the gated trial's outcome, and whether the run was simulated. */
export interface ExecutorResult {
  readonly outcome: unknown;
  readonly simulated: boolean;
}

export interface RunExecutor {
  run(req: RunRequest): Promise<ExecutorResult>;
}

export interface RunRecord {
  readonly kind: typeof RUN_ROW_KIND;
  readonly scheduleId: string;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly source: TriggerSource;
  readonly triggerKeySha256: string;
  readonly status: RunStatus;
  readonly verdict: "verified" | "refuted" | "uncertain" | null;
  /** True only for a verified gate decision for this run. */
  readonly accepted: boolean;
  /** The gate's reason codes, when the gate decided. */
  readonly reasonCodes: readonly ReasonCode[];
  /** Scheduler codes (budget, policy, pause, mapping). Codes only, never text. */
  readonly codes: readonly string[];
  readonly simulated: boolean;
  readonly evidence: false;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly missedSlots?: {
    readonly count: number;
    readonly firstAt: string;
    readonly lastAt: string;
  };
}

export type Admission =
  | { readonly admitted: true; readonly runId: string }
  | { readonly admitted: false; readonly code: string };

export interface Submission {
  readonly admission: Admission;
  readonly done: Promise<RunRecord>;
}

export interface SchedulerOptions {
  readonly schedules: readonly ScheduleSpec[];
  readonly state: ScheduleState;
  readonly clock: Clock;
  readonly executor: RunExecutor;
  readonly policies: readonly RunPolicy[];
  readonly notifier: Notifier;
  readonly ledger: { readonly path: string; readonly key: Uint8Array; readonly ledgerId: string };
  /** Operator diagnostics: codes only. */
  readonly onDiagnostic?: (code: string) => void;
  /** How late a cron slot may be evaluated and still count as on time. Default 120 s. */
  readonly graceMs?: number;
}

/** Statuses (and codes) that do not notify: the operator chose them, or nothing happened. */
const QUIET_CODES = new Set(["DUPLICATE", "PAUSED"]);

const VERDICTS = new Set(["verified", "refuted", "uncertain"]);

/** The run id a trigger gets: derived from its key, so a replay maps to the same id. */
export function scheduledRunId(scheduleId: string, keySha256: string): string {
  return `sched-${scheduleId}-${keySha256.slice(0, 16)}`;
}

type Mapped = Pick<
  RunRecord,
  "status" | "verdict" | "accepted" | "reasonCodes" | "codes" | "simulated"
>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Map an executor result to the row's verdict fields. Fails closed on anything unexpected. */
export function mapOutcome(result: unknown, runId: string): Mapped {
  const bad = (code: string, simulated = true): Mapped => ({
    status: "error",
    verdict: null,
    accepted: false,
    reasonCodes: [],
    codes: [code],
    simulated,
  });
  if (!isObj(result) || !isObj(result.outcome)) return bad("EXECUTOR_INVALID_OUTPUT");
  const simulated = result.simulated !== false;
  const o = result.outcome;
  if (o.status === "refused")
    return {
      status: "refused",
      verdict: null,
      accepted: false,
      reasonCodes: [],
      codes: ["LAUNCH_AUDIT_REFUSED"],
      simulated,
    };
  if (o.status !== "decided" || !isObj(o.result)) return bad("EXECUTOR_INVALID_OUTPUT", simulated);
  const r = o.result;
  const verdict = r.verdict;
  const reasonCodes = Array.isArray(r.reasonCodes)
    ? (r.reasonCodes.filter((c) => typeof c === "string") as ReasonCode[])
    : [];
  if (typeof verdict !== "string" || !VERDICTS.has(verdict))
    return bad("EXECUTOR_INVALID_OUTPUT", simulated);
  const v = verdict as "verified" | "refuted" | "uncertain";
  const reqRunId = isObj(r.request) ? r.request.runId : undefined;
  if (reqRunId !== runId)
    return {
      status: "uncertain",
      verdict: "uncertain",
      accepted: false,
      reasonCodes,
      codes: ["RESULT_RUN_MISMATCH"],
      simulated,
    };
  const accepted = v === "verified" && r.accepted === true && reasonCodes.includes("ORACLE_PASS");
  if (v === "verified" && !accepted)
    return {
      status: "uncertain",
      verdict: "uncertain",
      accepted: false,
      reasonCodes,
      codes: ["RESULT_INCONSISTENT"],
      simulated,
    };
  if (v !== "verified" && r.accepted !== false)
    return {
      status: v,
      verdict: v,
      accepted: false,
      reasonCodes,
      codes: ["RESULT_INCONSISTENT"],
      simulated,
    };
  return { status: v, verdict: v, accepted, reasonCodes, codes: [], simulated };
}

export class Scheduler {
  private readonly specs = new Map<string, ScheduleSpec>();
  private readonly inFlight = new Map<string, Set<AbortController>>();
  private readonly hashCache = new Map<string, string>();
  /** One promise per held concurrency slot; it resolves when the slot is released. */
  private readonly slots = new Set<Promise<void>>();
  private readonly graceMs: number;

  constructor(private readonly opts: SchedulerOptions) {
    if (opts.policies.length === 0)
      throw new Error("the scheduler requires at least one policy (policies are always applied)");
    for (const s of opts.schedules) {
      this.specs.set(s.id, s);
      this.inFlight.set(s.id, new Set());
    }
    this.graceMs = opts.graceMs ?? 120_000;
  }

  private diag(code: string): void {
    try {
      this.opts.onDiagnostic?.(code);
    } catch {
      // A diagnostics sink never changes an outcome.
    }
  }

  running(scheduleId: string): number {
    return this.inFlight.get(scheduleId)?.size ?? 0;
  }

  /**
   * Resolves once no run holds a concurrency slot, i.e. every admitted run's executor has
   * actually settled (a timed-out or killed run's row is written earlier). The service waits
   * on this before giving up the state-dir lock, so a restart cannot exceed `concurrency`
   * while an executor that ignores the abort signal is still running.
   */
  async idle(): Promise<void> {
    while (this.slots.size > 0) await Promise.all([...this.slots]);
  }

  isPaused(): boolean {
    return this.opts.state.isPaused();
  }

  pause(): void {
    this.opts.state.pause("PAUSED");
  }

  resume(): void {
    this.opts.state.resume();
  }

  /** Pause, and abort every run in flight. Aborted runs are recorded `killed`. */
  kill(): void {
    this.opts.state.pause("KILLED");
    for (const set of this.inFlight.values()) for (const c of set) c.abort(new Error("killed"));
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /** Append the row; on failure return an `error` / LEDGER_FAILED row instead (never verified). */
  private async finish(row: RunRecord): Promise<RunRecord> {
    let out = row;
    try {
      appendChainedRow(this.opts.ledger.path, this.opts.ledger.key, this.opts.ledger.ledgerId, {
        ...row,
      });
    } catch (e) {
      this.diag(`LEDGER_FAILED:${errorCode(e)}`);
      out = {
        ...row,
        status: "error",
        verdict: null,
        accepted: false,
        codes: [...row.codes, "LEDGER_FAILED"],
      };
    }
    if (out.status !== "verified" && !out.codes.some((c) => QUIET_CODES.has(c))) {
      try {
        await this.opts.notifier.notify({
          kind: "myco.schedule.notification/v1",
          scheduleId: out.scheduleId,
          taskId: out.taskId,
          runId: out.runId,
          source: out.source,
          status: out.status,
          codes: [...out.reasonCodes, ...out.codes],
          at: out.endedAt,
        });
      } catch (e) {
        this.diag(`NOTIFIER_FAILED:${errorCode(e)}`);
      }
    }
    return out;
  }

  private skip(
    spec: { id: string; taskId: string | null },
    source: TriggerSource,
    keySha: string,
    status: RunStatus,
    code: string,
    runId: string | null = null,
  ): Submission {
    const now = this.iso(this.opts.clock.now());
    return {
      admission: { admitted: false, code },
      done: this.finish({
        kind: RUN_ROW_KIND,
        scheduleId: spec.id,
        taskId: spec.taskId,
        runId,
        source,
        triggerKeySha256: keySha,
        status,
        verdict: null,
        accepted: false,
        reasonCodes: [],
        codes: [code],
        simulated: true,
        evidence: false,
        startedAt: now,
        endedAt: now,
      }),
    };
  }

  /** Admit (synchronously) and run (asynchronously) one trigger. */
  submit(req: TriggerRequest): Submission {
    const spec = this.specs.get(req.scheduleId);
    const keySha = triggerKeySha256(req.scheduleId, req.source, req.key);
    if (!spec) {
      this.diag("UNKNOWN_SCHEDULE");
      return {
        admission: { admitted: false, code: "UNKNOWN_SCHEDULE" },
        done: Promise.resolve(this.nullRow(req, keySha)),
      };
    }
    const enabled =
      (req.source === "cron" && spec.cron !== undefined) ||
      (req.source === "inbox" && spec.events.inbox !== undefined) ||
      (req.source === "webhook" && spec.events.webhook) ||
      (req.source === "manual" && spec.events.manual);
    if (!enabled) return this.skip(spec, req.source, keySha, "skipped", "SOURCE_NOT_ENABLED");
    if (this.opts.state.isPaused()) return this.skip(spec, req.source, keySha, "skipped", "PAUSED");
    if (this.opts.state.has(keySha))
      return this.skip(spec, req.source, keySha, "skipped", "DUPLICATE");
    const runId = scheduledRunId(spec.id, keySha);
    const now = this.opts.clock.now();
    const claim = (admitted: boolean): boolean => {
      try {
        this.opts.state.claim({
          keySha256: keySha,
          scheduleId: spec.id,
          source: req.source,
          runId,
          at: now,
          admitted,
        });
        return true;
      } catch (e) {
        this.diag(`STATE_WRITE_FAILED:${errorCode(e)}`);
        return false;
      }
    };
    if (this.opts.state.admittedOn(spec.id, now) >= spec.budget.runsPerDay) {
      claim(false);
      return this.skip(spec, req.source, keySha, "skipped", "BUDGET_RUNS_PER_DAY", runId);
    }
    const flights = this.inFlight.get(spec.id) as Set<AbortController>;
    if (flights.size >= spec.budget.concurrency)
      return this.skip(spec, req.source, keySha, "skipped", "BUDGET_CONCURRENCY", runId);
    if (!claim(true))
      return this.skip(spec, req.source, keySha, "error", "STATE_WRITE_FAILED", runId);
    const controller = new AbortController();
    flights.add(controller);
    // The slot is held until the executor's own promise settles, not until the row is
    // written: a timed-out or killed run whose executor ignores the signal still counts
    // toward `concurrency`, so the budget caps what runs, not only what is reported.
    let freeSlot: () => void = () => {};
    const slot = new Promise<void>((resolve) => {
      freeSlot = resolve;
    });
    this.slots.add(slot);
    const release = () => {
      flights.delete(controller);
      this.slots.delete(slot);
      freeSlot();
    };
    let executorStarted = false;
    const done = this.run(spec, req, keySha, runId, controller, (executing) => {
      executorStarted = true;
      void executing.then(release, release);
    });
    const releaseIfNotStarted = () => {
      if (!executorStarted) release();
    };
    done.then(releaseIfNotStarted, releaseIfNotStarted);
    return { admission: { admitted: true, runId }, done };
  }

  private nullRow(req: TriggerRequest, keySha: string): RunRecord {
    const now = this.iso(this.opts.clock.now());
    return {
      kind: RUN_ROW_KIND,
      scheduleId: req.scheduleId,
      taskId: null,
      runId: null,
      source: req.source,
      triggerKeySha256: keySha,
      status: "skipped",
      verdict: null,
      accepted: false,
      reasonCodes: [],
      codes: ["UNKNOWN_SCHEDULE"],
      simulated: true,
      evidence: false,
      startedAt: now,
      endedAt: now,
    };
  }

  private async run(
    spec: ScheduleSpec,
    req: TriggerRequest,
    keySha: string,
    runId: string,
    controller: AbortController,
    hold: (executing: Promise<unknown>) => void,
  ): Promise<RunRecord> {
    const startedAt = this.iso(this.opts.clock.now());
    const base = {
      kind: RUN_ROW_KIND as typeof RUN_ROW_KIND,
      scheduleId: spec.id,
      taskId: spec.taskId,
      runId,
      source: req.source,
      triggerKeySha256: keySha,
      evidence: false as const,
      startedAt,
    };
    const end = (m: Mapped) =>
      this.finish({ ...base, ...m, endedAt: this.iso(this.opts.clock.now()) });
    const plain = (status: RunStatus, code: string): Mapped => ({
      status,
      verdict: null,
      accepted: false,
      reasonCodes: [],
      codes: [code],
      simulated: true,
    });

    for (const policy of this.opts.policies) {
      let decision: unknown;
      try {
        decision = await policy.evaluate({
          scheduleId: spec.id,
          taskId: spec.taskId,
          runId,
          source: req.source,
        });
      } catch (e) {
        this.diag(`POLICY_ERROR:${errorCode(e)}`);
        return end(plain("denied", "POLICY_ERROR"));
      }
      if (isObj(decision) && decision.allow === true) continue;
      if (
        isObj(decision) &&
        decision.allow === false &&
        typeof decision.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(decision.code)
      )
        return end({
          ...plain("denied", "POLICY_DENIED"),
          codes: ["POLICY_DENIED", decision.code],
        });
      return end(plain("denied", "POLICY_INVALID"));
    }
    // A kill that landed while the policies ran is a kill, not a quiet pause.
    if (controller.signal.aborted) return end(plain("killed", "KILLED"));
    // Paused while the policies ran: the claim stays (the key and its runs/day slot are
    // used up), so the trigger does not run later. See README "Pause / kill".
    if (this.opts.state.isPaused()) return end(plain("skipped", "PAUSED"));

    let cancelTimer: () => void = () => {};
    const stop = new Promise<"timeout" | "killed">((resolve) => {
      cancelTimer = this.opts.clock.setTimer(spec.budget.wallTimeS * 1000, () => {
        resolve("timeout"); // first: the abort listener below would otherwise win the race
        controller.abort(new Error("timeout"));
      });
      controller.signal.addEventListener("abort", () => resolve("killed"), { once: true });
    });
    try {
      const work = this.opts.executor
        .run({
          scheduleId: spec.id,
          taskId: spec.taskId,
          runId,
          source: req.source,
          ...(req.inboxFile ? { inboxFile: req.inboxFile } : {}),
          signal: controller.signal,
        })
        .then(
          (r) => ({ ok: true as const, r }),
          (e: unknown) => ({ ok: false as const, e }),
        );
      hold(work);
      const first = await Promise.race([work, stop]);
      if (first === "timeout" || first === "killed") {
        // Recorded now; the slot stays held until `work` settles (see `submit`).
        return first === "timeout"
          ? end(plain("timeout", "BUDGET_WALL_TIME"))
          : end(plain("killed", "KILLED"));
      }
      if (!first.ok) {
        this.diag(`EXECUTOR_ERROR:${errorCode(first.e)}`);
        return end(plain("error", "EXECUTOR_ERROR"));
      }
      return end(mapOutcome(first.r, runId));
    } finally {
      cancelTimer();
    }
  }

  /**
   * One evaluation: cron slots since the last cursor, new inbox files, manual spool files.
   * Synchronous admission; each `done` resolves when that run's row is written.
   */
  tick(): Submission[] {
    const out: Submission[] = [];
    const now = this.opts.clock.now();
    const paused = this.opts.state.isPaused();
    const cursor = this.opts.state.readCursor() ?? now;
    for (const spec of this.specs.values()) {
      if (!spec.cron) continue;
      const { slots, total } = cronSlotsBetween(spec.cron, cursor, now);
      if (total === 0) continue;
      if (paused) {
        out.push(this.missed(spec, "PAUSED", slots, total));
        continue;
      }
      const onTime = slots.filter((s) => now - s <= this.graceMs);
      const late = slots.filter((s) => now - s > this.graceMs);
      let lateTotal = total - onTime.length;
      if (lateTotal > 0 && spec.missed === "run-latest" && onTime.length === 0) {
        const latest = late.pop() as number;
        lateTotal--;
        out.push(this.submit({ scheduleId: spec.id, source: "cron", key: this.iso(latest) }));
      }
      if (lateTotal > 0 && late.length > 0) out.push(this.missed(spec, "MISSED", late, lateTotal));
      for (const s of onTime)
        out.push(this.submit({ scheduleId: spec.id, source: "cron", key: this.iso(s) }));
    }
    try {
      this.opts.state.writeCursor(now);
    } catch (e) {
      this.diag(`STATE_WRITE_FAILED:${errorCode(e)}`);
    }
    if (paused) return out;
    for (const spec of this.specs.values()) {
      if (!spec.events.inbox) continue;
      let files: { name: string; sha256: string }[];
      try {
        files = scanInbox(spec.events.inbox.dir, this.hashCache);
      } catch (e) {
        this.diag(`INBOX_UNREADABLE:${errorCode(e)}`);
        continue;
      }
      for (const f of files) {
        const key = `${f.name}\0${f.sha256}`;
        if (this.opts.state.has(triggerKeySha256(spec.id, "inbox", key))) continue;
        // Queued, not refused: an arrival waits for a free slot instead of being dropped.
        if (this.running(spec.id) >= spec.budget.concurrency) break;
        out.push(this.submit({ scheduleId: spec.id, source: "inbox", key, inboxFile: f }));
      }
    }
    out.push(...this.drainManualSpool());
    return out;
  }

  private missed(spec: ScheduleSpec, code: string, slots: number[], total: number): Submission {
    const first = slots[0] as number;
    const last = slots[slots.length - 1] as number;
    const keySha = sha256(
      `myco.schedule.summary/v1\0${spec.id}\0${code}\0${first}\0${last}\0${total}`,
    );
    const at = this.iso(this.opts.clock.now());
    return {
      admission: { admitted: false, code },
      done: this.finish({
        kind: RUN_ROW_KIND,
        scheduleId: spec.id,
        taskId: spec.taskId,
        runId: null,
        source: "cron",
        triggerKeySha256: keySha,
        status: "skipped",
        verdict: null,
        accepted: false,
        reasonCodes: [],
        codes: [code],
        simulated: true,
        evidence: false,
        startedAt: at,
        endedAt: at,
        missedSlots: { count: total, firstAt: this.iso(first), lastAt: this.iso(last) },
      }),
    };
  }

  private drainManualSpool(): Submission[] {
    return drainSpool(
      this.opts.state.manualDir,
      (scheduleId, key) => {
        const spec = this.specs.get(scheduleId);
        // Queued, like an inbox arrival: a manual request waits for a free slot.
        if (spec && this.running(scheduleId) >= spec.budget.concurrency) return undefined;
        return this.submit({ scheduleId, source: "manual", key });
      },
      (code) => this.diag(code),
    );
  }
}
