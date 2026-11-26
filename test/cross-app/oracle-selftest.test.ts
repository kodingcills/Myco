/**
 * Capability track P, acceptance item 3: each step oracle of the cross-app family passes the
 * R5 oracle mutation self-test (`src/oracle-selftest/run.ts`, the same runner and bar as the
 * committed R5 report): every control verifies, and every claimed corruption class is run and
 * caught. A bite check shows the bar fails a step oracle that ignores collateral or reads
 * only the final state (the masking a per-step checkpoint exists to prevent).
 */
import { describe, expect, it } from "vitest";
import { crossAppFamily } from "../../src/gate/cross-app.ts";
import {
  type CrossAppStepIntent,
  crossAppCalcStepCases,
  crossAppCalcStepOracle,
  crossAppWriterStepCases,
  crossAppWriterStepOracle,
} from "../../src/oracle-selftest/cross-app-subjects.ts";
import { runSelfTest } from "../../src/oracle-selftest/run.ts";
import type { OracleUnderTest } from "../../src/oracle-selftest/types.ts";

const subjects = [
  [crossAppCalcStepOracle, crossAppCalcStepCases()],
  [crossAppWriterStepOracle, crossAppWriterStepCases()],
] as const;

describe("R5 self-test: cross-app step oracles", () => {
  for (const [oracle, cases] of subjects) {
    it(`${oracle.name} passes the bar on ${cases.length} cases`, () => {
      const { report, rows } = runSelfTest(oracle, cases);
      expect(report.pass, report.reasons.join("; ")).toBe(true);
      expect(report.controlsVerified).toBe(report.cases);
      expect(report.claims).toEqual([
        "edit-missing",
        "wrong-value",
        "wrong-target",
        "collateral",
        "truncated",
        "corrupt-byte",
        "missing-file",
      ]);
      for (const cls of report.claims) {
        expect(report.perClass[cls].runs, cls).toBe(cases.length);
        expect(report.perClass[cls].caught, cls).toBe(cases.length);
        // Value classes are refuted, read classes uncertain (the class's expected status),
        // except `truncated`: CSV and plain text have no integrity marker, so a cut document
        // reads in full and the whole-document rule refutes it (as the Calc gate does).
        if (cls !== "truncated")
          expect(report.perClass[cls].expectedStatus, cls).toBe(cases.length);
      }
      // Each caught value corruption is refuted at its own step, never later.
      for (const row of rows.filter((r) => r.status === "refuted")) {
        const step = Number(/step(\d+)$/.exec(row.caseId)?.[1]);
        expect(row.code, row.caseId).toMatch(new RegExp(`@checkpoint-${step}$`));
      }
    });
  }

  it("the bar fails a lazy step oracle (end state only, no per-step check)", () => {
    const lazy: OracleUnderTest<CrossAppStepIntent> = {
      ...crossAppCalcStepOracle,
      name: "lazy",
      // Judges only the end state, which is correct in every case: the step's own snapshot
      // is never compared. Without per-step checkpoints, an earlier failure is masked.
      verify: (doc) =>
        doc.bytes === null
          ? { status: "uncertain", code: "missing" }
          : { status: "verified", code: "end-state-only" },
    };
    const { report } = runSelfTest(lazy, crossAppCalcStepCases());
    expect(report.pass).toBe(false);
    expect(report.reasons.join("; ")).toMatch(/wrong-value: \d+ of \d+ corruptions verified/);
    expect(crossAppFamily.version).toBe("1");
  });
});
