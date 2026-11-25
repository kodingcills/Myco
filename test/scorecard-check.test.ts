import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Row 8 step 8 (re-scoped 2026-11-25): scripts/scorecard-check.py recomputes every
// number in docs/m1-scorecard.md from committed artifacts and fails on any mismatch.
const CHECK = "scripts/scorecard-check.py";
const SCORECARD = "docs/m1-scorecard.md";

function run(...args: string[]) {
  return spawnSync("python3", [CHECK, ...args], { encoding: "utf8", timeout: 120_000 });
}

function mutate(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

describe("scorecard-check", () => {
  it("passes on the committed scorecard and reports its coverage", () => {
    const result = run();
    expect(result.stderr).not.toContain("MISMATCH");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SCORECARD CHECK OK");
    expect(result.stdout).toMatch(/\d+ ok, 0 mismatch, \d+ not machine-checked/);
    expect(result.stdout).toContain("unchecked");
  }, 120_000);

  it("fails and names each row when one number changes in rows 3, 4 and 6", () => {
    let text = readFileSync(SCORECARD, "utf8");
    text = mutate(
      text,
      "recorded 29 verified and one refuted",
      "recorded 28 verified and one refuted",
    );
    text = mutate(text, "`falseSuccesses: 0`", "`falseSuccesses: 1`");
    text = mutate(text, "**929 trace events**", "**930 trace events**");
    const doc = join(mkdtempSync(join(tmpdir(), "scorecard-check-")), "m1-scorecard.md");
    writeFileSync(doc, text);

    const result = run("--doc", doc, "--no-subchecks");
    expect(result.status).toBe(1);
    const lines = result.stderr.split("\n").filter((line) => line.startsWith("MISMATCH"));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^MISMATCH row 3: .*expected 'recorded 29 verified.*found 'recorded 28 verified/,
    );
    expect(lines[1]).toMatch(/^MISMATCH row 4: .*`falseSuccesses: 0`.*found .*`falseSuccesses: 1`/);
    expect(lines[2]).toMatch(
      /^MISMATCH row 6: .*\*\*929 trace events\*\*.*found .*\*\*930 trace events\*\*/,
    );
  }, 120_000);
});
