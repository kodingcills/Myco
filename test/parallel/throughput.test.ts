/**
 * Track L — the $0 throughput harness end to end on the portable fake backend: scripted
 * agents, the real gated path, verified-result counts, and the report's simulated stamp.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ScriptedDesktopAgent, scriptedFileAgent } from "../../src/parallel/agents.ts";
import { STRICT_REQUIREMENTS } from "../../src/parallel/backend.ts";
import { renderReport } from "../../src/parallel/cli.ts";
import { behaviourFor, EXPECTED_VERDICT, runThroughput } from "../../src/parallel/throughput.ts";
import { fakeBackend } from "./fake-backend.ts";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-l-tp-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const caps = {
  memoryMbPerTrial: 64,
  cpusPerTrial: 1,
  cpuSecondsPerTrial: 60,
  trialTimeoutMs: 20_000,
  memoryBudgetMb: 1024,
  cpuBudget: 4,
};

describe("throughput harness ($0, scripted agents)", () => {
  it("runs each N, counts verified results, gets every verdict right, and is stamped simulated", async () => {
    const report = await runThroughput({
      backend: fakeBackend(),
      requirements: STRICT_REQUIREMENTS,
      runRoot: base,
      ns: [1, 2, 4],
      trialsPerN: 8,
      agent: scriptedFileAgent,
      caps,
    });
    expect(report.simulated).toBe(true);
    expect(report.evidence).toBe(false);
    expect(report.costEstimate).toBeNull();
    expect(report.allCorrect).toBe(true);
    expect(report.points.map((p) => p.n)).toEqual([1, 2, 4]);
    for (const p of report.points) {
      expect(p.trials).toBe(8);
      // honest at i = 0, 2, 4, 6 of the cycle: 4 of 8 verified, the rest refuted.
      expect(p.countedVerified).toBe(4);
      expect(p.correct).toBe(8);
      expect(p.contaminated).toBe(0);
      expect(p.peakConcurrent).toBe(p.n);
      expect(p.trialsPerHour).toBeGreaterThan(0);
    }
    expect(renderReport(report)).toMatch(/every trial got its expected verdict/);
  });

  it("a wrong verdict is a mismatch, and allCorrect is false", async () => {
    // An agent that always saves honestly: skips-save and wrong-row slots expect refuted.
    const alwaysHonest = (): ScriptedDesktopAgent => scriptedFileAgent("honest");
    const report = await runThroughput({
      backend: fakeBackend(),
      requirements: STRICT_REQUIREMENTS,
      runRoot: base,
      ns: [2],
      trialsPerN: 4,
      agent: alwaysHonest,
      caps,
    });
    expect(report.allCorrect).toBe(false);
    expect(report.points[0]?.mismatches).toHaveLength(2);
    expect(report.points[0]?.countedVerified).toBe(4);
  });

  it("the behaviour mix and its expected verdicts", () => {
    expect([0, 1, 2, 3].map(behaviourFor)).toEqual(["honest", "skips-save", "honest", "wrong-row"]);
    expect(EXPECTED_VERDICT).toEqual({
      honest: "verified",
      "skips-save": "refuted",
      "wrong-row": "refuted",
    });
  });
});
