/**
 * Which omissions a resume may re-attempt (TIF-200).
 *
 * A resume splits omissions in two, and getting the split wrong is expensive in both
 * directions:
 *
 *   HARNESS faults   the run lost a trial through no fault of the measurement -
 *                    `trial-interrupted` (process or guest died mid-trial) and
 *                    `planner-failed` (the provider gave something unusable: a
 *                    truncation, a refusal, a rejected call). RE-ATTEMPT these.
 *
 *   DECISIONS        the sweep stopped on purpose - `spend-limit`, `driver-unreachable`,
 *                    `repeated-cause`. Re-attempting one silently un-stops a run whose
 *                    stop reason was the finding. LEAVE these alone.
 *
 * r6 is why `planner-failed` was added: it finished with 10 such rows and a resume could
 * re-attempt only the single `trial-interrupted` one, so ten trials the arm had already
 * paid to reach were unreachable. TIF-200 classifies a truncation as a harness fault, and
 * a fault category that cannot be retried is one the arm cannot recover from.
 *
 * The states are PRODUCED by real runs rather than hand-written, so the test cannot drift
 * from what the sweep actually writes into a ledger.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedC1 } from "../../src/baseline/c1-trial.ts";
import { type Planner, PlannerFailure } from "../../src/baseline/planner.ts";
import { runC1Sweep } from "../../src/baseline/sweep.ts";

const dirs: string[] = [];
function directory() {
  // Under HOME, never `tmpdir()`: the launcher refuses a run directory under /tmp, and
  // `tmpdir()` is /tmp on Linux but not macOS.
  const path = mkdtempSync(join(homedir(), ".myco-resume-omissions-"));
  dirs.push(path);
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const shot = { type: "image", mimeType: "image/png", data: "eA==" };
function fakeMcp() {
  return {
    request: async (method: string, params: { name?: string }) => {
      if (method === "initialize") return { protocolVersion: "2025-11-25" };
      if (params.name === "get_window_state")
        return {
          content: [{ type: "text", text: "t" }, shot],
          structuredContent: { element_token: "t" },
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
const IDENTITY = { model: "claude-sonnet-5-5", snapshot: "cua-c1-base", planner: "paid" };
const base = (dir: string) => ({
  coordinatorGo: true,
  directory: dir,
  priorSpendMicros: 0,
  armLimitMicros: 9_000_000,
  identity: IDENTITY,
});

/** A paid planner that never fails - used for the resume half of each test. */
const workingPlanner: Planner = {
  paid: true,
  act: async () => ({
    calls: [{ model: "claude-sonnet-5-5", usage: { prompt: 1, completion: 1, cost: 0.001 } }],
    decision: { tool: "click", arguments: { x: 1, y: 2 } },
  }),
} as never;

/** A paid planner whose every call fails the way a truncation does. */
const failingPlanner: Planner = {
  paid: true,
  act: async () => {
    throw new PlannerFailure("truncated at max_tokens=1024", 1_000);
  },
} as never;

describe("a resume re-attempts harness faults and leaves decisions alone", () => {
  it("re-attempts a planner-failed omission - the r6 case", async () => {
    const dir = directory();
    // Two failures produce two `planner-failed` rows; the abort then omits the rest as
    // `repeated-cause`. That is r6's exact shape: recoverable faults followed by a
    // deliberate stop.
    await runC1Sweep({ ...base(dir), planner: failingPlanner, prepare: async () => prepared() });
    const led = JSON.parse(readFileSync(join(dir, "accounting.json"), "utf8"));
    const reasons = Object.values(led.c1 as Record<string, { reason?: string }>).map(
      (e) => e.reason,
    );
    expect(reasons.filter((r) => r === "planner-failed").length).toBe(2);
    expect(reasons).toContain("repeated-cause");

    let prepares = 0;
    await runC1Sweep({
      ...base(dir),
      planner: workingPlanner,
      resume: true,
      prepare: async () => {
        prepares += 1;
        return prepared();
      },
    });
    // The two failed trials ARE re-attempted: they are harness faults the arm already
    // paid to reach. Before TIF-200 they would have been skipped forever.
    expect(prepares).toBeGreaterThanOrEqual(2);
    // Nothing stays `planner-failed` once a working planner runs: both recovered.
    const after = JSON.parse(readFileSync(join(dir, "accounting.json"), "utf8"));
    const stillFailed = Object.values(after.c1 as Record<string, { reason?: string }>).filter(
      (e) => e.reason === "planner-failed",
    );
    expect(stillFailed).toEqual([]);
  });

  it("leaves a repeated-cause omission alone", async () => {
    const dir = directory();
    await runC1Sweep({ ...base(dir), planner: failingPlanner, prepare: async () => prepared() });
    const led = JSON.parse(readFileSync(join(dir, "accounting.json"), "utf8"));
    const repeated = Object.entries(led.c1 as Record<string, { reason?: string }>).filter(
      ([, e]) => e.reason === "repeated-cause",
    );
    expect(repeated.length).toBeGreaterThan(0);

    // A resume must leave them omitted: `repeated-cause` means the sweep was measuring the
    // harness, and that IS the finding. Re-running would un-stop the run.
    await runC1Sweep({
      ...base(dir),
      planner: workingPlanner,
      resume: true,
      prepare: async () => prepared(),
    });
    const after = JSON.parse(readFileSync(join(dir, "accounting.json"), "utf8"));
    for (const [index] of repeated) {
      expect(after.c1[index].reason, `index ${index} must stay omitted`).toBe("repeated-cause");
    }
  });

  it("leaves a spend-limit omission alone", async () => {
    const dir = directory();
    // An arm limit of 0 admits nothing, so every trial is omitted as spend-limit - a
    // DECISION reached before any trial runs.
    await runC1Sweep({
      ...base(dir),
      priorSpendMicros: 0,
      armLimitMicros: 0,
      planner: workingPlanner,
      prepare: async () => prepared(),
    });
    const led = JSON.parse(readFileSync(join(dir, "accounting.json"), "utf8"));
    const reasons = Object.values(led.c1 as Record<string, { reason?: string }>).map(
      (e) => e.reason,
    );
    expect(reasons.every((r) => r === "spend-limit")).toBe(true);

    let prepares = 0;
    await runC1Sweep({
      ...base(dir),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      planner: workingPlanner,
      resume: true,
      prepare: async () => {
        prepares += 1;
        return prepared();
      },
    });
    // Re-running these would re-buy exactly what the ceiling stopped. A resume with a
    // raised limit is the operator changing the terms, not the sweep recovering.
    expect(prepares).toBe(0);
  });
});
