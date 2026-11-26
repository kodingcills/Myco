/**
 * Track E: resume from the append-only ledger, with a fake runner. Re-running skips recorded
 * trials, never duplicates a row and never rewrites history, including after a crash
 * mid-trial (in-process and a real SIGKILL of a child runner) and a torn last line.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSha256 } from "../../src/pilot/config.ts";
import { fakeDriver, PILOT_DRY_RUN_PLANNER, virtualClock } from "../../src/pilot/dry-run.ts";
import {
  ledgerRows,
  loadLedger,
  PROGRESS_FILE,
  R1_ATTEMPT_LEDGER_FILE,
} from "../../src/pilot/ledger.ts";
import {
  acquireLock,
  HarnessFault,
  LOCK_FILE,
  type PilotDriver,
  runPilot,
} from "../../src/pilot/runner.ts";
import { config, dryRun, PUBLISHED, ROOT, SOURCES, tmp } from "./helpers.ts";

const ledgerText = (dir: string) => readFileSync(join(dir, PROGRESS_FILE), "utf8");

function finalRows(dir: string) {
  const { armRows } = ledgerRows(loadLedger(join(dir, PROGRESS_FILE)));
  return armRows;
}

describe("pilot resume from the ledger (track E)", () => {
  it("a re-run skips every recorded trial and appends nothing", async () => {
    const dir = tmp();
    const first = await dryRun(dir);
    expect(first.result).toMatchObject({ status: "complete", ran: 30, skipped: 0 });
    const before = ledgerText(dir);
    const driver = fakeDriver();
    const again = await dryRun(dir, { driver });
    expect(again.result).toMatchObject({ status: "complete", ran: 0, skipped: 30 });
    expect(driver.launched).toEqual([]);
    expect(ledgerText(dir)).toBe(before);
    const rows = finalRows(dir);
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.taskId)).size).toBe(30);
  });

  it("a crash mid-trial is closed as a harness crash on resume and re-run in place; history is kept", async () => {
    const dir = tmp();
    let n = 0;
    const crashing = fakeDriver({
      beforeAgent: () => {
        n++;
        if (n === 5) throw new Error("simulated runner crash (not a HarnessFault)");
      },
    });
    await expect(dryRun(dir, { driver: crashing })).rejects.toThrow(/simulated runner crash/);
    const crashed = ledgerText(dir);
    const state = loadLedger(join(dir, PROGRESS_FILE));
    const open = [...state.byTask.values()].flat().filter((a) => a.end === null);
    expect(open).toHaveLength(1);
    const crashedKey = open[0]?.start.trialKey as string;

    const resumed = await dryRun(dir);
    expect(resumed.result).toMatchObject({ status: "complete", ran: 26, skipped: 4 });
    const after = ledgerText(dir);
    expect(after.startsWith(crashed)).toBe(true); // Appended only: nothing rewritten.

    const final = loadLedger(join(dir, PROGRESS_FILE));
    const task = open[0]?.start.taskId as string;
    const attempts = final.byTask.get(task) ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.end).toMatchObject({
      outcome: "harness-fault",
      harnessClass: "crash",
      recovered: true,
    });
    expect(attempts[0]?.end?.armRow?.cause).toEqual({
      kind: "harness",
      detail: "harness fault: crash",
    });
    expect(attempts[1]?.start.supersedes).toBe(crashedKey);
    const rows = finalRows(dir);
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.trialKey)).size).toBe(30);
    expect(rows.some((r) => r.trialKey === crashedKey)).toBe(false);
  });

  it("a runner killed with SIGKILL mid-trial (stale lock, open attempt) resumes cleanly", {
    timeout: 60_000,
  }, async () => {
    const dir = tmp();
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", join(ROOT, "test", "pilot", "crash-child.ts"), dir, "3"],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    expect(child.signal).toBe("SIGKILL");
    expect(readFileSync(join(dir, LOCK_FILE), "utf8").trim()).toMatch(/^\d+$/);
    const before = ledgerText(dir);
    const resumed = await dryRun(dir);
    expect(resumed.result).toMatchObject({ status: "complete", ran: 28, skipped: 2 });
    expect(ledgerText(dir).startsWith(before)).toBe(true);
    const crashes = [...loadLedger(join(dir, PROGRESS_FILE)).byTask.values()]
      .flat()
      .filter((a) => a.end?.harnessClass === "crash");
    expect(crashes).toHaveLength(1);
    expect(finalRows(dir)).toHaveLength(30);
  });

  it("a torn last line is closed with a marker, never rewritten", async () => {
    const dir = tmp();
    let n = 0;
    await expect(
      dryRun(dir, {
        driver: fakeDriver({
          beforeAgent: () => {
            if (++n === 2) throw new Error("crash");
          },
        }),
      }),
    ).rejects.toThrow();
    appendFileSync(join(dir, PROGRESS_FILE), '{"schema":"myco.pilot.attempt/1","event":"en');
    const torn = ledgerText(dir);
    const resumed = await dryRun(dir);
    expect(resumed.result.status).toBe("complete");
    const text = ledgerText(dir);
    expect(text.startsWith(torn)).toBe(true);
    expect(text).toContain('"event":"torn-previous-line"');
    expect(finalRows(dir)).toHaveLength(30);
    // And the ledger still loads after a third run.
    expect((await dryRun(dir)).result).toMatchObject({ ran: 0, skipped: 30 });
  });

  it("refuses to resume under a changed config, mode or planner", async () => {
    const dir = tmp();
    await dryRun(dir);
    await expect(dryRun(dir, { pacing: { concurrency: 2 } })).rejects.toThrow(/new run directory/);
    await expect(
      runPilot({
        config: config(),
        published: PUBLISHED,
        outDir: dir,
        repoRoot: ROOT,
        oracleSources: SOURCES,
        driver: fakeDriver(),
        plannerModelId: "simulated:other",
      }),
    ).rejects.toThrow(/different run mode or planner/);
    // A live planner with a simulated driver is refused before anything is touched.
    await expect(
      runPilot({
        config: config(),
        published: PUBLISHED,
        outDir: tmp(),
        repoRoot: ROOT,
        oracleSources: SOURCES,
        driver: fakeDriver(),
        plannerModelId: "claude-sonnet-5-5",
      }),
    ).rejects.toThrow(/simulated driver/);
  });

  it("refuses a run directory another live runner holds", async () => {
    const dir = tmp();
    await dryRun(dir);
    writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n`);
    await expect(dryRun(dir)).rejects.toThrow(/another pilot runner/);
  });

  it("the ledger loader fails closed on a rewritten or duplicated history", async () => {
    const dir = tmp();
    await dryRun(dir, { pacing: {} });
    const lines = ledgerText(dir).trimEnd().split("\n");
    const endLine = lines.find((l) => l.includes('"event":"end"')) as string;
    appendFileSync(join(dir, PROGRESS_FILE), `${endLine}\n`);
    expect(() => loadLedger(join(dir, PROGRESS_FILE))).toThrow(/duplicate end/);

    const dir2 = tmp();
    await dryRun(dir2);
    const start = JSON.parse(
      ledgerText(dir2)
        .split("\n")
        .find((l) => l.includes('"event":"start"')) as string,
    );
    appendFileSync(
      join(dir2, PROGRESS_FILE),
      `${JSON.stringify({ ...start, attempt: 2, trialKey: "x-a2", runId: "x-a2", supersedes: start.trialKey })}\n`,
    );
    expect(() => loadLedger(join(dir2, PROGRESS_FILE))).toThrow(/agent outcomes are final/);
    expect(PILOT_DRY_RUN_PLANNER.startsWith("simulated:")).toBe(true);
  });

  it("the progress file never collides with #518's R1 attempt ledger (round 1, D3)", async () => {
    expect(PROGRESS_FILE).toBe("pilot-progress.jsonl");
    expect(R1_ATTEMPT_LEDGER_FILE).toBe("attempts.jsonl");
    const dir = tmp();
    await dryRun(dir);
    expect(existsSync(join(dir, PROGRESS_FILE))).toBe(true);
    expect(existsSync(join(dir, R1_ATTEMPT_LEDGER_FILE))).toBe(false);
  });

  it("the loader fails closed on a broken supersedes link (round 1, V2)", async () => {
    const dir = tmp();
    let n = 0;
    await dryRun(dir, {
      driver: fakeDriver({
        beforeAgent: () => {
          if (++n === 1) throw new HarnessFault("timeout", "slow");
        },
      }),
    });
    const text = ledgerText(dir);
    const relinked = text.replace(
      '"supersedes":"r1p-fc-v1-001-a1"',
      '"supersedes":"r1p-fc-v1-002-a1"',
    );
    expect(relinked).not.toBe(text);
    writeFileSync(join(dir, PROGRESS_FILE), relinked);
    expect(() => loadLedger(join(dir, PROGRESS_FILE))).toThrow(/supersedes r1p-fc-v1-002-a1, not/);
  });

  it("the loader fails closed on a malformed line before the last (round 1, V9)", async () => {
    const dir = tmp();
    await dryRun(dir);
    const lines = ledgerText(dir).split("\n");
    lines[5] = "{not json";
    writeFileSync(join(dir, PROGRESS_FILE), lines.join("\n"));
    expect(() => loadLedger(join(dir, PROGRESS_FILE))).toThrow(/:6: malformed line/);
  });

  it("a torn header line (crash while writing line 1) is closed and the run resumes", async () => {
    const dir = tmp();
    writeFileSync(join(dir, PROGRESS_FILE), '{"schema":"myco.pilot.head');
    const torn = ledgerText(dir);
    const { result } = await dryRun(dir);
    expect(result).toMatchObject({ status: "complete", ran: 30 });
    expect(ledgerText(dir).startsWith(torn)).toBe(true);
    expect(loadLedger(join(dir, PROGRESS_FILE)).header).toMatchObject({ simulated: true });
    expect((await dryRun(dir)).result).toMatchObject({ ran: 0, skipped: 30 });
  });

  describe("live runs (a non-simulated fake driver; no claude, no model)", () => {
    const live = (): PilotDriver => ({ ...fakeDriver(), simulated: false });
    const run = (outDir: string, plannerModelId: string, liveLaunchSha256?: string) => {
      const clock = virtualClock();
      return runPilot({
        config: config(),
        published: PUBLISHED,
        outDir,
        repoRoot: ROOT,
        oracleSources: SOURCES,
        driver: live(),
        plannerModelId,
        sleep: clock.sleep,
        now: clock.now,
        ...(liveLaunchSha256 === undefined ? {} : { liveLaunchSha256 }),
      });
    };
    const sha = configSha256(config());

    it("refuses a live driver without the approved plan's sha256 (the runner's own guard)", async () => {
      const dir = tmp();
      await expect(run(dir, "claude-sonnet-5-5")).rejects.toThrow(/liveLaunchSha256/);
      await expect(run(dir, "claude-sonnet-5-5", "0".repeat(64))).rejects.toThrow(
        /liveLaunchSha256/,
      );
      expect(existsSync(join(dir, PROGRESS_FILE))).toBe(false);
    });

    it("refuses a live planner that is not the config's model (round 1, V4)", async () => {
      await expect(run(tmp(), "claude-opus-5-5", sha)).rejects.toThrow(
        /not the config's model claude-sonnet-5-5/,
      );
    });

    it("refuses a live run into a SIMULATED run directory (round 1, V7)", async () => {
      const dir = tmp();
      await dryRun(dir);
      await expect(run(dir, "claude-sonnet-5-5", sha)).rejects.toThrow(/holds a simulated run/);
    });
  });

  it("the lock is an exclusive create: a lock that appears before the create is refused", () => {
    const dir = tmp();
    expect(() =>
      acquireLock(dir, () => writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n`)),
    ).toThrow(/another pilot runner/);
    // A dead runner's lock is taken over.
    const stale = tmp();
    writeFileSync(join(stale, LOCK_FILE), "999999999\n");
    const release = acquireLock(stale);
    expect(readFileSync(join(stale, LOCK_FILE), "utf8").trim()).toBe(String(process.pid));
    release();
    expect(existsSync(join(stale, LOCK_FILE))).toBe(false);
  });
});
