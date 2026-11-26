/**
 * Track S: the scheduler's pluggable seams — clock, policies, notifier, executor.
 *
 * Each seam is a small interface so tests run at $0 with a fake clock and scripted agents,
 * and so sibling tracks plug in without this module importing their unmerged code:
 *  - `RunPolicy` is the track O policy interface as the scheduler consumes it (lands with O:
 *    O's policy engine is adapted to this one method). The scheduler requires at least one
 *    policy and applies every policy to every trigger, whatever its source.
 *  - `RunExecutor` runs one trial; the production shape goes through `runGatedTrial`
 *    (src/schedule/executor.ts).
 */

import type { TriggerSource } from "./config.ts";

export interface Clock {
  /** ms since epoch. */
  now(): number;
  /** Call `fn` once after `ms`; returns a cancel function. */
  setTimer(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(ms, fn) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/** A deterministic clock for tests: time moves only on `advance`, which fires due timers. */
export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  constructor(startMs: number) {
    this.t = startMs;
  }
  now(): number {
    return this.t;
  }
  setTimer(ms: number, fn: () => void): () => void {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return () => {
      this.timers.delete(id);
    };
  }
  /** Move time forward by `ms`, firing timers in time order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
  get pendingTimers(): number {
    return this.timers.size;
  }
}

export interface PolicyContext {
  readonly scheduleId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly source: TriggerSource;
}

export type PolicyDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly code: string };

/** The track O policy interface as consumed here (lands with O). */
export interface RunPolicy {
  readonly id: string;
  evaluate(ctx: PolicyContext): PolicyDecision | Promise<PolicyDecision>;
}

/** A local default: only the listed task ids may run on a schedule. */
export function taskAllowListPolicy(taskIds: readonly string[]): RunPolicy {
  const allowed = new Set(taskIds);
  return {
    id: "local.task-allow-list",
    evaluate: (ctx) =>
      allowed.has(ctx.taskId) ? { allow: true } : { allow: false, code: "TASK_NOT_ALLOWED" },
  };
}

/** What a failure notification carries: ids and codes only, never a payload or a reason text. */
export interface RunNotification {
  readonly kind: "myco.schedule.notification/v1";
  readonly scheduleId: string;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly source: TriggerSource;
  readonly status: string;
  readonly codes: readonly string[];
  readonly at: string;
}

export interface Notifier {
  notify(n: RunNotification): void | Promise<void>;
}
