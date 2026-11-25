import { describe, expect, it } from "vitest";
import {
  type ColumnType,
  cellMatches,
  type GradeInput,
  grade,
  sha256,
} from "../../src/benchmark/grade/grade.ts";
import {
  isDateFormatCode,
  parseCsv,
  parseRef,
  readCsvGrid,
  readXlsxGrid,
  refOf,
  SheetReadError,
  serialToIsoDate,
} from "../../src/benchmark/grade/sheet.ts";
import { readZip, ZipReadError } from "../../src/benchmark/grade/zip.ts";
import {
  buildXlsx,
  calcImport,
  isoToSerial,
  type TestCell,
  toCalcCell,
  zip,
} from "./xlsx-writer.ts";

const FIXTURE = [
  "id,name,qty,joined,salary",
  "EMP-0001,Ada Ito,12,2020-03-04,$41234.50",
  "EMP-0002,Bruno Jovic,7,2021-11-30,$30500.00",
  "EMP-0003,Cleo Kaur,999,2023-06-15,$79999.99",
]
  .join("\n")
  .concat("\n");
const FIXTURE_BYTES = Buffer.from(FIXTURE, "utf8");
const COLUMN_TYPES: Record<string, ColumnType> = {
  id: "key",
  name: "text",
  qty: "integer",
  joined: "date",
  salary: "currency",
};

function input(
  persisted: GradeInput["persisted"],
  intent: GradeInput["intent"] = { rowKey: "EMP-0002", column: "qty", newValue: "42" },
): GradeInput {
  return {
    fixtureCsv: FIXTURE_BYTES,
    fixtureSha256: sha256(FIXTURE_BYTES),
    persisted,
    intent,
    columnTypes: COLUMN_TYPES,
  };
}

/** The workbook after Calc imported the fixture and applied `edits` (A1 -> cell or null to clear). */
function calcSaved(
  edits: Record<string, TestCell | null> = {},
  extra: Partial<Parameters<typeof buildXlsx>[0]> = {},
) {
  const cells: Record<string, TestCell> = calcImport(FIXTURE);
  for (const [ref, cell] of Object.entries(edits)) {
    if (cell === null) delete cells[ref];
    else cells[ref] = cell;
  }
  return { format: "xlsx" as const, bytes: buildXlsx({ cells, ...extra }) };
}

describe("benchmark grader: readers", () => {
  it("round-trips A1 references", () => {
    for (const [row, col] of [
      [0, 0],
      [2, 1],
      [99, 25],
      [9, 26],
      [0, 701],
      [0, 702],
    ] as const) {
      expect(parseRef(refOf(row, col))).toEqual({ row, col });
    }
    expect(refOf(0, 26)).toBe("AA1");
    expect(() => parseRef("A0")).toThrow(SheetReadError);
  });

  it("converts serials in both date systems", () => {
    expect(serialToIsoDate(43831, 1900)).toBe("2020-01-01");
    expect(serialToIsoDate(1, 1900)).toBe("1900-01-01");
    expect(serialToIsoDate(59, 1900)).toBe("1900-02-28");
    expect(serialToIsoDate(60, 1900)).toBeNull();
    expect(serialToIsoDate(61, 1900)).toBe("1900-03-01");
    expect(serialToIsoDate(1, 1904)).toBe("1904-01-02");
    expect(serialToIsoDate(43831.5, 1900)).toBeNull();
    expect(isoToSerial("2020-01-01")).toBe(43831);
  });

  it("classifies number formats as date or not", () => {
    expect(isDateFormatCode("YYYY\\-MM\\-DD")).toBe(true);
    expect(isDateFormatCode("d/m/yy")).toBe(true);
    expect(isDateFormatCode("[$$-409]#,##0.00;[RED]\\-[$$-409]#,##0.00")).toBe(false);
    expect(isDateFormatCode('0.00" days"')).toBe(false);
    expect(isDateFormatCode("hh:mm")).toBe(false);
  });

  it("parses RFC 4180 CSV", () => {
    expect(parseCsv('a,"b,c","d""e"\r\n,x\n')).toEqual([
      ["a", "b,c", 'd"e'],
      ["", "x"],
    ]);
    expect(() => parseCsv('a,"open')).toThrow(SheetReadError);
  });

  it("reads stored and deflated archives identically", () => {
    const files = { "a.txt": "hello", "b/c.xml": "<x/>" };
    for (const deflate of [true, false]) {
      const entries = readZip(zip(files, deflate));
      expect(entries.get("a.txt")?.toString()).toBe("hello");
      expect(entries.get("b/c.xml")?.toString()).toBe("<x/>");
    }
  });

  it("rejects non-zip and truncated input", () => {
    expect(() => readZip(Buffer.from("id,name\n"))).toThrow(ZipReadError);
    const good = zip({ "a.txt": "hello world" });
    expect(() => readZip(good.subarray(10))).toThrow(ZipReadError);
  });

  it("reads Calc-shaped cell kinds", () => {
    const grid = readXlsxGrid(
      buildXlsx({
        cells: {
          A1: { t: "s", v: "x & <y>" },
          B1: { t: "n", v: 43831, style: "date" },
          C1: { t: "n", v: 12.5, style: "currency" },
          D1: { t: "inline", v: "inline" },
          E1: { t: "b", v: true },
          F1: { t: "n-formula", f: "B1+1", v: 43832 },
        },
        customDateFormat: true,
      }),
    );
    expect(grid.cells.get("0,0")).toEqual({ kind: "text", text: "x & <y>" });
    expect(grid.cells.get("0,1")).toEqual({ kind: "number", value: 43831, isDate: true });
    expect(grid.cells.get("0,2")).toEqual({ kind: "number", value: 12.5, isDate: false });
    expect(grid.cells.get("0,3")).toEqual({ kind: "text", text: "inline" });
    expect(grid.cells.get("0,4")).toEqual({ kind: "boolean", value: true });
    expect(grid.cells.get("0,5")).toEqual({ kind: "formula", formula: "B1+1" });
    expect(grid.sheetCount).toBe(1);
  });

  it("decodes CSV as strict UTF-8", () => {
    expect(() => readCsvGrid(Buffer.from([0x61, 0xff, 0x0a]))).toThrow(TypeError);
  });
});

describe("benchmark grader: cell semantics", () => {
  it("needs the column's own domain for number-stored cells", () => {
    const date = { kind: "number" as const, value: isoToSerial("2021-11-30"), isDate: true };
    expect(cellMatches("2021-11-30", date, "date", 1900)).toBe(true);
    expect(cellMatches("2021-11-30", { ...date, isDate: false }, "date", 1900)).toBe(false);
    expect(cellMatches("42", { kind: "number", value: 42, isDate: false }, "integer", 1900)).toBe(
      true,
    );
    expect(cellMatches("42", { kind: "number", value: 42, isDate: true }, "integer", 1900)).toBe(
      false,
    );
    expect(
      cellMatches("$30500.00", { kind: "number", value: 30500, isDate: false }, "currency", 1900),
    ).toBe(true);
    expect(
      cellMatches(
        "$30500.00",
        { kind: "number", value: 30500.01, isDate: false },
        "currency",
        1900,
      ),
    ).toBe(false);
    expect(cellMatches("Ada Ito", { kind: "number", value: 1, isDate: false }, "text", 1900)).toBe(
      false,
    );
    expect(cellMatches("", undefined, "text", 1900)).toBe(true);
    expect(cellMatches("x", undefined, "text", 1900)).toBe(false);
    expect(cellMatches("x", { kind: "formula", formula: '"x"' }, "text", 1900)).toBe(false);
  });
});

describe("benchmark grader: verdicts", () => {
  it("passes the correct edit saved by Calc", () => {
    const r = grade(input(calcSaved({ C3: { t: "n", v: 42 } })));
    expect(r.status).toBe("pass");
    expect(r.target).toBe("C3");
    expect(r.reasons).toEqual([]);
  });

  it("passes the correct edit for each typed column", () => {
    const cases: [string, string, TestCell][] = [
      ["name", "Zed Zulu", { t: "s", v: "Zed Zulu" }],
      ["joined", "2024-02-29", toCalcCell("2024-02-29")],
      ["salary", "$55000.25", toCalcCell("$55000.25")],
    ];
    const refs: Record<string, string> = { name: "B3", joined: "D3", salary: "E3" };
    for (const [column, newValue, cell] of cases) {
      const r = grade(
        input(calcSaved({ [refs[column] as string]: cell }), {
          rowKey: "EMP-0002",
          column,
          newValue,
        }),
      );
      expect(r.status, column).toBe("pass");
    }
  });

  it("passes the correct edit persisted as CSV (the fake app's format)", () => {
    const csv = FIXTURE.replace("EMP-0002,Bruno Jovic,7,", "EMP-0002,Bruno Jovic,42,");
    expect(grade(input({ format: "csv", bytes: Buffer.from(csv) })).status).toBe("pass");
  });

  it("works in the 1904 date system and with deflate off", () => {
    const cells = calcImport(FIXTURE);
    for (const [ref, cell] of Object.entries(cells)) {
      if (cell.t === "n" && cell.style === "date") cells[ref] = { ...cell, v: cell.v - 1462 };
    }
    cells.C3 = { t: "n", v: 42 };
    const r = grade(
      input({ format: "xlsx", bytes: buildXlsx({ cells, date1904: true, deflate: false }) }),
    );
    expect(r.status).toBe("pass");
  });

  // Each case is a document a false "done" could leave behind. The grader must fail all.
  const FALSE_DONE: [string, () => GradeInput["persisted"], RegExp][] = [
    ["edit never saved (pristine document)", () => calcSaved(), /target C3 holds number 7/],
    ["wrong value", () => calcSaved({ C3: { t: "n", v: 43 } }), /target C3/],
    ["right value, wrong record", () => calcSaved({ C2: { t: "n", v: 42 } }), /target C3/],
    ["right value, wrong column", () => calcSaved({ B3: { t: "s", v: "42" } }), /target C3/],
    [
      "right edit plus a collateral edit",
      () => calcSaved({ C3: { t: "n", v: 42 }, B4: { t: "s", v: "Cleo X" } }),
      /1 cell\(s\) other than the target/,
    ],
    [
      "right edit plus a deleted cell",
      () => calcSaved({ C3: { t: "n", v: 42 }, E2: null }),
      /other than the target/,
    ],
    [
      "right edit plus content past the grid",
      () => calcSaved({ C3: { t: "n", v: 42 }, G9: { t: "s", v: "note" } }),
      /other than the target/,
    ],
    [
      "formula that evaluates to the value",
      () => calcSaved({ C3: { t: "n-formula", f: "40+2", v: 42 } }),
      /formula/,
    ],
    [
      "value stored as a date",
      () => calcSaved({ C3: { t: "n", v: 42, style: "date" } }),
      /date-serial/,
    ],
    [
      "right edit plus content on another sheet",
      () => calcSaved({ C3: { t: "n", v: 42 } }, { extraSheet: { A1: { t: "s", v: "x" } } }),
      /other than the first/,
    ],
  ];
  for (const [name, persisted, reason] of FALSE_DONE) {
    it(`fails: ${name}`, () => {
      const r = grade(input(persisted()));
      expect(r.status).toBe("fail");
      expect(r.reasons.join("; ")).toMatch(reason);
    });
  }

  it("fails a bare serial typed into a date column (no date format)", () => {
    const r = grade(
      input(calcSaved({ D3: { t: "n", v: isoToSerial("2022-01-01") } }), {
        rowKey: "EMP-0002",
        column: "joined",
        newValue: "2022-01-01",
      }),
    );
    expect(r.status).toBe("fail");
  });

  it("fails an amount stored as text without the currency form", () => {
    const r = grade(
      input(calcSaved({ E3: { t: "s", v: "55000.25" } }), {
        rowKey: "EMP-0002",
        column: "salary",
        newValue: "$55000.25",
      }),
    );
    expect(r.status).toBe("fail");
  });

  it("fails an unsatisfiable intent whatever the document holds", () => {
    expect(
      grade(
        input(calcSaved(), { rowKey: "EMP-9999", column: "qty", newValue: "1" }),
      ).reasons.join(),
    ).toMatch(/record "EMP-9999" is not in the fixture/);
    expect(
      grade(input(calcSaved(), { rowKey: "EMP-0002", column: "nickname", newValue: "1" })).status,
    ).toBe("fail");
    expect(
      grade(input(calcSaved(), { rowKey: "EMP-0002", column: "id", newValue: "EMP-0099" })).status,
    ).toBe("fail");
  });

  it("is ungradable, never pass, when it cannot look", () => {
    expect(grade(input(null)).status).toBe("ungradable");
    expect(grade(input({ format: "xlsx", bytes: Buffer.from("not a zip") })).status).toBe(
      "ungradable",
    );
    expect(
      grade(input({ format: "xlsx", bytes: buildXlsx({ cells: {} }).subarray(0, 40) })).status,
    ).toBe("ungradable");
    expect(
      grade({ ...input(calcSaved({ C3: { t: "n", v: 42 } })), fixtureSha256: "0".repeat(64) })
        .status,
    ).toBe("ungradable");
  });

  it("is ungradable when the fixture is ambiguous for the intent", () => {
    const dup = Buffer.from(`${FIXTURE}EMP-0002,Dup Row,1,2020-01-01,$1.00\n`);
    const r = grade({
      ...input({ format: "csv", bytes: dup }),
      fixtureCsv: dup,
      fixtureSha256: sha256(dup),
    });
    expect(r.status).toBe("ungradable");
  });

  it("reports hashes, never paths", () => {
    const persisted = calcSaved({ C3: { t: "n", v: 42 } });
    const r = grade(input(persisted));
    expect(r.fixtureSha256).toBe(sha256(FIXTURE_BYTES));
    expect(r.persistedSha256).toBe(sha256(persisted.bytes));
  });
});
