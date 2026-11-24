/**
 * The per-directory run lock (TIF-190).
 *
 * The lock is a directory, which makes taking it atomic - but nothing removed it when
 * a run was killed. arm-003d's r6 was stopped with SIGKILL, left `.run-lock` behind,
 * and every later attempt died with `EEXIST: mkdir .../.run-lock` before a single
 * trial ran. The resume feature could not resume the run it had been built for, and
 * the only remedy was for an operator to know to `rmdir` a hidden directory first.
 *
 * Two properties matter, and they pull in opposite directions:
 *
 *  1. a lock left by a DEAD process must not block a resume  (the bug above)
 *  2. a lock held by a LIVE process must still block, loudly
 *
 * The second is the safety property: two sweeps sharing one directory share one
 * ledger, so the guard has to fail closed unless the owner is positively dead. Every
 * test here is about that boundary, not about the happy path.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedC1 } from "../../src/baseline/c1-trial.ts";
import type { Planner } from "../../src/baseline/planner.ts";
import { runC1Sweep } from "../../src/baseline/sweep.ts";

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "myco-runlock-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const shot = { type: "image", mimeType: "image/png", data: "eA==" };
function fakeMcp() {
  return {
    request: async (method: string, params: { name?: string }) => {
      if (method === "initialize") return { protocolVersion: "2025-11-25" };
      if (params.name === "get_window_state")
        return {
          content: [{ type: "text", text: "tree" }, shot],
          structuredContent: { element_token: "tree" },
        };
      return { structuredContent: { path: "pixel", verified: true } };
    },
    notify: async () => {},
  } as never;
}
function prepared(tick = { n: 0 }): PreparedC1 {
  return {
    driver: {
      hostVersion: "0.56.4",
      guestVersion: "0.56.4",
      pipeReachable: true,
      sessionIdentityMatches: true,
    },
    resetMs: 1,
    acPower: true,
    caffeinate: true,
    loadAvg1: 0,
    window: { pid: 1, window_id: 2 },
    connect: async () => fakeMcp(),
    closeTransport: async () => {},
    judge: async () => ({ kind: tick.n++ % 2 === 0 ? "persisted" : "driver-action" }),
    audit: async () => false,
  } as never;
}
const planner: Planner = {
  paid: true,
  act: async () => ({
    calls: [{ model: "claude-sonnet-5-5", usage: { prompt: 1, completion: 1, cost: 0.001 } }],
    decision: { tool: "click", arguments: { x: 1, y: 2 } },
  }),
} as never;

/** A pid that cannot be running: above the platform's max, and not our own. */
const DEAD_PID = 2_147_483_646;

describe("the run lock survives a killed run", () => {
  it("clears a lock left by a DEAD process instead of dying on EEXIST", async () => {
    const dir = directory();
    // Exactly what a SIGKILLed run leaves: the directory plus its owner marker.
    mkdirSync(join(dir, ".run-lock"), { mode: 0o700 });
    writeFileSync(join(dir, ".run-lock", "owner.pid"), `${DEAD_PID}\n`);

    // Before the fix this threw EEXIST before any trial ran, which is what made r6
    // unresumable without manual `rmdir`.
    const report = await runC1Sweep({
      coordinatorGo: true,
      directory: dir,
      planner,
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: { model: "claude-sonnet-5-5", snapshot: "cua-c1-base", planner: "paid" },
      prepare: async () => prepared(),
    });
    expect(report.rows.length).toBe(30);
  });

  it("clears a lock with NO owner marker (killed between mkdir and the write)", async () => {
    const dir = directory();
    mkdirSync(join(dir, ".run-lock"), { mode: 0o700 });
    const report = await runC1Sweep({
      coordinatorGo: true,
      directory: dir,
      planner,
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: { model: "claude-sonnet-5-5", snapshot: "cua-c1-base", planner: "paid" },
      prepare: async () => prepared(),
    });
    expect(report.rows.length).toBe(30);
  });

  it("REFUSES a lock held by a LIVE process, naming the pid", async () => {
    const dir = directory();
    mkdirSync(join(dir, ".run-lock"), { mode: 0o700 });
    // Our own pid is unambiguously alive, so this stands in for a concurrent sweep.
    writeFileSync(join(dir, ".run-lock", "owner.pid"), `${process.pid}\n`);

    // Fails closed: two sweeps in one directory would share one ledger.
    await expect(
      runC1Sweep({
        coordinatorGo: true,
        directory: dir,
        planner,
        priorSpendMicros: 0,
        armLimitMicros: 9_000_000,
        identity: { model: "claude-sonnet-5-5", snapshot: "cua-c1-base", planner: "paid" },
        prepare: async () => prepared(),
      }),
    ).rejects.toThrow(new RegExp(`held by live pid ${process.pid}`));
  });

  it("records its own pid, so a later run can tell alive from dead", async () => {
    const dir = directory();
    const lockOwner = join(dir, ".run-lock", "owner.pid");
    // Sample the marker while the sweep holds the lock: `prepare` is called per trial,
    // so the first call happens with the lock held.
    let observed: string | undefined;
    await runC1Sweep({
      coordinatorGo: true,
      directory: dir,
      planner,
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: { model: "claude-sonnet-5-5", snapshot: "cua-c1-base", planner: "paid" },
      prepare: async () => {
        if (observed === undefined && existsSync(lockOwner))
          observed = readFileSync(lockOwner, "utf8").trim();
        return prepared();
      },
    });
    // Without this the "dead owner" branch could never be distinguished from
    // "no owner", and every stale lock would look like a live one.
    expect(observed).toBe(String(process.pid));
  });

  it("releases the lock when the run ends, so the next one can start", async () => {
    const dir = directory();
    const base = {
      coordinatorGo: true,
      directory: dir,
      planner,
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: { model: "claude-sonnet-5-5", snapshot: "cua-c1-base", planner: "paid" },
    };
    await runC1Sweep({ ...base, prepare: async () => prepared() });
    expect(existsSync(join(dir, ".run-lock"))).toBe(false);
    // And a second run is therefore admitted.
    await expect(runC1Sweep({ ...base, prepare: async () => prepared() })).resolves.toMatchObject({
      rows: expect.any(Array),
    });
  });
});
