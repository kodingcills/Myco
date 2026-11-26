/**
 * M2-09 / R5 part 1: the oracle mutation self-test. The committed report is what a fresh
 * run writes; the hand-written oracles pass their bar; and the bar fails oracles that are
 * lazy, throw, refuse everything, or claim a class they cannot catch. That last group is
 * what agent-written oracles will meet.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSelfTest, renderJson, renderReadme } from "../../src/oracle-selftest/report.ts";
import { runSelfTest } from "../../src/oracle-selftest/run.ts";
import {
  calcCases,
  calcRecordEditOracle,
  writerCases,
  writerOracle,
} from "../../src/oracle-selftest/subjects.ts";
import type { CorruptionClass, OracleUnderTest } from "../../src/oracle-selftest/types.ts";
import type { CalcRecordEditParams } from "../../src/tasks/intent.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DIR = join(ROOT, "docs", "research", "experiments", "r5-oracle-selftest");
const bundle = buildSelfTest();
const calc = calcCases(4);

describe("committed R5 report", () => {
  it("is what a fresh run writes, byte for byte", () => {
    expect(readFileSync(join(DIR, "report.json"), "utf8")).toBe(renderJson(bundle));
    expect(readFileSync(join(DIR, "README.md"), "utf8")).toBe(renderReadme(bundle));
  });

  it("carries no host path", () => {
    const text = renderJson(bundle) + renderReadme(bundle);
    expect(text).not.toMatch(
      /\/Users\/|\/home\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\|myco-oracle-selftest-/,
    );
  });

  it("--check exits 0 on the committed report", { timeout: 60_000 }, () => {
    const r = spawnSync("npx", ["tsx", "scripts/oracle-selftest.ts", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
  });
});

describe("hand-written oracles", () => {
  it("both pass their bar: every control verifies, every claimed class fully caught", () => {
    for (const r of bundle.reports) {
      expect(r.pass, `${r.oracle}: ${r.reasons.join("; ")}`).toBe(true);
      expect(r.controlsVerified).toBe(r.cases);
      for (const cls of r.claims) {
        const s = r.perClass[cls];
        expect(s.runs, `${r.oracle} ${cls}`).toBeGreaterThan(0);
        expect(s.caught, `${r.oracle} ${cls}`).toBe(s.runs);
      }
    }
  });

  it("report the known gaps as unclaimed, never as passes", () => {
    const [calcReport, writerReport] = bundle.reports;
    expect(calcReport?.perClass.collateral).toMatchObject({ claimed: false, caught: 0 });
    expect(writerReport?.perClass.collateral).toMatchObject({ claimed: false, caught: 0 });
    expect(calcReport?.perClass.truncated.claimed).toBe(false);
    expect(calcReport?.perClass.truncated.caught).toBeLessThan(
      calcReport?.perClass.truncated.runs ?? 0,
    );
  });

  it("cover every Writer postcondition kind in both formats", () => {
    const ids = writerCases().map((c) => c.id);
    for (const kind of ["paragraph-text", "heading-level", "table-cell", "paragraph-style"])
      for (const format of ["docx", "odt"])
        expect(
          ids.some((id) => id.endsWith(`${kind}-${format}`)),
          `${kind} ${format}`,
        ).toBe(true);
  });
});

describe("the bar fails bad oracles", () => {
  const base = calcRecordEditOracle;
  const lazy: OracleUnderTest<CalcRecordEditParams> = {
    ...base,
    name: "lazy",
    verify: () => ({ status: "verified", code: "lazy" }),
  };
  const refuser: OracleUnderTest<CalcRecordEditParams> = {
    ...base,
    name: "refuser",
    verify: () => ({ status: "refuted", code: "no" }),
  };
  const thrower: OracleUnderTest<CalcRecordEditParams> = {
    ...base,
    name: "thrower",
    verify: (doc, intent) => {
      if (doc.bytes === null) throw new Error("no file");
      return base.verify(doc, intent);
    },
  };
  const overClaiming: OracleUnderTest<CalcRecordEditParams> = {
    ...base,
    name: "over-claiming",
    claims: new Set<CorruptionClass>([...base.claims, "collateral"]),
  };

  it("an oracle that always verifies fails on every claimed class", () => {
    const { report } = runSelfTest(lazy, calc);
    expect(report.pass).toBe(false);
    for (const cls of base.claims)
      expect(report.reasons.join("\n")).toContain(`${cls}: 4 of 4 corruptions verified`);
  });

  it("an oracle that refuses everything fails on its controls", () => {
    const { report } = runSelfTest(refuser, calc);
    expect(report.pass).toBe(false);
    expect(report.reasons).toContain("4 of 4 correct documents did not verify");
  });

  it("a throw is a harness fault, not a catch", () => {
    const { rows, report } = runSelfTest(thrower, calc);
    expect(report.pass).toBe(false);
    expect(report.reasons.join()).toContain("missing-file: 4 of 4 corruptions verified");
    expect(
      rows
        .filter((r) => r.cls === "missing-file")
        .every((r) => r.status === "harness-fault" && !r.ok),
    ).toBe(true);
  });

  it("claiming a class the oracle cannot catch fails the bar (collateral on a target-only oracle)", () => {
    const { report } = runSelfTest(overClaiming, calc);
    expect(report.pass).toBe(false);
    expect(report.reasons).toEqual(["collateral: 4 of 4 corruptions verified"]);
  });

  it("a claim with no corruption run fails the bar", () => {
    const noCorruptions = calc.map((c) => ({
      ...c,
      corruptions: c.corruptions.filter((x) => x.cls !== "wrong-value"),
    }));
    const { report } = runSelfTest(base, noCorruptions);
    expect(report.reasons).toContain("claims wrong-value but no wrong-value corruption was run");
  });

  it("no cases is a failure, not a vacuous pass", () => {
    const { report } = runSelfTest(writerOracle, []);
    expect(report.pass).toBe(false);
    expect(report.reasons).toContain("no cases");
  });
});
