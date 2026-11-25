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
    expect(result.stdout).toMatch(/in scope +## Open risk: guest-side fixture convert/);
    expect(result.stdout).toMatch(/in scope +## Second reason arm-002 is superseded/);
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

  // TIF-211: row7-compare --check reads only the `| 7 |` row. These figures outside it
  // (the slots table, the cap total, the unruled-row count) are guarded here instead.
  it.each([
    [
      "slots pass rate",
      "**0/30 verified** (30 refuted",
      "**1/30 verified** (30 refuted",
      /^MISMATCH slots: baseline pass rate/,
    ],
    [
      "slots paired table",
      "**b = 29** (Myco only)",
      "**b = 28** (Myco only)",
      /^MISMATCH slots: paired table/,
    ],
    ["slots Wilson interval", "**0.000–0.114**", "**0.000–0.115**", /^MISMATCH slots: Wilson 95%/],
    [
      "slots cap total",
      "= **$7.8521 of $9.00**",
      "= **$7.8522 of $9.00**",
      /^MISMATCH slots: spend/,
    ],
    [
      "row 7 cap total",
      "= **$7.8521 of the $9.00 cap**",
      "= **$7.8522 of the $9.00 cap**",
      /^MISMATCH row 7: spend/,
    ],
    [
      "row 7 unruled rows",
      "the other 18 of the 27",
      "the other 17 of the 27",
      /^MISMATCH row 7: unruled rows with the pattern/,
    ],
  ])(
    "fails when row 7's %s changes outside the `| 7 |` row check",
    (_name, from, to, line) => {
      const result = checkMutated(mutate(readFileSync(SCORECARD, "utf8"), from, to));
      expect(result.status).toBe(1);
      expect(result.mismatch).toHaveLength(1);
      expect(result.mismatch[0]).toMatch(line);
    },
    120_000,
  );

  // The five 2026-11-25 doc fixes and row 8's step-1 figures are checked claims: changing
  // any of them must fail, and the uncommitted booked spike figures must not print `ok`.
  it.each([
    [
      "**rows 3 and 29 have the zero-step shape**",
      "**rows 3 and 28 have the zero-step shape**",
      /^MISMATCH arm002-truncation: rows with the truncation signature/,
    ],
    [
      "spend is $0.076808 (",
      "spend is $0.076800 (",
      /^MISMATCH arm002-truncation: spike trial's committed spend/,
    ],
    [
      "(`PROMPT` in `src/baseline/planner.ts`)",
      "(`PROMPTS` in `src/baseline/planner.ts`)",
      /^MISMATCH arm002-decision: the system prompt symbol/,
    ],
    [
      "Index 6 is the one row",
      "Index 7 is the one row",
      /^MISMATCH arm002-decision: what the modified rows typed/,
    ],
    ["§3.1 reset (185 s,", "§3.1 reset (180 s,", /^MISMATCH row 8: re-run §3\.1 reset/],
    [
      "4/4 verified, exit 0, 182 s",
      "4/4 verified, exit 0, 128 s",
      /^MISMATCH row 8: re-run §6 subset/,
    ],
    [
      "removed here.",
      "removed here. `validate-live` reports ALL OK on 0 files.",
      /^MISMATCH row 8: J10 settled/,
    ],
  ])(
    "fails when %s changes",
    (from, to, expected) => {
      const result = checkMutated(mutate(readFileSync(SCORECARD, "utf8"), from, to));
      expect(result.status).toBe(1);
      expect([...result.mismatch, ...result.unattributed]).toContainEqual(
        expect.stringMatching(expected),
      );
    },
    120_000,
  );

  it("checks the M1 sign-off figures and fails when one changes", () => {
    const ok = run("--no-subchecks");
    expect(ok.stdout).toMatch(/in scope +## M1 sign-off/);
    expect(ok.stdout).toMatch(
      /^ok +signoff +v3 verified and Wilson .*29\/30 verified, Wilson 0\.833–0\.994/m,
    );
    expect(ok.stdout).toMatch(
      /^unchecked +signoff +scorecard-check\.py: 134 ok.*before this record was added/m,
    );

    const result = checkMutated(
      mutate(
        readFileSync(SCORECARD, "utf8"),
        // Anchored without the run path: probe-directory.test.ts forbids tests naming a live run dir.
        "29/30 verified, Wilson 0.833",
        "28/30 verified, Wilson 0.833",
      ),
    );
    expect(result.status).toBe(1);
    expect(result.mismatch).toContainEqual(
      expect.stringMatching(
        /^MISMATCH signoff: v3 verified and Wilson: expected .*29\/30 verified.*found .*28\/30/,
      ),
    );
  }, 120_000);

  it("lists the booked spike and the $1.632162 total as unchecked, never ok", () => {
    const result = run("--no-subchecks");
    const lines = result.stdout.split("\n").filter((line) => line.includes("1.632162"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^unchecked +arm002-truncation .*unverifiable/);
  }, 120_000);

  it("fails on a number no claim covers, and on a section it does not classify", () => {
    let text = readFileSync(SCORECARD, "utf8");
    text = mutate(text, "with trace evidence |", "with trace evidence in 12 traces |");
    text = mutate(text, "## Open risk:", "## A new section\n\nNothing.\n\n## Open risk:");
    const result = checkMutated(text);
    expect(result.status).toBe(1);
    expect(result.unattributed).toEqual([expect.stringMatching(/^UNATTRIBUTED row 5: .*\['12'\]/)]);
    expect(result.mismatch).toEqual([
      expect.stringMatching(/^MISMATCH layout: ## A new section: .*does not classify/),
    ]);
  }, 120_000);

  // Round 2: each defect class the final review found, as a case that must exit 1.
  const R3 = "re-verified tonight. **Note";
  const inRow3 = (text: string): [string, string] => [R3, `re-verified tonight. ${text} **Note`];
  const TABLE_END = "|\n\n## M1 sign-off";
  const cases: [string, [string, string], RegExp][] = [
    [
      "a new reference (TIF-999)",
      [
        "**Derived from committed logs, not quoted** (TIF-139)",
        "**Derived from committed logs, not quoted** (TIF-139) and TIF-999",
      ],
      /^UNATTRIBUTED row 6: .*'TIF-999'/,
    ],
    ["a sentence-final number", inRow3("A rerun verified 31."), /^UNATTRIBUTED row 3: .*\['31'\]/],
    [
      "a number with a unit suffix",
      inRow3("It finished in 31s"),
      /^UNATTRIBUTED row 3: .*\['31'\]/,
    ],
    [
      "both ends of a range",
      inRow3("It held over 31-40 trials"),
      /^UNATTRIBUTED row 3: .*\['31', '40'\]/,
    ],
    [
      "a mid-sentence (7)",
      inRow3("A recheck refuted (7) of them."),
      /^UNATTRIBUTED row 3: .*\['7'\]/,
    ],
    [
      "an out-of-sequence enumerator",
      ["(0 rows) |", "(0 rows). (7) More |"],
      /^UNATTRIBUTED row 7: .*\['7'\]/,
    ],
    [
      "a word-internal figure not on the identifier list",
      inRow3("It took n31 retries"),
      /^UNATTRIBUTED row 3: .*\['n31'\]/,
    ],
    [
      "a new | 9 | row",
      [TABLE_END, "|\n| 9 | Extra | **DONE** | nothing | — |\n\n## M1 sign-off"],
      /^MISMATCH layout: criterion table: unexpected criterion row 9/,
    ],
    [
      "a duplicate | 3 | row",
      [TABLE_END, "|\n| 3 | Reliability | **DONE** | more | — |\n\n## M1 sign-off"],
      /^MISMATCH layout: criterion table: duplicate criterion row 3/,
    ],
    [
      "a paragraph between the table and the first ##",
      [TABLE_END, "|\n\nAn extra paragraph.\n\n## M1 sign-off"],
      /^MISMATCH layout: between table and sections: unclassified text: 'An extra paragraph\.'/,
    ],
    [
      "a paragraph in the preamble",
      ["\n\n| # |", "\n\nAn extra 31 trials passed.\n\n| # |"],
      /^UNATTRIBUTED status: .*\['31'\]/,
    ],
    [
      "a # Foo H1 section",
      ["## Open risk:", "# Foo\n\nNothing.\n\n## Open risk:"],
      /^MISMATCH layout: # Foo: .*does not classify/,
    ],
  ];
  it.each(cases)(
    "fails on %s",
    (_name, [from, to], expected) => {
      const result = checkMutated(mutate(readFileSync(SCORECARD, "utf8"), from, to));
      expect(result.status).toBe(1);
      expect([...result.mismatch, ...result.unattributed]).toContainEqual(
        expect.stringMatching(expected),
      );
    },
    120_000,
  );

  // The identifier list is exactly the word-internal digit runs of the committed doc:
  // nothing in it is unused, and nothing the sweep skipped is missing from it.
  it("skips exactly the listed identifier words in the committed scorecard", () => {
    const result = run("--identifiers");
    expect(result.status).toBe(0);
    const { skipped, allowlist } = JSON.parse(result.stdout) as {
      skipped: string[];
      allowlist: string[];
    };
    expect(skipped).toEqual(allowlist);
    for (const word of skipped) {
      expect(word).toMatch(/[A-Za-z_-]\d/);
    }
  }, 120_000);
});
