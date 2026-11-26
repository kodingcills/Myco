/** Track S: the `myco-schedule` operator commands ($0: scripted executor, no webhook port). */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkChainedLedger } from "../../src/integrity/ledger.ts";
import { main } from "../../src/schedule/cli.ts";
import { tmp } from "./helpers.ts";

const KEY_HEX = "0f".repeat(32);

function fixture(extra: Record<string, unknown> = {}) {
  const dir = tmp("myco-sched-cli-");
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", "s.env"), `MYCO_SCHEDULE_LEDGER_KEY=${KEY_HEX}\n`, {
    mode: 0o600,
  });
  const config = join(dir, "schedule.json");
  writeFileSync(
    config,
    JSON.stringify({
      version: "myco.schedule/v1",
      stateDir: join(dir, "state"),
      ledgerKey: { keyFile: join(dir, "secrets", "s.env"), keyName: "MYCO_SCHEDULE_LEDGER_KEY" },
      notifier: { kind: "file", path: join(dir, "notify.jsonl") },
      schedules: [
        {
          id: "ops",
          taskId: "fc-v1-001",
          events: { manual: true },
          budget: { runsPerDay: 5, wallTimeS: 60, concurrency: 1 },
        },
      ],
      ...extra,
    }),
  );
  return { dir, config };
}

function io(stopSignal?: Promise<void>) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      ...(stopSignal ? { stopSignal } : {}),
    },
  };
}

describe("myco-schedule", () => {
  it("trigger queues, serve runs it through the gate, pause/kill/resume/status work", {
    timeout: 30_000,
  }, async () => {
    const { dir, config } = fixture();
    let t = io();
    expect(
      await main(["trigger", "--config", config, "--schedule", "ops", "--key", "req-1"], t.io),
    ).toBe(0);
    expect(JSON.parse(t.out[0] as string)).toEqual({
      code: "QUEUED",
      scheduleId: "ops",
      key: "req-1",
    });
    let stop: () => void = () => {};
    const stopped = new Promise<void>((r) => {
      stop = r;
    });
    t = io(stopped);
    const serving = main(["serve", "--config", config, "--allow-task", "fc-v1-001"], t.io);
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(await serving).toBe(0);
    expect(t.out.map((l) => JSON.parse(l).code)).toEqual(["SERVING", "STOPPED"]);
    expect(JSON.parse(t.out[1] as string).rows).toBe(1);
    const chain = checkChainedLedger(
      join(dir, "state", "ledger.jsonl"),
      Buffer.from(KEY_HEX, "hex"),
      "myco.schedule.ledger/v1",
    );
    expect(chain.rows.map((r) => [r.status, r.source, r.simulated])).toEqual([
      ["verified", "manual", true],
    ]);

    for (const [cmd, code] of [
      ["pause", "PAUSED"],
      ["kill", "KILLED"],
      ["resume", "RESUMED"],
    ] as const) {
      t = io();
      expect(await main([cmd, "--config", config], t.io)).toBe(0);
      expect(JSON.parse(t.out[0] as string).code).toBe(code);
    }
    t = io();
    expect(await main(["status", "--config", config], t.io)).toBe(0);
    expect(JSON.parse(t.out[0] as string)).toMatchObject({
      paused: null,
      ledgerRows: 1,
      schedules: ["ops"],
    });
    const all =
      [...t.out, ...t.err].join("") + readFileSync(join(dir, "state", "ledger.jsonl"), "utf8");
    expect(all).not.toContain(KEY_HEX);
  });

  it("serve refuses to start without a policy; bad input exits non-zero without echoing values", async () => {
    const { config } = fixture();
    let t = io();
    expect(await main(["serve", "--config", config], t.io)).toBe(1);
    expect(t.err.join("")).toMatch(/--allow-task/);
    t = io();
    expect(await main(["trigger", "--config", config, "--schedule", "nope"], t.io)).toBe(1);
    const planted = fixture({
      tickSeconds: 30,
      notifier: { kind: "file", path: "/var/sk-ant-api03-PLANTED00000000000000" },
    });
    t = io();
    expect(await main(["status", "--config", planted.config], t.io)).toBe(2);
    expect(t.err.join("")).toMatch(/looks like a secret/);
    expect(t.err.join("")).not.toContain("PLANTED");
    t = io();
    expect(await main([], t.io)).toBe(2);
  });
});
