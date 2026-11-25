import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Row 8 step 8 (re-scoped 2026-11-25): scripts/scorecard-check.py recomputes the numbers
// in docs/m1-scorecard.md's in-scope sections from committed artifacts, fails on any
// mismatch, and fails on any number-like token no claim covers.
const CHECK = "scripts/scorecard-check.py";
const SCORECARD = "docs/m1-scorecard.md";

function run(...args: string[]) {
  return spawnSync("python3", [CHECK, ...args], { encoding: "utf8", timeout: 120_000 });
}

function checkMutated(text: string) {
  const doc = join(mkdtempSync(join(tmpdir(), "scorecard-check-")), "m1-scorecard.md");
  writeFileSync(doc, text);
  const result = run("--doc", doc, "--no-subchecks");
  const lines = (prefix: string) =>
    result.stderr.split("\n").filter((line) => line.startsWith(prefix));
  return {
    status: result.status,
    mismatch: lines("MISMATCH"),
    unattributed: lines("UNATTRIBUTED"),
  };
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
    expect(result.stdout).toMatch(/\d+ ok, 0 mismatch, 0 unattributed, \d+ not machine-checked/);
    expect(result.stdout).toContain("unchecked");
    expect(result.stdout).toMatch(/out of scope +## Open risk: guest-side fixture convert/);
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

  // Regression: the evidence commit used to print `ok` from the COMMIT file alone.
  it("fails when row 4's evidence commit or PR changes in the doc", () => {
    const original = readFileSync(SCORECARD, "utf8");
    const cases: [string, string][] = [
      ["committed by #269 (`3eaa23c`)", "committed by #269 (`3eaa23d`)"],
      ["committed by #269 (`3eaa23c`)", "committed by #270 (`3eaa23c`)"],
    ];
    for (const [from, to] of cases) {
      const result = checkMutated(mutate(original, from, to));
      expect(result.status).toBe(1);
      expect(result.mismatch).toHaveLength(1);
      expect(result.mismatch[0]).toMatch(
        /^MISMATCH row 4: evidence commit and PR: expected 'evidence committed by #269 \(`3eaa23c`\)'/,
      );
    }
  }, 240_000);

  it("fails and names rows 7 and 8 when an action count and the sweep's second mention change", () => {
    let text = readFileSync(SCORECARD, "utf8");
    text = mutate(text, "all 30 actions are clicks", "all 29 actions are clicks");
    text = mutate(text, "the 28/30 sweep", "the 27/30 sweep");
    const result = checkMutated(text);
    expect(result.status).toBe(1);
    expect(result.mismatch).toHaveLength(2);
    expect(result.mismatch[0]).toMatch(
      /^MISMATCH row 7: .*expected 'all 30 actions are clicks'.*found 'all 29 actions/,
    );
    expect(result.mismatch[1]).toMatch(
      /^MISMATCH row 8: .*expected 'the 28\/30 sweep'.*found 'the 27\/30 sweep'/,
    );
  }, 120_000);

  it("fails on a number no claim covers, and on a section it does not classify", () => {
    let text = readFileSync(SCORECARD, "utf8");
    text = mutate(text, "with trace evidence |", "with trace evidence in 12 traces |");
    text = mutate(text, "## Open risk:", "## A new section\n\nNothing.\n\n## Open risk:");
    const result = checkMutated(text);
    expect(result.status).toBe(1);
    expect(result.unattributed).toEqual([expect.stringMatching(/^UNATTRIBUTED row 5: .*\['12'\]/)]);
    expect(result.mismatch).toEqual([
      expect.stringMatching(/^MISMATCH sections: ## A new section: .*does not classify/),
    ]);
  }, 120_000);
});
