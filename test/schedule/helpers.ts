/** Track S test helpers: a temp state dir, schedule specs, scripted executors. $0, no model. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduleSpec } from "../../src/schedule/config.ts";
import { parseCron } from "../../src/schedule/cron.ts";
import {
  FakeClock,
  type Notifier,
  type RunNotification,
  type RunPolicy,
} from "../../src/schedule/runtime.ts";
import {
  type ExecutorResult,
  type RunExecutor,
  type RunRequest,
  Scheduler,
} from "../../src/schedule/scheduler.ts";
import { ScheduleState } from "../../src/schedule/state.ts";

export const T0 = Date.UTC(2026, 10, 26, 10, 0, 0); // 2026-11-26T10:00:00Z
export const KEY = new Uint8Array(32).fill(7);
export const allowAll: RunPolicy = { id: "test.allow", evaluate: () => ({ allow: true }) };

export function tmp(prefix = "myco-sched-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function spec(over: Partial<ScheduleSpec> & { cronText?: string } = {}): ScheduleSpec {
  const { cronText, ...rest } = over;
  return {
    id: "nightly",
    taskId: "fc-v1-001",
    ...(cronText ? { cron: parseCron(cronText) } : {}),
    events: { webhook: true, manual: true },
    budget: { runsPerDay: 100, wallTimeS: 600, concurrency: 1 },
    missed: "skip",
    ...rest,
  };
}

export function decided(
  req: Pick<RunRequest, "runId">,
  verdict: "verified" | "refuted" | "uncertain",
  extra: { accepted?: boolean; reasonCodes?: string[]; simulated?: boolean } = {},
): ExecutorResult {
  const accepted = extra.accepted ?? verdict === "verified";
  const reasonCodes =
    extra.reasonCodes ??
    (verdict === "verified"
      ? ["ORACLE_PASS"]
      : verdict === "refuted"
        ? ["ORACLE_FAIL"]
        : ["STATE_MISSING"]);
  return {
    outcome: {
      status: "decided",
      result: { verdict, accepted, reasonCodes, request: { runId: req.runId } },
    },
    simulated: extra.simulated ?? true,
  };
}

export class StubExecutor implements RunExecutor {
  readonly calls: RunRequest[] = [];
  constructor(
    public impl: (req: RunRequest) => Promise<ExecutorResult> = async (r) => decided(r, "verified"),
  ) {}
  run(req: RunRequest): Promise<ExecutorResult> {
    this.calls.push(req);
    return this.impl(req);
  }
}

export class MemoryNotifier implements Notifier {
  readonly sent: RunNotification[] = [];
  notify(n: RunNotification): void {
    this.sent.push(n);
  }
}

export const flush = () => new Promise<void>((r) => setImmediate(r));

export function setup(o: {
  schedules?: ScheduleSpec[];
  policies?: RunPolicy[];
  executor?: StubExecutor;
  dir?: string;
  clock?: FakeClock;
  ledgerPath?: string;
}) {
  const dir = o.dir ?? tmp();
  const clock = o.clock ?? new FakeClock(T0);
  const state = new ScheduleState(join(dir, "state"));
  const executor = o.executor ?? new StubExecutor();
  const notifier = new MemoryNotifier();
  const diagnostics: string[] = [];
  const ledgerPath = o.ledgerPath ?? join(dir, "ledger.jsonl");
  const scheduler = new Scheduler({
    schedules: o.schedules ?? [spec()],
    state,
    clock,
    executor,
    policies: o.policies ?? [allowAll],
    notifier,
    ledger: { path: ledgerPath, key: KEY, ledgerId: "test" },
    onDiagnostic: (c) => diagnostics.push(c),
  });
  return { dir, clock, state, executor, notifier, diagnostics, ledgerPath, scheduler };
}
