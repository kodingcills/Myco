/**
 * TIF-267 round 2: hostile and malformed documents. The grader must answer `ungradable`
 * for anything it cannot read, never throw (one bad document must not cost the rest of a
 * grading batch), and each container/XML guard must be pinned by a test that fails when the
 * guard is removed.
 */
import { describe, expect, it } from "vitest";
import { benchmarkGradeRequestSchema } from "../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  type ColumnType,
  type GradeInput,
  grade,
  sha256,
} from "../../src/benchmark/grade/grade.ts";
import { readXlsxGrid, SheetReadError } from "../../src/benchmark/grade/sheet.ts";
import { MAX_INFLATED_BYTES, readZip, ZipReadError } from "../../src/benchmark/grade/zip.ts";
import { buildXlsx, calcImport, zip } from "./xlsx-writer.ts";

const FIXTURE = "id,name,qty\nEMP-0001,Ada Ito,12\nEMP-0002,Bruno Jovic,7\n";
const FIXTURE_BYTES = Buffer.from(FIXTURE);
const TYPES: Record<string, ColumnType> = { id: "key", name: "text", qty: "integer" };
const INTENT = { rowKey: "EMP-0002", column: "qty", newValue: "42" };

function input(persisted: GradeInput["persisted"], columnTypes = TYPES): GradeInput {
  return {
    fixtureCsv: FIXTURE_BYTES,
    fixtureSha256: sha256(FIXTURE_BYTES),
    persisted,
    intent: INTENT,
    columnTypes,
  };
}

const sheetWith = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${inner}</sheetData></worksheet>`;

/** Offsets of the end-of-central-directory record and the first central entry. */
function zipOffsets(buf: Buffer): { eocd: number; central: number } {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  return { eocd, central: buf.readUInt32LE(eocd + 16) };
}

describe("character references (D2)", () => {
  for (const ref of [
    "&#x110000;",
    "&#1114112;",
    "&#xD800;",
    "&#xDFFF;",
    "&#x99999999999999999999;",
  ]) {
    it(`rejects ${ref} as a SheetReadError and grades it ungradable`, () => {
      const xml = sheetWith(`<row r="1"><c r="A1" t="inlineStr"><is><t>${ref}</t></is></c></row>`);
      const bytes = buildXlsx({ cells: {}, rawSheetXml: xml });
      expect(() => readXlsxGrid(bytes)).toThrow(SheetReadError);
      const r = grade(input({ format: "xlsx", bytes }));
      expect(r.status).toBe("ungradable");
      expect(r.reasons.join()).toMatch(/invalid character reference/);
    });
  }

  it("still decodes valid references, including astral ones", () => {
    const xml = sheetWith(
      `<row r="1"><c r="A1" t="inlineStr"><is><t>&#x1F600;&#65;&amp;</t></is></c></row>`,
    );
    expect(readXlsxGrid(buildXlsx({ cells: {}, rawSheetXml: xml })).cells.get("0,0")).toEqual({
      kind: "text",
      text: "\u{1F600}A&",
    });
  });
});

describe("unexpected reader failures cost one trial, not the batch (D2)", () => {
  it("turns a non-SheetReadError from the reader into ungradable (invalid UTF-8 CSV)", () => {
    const r = grade(input({ format: "csv", bytes: Buffer.from([0x69, 0x64, 0xff, 0x0a]) }));
    expect(r.status).toBe("ungradable");
    expect(r.reasons.join()).toMatch(/\(TypeError\)/);
  });

  it("never throws on any single-byte corruption of a valid workbook", () => {
    const cells = calcImport(FIXTURE);
    cells.C3 = { t: "n", v: 42 };
    const good = buildXlsx({ cells });
    const seen = new Set<string>();
    for (let at = 0; at < good.length; at += 3) {
      for (const flip of [0x01, 0x80, 0xff]) {
        const bad = Buffer.from(good);
        bad[at] = (bad[at] as number) ^ flip;
        const r = grade(input({ format: "xlsx", bytes: bad }));
        seen.add(r.status);
      }
    }
    expect([...seen].every((s) => s === "pass" || s === "fail" || s === "ungradable")).toBe(true);
    expect(seen.has("ungradable")).toBe(true);
  });
});

describe("container guards (D4)", () => {
  it("refuses an archive that declares more than the inflate cap", () => {
    const buf = zip({ "a.txt": "x" }, false);
    const { central } = zipOffsets(buf);
    buf.writeUInt32LE(MAX_INFLATED_BYTES + 1, central + 24);
    expect(() => readZip(buf)).toThrow(/inflates too large/);
  });

  it("refuses a ZIP64 archive", () => {
    const buf = zip({ "a.txt": "x" }, false);
    const { eocd } = zipOffsets(buf);
    buf.writeUInt16LE(0xffff, eocd + 10);
    expect(() => readZip(buf)).toThrow(/zip64/);
  });

  it("refuses an encrypted entry", () => {
    const buf = zip({ "a.txt": "x" }, false);
    const { central } = zipOffsets(buf);
    buf.writeUInt16LE(0x1, central + 8);
    expect(() => readZip(buf)).toThrow(ZipReadError);
    expect(() => readZip(buf)).toThrow(/encrypted/);
  });

  it("refuses a sheet that defines the same cell twice", () => {
    const xml = sheetWith(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="A1" t="inlineStr"><is><t>b</t></is></c></row>',
    );
    expect(() => readXlsxGrid(buildXlsx({ cells: {}, rawSheetXml: xml }))).toThrow(
      /duplicate cell A1/,
    );
  });
});

describe("request mistakes are ungradable, not false fails", () => {
  it("is ungradable when a column has no declared type", () => {
    const cells = calcImport(FIXTURE);
    cells.C3 = { t: "n", v: 42 };
    const r = grade(input({ format: "xlsx", bytes: buildXlsx({ cells }) }, {}));
    expect(r.status).toBe("ungradable");
    expect(r.reasons.join()).toMatch(/column types missing for: "id", "name", "qty"/);
  });

  it("is ungradable when the declared format does not match the bytes", () => {
    const csv = Buffer.from(FIXTURE.replace("Bruno Jovic,7", "Bruno Jovic,42"));
    expect(grade(input({ format: "xlsx", bytes: csv })).reasons.join()).toMatch(/declared xlsx/);
    const cells = calcImport(FIXTURE);
    cells.C3 = { t: "n", v: 42 };
    const r = grade(input({ format: "csv", bytes: buildXlsx({ cells }) }));
    expect(r.status).toBe("ungradable");
    expect(r.reasons.join()).toMatch(/declared csv but its bytes are a zip/);
  });
});

describe("grade request schema (the TIF-268 input contract)", () => {
  const good = {
    trialKey: "t1",
    taskId: "fc-1",
    fixtureSha256: "a".repeat(64),
    fixtureFile: "fixtures/fc-1.csv",
    persistedFile: "runs/t1/doc.xlsx",
    persistedFormat: "xlsx",
    intent: { rowKey: "EMP-0002", column: "qty", newValue: "42" },
    columnTypes: { id: "key", qty: "integer" },
  };
  it("accepts a well-formed request", () => {
    expect(validateSchema(good, benchmarkGradeRequestSchema)).toEqual([]);
    expect(validateSchema({ ...good, persistedFile: null }, benchmarkGradeRequestSchema)).toEqual(
      [],
    );
  });
  const BAD: [string, object][] = [
    ["an absolute path", { ...good, persistedFile: "/abs/doc.xlsx" }],
    ["a parent-directory path", { ...good, fixtureFile: "../fixtures/x.csv" }],
    ["a nested parent-directory path", { ...good, persistedFile: "runs/../../x.xlsx" }],
    ["a drive path", { ...good, fixtureFile: "C:\\fixtures\\x.csv" }],
    ["a claim field", { ...good, claim: "done" }],
    ["a gate verdict field", { ...good, gateVerdict: "verified" }],
    ["an unknown format", { ...good, persistedFormat: "ods" }],
  ];
  for (const [name, req] of BAD) {
    it(`rejects ${name}`, () => {
      expect(validateSchema(req, benchmarkGradeRequestSchema).length).toBeGreaterThan(0);
    });
  }
});
