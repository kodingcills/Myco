/**
 * Track L — the $0 end-to-end run against REAL headless LibreOffice Calc: N `linux-plain`
 * disposable desktops (private root and HOME, own process group), each with its own Xvfb, a scripted agent driving Calc through the
 * Linux path's actuator, the gate deciding from the sealed capture, contamination checked.
 *
 * Opt-in, like test/linux/linux-path.test.ts: MYCO_PARALLEL_REAL=1 or
 * MYCO_PARALLEL_REQUIRED=1 (several soffice processes per case would load the parallel
 * `pnpm test`). Needs soffice, Python-UNO and Xvfb; skips without them
 * EXCEPT under MYCO_PARALLEL_REQUIRED=1, where it fails instead (it can never pass by
 * skipping in the `safe parallelism` CI job).
 *
 * `linux-plain` leaves other trials' roots writable, so no trial here is ever COUNTED as
 * verified (`shared-host-dirs`): the run checks that every gate verdict is right, that
 * nothing is contaminated and that every desktop and soffice is gone, and that the count
 * stays 0. Strict namespace isolation is not in this PR.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pythonUnoAvailable } from "../../src/linux/actuator.ts";
import { sofficeVersion } from "../../src/linux/soffice.ts";
import { calcActuatorAgent } from "../../src/parallel/agents.ts";
import { linuxBackend } from "../../src/parallel/linux-backend.ts";
import { runThroughput } from "../../src/parallel/throughput.ts";

const REQUIRED = process.env.MYCO_PARALLEL_REQUIRED === "1";
const OPTED_IN = REQUIRED || process.env.MYCO_PARALLEL_REAL === "1";
const READY =
  process.platform === "linux" &&
  OPTED_IN &&
  sofficeVersion() !== null &&
  pythonUnoAvailable() &&
  spawnSync("Xvfb", ["-help"]).error === undefined &&
  (await linuxBackend().probe()).available;

let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "myco-l-real-"));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const sofficePids = () =>
  new Set(
    spawnSync("pgrep", ["-f", "soffice"], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .filter(Boolean),
  );

describe.skipIf(!READY && !REQUIRED)("real Calc in N isolated desktops ($0, scripted)", () => {
  it("8 trials at N = 1, 2, 4: every gate verdict correct, none counted, nothing contaminated, every desktop and soffice gone", async () => {
    const before = sofficePids();
    const report = await runThroughput({
      backend: linuxBackend(),
      requirements: {
        network: "best-effort",
        privateTmp: "best-effort",
        hideHostDirs: "best-effort",
        display: "xvfb",
      },
      runRoot: base,
      ns: [1, 2, 4],
      trialsPerN: 8,
      agent: (b) => calcActuatorAgent(b),
      caps: {
        memoryMbPerTrial: 1024,
        cpusPerTrial: 1,
        cpuSecondsPerTrial: 120,
        trialTimeoutMs: 180_000,
        memoryBudgetMb: 4096,
        cpuBudget: 4,
      },
      label: "real-calc",
    });
    expect(report.allCorrect).toBe(true);
    for (const p of report.points) {
      expect(p.gateVerified).toBe(4);
      expect(p.countedVerified).toBe(0);
      expect(p.disqualified).toBe(0);
      expect(p.contaminated).toBe(0);
      expect(p.peakConcurrent).toBe(p.n);
    }
    for (const n of [1, 2, 4]) expect(readdirSync(join(base, `n${n}`, "trials"))).toEqual([]);
    const left = [...sofficePids()].filter((p) => !before.has(p));
    expect(left).toEqual([]);
  }, 600_000);
});
