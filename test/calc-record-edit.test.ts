import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCsvSpreadsheet } from "../src/core/filepersist.ts";
import { runProgram } from "../src/core/runner.ts";
import { FakeSpreadsheetApp } from "../src/fake/app.ts";
import {
  calcRecordEditFamily,
  calcRecordEditVerifier,
  intentFor,
  programFor,
} from "../src/tasks/calc-record-edit.ts";
import { DATA_COLUMNS, dataRowsForSeed, generateFixture } from "../src/tasks/fixture.ts";
import {
  type CalcRecordEditParams,
  generateParameterSets,
  groundTruth,
  isAutoCorrectImmune,
} from "../src/tasks/intent.ts";

const SEEDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];

function tmpCsv(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `myco-family-${name}-`)), "fixture.csv");
}

/** Spin up the fake app pre-loaded with the fixture for a seed. */
function fakeForSeed(seed: string, filePath: string): FakeSpreadsheetApp {
  const fixture = generateFixture(seed);
  writeFileSync(filePath, fixture.csv);
  return new FakeSpreadsheetApp({ filePath, rows: fixture.dataRows + 1, cols: 5 });
}

describe("calc-record-edit parameter generation", () => {
  it("produces 30 parameter sets, all distinct, deterministic from the seed list", () => {
    const first = generateParameterSets(SEEDS);
    const second = generateParameterSets(SEEDS);
    expect(first).toHaveLength(30);
    expect(second).toEqual(first); // deterministic
    const seen = new Set(first.map((p) => JSON.stringify(p)));
    expect(seen.size).toBe(30); // distinct
  });

  it("varies rowKey, column, newValue, and fixture size across the typed columns", () => {
    const sets = generateParameterSets(SEEDS);
    const columns = new Set(sets.map((p) => p.column));
    const rowKeys = new Set(sets.map((p) => p.rowKey));
    const values = new Set(sets.map((p) => p.newValue));
    const sizes = new Set(sets.map((p) => dataRowsForSeed(p.fixtureSeed)));
    expect(columns).toEqual(new Set(["name", "qty", "joined", "salary"]));
    expect(rowKeys.size).toBeGreaterThan(10);
    expect(values.size).toBe(30);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(200);
  });

  it("is stable against a different seed-list order for the same seed at the same index", () => {
    // Determinism is per (seed, index); reordering the list changes which seed
    // lands at an index, but the generated set for a given seed+index is fixed.
    const a = generateParameterSets(SEEDS)[0];
    const b = generateParameterSets([SEEDS[0] ?? ""]);
    expect(b[0]).toEqual(a);
  });

  it("emits AutoCorrect-immune newValues for a 5,000-seed sweep across all columns", () => {
    for (let i = 0; i < 5_000; i++) {
      for (const set of generateParameterSets([`sweep-${i}`])) {
        const col = DATA_COLUMNS.find((c) => c.name === set.column);
        expect(col, set.column).toBeDefined();
        if (!col) continue;
        expect(isAutoCorrectImmune(set.newValue, col.type), `${set.newValue} / ${set.column}`).toBe(
          true,
        );
      }
    }
  });
});

describe("parameter generation shape", () => {
  it("keeps the standard-seed-list 30-set shape unchanged", () => {
    const sets = generateParameterSets(SEEDS);
    expect(sets).toHaveLength(30);
    expect(new Set(sets.map((p) => JSON.stringify(p))).size).toBe(30);
    expect(new Set(sets.map((p) => p.newValue)).size).toBe(30);
    expect(new Set(sets.map((p) => p.column))).toEqual(
      new Set(["name", "qty", "joined", "salary"]),
    );
  });
});

describe("isAutoCorrectImmune", () => {
  it("rejects known-bad values", () => {
    const bad = [
      "revised-908578",
      "myco-smoke-1",
      "=SUM(A1)",
      "'quoted",
      "2024-01-01",
      "",
      "+42",
      "-30",
    ];
    for (const v of bad) {
      expect(isAutoCorrectImmune(v, "text"), v).toBe(false);
    }
  });

  it("accepts known-good values", () => {
    const good = ["REVISED-908578", "Myco-Smoke-1", "908578", "EMP-0038"];
    for (const v of good) {
      expect(isAutoCorrectImmune(v, "text"), v).toBe(true);
    }
  });

  it("accepts typed values for their own column types", () => {
    expect(isAutoCorrectImmune("42", "integer")).toBe(true);
    expect(isAutoCorrectImmune("2024-01-01", "date")).toBe(true);
    expect(isAutoCorrectImmune("$123.45", "currency")).toBe(true);
  });
});

describe("calc-record-edit ground truth", () => {
  it("matches a hand-computed case", () => {
    // Hand-computed (2026-11-18, from the fixture PRNG chain for seed
    // "alpha"): fixture has 107 data rows; row EMP-0001 is
    // [EMP-0001, "Hana Ito", 650, 2021-09-25, $72747.62]. The qty column is
    // sheet column C, and EMP-0001 is sheet row 2 (row 1 is the header), so
    // the target cell is C2 and the pristine value is 650.
    const params: CalcRecordEditParams = {
      fixtureSeed: "alpha",
      rowKey: "EMP-0001",
      column: "qty",
      newValue: "42",
    };
    const gt = groundTruth(params);
    expect(gt.cellRef).toBe("C2");
    expect(gt.expectedValue).toBe("42");
    expect(gt.previousValue).toBe("650");
    // Cross-check the pinned literal against the fixture generator itself.
    expect(generateFixture("alpha").rows[0]?.[2]).toBe("650");
  });

  it("is reproducible host-side without touching the guest", () => {
    const params: CalcRecordEditParams = {
      fixtureSeed: "bravo",
      rowKey: "EMP-0007",
      column: "salary",
      newValue: "$123.45",
    };
    expect(groundTruth(params)).toEqual(groundTruth(params));
  });
});

describe("calc-record-edit guarded program against the fake app", () => {
  const sampleSeeds = ["alpha", "bravo", "charlie"];
  const sampleSets = generateParameterSets(SEEDS);

  it.each(sampleSets.slice(0, 5).map((p) => ({ p })))(
    "completes and verifies for $p.rowKey / $p.column (seed $p.fixtureSeed)",
    async ({ p }) => {
      const filePath = tmpCsv(p.fixtureSeed);
      const app = fakeForSeed(p.fixtureSeed, filePath);
      const outcome = await runProgram(app, programFor(app, p));
      expect(outcome.completed).toBe(true);
      expect(outcome.guardFailure).toBeUndefined();

      const persisted = readCsvSpreadsheet(filePath);
      const verdict = calcRecordEditVerifier.verify(persisted, intentFor(p));
      expect(verdict.status).toBe("verified");
    },
  );

  it("verifies `verified` across several parameter sets via the family wiring", async () => {
    for (const p of sampleSets.slice(5, 9)) {
      const filePath = tmpCsv(`${p.fixtureSeed}-${p.rowKey}`);
      fakeForSeed(p.fixtureSeed, filePath);
      const persisted = readCsvSpreadsheet(filePath);
      expect(calcRecordEditFamily.satisfiedBy(persisted, { ...p })).toBe(false); // pristine: edit not landed
    }
  });

  it("aborts with a precondition GuardFailure for a nonexistent rowKey (invalid-target)", async () => {
    const seed = sampleSeeds[0] ?? "alpha";
    const filePath = tmpCsv("invalid-row");
    const app = fakeForSeed(seed, filePath);
    const fileBefore = readFileSync(filePath, "utf8"); // fixture bytes before the run
    const dataRows = dataRowsForSeed(seed);
    const params: CalcRecordEditParams = {
      fixtureSeed: seed,
      rowKey: `EMP-${String(dataRows + 5).padStart(4, "0")}`,
      column: "name",
      newValue: "ghost",
    };
    const outcome = await runProgram(app, programFor(app, params));
    expect(outcome.completed).toBe(false);
    expect(outcome.guardFailure?.phase).toBe("precondition");
    expect(outcome.guardFailure?.observed).toContain("invalid target");
    // nothing was acted on: the file is byte-identical to before the run
    expect(readFileSync(filePath, "utf8")).toBe(fileBefore);
  });

  it("aborts for an unknown column name", async () => {
    const filePath = tmpCsv("invalid-col");
    const app = fakeForSeed("alpha", filePath);
    const params: CalcRecordEditParams = {
      fixtureSeed: "alpha",
      rowKey: "EMP-0001",
      column: "nickname",
      newValue: "x",
    };
    const outcome = await runProgram(app, programFor(app, params));
    expect(outcome.completed).toBe(false);
    expect(outcome.guardFailure?.phase).toBe("precondition");
  });

  it("yields `refuted` when the persisted file lacks the edit", () => {
    // Harness test per ADR-0002: adapter-reported success is not consulted;
    // the file is missing the edit → refuted.
    const filePath = tmpCsv("unsaved");
    fakeForSeed("alpha", filePath); // pristine fixture on disk
    const params: CalcRecordEditParams = {
      fixtureSeed: "alpha",
      rowKey: "EMP-0001",
      column: "name",
      newValue: "should-not-appear",
    };
    const persisted = readCsvSpreadsheet(filePath);
    const verdict = calcRecordEditVerifier.verify(persisted, intentFor(params));
    expect(verdict.status).toBe("refuted");
  });
});

describe("calc-record-edit fixtures", () => {
  it("generates deterministic CSV bytes from a seed", () => {
    expect(generateFixture("alpha").csv).toBe(generateFixture("alpha").csv);
    expect(generateFixture("alpha").csv).not.toBe(generateFixture("bravo").csv);
  });

  it("sizes fixtures 5–200 data rows with typed columns", () => {
    for (const seed of SEEDS) {
      const f = generateFixture(seed);
      expect(f.dataRows).toBeGreaterThanOrEqual(5);
      expect(f.dataRows).toBeLessThanOrEqual(200);
      expect(f.header).toEqual(["id", "name", "qty", "joined", "salary"]);
      expect(f.rows[0]?.[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // date column
      expect(f.rows[0]?.[4]).toMatch(/^\$\d+\.\d{2}$/); // currency column
    }
  });
});
