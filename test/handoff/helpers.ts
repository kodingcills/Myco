import type { HandoffClock } from "../../src/handoff/broker.ts";

/** A manual clock: timers fire only when `advance` passes their deadline. */
export class FakeClock implements HandoffClock {
  private t = Date.parse("2026-11-26T15:00:00.000Z");
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  setTimer(ms: number, fn: () => void): unknown {
    this.seq += 1;
    this.timers.set(this.seq, { at: this.t + ms, fn });
    return this.seq;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Move time forward, firing due timers in deadline order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }

  get pending(): number {
    return this.timers.size;
  }
}

/** Let queued promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Every string anywhere in a JSON value. */
export function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value !== null && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allStrings(v, out);
    }
  return out;
}
