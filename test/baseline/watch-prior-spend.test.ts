/**
 * The spend the watchdog reports, and the spend the cap enforces (TIF-192).
 *
 * They were different numbers. `watch-c1-arm.sh` summed the run's ledger alone and
 * printed it against the project ceiling:
 *
 *     [watch] rows=9 committed=$2.2268/$9.00
 *
 * which reads as "the project has spent $2.23 of $9" when the project had committed
 * $6.70. The guard in `src/baseline/sweep.ts` is
 *
 *     priorSpendMicros + charged(ledger.c1) + charged(ledger.c2) + reservation
 *
 * so the ledger alone is only the run-local HALF of it. That understatement is the
 * dangerous direction for a watcher whose entire job is to warn before a cap is hit:
 * it will not fire early, and it reads as though the cap were run-local - which is
 * exactly the misreading it caused.
 *
 * These tests pin the relation between the two, so the watcher cannot drift from the
 * guard again without a failure. They run the watcher's own arithmetic on a synthetic
 * ledger: no VM, no API, no network.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
function ledgerDir(c1: Record<string, { status: string; micros: number }>, c2 = {}) {
  const dir = mkdtempSync(join(tmpdir(), "myco-watch-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "accounting.json"),
    JSON.stringify({ manifestSha256: "x", c1, c2 }, null, 2),
  );
  // The watcher breaks out of its loop when no sweep holds the directory; a
  // progress.log keeps its initial mtime logic happy.
  writeFileSync(join(dir, "progress.log"), "probe\n");
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * The watcher's own arithmetic, extracted by running the script's Python block the
 * way the script does. Kept as a shell invocation rather than a reimplementation so
 * a change to the script is what this test sees.
 */
function watchLine(
  dir: string,
  priorDollars: string,
  limit = "900.00",
): { line: string; code: number } {
  // The block lives inside the script; pull it out and run it with the same argv the
  // script passes, so this exercises the real source text.
  const source = execFileSync(
    "sed",
    ["-n", "/^import glob, json, sys$/,/^PY$/p", "scripts/watch-c1-arm.sh"],
    {
      encoding: "utf8",
    },
  )
    .replace(/^PY$/m, "")
    .trim();
  // `spawnSync`, not `execFileSync`: breaching the cap makes the watcher EXIT 9, which
  // is the behaviour under test - a helper that threw on it could not observe the
  // very thing it is checking.
  const run = spawnSync("python3", ["-", dir, limit, "0", "25", priorDollars], {
    input: source,
    encoding: "utf8",
  });
  return { line: (run.stdout ?? "").trim(), code: run.status ?? -1 };
}

const scored = (micros: number) => ({ status: "scored", micros });

describe("the watchdog measures the same spend the cap does", () => {
  it("adds prior spend to the ledger, rather than reporting the ledger alone", () => {
    // 9 scored rows and two live reservations, the shape r6 was in.
    const dir = ledgerDir({
      "0": scored(113_880),
      "1": scored(124_830),
      "2": { status: "reserved", micros: 607_200 },
      "3": scored(131_430),
    });
    const { line } = watchLine(dir, "4.480732");
    // local is the ledger's own sum: 113,880 + 124,830 + 607,200 + 131,430 = 977,340
    expect(line).toContain("local=$0.9773");
    // committed is prior + local: 4.480732 + 0.977340 = 5.458072
    expect(line).toContain("committed=$5.4581");
  });

  it("reports the ledger alone only when prior spend is genuinely zero", () => {
    const dir = ledgerDir({ "0": scored(500_000) });
    const { line } = watchLine(dir, "0");
    expect(line).toContain("local=$0.5000");
    expect(line).toContain("committed=$0.5000");
  });

  it("counts reservations, not just scored rows", () => {
    // The comment above this behaviour is explicit: an omitted trial made real calls,
    // and a reserved row holds a live reservation. A scored-only figure under-reports
    // by the amount most likely to matter near a cap.
    const dir = ledgerDir({
      "0": scored(100_000),
      "1": { status: "reserved", micros: 607_200 },
      "2": { status: "omitted", micros: 250_000 },
    });
    const { line } = watchLine(dir, "0");
    expect(line).toContain("local=$0.9572");
  });

  it("would fire the spend trigger exactly when the cap is reached", () => {
    // The trigger compares `committed > limit`, so the arithmetic above decides it.
    // Prior spend is what makes the difference: with it included, a run that had spent
    // little locally but sits on a large prior trips; run-local it would not, and the
    // warning would never come.
    //
    // Compared in integer micros, not floats: 4.480732 + 0.1 is not exactly 4.580732
    // in binary floating point, and a test that pins the printed digits would be
    // asserting rounding rather than the property.
    const dir = ledgerDir({ "0": scored(100_000) });
    const limitMicros = 4_500_000;
    const priorMicros = 4_480_732;
    const localMicros = 100_000;
    const { line, code } = watchLine(
      dir,
      String(priorMicros / 1_000_000),
      String(limitMicros / 1_000_000),
    );
    const committedMicros = priorMicros + localMicros;
    // The watcher's printed figure rounds to four places; assert the magnitude, then
    // the property in integers.
    expect(line).toContain("local=$0.1000");
    expect(line).toContain("committed=$4.58");
    expect(committedMicros).toBeGreaterThan(limitMicros);
    // The watcher EXITS 9 on a breach, and now that prior spend is included it does
    // so for this run. Run-local it would not have fired at all.
    expect(code).toBe(9);
    expect(localMicros).toBeLessThan(limitMicros);
  });
});
