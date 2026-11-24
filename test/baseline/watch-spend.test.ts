import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the watcher's spend total by RUNNING THE SCRIPT.
 *
 * The regression this guards is specific and has already happened once in this
 * codebase: counting only `scored` entries instead of every ledger entry. An
 * omitted trial still made real API calls before it died, and a reserved row
 * holds a live reservation, so a scored-only total under-reports by exactly the
 * amount that matters when a cap is being approached.
 *
 * It spawns scripts/watch-c1-arm.sh rather than exercising an extracted block,
 * because the block and the program are not the same thing - testing the block
 * is how the SILENT_MIN NameError and the un-trippable-silence bug both shipped
 * while reported as verified.
 */

const SCRIPT = join(process.cwd(), "scripts/watch-c1-arm.sh");

/** A ledger where scored-only and committed deliberately disagree. */
function armDir(entries: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-watch-spend-"));
  writeFileSync(join(dir, "accounting.json"), JSON.stringify({ c1: entries, c2: {} }));
  writeFileSync(join(dir, "progress.log"), "trial 0\n");
  return dir;
}

/**
 * The watcher exits immediately with "SWEEP ENDED" unless a process whose argv
 * contains `c1-sweep.ts <dir>` is alive. Without this stub the spend path is
 * never reached and the test would assert against the early-exit line - so the
 * stub is part of exercising the program, not decoration.
 */
function startSweepStub(dir: string): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)", "c1-sweep.ts", dir], {
    stdio: "ignore",
    detached: false,
  });
}

const scored = (micros: number) => ({
  status: "scored",
  micros,
  row: { verdictReason: "modified" },
});

/**
 * Run the watcher once and return its first report line plus exit status.
 *
 * The script loops forever by design, so it is started, allowed to produce one
 * report, then killed. A stub process with the matching argv keeps the
 * "sweep ended" early-exit path from firing first.
 */
async function runWatcher(
  dir: string,
  limit: string,
  // Prior spend is a REQUIRED argument (TIF-192): the watcher measures prior + this
  // run, so a call without it is refused rather than silently reporting a run-local
  // figure. These tests are about the ledger arithmetic, so they pass 0 and assert
  // against the run-local column, which is still reported.
  prior = "0",
): Promise<{ out: string; code: number }> {
  const stub = startSweepStub(dir);
  // detached so the whole group can be signalled: the script's own `sleep 300`
  // keeps the stdout pipe open, so killing only bash leaves the test waiting for
  // a close that never arrives.
  const child = spawn("bash", [SCRIPT, dir, limit, "20", prior], {
    env: { ...process.env, PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let out = "";
  const done = new Promise<number>((resolve) => {
    // The script either exits on its own (trigger paths: 9 or 10) or loops
    // forever (no trigger), so a timeout is the "kept running" outcome. Killing
    // on the first report line would destroy the exit status the trigger tests
    // assert on - which is exactly what happened on the first attempt here.
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const killTimer = setTimeout(killGroup, 4000);
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      killGroup();
      resolve(code ?? 0);
    });
  });
  const code = await done;
  stub.kill("SIGKILL");
  return { out, code };
}

describe("watch-c1-arm spend total", () => {
  it("counts omitted and reserved entries, not just scored ones", async () => {
    // scored 0.20, omitted 0.30, reserved 0.20 -> committed 0.70
    // A scored-only total would read 0.20.
    const dir = armDir({
      "0": scored(200_000),
      "1": { status: "omitted", micros: 300_000, reason: "trial-interrupted" },
      "2": { status: "reserved", micros: 200_000 },
    });
    const { out } = await runWatcher(dir, "9.00");
    expect(out).toContain("committed=$0.7000");
    expect(out).not.toContain("committed=$0.2000");
  }, 15_000);

  it("triggers over the limit on committed spend, including non-scored entries", async () => {
    // The discriminating case: scored 0.20 alone is UNDER the 0.50 limit, while
    // committed 0.70 is OVER it. A scored-only total would not trigger here,
    // which is exactly why this limit was chosen.
    const dir = armDir({
      "0": scored(200_000),
      "1": { status: "omitted", micros: 300_000, reason: "trial-interrupted" },
      "2": { status: "reserved", micros: 200_000 },
    });
    const { out, code } = await runWatcher(dir, "0.50");
    expect(out).toContain("committed=$0.7000");
    expect(out).toContain("TRIGGER committed spend over limit");
    expect(code).toBe(9);
  }, 15_000);

  it("does not trigger when committed spend is under the limit", async () => {
    const dir = armDir({ "0": scored(200_000) });
    const { out } = await runWatcher(dir, "9.00");
    expect(out).toContain("committed=$0.2000");
    expect(out).not.toContain("TRIGGER");
  }, 15_000);
});
