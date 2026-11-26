/**
 * TIF-98 fast-reset guard: scripts/reset-boot-summary.py classifies each recorded boot as
 * cold or fast with the same threshold as scripts/reset-trial-vm.sh, and the committed
 * summary is what it recomputes from the committed reset logs.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "reset-boot-summary.py");
const DIR = join(ROOT, "docs", "research", "experiments", "tif-98-fast-reset-2026-11-26");

const run = (args: string[], cwd = DIR) =>
  spawnSync("python3", [SCRIPT, ...args], { cwd, encoding: "utf8" });
const log = (lines: string[]) => {
  const d = mkdtempSync(join(tmpdir(), "myco-boot-summary-"));
  const p = join(d, "reset.log");
  writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
};
const first = (ssh: number, cpu: number) =>
  `wait-guest-ready: first ssh answer after ${ssh}s (guest CPU ${cpu}s)`;
const timing = (total: number) => `reset-trial-vm: timing stop=0 restore=2 total=${total}`;

describe("reset-boot-summary.py", () => {
  it("the committed summary.md is what it recomputes from summary-inputs.txt", () => {
    const inputs = readFileSync(join(DIR, "summary-inputs.txt"), "utf8")
      .split("\n")
      .filter(Boolean);
    const r = run(inputs);
    expect(r.status).toBe(0);
    expect(readFileSync(join(DIR, "summary.md"), "utf8")).toBe(r.stdout);
  });

  it("uses the reset's threshold: 100 s is cold, 99 s is fast", () => {
    const out = run(
      [log([first(140, 100), timing(160)]), log([first(13, 99), timing(26)])],
      ROOT,
    ).stdout;
    expect(out).toMatch(/\| 1 \| 140 \| 100 \| 160 \| cold \|/);
    expect(out).toMatch(/\| 1 \| 13 \| 99 \| 26 \| fast \|/);
    const reset = readFileSync(join(ROOT, "scripts", "reset-trial-vm.sh"), "utf8");
    expect(reset).toContain("COLD_MIN_GUEST_CPU=$" + "{MYCO_COLD_MIN_GUEST_CPU:-100}");
    expect(readFileSync(SCRIPT, "utf8")).toContain("COLD_MIN_GUEST_CPU = 100");
  });

  it("splits a file that holds several resets at their timing lines; a guarded reset has two boots", () => {
    const out = run(
      [log([first(14, 4), first(143, 291), timing(205), first(150, 280), timing(170)])],
      ROOT,
    ).stdout;
    expect(out).toMatch(/#1 \| 1 \| 14 \| 4 \| 205 \| fast \|/);
    expect(out).toMatch(/#1 \| 2 \| 143 \| 291 \| 205 \| cold \|/);
    expect(out).toMatch(/#2 \| 1 \| 150 \| 280 \| 170 \| cold \|/);
  });

  it("refuses a log with no first-ssh line or no timing line", () => {
    expect(run([log([timing(160)])], ROOT).status).toBe(1);
    expect(run([log([first(140, 280)])], ROOT).status).toBe(1);
  });
});
