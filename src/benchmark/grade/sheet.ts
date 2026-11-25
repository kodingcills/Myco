/**
 * Spreadsheet readers for the independent benchmark grader (TIF-267).
 *
 * Two inputs, both read straight from bytes on the host:
 *  - CSV (the pristine fixture, and the fake app's persisted format);
 *  - `.xlsx` (what LibreOffice Calc saves in the guest), via `zip.ts` and the OOXML
 *    parts it needs: workbook, its relationships, shared strings, styles, first sheet.
 *
 * Deliberately shares nothing with the gate's reader (`src/core/filepersist.ts`, which
 * parses the CSV that `soffice --convert-to csv` produces). A cell keeps its stored kind
 * (text, number, boolean, error, formula) and whether its number format is a date, so the
 * grader can tell "2020-01-01" from a bare 43831 typed into a date column.
 */
import { readZip, ZipReadError } from "./zip.ts";

export type Cell =
  | { kind: "text"; text: string }
  | { kind: "number"; value: number; isDate: boolean }
  | { kind: "boolean"; value: boolean }
  | { kind: "error"; text: string }
  | { kind: "formula"; formula: string };

/** A sparse grid: key `${row},${col}`, both 0-based. Empty cells are absent. */
export interface Grid {
  readonly cells: ReadonlyMap<string, Cell>;
  /** Number of sheets in the workbook (1 for CSV). */
  readonly sheetCount: number;
  /** Non-empty cells found on sheets other than the first. */
  readonly otherSheetCells: number;
  /** 1900 or 1904 date system (CSV: 1900, unused). */
  readonly dateSystem: 1900 | 1904;
}

export class SheetReadError extends Error {
  override name = "SheetReadError";
}

export const cellKey = (row: number, col: number) => `${row},${col}`;

/** "B3" -> { row: 2, col: 1 } */
export function parseRef(ref: string): { row: number; col: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (!match) throw new SheetReadError(`bad cell reference ${JSON.stringify(ref)}`);
  let col = 0;
  for (const ch of match[1] as string) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

/** 0-based (row, col) -> "B3". */
export function refOf(row: number, col: number): string {
  let n = col + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `${letters}${row + 1}`;
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180: quoted fields, doubled quotes, CRLF or LF)
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  while (i < body.length) {
    const ch = body[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && body[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (quoted) throw new SheetReadError("unterminated quoted CSV field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readCsvGrid(bytes: Uint8Array): Grid {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const cells = new Map<string, Cell>();
  parseCsv(text).forEach((row, r) => {
    row.forEach((value, c) => {
      if (value !== "") cells.set(cellKey(r, c), { kind: "text", text: value });
    });
  });
  return { cells, sheetCount: 1, otherSheetCells: 0, dateSystem: 1900 };
}

// ---------------------------------------------------------------------------
// XLSX (OOXML SpreadsheetML)
// ---------------------------------------------------------------------------

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
    out[m[1] as string] = decodeXml(m[2] as string);
  }
  return out;
}

/** Concatenated text of every `<t>` element in a fragment (rich-text runs included). */
function textRuns(fragment: string): string {
  let out = "";
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    out += decodeXml(m[1] ?? "");
  }
  return out;
}

function part(entries: Map<string, Buffer>, name: string): string | undefined {
  return entries.get(name)?.toString("utf8");
}

function resolveTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Built-in number formats that render as dates or date-times (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58,
]);

/** A custom format is a date format if it carries a year or day token outside quotes. */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "");
  return /[yYdD]/.test(stripped);
}

function readStyles(xml: string | undefined): boolean[] {
  if (xml === undefined) return [];
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const a = attributes(m[1] as string);
    if (a.numFmtId !== undefined && a.formatCode !== undefined) {
      custom.set(Number(a.numFmtId), a.formatCode);
    }
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const isDate: boolean[] = [];
  for (const m of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)) {
    const id = Number(attributes(m[1] as string).numFmtId ?? "0");
    const code = custom.get(id);
    isDate.push(code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id));
  }
  return isDate;
}

function readSheetCells(
  xml: string,
  sharedStrings: readonly string[],
  dateStyles: readonly boolean[],
): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  const sheetData = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (!sheetData) throw new SheetReadError("worksheet has no sheetData");
  const body = sheetData[1] ?? "";
  for (const m of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const a = attributes(m[1] as string);
    const inner = m[2] ?? "";
    if (a.r === undefined) throw new SheetReadError("cell without a reference");
    const { row, col } = parseRef(a.r);
    const key = cellKey(row, col);
    if (cells.has(key)) throw new SheetReadError(`duplicate cell ${a.r}`);

    const formula = /<f\b[^>]*?(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
    if (formula) {
      cells.set(key, { kind: "formula", formula: decodeXml(formula[1] ?? "") });
      continue;
    }
    const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    const type = a.t ?? "n";
    if (type === "inlineStr") {
      const text = textRuns(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "");
      if (text !== "") cells.set(key, { kind: "text", text });
    } else if (type === "s") {
      if (v === undefined) continue;
      const text = sharedStrings[Number(v)];
      if (text === undefined) throw new SheetReadError(`shared string ${v} out of range`);
      if (text !== "") cells.set(key, { kind: "text", text });
    } else if (type === "str") {
      const text = decodeXml(v ?? "");
      if (text !== "") cells.set(key, { kind: "text", text });
    } else if (type === "b") {
      if (v !== undefined) cells.set(key, { kind: "boolean", value: v.trim() === "1" });
    } else if (type === "e") {
      cells.set(key, { kind: "error", text: decodeXml(v ?? "") });
    } else if (type === "n" || type === "d") {
      if (v === undefined) continue;
      const value = Number(v);
      if (!Number.isFinite(value)) throw new SheetReadError(`cell ${a.r} has non-numeric value`);
      const style = a.s === undefined ? 0 : Number(a.s);
      cells.set(key, { kind: "number", value, isDate: dateStyles[style] ?? false });
    } else {
      throw new SheetReadError(`cell ${a.r} has unknown type ${type}`);
    }
  }
  return cells;
}

export function readXlsxGrid(bytes: Uint8Array): Grid {
  let entries: Map<string, Buffer>;
  try {
    entries = readZip(bytes);
  } catch (error) {
    if (error instanceof ZipReadError) throw new SheetReadError(`xlsx container: ${error.message}`);
    throw error;
  }
  const workbook = part(entries, "xl/workbook.xml");
  if (workbook === undefined) throw new SheetReadError("xlsx has no xl/workbook.xml");
  const rels = part(entries, "xl/_rels/workbook.xml.rels");
  if (rels === undefined) throw new SheetReadError("xlsx has no workbook relationships");

  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = attributes(m[1] as string);
    if (a.Id !== undefined && a.Target !== undefined) {
      targets.set(a.Id, resolveTarget("xl/workbook.xml", a.Target));
    }
  }
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)].map((m) => {
    const a = attributes(m[1] as string);
    const id = a["r:id"];
    const target = id === undefined ? undefined : targets.get(id);
    if (target === undefined) throw new SheetReadError("sheet without a resolvable relationship");
    return target;
  });
  if (sheets.length === 0) throw new SheetReadError("workbook has no sheets");

  const sharedXml = part(entries, "xl/sharedStrings.xml");
  const sharedStrings = sharedXml
    ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => textRuns(m[1] ?? ""))
    : [];
  const dateStyles = readStyles(part(entries, "xl/styles.xml"));
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*"(1|true)"/.test(workbook);

  const sheetXml = (target: string) => {
    const xml = part(entries, target);
    if (xml === undefined) throw new SheetReadError(`missing worksheet part ${target}`);
    return readSheetCells(xml, sharedStrings, dateStyles);
  };
  const first = sheetXml(sheets[0] as string);
  let otherSheetCells = 0;
  for (const target of sheets.slice(1)) otherSheetCells += sheetXml(target).size;
  return {
    cells: first,
    sheetCount: sheets.length,
    otherSheetCells,
    dateSystem: date1904 ? 1904 : 1900,
  };
}

/** Spreadsheet serial day number -> ISO date (whole days only; time part rejected). */
export function serialToIsoDate(serial: number, system: 1900 | 1904): string | null {
  if (!Number.isInteger(serial) || serial < 1) return null;
  // 1900 system: serial 60 is the nonexistent 1900-02-29; serials after it are offset by one.
  if (system === 1900 && serial === 60) return null;
  const baseMs =
    system === 1904
      ? Date.UTC(1904, 0, 1)
      : serial < 60
        ? Date.UTC(1899, 11, 31)
        : Date.UTC(1899, 11, 30);
  return new Date(baseMs + serial * 86_400_000).toISOString().slice(0, 10);
}
