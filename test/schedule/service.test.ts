/** Track S: the service wiring — the KILLED switch from the CLI, and ledger-key loading. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScheduleFile } from "../../src/schedule/config.ts";
import { FakeClock } from "../../src/schedule/runtime.ts";
import { startScheduleService } from "../../src/schedule/service.ts";
import { allowAll, decided, flush, MemoryNotifier, StubExecutor, T0, tmp } from "./helpers.ts";

function config(dir: string, keyLine: string) {
  mkdirSync(join(dir, "secrets"), { recursive: true });
  writeFileSync(join(dir, "secrets", "s.env"), `${keyLine}\n`, { mode: 0o600 });
  return parseScheduleFile(
    JSON.stringify({
      version: "myco.schedule/v1",
      stateDir: join(dir, "state"),
      ledgerKey: { keyFile: join(dir, "secrets", "s.env"), keyName: "MYCO_SCHEDULE_LEDGER_KEY" },
      tickSeconds: 10,
      schedules: [
        {
          id: "ops",
          taskId: "fc-v1-001",
          events: { manual: true },
          budget: { runsPerDay: 5, wallTimeS: 600, concurrency: 1 },
        },
      ],
    }),
  );
}

describe("schedule service", () => {
  it("a KILLED pause file (myco-schedule kill) aborts runs in flight on the next tick", async () => {
    const dir = tmp();
    const clock = new FakeClock(T0);
    const ex = new StubExecutor(
      (req) =>
        new Promise((r) => req.signal.addEventListener("abort", () => r(decided(req, "verified")))),
    );
    const svc = await startScheduleService({
      config: config(dir, `MYCO_SCHEDULE_LEDGER_KEY=${"1a".repeat(32)}`),
      clock,
      executor: ex,
      policies: [allowAll],
      notifier: new MemoryNotifier(),
    });
    svc.scheduler.submit({ scheduleId: "ops", source: "manual", key: "a" });
    await flush();
    expect(svc.scheduler.running("ops")).toBe(1);
    svc.state.pause("KILLED");
    clock.advance(10_000);
    await flush();
    expect(ex.calls[0]?.signal.aborted).toBe(true);
    expect(svc.scheduler.running("ops")).toBe(0);
    await svc.stop();
  });

  it("a plain pause does not abort runs in flight", async () => {
    const dir = tmp();
    const clock = new FakeClock(T0);
    const ex = new StubExecutor(
      (req) =>
        new Promise((r) => req.signal.addEventListener("abort", () => r(decided(req, "verified")))),
    );
    const svc = await startScheduleService({
      config: config(dir, `MYCO_SCHEDULE_LEDGER_KEY=${"1a".repeat(32)}`),
      clock,
      executor: ex,
      policies: [allowAll],
      notifier: new MemoryNotifier(),
      loop: true,
    });
    svc.scheduler.submit({ scheduleId: "ops", source: "manual", key: "a" });
    await flush();
    svc.state.pause("PAUSED");
    clock.advance(10_000);
    await flush();
    expect(ex.calls[0]?.signal.aborted).toBe(false);
    svc.scheduler.kill();
    await svc.stop();
  });

  it("refuses a ledger key that is not 64 hex characters, without echoing it", async () => {
    const dir = tmp();
    const bad = "MYCO_SCHEDULE_LEDGER_KEY=PLANTED-not-hex";
    let message = "";
    try {
      await startScheduleService({
        config: config(dir, bad),
        clock: new FakeClock(T0),
        executor: new StubExecutor(),
        policies: [allowAll],
        loop: false,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/must be 64 hex characters/);
    expect(message).not.toContain("PLANTED");
  });
});
