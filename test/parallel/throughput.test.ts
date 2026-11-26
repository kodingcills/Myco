/**
 * Track L — the $0 throughput harness end to end on the portable fake backend: scripted
 * agents, the real gated path, verified-result counts, and the report's simulated stamp.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ScriptedDesktopAgent, scriptedFileAgent } from "../../src/parallel/agents.ts";
import { STRICT_REQUIREMENTS } from "../../src/parallel/backend.ts";
import { main, renderReport } from "../../src/parallel/cli.ts";
import { behaviourFor, EXPECTED_VERDICT, runThroughput } from "../../src/parallel/throughput.ts";
import { fakeBackend, STRONG } from "./fake-backend.ts";

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
  // The macOS runner has 3 CPUs: the cap check (rightly) refuses a budget above the host.
  cpuBudget: Math.min(4, availableParallelism()),
};
const LEVELS = [1, 2, 4].filter((n) => n <= caps.cpuBudget);

describe("throughput harness ($0, scripted agents)", () => {
  it("runs each N, counts verified results, gets every verdict right, and is stamped simulated", async () => {
    const report = await runThroughput({
      backend: fakeBackend(),
      requirements: STRICT_REQUIREMENTS,
      runRoot: base,
      ns: LEVELS,
      trialsPerN: 8,
      agent: scriptedFileAgent,
      caps,
    });
    expect(report.simulated).toBe(true);
    expect(report.evidence).toBe(false);
    expect(report.costEstimate).toBeNull();
    expect(report.allCorrect).toBe(true);
    expect(report.points.map((p) => p.n)).toEqual(LEVELS);
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

  it("on a backend with visible roots: every gate verdict right, nothing counted, still allCorrect", async () => {
    const report = await runThroughput({
      backend: fakeBackend({ isolation: () => ({ ...STRONG, hostDirsHidden: false }) }),
      requirements: { ...STRICT_REQUIREMENTS, hideHostDirs: "best-effort" },
      runRoot: base,
      ns: [2],
      trialsPerN: 4,
      agent: scriptedFileAgent,
      caps,
    });
    expect(report.allCorrect).toBe(true);
    expect(report.points[0]?.gateVerified).toBe(2);
    expect(report.points[0]?.countedVerified).toBe(0);
    expect(report.points[0]?.disqualified).toBe(0);
  });

  it("shared-host-dirs is the only disqualifier that does not make a mismatch", async () => {
    const report = await runThroughput({
      backend: fakeBackend({
        isolation: () => ({ ...STRONG, hostDirsHidden: false }),
        destroy: () => ({ processesGone: false }),
      }),
      requirements: { ...STRICT_REQUIREMENTS, hideHostDirs: "best-effort" },
      runRoot: base,
      ns: [1],
      trialsPerN: 1,
      agent: scriptedFileAgent,
      caps,
    });
    expect(report.allCorrect).toBe(false);
    expect(report.points[0]?.mismatches[0]).toMatch(/teardown/);
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

describe("myco-parallel exit codes (docs §1: 0 / 1 / 3)", () => {
  it("3 on a usage error, 0 on --help", async () => {
    const lines: string[] = [];
    expect(await main(["--bogus"], (t) => lines.push(t))).toBe(3);
    expect(await main(["--help"], (t) => lines.push(t))).toBe(0);
  });

  it.skipIf(process.platform !== "linux")(
    "1 under the strict default on linux-plain (every trial refused), 0 when weak is allowed",
    async () => {
      const quiet = () => {};
      const common = ["--n", "1", "--trials", "2", "--agent", "file", "--display", "none"];
      expect(await main([...common, "--out", join(base, "strict")], quiet)).toBe(1);
      expect(
        await main([...common, "--allow-weak-isolation", "--out", join(base, "weak")], quiet),
      ).toBe(0);
    },
    60_000,
  );
});
