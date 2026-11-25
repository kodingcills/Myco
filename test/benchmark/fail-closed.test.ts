/**
 * TIF-267 round 3 (E1): the grader fails closed. A huge date serial must not throw, and any
 * exception raised past the fixture-hash check (reader or comparison) must become
 * `ungradable` for that trial instead of aborting a grading batch.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type ColumnType,
  type GradeInput,
  grade,
  sha256,
} from "../../src/benchmark/grade/grade.ts";
import { MAX_DATE_SERIAL, serialToIsoDate } from "../../src/benchmark/grade/sheet.ts";
import { buildXlsx, calcImport, type TestCell } from "./xlsx-writer.ts";

// One switch, read by the mocked comparison helper below; off for every test but one.
const fault = vi.hoisted(() => ({ throwInComparison: false }));
vi.mock("../../src/benchmark/grade/sheet.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/benchmark/grade/sheet.ts")>();
  return {
    ...real,
    serialToIsoDate: (serial: number, system: 1900 | 1904) => {
      if (fault.throwInComparison) throw new RangeError("injected comparison fault");
      return real.serialToIsoDate(serial, system);
    },
  };
});

const FIXTURE = [
  "id,name,qty,joined,salary",
  "EMP-0001,Ada Ito,12,2020-03-04,$41234.50",
  "EMP-0002,Bruno Jovic,7,2021-11-30,$30500.00",
  "EMP-0003,Cleo Kaur,999,2023-06-15,$79999.99",
]
  .join("\n")
  .concat("\n");
const FIXTURE_BYTES = Buffer.from(FIXTURE);
const TYPES: Record<string, ColumnType> = {
  id: "key",
  name: "text",
  qty: "integer",
  joined: "date",
  salary: "currency",
};
const INTENT = { rowKey: "EMP-0002", column: "qty", newValue: "42" };

function input(bytes: Buffer): GradeInput {
  return {
    fixtureCsv: FIXTURE_BYTES,
    fixtureSha256: sha256(FIXTURE_BYTES),
    persisted: { format: "xlsx", bytes },
    intent: INTENT,
    columnTypes: TYPES,
  };
}

function correctWith(edits: Record<string, TestCell>, deflate = true): Buffer {
  const cells: Record<string, TestCell> = { ...calcImport(FIXTURE), C3: { t: "n", v: 42 } };
  return buildXlsx({ cells: { ...cells, ...edits }, deflate });
}

describe("date serial bounds (E1)", () => {
  it("accepts the last representable day and rejects anything later, in both systems", () => {
    expect(MAX_DATE_SERIAL).toEqual({ 1900: 2958465, 1904: 2957003 });
    expect(serialToIsoDate(2958465, 1900)).toBe("9999-12-31");
    expect(serialToIsoDate(2958466, 1900)).toBeNull();
    expect(serialToIsoDate(2957003, 1904)).toBe("9999-12-31");
    expect(serialToIsoDate(2957004, 1904)).toBeNull();
    expect(serialToIsoDate(1e9, 1900)).toBeNull();
    expect(serialToIsoDate(Number.MAX_SAFE_INTEGER, 1904)).toBeNull();
    // The invalid-Date guard is unreachable while the bound holds; an out-of-contract date
    // system value has no bound entry, so it pins the guard on its own.
    expect(serialToIsoDate(1e9, 1999 as unknown as 1900)).toBeNull();
  });

  it("grades a date-styled 1e9 in a non-target date cell as fail, never a throw", () => {
    // Documented outcome: the cell provably differs from the pristine date (no day has that
    // serial), so the document does not satisfy the intent. That is `fail` (collateral
    // damage), not "could not look".
    const r = grade(input(correctWith({ D2: { t: "n", v: 1e9, style: "date" } })));
    expect(r.status).toBe("fail");
    expect(r.targetSatisfied).toBe(true);
    expect(r.reasons.join()).toMatch(/1 cell\(s\) other than the target/);
    expect(r.mismatches[0]).toMatchObject({
      cell: "D2",
      actual: "date-serial 1000000000",
      target: false,
    });
  });
});

describe("fail closed past the hash check (E1)", () => {
  it("turns an exception in the comparison step into ungradable", () => {
    fault.throwInComparison = true;
    try {
      const r = grade(input(correctWith({})));
      expect(r.status).toBe("ungradable");
      expect(r.reasons).toEqual(["grader error (RangeError): injected comparison fault"]);
    } finally {
      fault.throwInComparison = false;
    }
    expect(grade(input(correctWith({}))).status).toBe("pass");
  });

  for (const deflate of [false, true]) {
    it(`never throws on any single-byte change of a ${deflate ? "deflated" : "stored"} workbook with date cells`, () => {
      const good = correctWith({}, deflate);
      expect(grade(input(good)).status).toBe("pass");
      // Stored entries put the XML on the wire, so writing a digit into every byte also
      // reaches the numeric and date values; deflated entries get a bit flip per byte.
      const replacements = deflate
        ? [(b: number) => b ^ 0xff]
        : [(b: number) => b ^ 0xff, () => 0x39];
      const statuses = new Set<string>();
      for (let at = 0; at < good.length; at++) {
        for (const replace of replacements) {
          const bad = Buffer.from(good);
          bad[at] = replace(bad[at] as number);
          statuses.add(grade(input(bad)).status);
        }
      }
      expect([...statuses].every((s) => ["pass", "fail", "ungradable"].includes(s))).toBe(true);
      expect(statuses.has("ungradable")).toBe(true);
    });
  }
});
