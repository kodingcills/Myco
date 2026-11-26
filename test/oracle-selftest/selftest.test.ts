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
import { parseCsvSpreadsheet } from "../../src/core/filepersist.ts";
import type { TaskIntent } from "../../src/core/verify.ts";
import { buildSelfTest, renderJson, renderReadme } from "../../src/oracle-selftest/report.ts";
import { runSelfTest } from "../../src/oracle-selftest/run.ts";
import {
  calcCases,
  calcRecordEditOracle,
  writerCases,
  writerOracle,
} from "../../src/oracle-selftest/subjects.ts";
import type {
  CorruptionClass,
  OracleUnderTest,
  SavedDocument,
  SelfTestCase,
} from "../../src/oracle-selftest/types.ts";
import { type CalcRecordEditParams, groundTruth } from "../../src/tasks/intent.ts";
import {
  documentParagraphs,
  documentTables,
  parseWriterDocument,
} from "../../src/verify/writer-reader.ts";

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

  const reportOf = (name: string) => {
    const r = bundle.reports.find((x) => x.oracle === name);
    if (r === undefined) throw new Error(`no report for ${name}`);
    return r;
  };

  it("README statement 1: collateral verifies on the M1 verifier and Writer, and the gate refutes it", () => {
    expect(reportOf("calc-record-edit/csv").perClass.collateral).toMatchObject({
      claimed: false,
      runs: 10,
      caught: 0,
    });
    expect(reportOf("writer-doc-edit").perClass.collateral).toMatchObject({
      claimed: false,
      runs: 24,
      caught: 0,
    });
    const gate = reportOf("calc-record-edit/gate");
    expect(gate.perClass.collateral).toMatchObject({ claimed: true, runs: 10, caught: 10 });
    const gateCollateral = bundle.rows.filter(
      (r) => r.oracle === "calc-record-edit/gate" && r.cls === "collateral",
    );
    expect(
      gateCollateral.every((r) => r.status === "refuted" && r.code.includes("DOCUMENT_COLLATERAL")),
    ).toBe(true);
  });

  it("README statement 2: a truncated CSV verifies on the M1 verifier exactly when the target cell survives", () => {
    const m1 = bundle.rows.filter(
      (r) => r.oracle === "calc-record-edit/csv" && r.cls === "truncated",
    );
    const caseById = new Map(calcCases().map((c) => [c.id, c]));
    expect(m1.some((r) => r.status === "verified")).toBe(true);
    expect(m1.some((r) => r.status !== "verified")).toBe(true);
    for (const row of m1) {
      const c = caseById.get(row.caseId);
      const doc = c?.corruptions.find((x) => x.cls === "truncated")?.doc;
      const cells = parseCsvSpreadsheet(
        new TextDecoder().decode(doc?.bytes ?? new Uint8Array()),
        "t",
      ).cells;
      const target = groundTruth(c?.intent as CalcRecordEditParams).cellRef;
      const survives = cells[target] === c?.intent.newValue;
      expect(row.status === "verified", `${row.caseId}: target cell survives=${survives}`).toBe(
        survives,
      );
    }
    expect(reportOf("calc-record-edit/gate").perClass.truncated).toMatchObject({
      runs: 10,
      caught: 10,
    });
  });

  it("README statement 3: Writer's PASS does not cover collateral (unclaimed, and verifying)", () => {
    const w = reportOf("writer-doc-edit");
    expect(w.pass).toBe(true);
    expect(w.claims).not.toContain("collateral");
    expect(w.perClass.collateral.caught).toBe(0);
  });

  it("README statement 4: classes with no CSV form were not run for the Calc oracles", () => {
    for (const name of ["calc-record-edit/csv", "calc-record-edit/gate"])
      for (const cls of ["corrupt-byte", "partial-save", "missing-main-part"] as const)
        expect(reportOf(name).perClass[cls].runs, `${name} ${cls}`).toBe(0);
    expect(renderReadme(bundle)).toContain("not applicable to this format (not run)");
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

describe("corruptions really change the document (D1)", () => {
  /** Replace every corruption of `cls` with the correct document itself. */
  const noOp = <I>(cases: readonly SelfTestCase<I>[], cls: CorruptionClass): SelfTestCase<I>[] =>
    cases.map((c) => ({
      ...c,
      corruptions: c.corruptions.map((x) => (x.cls === cls ? { cls, doc: c.correct } : x)),
    }));

  it("a no-op collateral corruption is a harness fault that fails the bar, on every oracle", () => {
    for (const [oracle, cases] of [
      [calcRecordEditOracle, calcCases(3)],
      [writerOracle, writerCases(["ws-1"])],
    ] as const) {
      const { rows, report } = runSelfTest(
        oracle as OracleUnderTest<unknown>,
        noOp(cases as SelfTestCase<unknown>[], "collateral"),
      );
      expect(report.pass, oracle.name).toBe(false);
      expect(report.reasons.join("\n")).toMatch(
        /collateral: \d+ corruption\(s\) are byte-identical to the correct document/,
      );
      expect(
        rows
          .filter((r) => r.cls === "collateral")
          .every((r) => r.code === "corruption-equals-control"),
      ).toBe(true);
    }
  });

  /** A whole-document reference oracle: verified iff the content equals the correct document's. */
  function reference<I>(
    name: string,
    cases: readonly SelfTestCase<I>[],
    content: (doc: SavedDocument) => string | null,
  ): OracleUnderTest<I> {
    const expected = new Map(cases.map((c) => [c.intent, content(c.correct)]));
    return {
      name,
      version: "test",
      claims: new Set<CorruptionClass>(["collateral"]),
      verify(doc, intent) {
        let got: string | null;
        try {
          got = content(doc);
        } catch {
          return { status: "uncertain", code: "unreadable" };
        }
        return got !== null && got === expected.get(intent)
          ? { status: "verified", code: "same" }
          : { status: "refuted", code: "differs" };
      },
    };
  }

  it("a whole-document reference oracle catches every collateral corruption on both document types", () => {
    const calcContent = (doc: SavedDocument) =>
      doc.bytes === null
        ? null
        : JSON.stringify(parseCsvSpreadsheet(new TextDecoder().decode(doc.bytes), "x").cells);
    const writerContent = (doc: SavedDocument) => {
      if (doc.bytes === null) return null;
      const parsed = parseWriterDocument(doc.bytes, "x.docx");
      return JSON.stringify([
        documentParagraphs(parsed).map((p) => p.text),
        documentTables(parsed),
      ]);
    };
    const calc = calcCases();
    const calcRef = runSelfTest(
      reference<CalcRecordEditParams>("ref-calc", calc, calcContent),
      calc,
    );
    expect(calcRef.report.pass, calcRef.report.reasons.join("; ")).toBe(true);
    expect(calcRef.report.perClass.collateral).toMatchObject({ runs: 10, caught: 10 });
    const writer = writerCases();
    const writerRef = runSelfTest(
      reference<TaskIntent>("ref-writer", writer, (doc) =>
        doc.fileName.endsWith(".odt") ? writerContentOdt(doc) : writerContent(doc),
      ),
      writer,
    );
    expect(writerRef.report.pass, writerRef.report.reasons.join("; ")).toBe(true);
    expect(writerRef.report.perClass.collateral).toMatchObject({ runs: 24, caught: 24 });
  });
});

function writerContentOdt(doc: SavedDocument): string | null {
  if (doc.bytes === null) return null;
  const parsed = parseWriterDocument(doc.bytes, "x.odt");
  return JSON.stringify([documentParagraphs(parsed).map((p) => p.text), documentTables(parsed)]);
}
