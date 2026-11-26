/**
 * Track S: the scheduler's guards, on a fake clock with scripted executors ($0, no model).
 * Each guard here has a mutation proof in the PR body: break the guard, this file fails.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkChainedLedger } from "../../src/integrity/ledger.ts";
import { writeManualRequest } from "../../src/schedule/manual.ts";
import { FakeClock, taskAllowListPolicy } from "../../src/schedule/runtime.ts";
import { mapOutcome, Scheduler } from "../../src/schedule/scheduler.ts";
import { ScheduleState, triggerKeySha256 } from "../../src/schedule/state.ts";
import {
  allowAll,
  decided,
  flush,
  KEY,
  MemoryNotifier,
  StubExecutor,
  setup,
  spec,
  T0,
  tmp,
} from "./helpers.ts";

const MIN = 60_000;
const ledgerRows = (path: string) => {
  const c = checkChainedLedger(path, KEY, "test");
  expect(c.ok).toBe(true);
  return c.rows;
};

describe("cron triggers", () => {
  it("run on matching minutes only, through the executor, and land in the chained ledger", async () => {
    const s = setup({ schedules: [spec({ cronText: "*/15 * * * *" })] });
    expect(s.scheduler.tick()).toEqual([]); // first tick sets the cursor, no catch-up
    s.clock.advance(14 * MIN);
    expect(s.scheduler.tick()).toEqual([]);
    s.clock.advance(1 * MIN);
    const subs = s.scheduler.tick();
    expect(subs).toHaveLength(1);
    const rec = await subs[0]?.done;
    expect(rec).toMatchObject({
      status: "verified",
      accepted: true,
      source: "cron",
      evidence: false,
      simulated: true,
    });
    expect(s.executor.calls[0]?.taskId).toBe("fc-v1-001");
    expect(ledgerRows(s.ledgerPath)).toHaveLength(1);
    expect(s.notifier.sent).toEqual([]);
  });

  it("are idempotent: a re-evaluated slot and a restarted service never run twice", async () => {
    const s = setup({ schedules: [spec({ cronText: "* * * * *" })] });
    s.scheduler.tick();
    s.clock.advance(MIN);
    await Promise.all(s.scheduler.tick().map((x) => x.done));
    expect(s.executor.calls).toHaveLength(1);
    // Rewind the cursor: the same slot is evaluated again.
    s.state.writeCursor(T0);
    const again = s.scheduler.tick();
    expect(again.map((x) => x.admission)).toEqual([{ admitted: false, code: "DUPLICATE" }]);
    await Promise.all(again.map((x) => x.done));
    // Restart: new state object and scheduler over the same directory.
    const state2 = new ScheduleState(s.state.dir);
    state2.writeCursor(T0);
    const s2 = new Scheduler({
      schedules: [spec({ cronText: "* * * * *" })],
      state: state2,
      clock: s.clock,
      executor: s.executor,
      policies: [allowAll],
      notifier: new MemoryNotifier(),
      ledger: { path: s.ledgerPath, key: KEY, ledgerId: "test" },
    });
    const r = s2.tick();
    expect(r.map((x) => x.admission)).toEqual([{ admitted: false, code: "DUPLICATE" }]);
    await Promise.all(r.map((x) => x.done));
    expect(s.executor.calls).toHaveLength(1);
    expect(s.notifier.sent).toEqual([]); // duplicates are quiet
  });

  it("missed slots, policy skip: one MISSED summary row, no run", async () => {
    const s = setup({ schedules: [spec({ cronText: "0 * * * *" })] });
    s.scheduler.tick();
    s.clock.advance(5 * 60 * MIN + 30 * MIN); // down for 5.5 hours: 5 hourly slots, all late
    const subs = s.scheduler.tick();
    expect(subs).toHaveLength(1);
    const rec = await subs[0]?.done;
    expect(rec).toMatchObject({ status: "skipped", codes: ["MISSED"], missedSlots: { count: 5 } });
    expect(s.executor.calls).toHaveLength(0);
    expect(s.notifier.sent.map((n) => n.codes)).toEqual([["MISSED"]]);
  });

  it("missed slots, policy run-latest: the latest slot runs once, the rest are summarised", async () => {
    const s = setup({ schedules: [spec({ cronText: "0 * * * *", missed: "run-latest" })] });
    s.scheduler.tick();
    s.clock.advance(5 * 60 * MIN + 30 * MIN);
    const recs = await Promise.all(s.scheduler.tick().map((x) => x.done));
    expect(recs.map((r) => r.status).sort()).toEqual(["skipped", "verified"]);
    expect(recs.find((r) => r.status === "skipped")?.missedSlots?.count).toBe(4);
    expect(s.executor.calls).toHaveLength(1);
  });

  it("a slot evaluated within the grace window counts as on time", async () => {
    const s = setup({ schedules: [spec({ cronText: "0 * * * *" })] });
    s.scheduler.tick();
    s.clock.advance(61 * MIN);
    const recs = await Promise.all(s.scheduler.tick().map((x) => x.done));
    expect(recs.map((r) => r.status)).toEqual(["verified"]);
  });
});

describe("global pause / kill switch", () => {
  it("pause stops cron, inbox and manual; paused slots are skipped quietly; queued events run after resume", async () => {
    const dir = tmp();
    const inbox = join(dir, "inbox");
    mkdirSync(inbox);
    const s = setup({
      dir,
      schedules: [
        spec({
          cronText: "* * * * *",
          events: { inbox: { dir: inbox }, webhook: true, manual: true },
        }),
      ],
    });
    s.scheduler.tick();
    s.scheduler.pause();
    writeFileSync(join(inbox, "report.csv"), "a,b\n");
    writeManualRequest(s.state.manualDir, "nightly", "req-1");
    s.clock.advance(3 * MIN);
    const paused = await Promise.all(s.scheduler.tick().map((x) => x.done));
    expect(paused.map((r) => [r.status, r.codes, r.missedSlots?.count])).toEqual([
      ["skipped", ["PAUSED"], 3],
    ]);
    expect(
      s.scheduler.submit({ scheduleId: "nightly", source: "webhook", key: "d1" }).admission,
    ).toEqual({ admitted: false, code: "PAUSED" });
    expect(s.executor.calls).toHaveLength(0);
    expect(s.notifier.sent).toEqual([]);
    s.scheduler.resume();
    s.clock.advance(10_000);
    const after = await Promise.all(s.scheduler.tick().map((x) => x.done));
    expect(after.map((r) => r.source).sort()).toEqual(["inbox"]); // manual waits: concurrency 1
    await Promise.all(s.scheduler.tick().map((x) => x.done));
    expect(s.executor.calls.map((c) => c.source)).toEqual(["inbox", "manual"]);
  });

  it("the PAUSED file alone pauses (operator touch), and kill aborts runs in flight; late results are ignored", async () => {
    let release: (() => void) | undefined;
    const ex = new StubExecutor(
      (req) =>
        new Promise((resolve) => {
          release = () => resolve(decided(req, "verified"));
        }),
    );
    const s = setup({ executor: ex });
    const sub = s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "k1" });
    expect(sub.admission.admitted).toBe(true);
    await flush();
    s.scheduler.kill();
    release?.();
    const rec = await sub.done;
    expect(rec).toMatchObject({ status: "killed", accepted: false, codes: ["KILLED"] });
    expect(ex.calls[0]?.signal.aborted).toBe(true);
    expect(s.state.isPaused()).toBe(true);
    s.scheduler.resume();
    writeFileSync(s.state.pausePath, "operator\n");
    expect(
      s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "k2" }).admission,
    ).toEqual({ admitted: false, code: "PAUSED" });
  });

  it("a pause that lands while policies are evaluated stops the run before the executor", async () => {
    let s: ReturnType<typeof setup> | undefined;
    const pausing = {
      id: "p",
      evaluate: () => {
        s?.scheduler.pause();
        return { allow: true as const };
      },
    };
    s = setup({ policies: [pausing] });
    const rec = await s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "k" })
      .done;
    expect(rec).toMatchObject({ status: "skipped", codes: ["PAUSED"] });
    expect(s.executor.calls).toHaveLength(0);
  });
});

describe("budgets", () => {
  it("runs/day: refuses past the budget (claimed, so not retried) and resets on the next UTC day", async () => {
    const s = setup({
      schedules: [spec({ budget: { runsPerDay: 2, wallTimeS: 60, concurrency: 4 } })],
    });
    for (const k of ["a", "b"])
      await s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: k }).done;
    const third = s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "c" });
    expect(third.admission).toEqual({ admitted: false, code: "BUDGET_RUNS_PER_DAY" });
    expect((await third.done).status).toBe("skipped");
    expect(
      s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "c" }).admission,
    ).toEqual({ admitted: false, code: "DUPLICATE" });
    s.clock.advance(14 * 60 * MIN); // past midnight UTC
    const d = s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "d" });
    expect(d.admission.admitted).toBe(true);
    await d.done;
    expect(s.executor.calls).toHaveLength(3);
    expect(s.notifier.sent.map((n) => n.codes)).toEqual([["BUDGET_RUNS_PER_DAY"]]);
  });

  it("runs/day survives a restart (counted from the durable claims)", async () => {
    const s = setup({
      schedules: [spec({ budget: { runsPerDay: 1, wallTimeS: 60, concurrency: 1 } })],
    });
    await s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" }).done;
    const s2 = setup({
      dir: s.dir,
      clock: s.clock,
      schedules: [spec({ budget: { runsPerDay: 1, wallTimeS: 60, concurrency: 1 } })],
    });
    expect(
      s2.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "b" }).admission,
    ).toEqual({ admitted: false, code: "BUDGET_RUNS_PER_DAY" });
  });

  it("concurrency: a second trigger while one is in flight is refused", async () => {
    let release: (() => void) | undefined;
    const ex = new StubExecutor(
      (req) =>
        new Promise((r) => {
          release = () => r(decided(req, "verified"));
        }),
    );
    const s = setup({ executor: ex });
    const a = s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" });
    const b = s.scheduler.submit({ scheduleId: "nightly", source: "webhook", key: "b" });
    expect(b.admission).toEqual({ admitted: false, code: "BUDGET_CONCURRENCY" });
    await flush();
    release?.();
    await a.done;
    expect(s.scheduler.running("nightly")).toBe(0);
    expect(
      s.scheduler.submit({ scheduleId: "nightly", source: "webhook", key: "b" }).admission.admitted,
    ).toBe(true);
  });

  it("wall time: a run over budget is aborted and recorded timeout, never verified", async () => {
    const ex = new StubExecutor(
      (req) =>
        new Promise((r) => req.signal.addEventListener("abort", () => r(decided(req, "verified")))),
    );
    const s = setup({
      executor: ex,
      schedules: [spec({ budget: { runsPerDay: 5, wallTimeS: 30, concurrency: 1 } })],
    });
    const sub = s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" });
    await flush();
    s.clock.advance(29_000);
    await flush();
    s.clock.advance(1_000);
    const rec = await sub.done;
    expect(rec).toMatchObject({ status: "timeout", accepted: false, codes: ["BUDGET_WALL_TIME"] });
    expect(ex.calls[0]?.signal.aborted).toBe(true);
    expect(s.clock.pendingTimers).toBe(0);
  });
});

describe("policies (track O interface) are always applied", () => {
  it("the scheduler refuses to start with no policy", () => {
    expect(() => setup({ policies: [] })).toThrow(/at least one policy/);
  });

  for (const source of ["cron", "inbox", "webhook", "manual"] as const) {
    it(`a denying policy stops a ${source} trigger before the executor`, async () => {
      const dir = tmp();
      const s = setup({
        dir,
        schedules: [
          spec({ cronText: "* * * * *", events: { inbox: { dir }, webhook: true, manual: true } }),
        ],
        policies: [allowAll, taskAllowListPolicy(["some-other-task"])],
      });
      const rec = await s.scheduler.submit({ scheduleId: "nightly", source, key: "k" }).done;
      expect(rec).toMatchObject({
        status: "denied",
        accepted: false,
        codes: ["POLICY_DENIED", "TASK_NOT_ALLOWED"],
      });
      expect(s.executor.calls).toHaveLength(0);
      expect(s.notifier.sent).toHaveLength(1);
    });
  }

  it("a throwing policy denies (POLICY_ERROR), a malformed decision denies (POLICY_INVALID)", async () => {
    const throwing = {
      id: "t",
      evaluate: () => {
        throw new Error("/secret/path");
      },
    };
    const s = setup({ policies: [throwing] });
    expect(
      await s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" }).done,
    ).toMatchObject({ status: "denied", codes: ["POLICY_ERROR"] });
    expect(s.diagnostics).toContain("POLICY_ERROR:Error");
    for (const bad of [
      undefined,
      { allow: "yes" },
      { allow: false },
      { allow: false, code: "not a code" },
      true,
    ]) {
      const t = setup({ policies: [{ id: "m", evaluate: () => bad as never }] });
      expect(
        await t.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" }).done,
      ).toMatchObject({ status: "denied", codes: ["POLICY_INVALID"] });
      expect(t.executor.calls).toHaveLength(0);
    }
  });
});

describe("verdict mapping fails closed", () => {
  const R = { runId: "sched-x-1" };
  const cases: [string, unknown, string, string[]][] = [
    ["verified + accepted + ORACLE_PASS", decided(R, "verified"), "verified", []],
    [
      "verified but accepted false",
      decided(R, "verified", { accepted: false }),
      "uncertain",
      ["RESULT_INCONSISTENT"],
    ],
    [
      "verified without ORACLE_PASS",
      decided(R, "verified", { reasonCodes: [] }),
      "uncertain",
      ["RESULT_INCONSISTENT"],
    ],
    [
      "refuted but accepted true",
      decided(R, "refuted", { accepted: true }),
      "refuted",
      ["RESULT_INCONSISTENT"],
    ],
    [
      "a result for another run",
      decided({ runId: "other" }, "verified"),
      "uncertain",
      ["RESULT_RUN_MISMATCH"],
    ],
    [
      "launch audit refused",
      { outcome: { status: "refused" }, simulated: true },
      "refused",
      ["LAUNCH_AUDIT_REFUSED"],
    ],
    [
      "unknown verdict",
      {
        outcome: {
          status: "decided",
          result: { verdict: "VERIFIED", accepted: true, reasonCodes: ["ORACLE_PASS"], request: R },
        },
        simulated: true,
      },
      "error",
      ["EXECUTOR_INVALID_OUTPUT"],
    ],
    ["garbage", "verified", "error", ["EXECUTOR_INVALID_OUTPUT"]],
    ["no outcome", { simulated: false }, "error", ["EXECUTOR_INVALID_OUTPUT"]],
  ];
  for (const [name, result, status, codes] of cases) {
    it(name, () => {
      const m = mapOutcome(result, R.runId);
      expect([m.status, m.codes]).toEqual([status, codes]);
      expect(m.accepted).toBe(status === "verified");
    });
  }

  it("simulated is true unless the executor explicitly says false; rows are never evidence", async () => {
    expect(mapOutcome({ ...decided(R, "verified"), simulated: undefined }, R.runId).simulated).toBe(
      true,
    );
    expect(mapOutcome(decided(R, "verified", { simulated: false }), R.runId).simulated).toBe(false);
    const s = setup({
      executor: new StubExecutor(async (r) => decided(r, "verified", { simulated: false })),
    });
    const rec = await s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" })
      .done;
    expect(rec.evidence).toBe(false);
  });

  it("an executor that throws is an error, notified, with a code-only diagnostic", async () => {
    const s = setup({
      executor: new StubExecutor(async () => {
        throw new Error("leak /home/op/.myco/secrets");
      }),
    });
    const rec = await s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" })
      .done;
    expect(rec).toMatchObject({ status: "error", accepted: false, codes: ["EXECUTOR_ERROR"] });
    expect(JSON.stringify([rec, s.notifier.sent, s.diagnostics])).not.toContain("/home/op");
  });

  it("refuted and uncertain results notify with the gate's reason codes", async () => {
    const s = setup({
      schedules: [spec({ budget: { runsPerDay: 9, wallTimeS: 9, concurrency: 2 } })],
      executor: new StubExecutor(async (r) =>
        decided(r, r.source === "manual" ? "refuted" : "uncertain"),
      ),
    });
    await s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" }).done;
    await s.scheduler.submit({ scheduleId: "nightly", source: "webhook", key: "b" }).done;
    expect(s.notifier.sent.map((n) => [n.status, n.codes])).toEqual([
      ["refuted", ["ORACLE_FAIL"]],
      ["uncertain", ["STATE_MISSING"]],
    ]);
  });
});

describe("ledger, notifier and state failures", () => {
  it("a ledger write failure turns even a verified run into error/LEDGER_FAILED, notified", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "ledger-is-a-dir"));
    const s = setup({ dir, ledgerPath: join(dir, "ledger-is-a-dir") });
    const rec = await s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" })
      .done;
    expect(rec).toMatchObject({ status: "error", accepted: false, verdict: null });
    expect(rec.codes).toContain("LEDGER_FAILED");
    expect(s.notifier.sent).toHaveLength(1);
  });

  it("a throwing notifier never changes the record", async () => {
    const s = setup({ executor: new StubExecutor(async (r) => decided(r, "refuted")) });
    (s.notifier as { notify: unknown }).notify = () => {
      throw new Error("smtp down");
    };
    const rec = await s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" })
      .done;
    expect(rec.status).toBe("refuted");
    expect(s.diagnostics).toContain("NOTIFIER_FAILED:Error");
  });

  it("a corrupt claims file refuses to start (forgetting a claim could double-run)", () => {
    const s = setup({});
    writeFileSync(join(s.state.dir, "claims.jsonl"), '{"keySha256":"x"\n');
    expect(() => new ScheduleState(s.state.dir)).toThrow(/refusing to start/);
  });

  it("a claim that cannot be written does not run", async () => {
    const s = setup({});
    mkdirSync(join(s.state.dir, "claims.jsonl"));
    const sub = s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" });
    expect(sub.admission).toEqual({ admitted: false, code: "STATE_WRITE_FAILED" });
    expect((await sub.done).status).toBe("error");
    expect(s.executor.calls).toHaveLength(0);
  });

  it("unknown schedules and disabled sources do not run", async () => {
    const s = setup({ schedules: [spec({ events: { webhook: false, manual: true } })] });
    expect(
      s.scheduler.submit({ scheduleId: "nope", source: "manual", key: "a" }).admission,
    ).toEqual({ admitted: false, code: "UNKNOWN_SCHEDULE" });
    expect(
      s.scheduler.submit({ scheduleId: "nightly", source: "webhook", key: "a" }).admission,
    ).toEqual({ admitted: false, code: "SOURCE_NOT_ENABLED" });
    expect(
      s.scheduler.submit({ scheduleId: "nightly", source: "cron", key: "a" }).admission,
    ).toEqual({ admitted: false, code: "SOURCE_NOT_ENABLED" });
    expect(s.executor.calls).toHaveLength(0);
  });
});

describe("inbox and manual triggers", () => {
  it("inbox: regular visible files only, each name+content once, re-delivery with new content runs again", async () => {
    const dir = tmp();
    const inbox = join(dir, "inbox");
    mkdirSync(inbox);
    const s = setup({
      dir,
      schedules: [
        spec({
          events: { inbox: { dir: inbox }, webhook: false, manual: false },
          budget: { runsPerDay: 50, wallTimeS: 60, concurrency: 4 },
        }),
      ],
    });
    writeFileSync(join(dir, "outside.csv"), "x");
    symlinkSync(join(dir, "outside.csv"), join(inbox, "link.csv"));
    writeFileSync(join(inbox, ".partial.csv"), "x");
    mkdirSync(join(inbox, "sub"));
    writeFileSync(join(inbox, "a.csv"), "1");
    await Promise.all(s.scheduler.tick().map((x) => x.done));
    expect(s.executor.calls.map((c) => c.inboxFile?.name)).toEqual(["a.csv"]);
    expect(s.scheduler.tick()).toEqual([]); // seen: no row, no run
    writeFileSync(join(inbox, "a.csv"), "2");
    await Promise.all(s.scheduler.tick().map((x) => x.done));
    expect(s.executor.calls).toHaveLength(2);
    expect(s.executor.calls[1]?.inboxFile?.sha256).not.toBe(s.executor.calls[0]?.inboxFile?.sha256);
  });

  it("manual: a request id runs once; a malformed request is deleted and never runs", async () => {
    const s = setup({
      schedules: [spec({ budget: { runsPerDay: 9, wallTimeS: 60, concurrency: 4 } })],
    });
    writeManualRequest(s.state.manualDir, "nightly", "req-1");
    writeFileSync(
      join(s.state.manualDir, "bad.json"),
      JSON.stringify({ scheduleId: "nightly", taskId: "evil" }),
    );
    await Promise.all(s.scheduler.tick().map((x) => x.done));
    writeManualRequest(s.state.manualDir, "nightly", "req-1");
    const again = s.scheduler.tick();
    expect(again.map((x) => x.admission)).toEqual([{ admitted: false, code: "DUPLICATE" }]);
    await Promise.all(again.map((x) => x.done));
    expect(s.executor.calls).toHaveLength(1);
    expect(s.diagnostics).toContain("MANUAL_REQUEST_INVALID");
    expect(s.scheduler.tick()).toEqual([]);
  });

  it("trigger keys are digests: the ledger holds no raw delivery id or file name", async () => {
    const s = setup({});
    await s.scheduler.submit({
      scheduleId: "nightly",
      source: "webhook",
      key: "delivery-PLANTED-123", // gitleaks:allow (synthetic delivery id, not a secret)
    }).done;
    const rows = ledgerRows(s.ledgerPath);
    expect(JSON.stringify(rows)).not.toContain("PLANTED");
    expect(rows[0]?.triggerKeySha256).toBe(
      triggerKeySha256("nightly", "webhook", "delivery-PLANTED-123"),
    );
  });
});

it("FakeClock fires timers in order and only up to the target time", () => {
  const c = new FakeClock(0);
  const seen: number[] = [];
  c.setTimer(20, () => seen.push(20));
  c.setTimer(10, () => seen.push(10));
  const cancel = c.setTimer(15, () => seen.push(15));
  cancel();
  c.advance(19);
  expect(seen).toEqual([10]);
  c.advance(1);
  expect(seen).toEqual([10, 20]);
  expect(c.now()).toBe(20);
});

void T0;
