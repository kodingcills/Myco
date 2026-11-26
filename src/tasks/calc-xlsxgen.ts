/**
 * Host-side `.xlsx` generator for Calc test documents (TIF-274 prerequisite).
 *
 * Serialises cells to a SpreadsheetML workbook laid out the way LibreOffice Calc saves one
 * (content types, package and workbook relationships, styles with custom number formats,
 * shared strings, one worksheet per sheet, docProps, theme), deterministically and without
 * LibreOffice. `xlsxFromCsv` builds the EQUIVALENT workbook of a CSV document: the same rows
 * and columns, with each value typed as Calc types it on import (integers and amounts as
 * numbers, ISO days as date serials, everything else as text).
 *
 * Test-document generation only: the gate's reader (`src/gate/xlsx-document.ts`) and the
 * independent grader's reader (`src/benchmark/grade/sheet.ts`) are written against the
 * format, not against this generator, and neither imports it.
 */
import { cellRef } from "../core/filepersist.ts";
import { writeZip, type ZipEntryInput } from "./writer-docgen.ts";

/** Number styles the generator writes (`cellXfs` index = position here). */
export const XLSX_STYLES = {
  general: 0,
  /** `YYYY\-MM\-DD`, what Calc assigns an imported ISO day. */
  date: 1,
  /** `[$$-409]#,##0.00;[RED]\-[$$-409]#,##0.00`, Calc's en-US currency format. */
  currency: 2,
  /** `0.00` (built-in 2). */
  fixed2: 3,
  /** `0` (built-in 1). */
  integer: 4,
  /** `0%` (built-in 9). */
  percent: 5,
  /** `MM/DD/YY`, a locale date order. */
  usDate: 6,
  /** `0.00" units"`, literal text in the format. */
  literal: 7,
  /** `#,##0.00 [$€-407]`, another currency. */
  euro: 8,
  /** `YYYY-MM-DD HH:MM:SS`, a date-time. */
  dateTime: 9,
} as const;
export type XlsxStyle = keyof typeof XLSX_STYLES;

export type XlsxCell =
  | { readonly kind: "text"; readonly text: string; readonly inline?: boolean }
  | { readonly kind: "number"; readonly value: number | string; readonly style?: XlsxStyle }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "error"; readonly text: string }
  | {
      readonly kind: "formula";
      readonly formula: string;
      /** Cached result; omitted = no `<v>` (an uncached formula). */
      readonly cached?: number;
      readonly style?: XlsxStyle;
    }
  | { readonly kind: "isoDate"; readonly value: string };

/** One sheet: a name and its cells by [row, col] (0-based). */
export interface XlsxSheet {
  readonly name: string;
  readonly cells: ReadonlyMap<string, XlsxCell>;
}

export interface XlsxOptions {
  readonly date1904?: boolean;
  /** Replace (string/bytes) or drop (null) entries after building, for fault tests. */
  readonly patch?: Readonly<Record<string, string | Uint8Array | null>>;
}

export const cellKey = (row: number, col: number) => `${row},${col}`;

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** XML-escape text; CR and TAB as character references so they survive XML parsing. */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;");
}

function textElement(text: string): string {
  const preserve = /^\s|\s$|[\n\r\t]/.test(text) ? ' xml:space="preserve"' : "";
  return `<t${preserve}>${xmlEscape(text)}</t>`;
}

const STYLES_XML = `${XML_HEAD}<styleSheet xmlns="${MAIN}"><numFmts count="6"><numFmt numFmtId="164" formatCode="YYYY\\-MM\\-DD"/><numFmt numFmtId="165" formatCode="[$$-409]#,##0.00;[RED]\\-[$$-409]#,##0.00"/><numFmt numFmtId="166" formatCode="MM/DD/YY"/><numFmt numFmtId="167" formatCode="0.00&quot; units&quot;"/><numFmt numFmtId="168" formatCode="#,##0.00 [$€-407]"/><numFmt numFmtId="169" formatCode="YYYY\\-MM\\-DD HH:MM:SS"/></numFmts><fonts count="1"><font><sz val="10"/><name val="Arial"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="169" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Default" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const THEME_XML = `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="LibreOffice"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1></a:clrScheme></a:themeElements></a:theme>`;

function sheetXml(sheet: XlsxSheet, shared: Map<string, number>): string {
  const byRow = new Map<number, [number, XlsxCell][]>();
  for (const [key, cell] of sheet.cells) {
    const [r, c] = key.split(",").map(Number) as [number, number];
    const list = byRow.get(r) ?? [];
    list.push([c, cell]);
    byRow.set(r, list);
  }
  const rows = [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([r, list]) => {
      const cells = list
        .sort((a, b) => a[0] - b[0])
        .map(([c, cell]) => cellXml(cellRef(r, c), cell, shared))
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `${XML_HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetPr filterMode="false"><pageSetUpPr fitToPage="false"/></sheetPr><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="12.8"/><sheetData>${rows}</sheetData><pageMargins left="0.7875" right="0.7875" top="1.05277777777778" bottom="1.05277777777778" header="0.7875" footer="0.7875"/></worksheet>`;
}

function styleAttr(style: XlsxStyle | undefined): string {
  return style === undefined || style === "general" ? "" : ` s="${XLSX_STYLES[style]}"`;
}

function cellXml(ref: string, cell: XlsxCell, shared: Map<string, number>): string {
  switch (cell.kind) {
    case "text": {
      if (cell.inline) return `<c r="${ref}" t="inlineStr"><is>${textElement(cell.text)}</is></c>`;
      let index = shared.get(cell.text);
      if (index === undefined) {
        index = shared.size;
        shared.set(cell.text, index);
      }
      return `<c r="${ref}" t="s"><v>${index}</v></c>`;
    }
    case "number":
      return `<c r="${ref}"${styleAttr(cell.style)} t="n"><v>${cell.value}</v></c>`;
    case "boolean":
      return `<c r="${ref}" t="b"><v>${cell.value ? 1 : 0}</v></c>`;
    case "error":
      return `<c r="${ref}" t="e"><v>${xmlEscape(cell.text)}</v></c>`;
    case "formula": {
      const v = cell.cached === undefined ? "" : `<v>${cell.cached}</v>`;
      return `<c r="${ref}"${styleAttr(cell.style)}><f>${xmlEscape(cell.formula)}</f>${v}</c>`;
    }
    case "isoDate":
      return `<c r="${ref}" t="d"><v>${xmlEscape(cell.value)}</v></c>`;
  }
}

/** The entries of a workbook (before `patch`), in LibreOffice's order. */
export function xlsxEntries(
  sheets: readonly XlsxSheet[],
  options: XlsxOptions = {},
): ZipEntryInput[] {
  const enc = (s: string) => new TextEncoder().encode(s);
  const shared = new Map<string, number>();
  const sheetParts = sheets.map((s) => sheetXml(s, shared));
  const sst = [...shared.keys()].map((t) => `<si>${textElement(t)}</si>`).join("");
  const sheetOverrides = sheets
    .map(
      (_s, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  const files: [string, string][] = [
    [
      "[Content_Types].xml",
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/_rels/.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/xl/_rels/workbook.xml.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${sheetOverrides}<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `${XML_HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId3" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "docProps/app.xml",
      `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>LibreOffice/24.2</Application></Properties>`,
    ],
    [
      "docProps/core.xml",
      `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:language>en-US</dc:language><cp:revision>1</cp:revision></cp:coreProperties>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `${XML_HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>${sheets
        .map(
          (_s, i) =>
            `<Relationship Id="rId${i + 2}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          "",
        )}<Relationship Id="rId${sheets.length + 2}" Type="${REL}/theme" Target="theme/theme1.xml"/><Relationship Id="rId${sheets.length + 3}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `${XML_HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><fileVersion appName="Calc"/><workbookPr backupFile="false" showObjects="all"${options.date1904 ? ' date1904="true"' : ""}/><workbookProtection/><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets
        .map(
          (s, i) =>
            `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" state="visible" r:id="rId${i + 2}"/>`,
        )
        .join(
          "",
        )}</sheets><calcPr iterateCount="100" refMode="A1" iterate="false" iterateDelta="0.001"/></workbook>`,
    ],
    ["xl/styles.xml", STYLES_XML],
    ...sheetParts.map((xml, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, xml]),
    [
      "xl/sharedStrings.xml",
      `${XML_HEAD}<sst xmlns="${MAIN}" count="${shared.size}" uniqueCount="${shared.size}">${sst}</sst>`,
    ],
    ["xl/theme/theme1.xml", THEME_XML],
  ];
  return files.map(([name, xml]) => ({ name, data: enc(xml) }));
}

/** A workbook's bytes. `patch` replaces or drops entries (fault tests). */
export function writeXlsx(sheets: readonly XlsxSheet[], options: XlsxOptions = {}): Uint8Array {
  const entries: ZipEntryInput[] = xlsxEntries(sheets, options);
  const patch = options.patch ?? {};
  const names = new Set(entries.map((e) => e.name));
  const out: ZipEntryInput[] = [];
  for (const e of entries) {
    if (!(e.name in patch)) out.push(e);
    else {
      const p = patch[e.name];
      if (p === null || p === undefined) continue;
      out.push({ name: e.name, data: typeof p === "string" ? new TextEncoder().encode(p) : p });
    }
  }
  for (const [name, p] of Object.entries(patch)) {
    if (names.has(name) || p === null || p === undefined) continue;
    out.push({ name, data: typeof p === "string" ? new TextEncoder().encode(p) : p });
  }
  return writeZip(out);
}

/** Serial day of an ISO date in the 1900 system (dates from 1900-03-01). */
export function isoToSerial(iso: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d)
    return undefined;
  if (ms < Date.UTC(1900, 2, 1) || y > 9999) return undefined;
  return Math.round((ms - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/** How Calc types one imported CSV value (the generator's rule; see the module comment). */
export function typedCell(text: string): XlsxCell {
  if (/^-?\d{1,15}$/.test(text) && String(Number(text)) === text)
    return { kind: "number", value: Number(text) };
  const serial = isoToSerial(text);
  if (serial !== undefined) return { kind: "number", value: serial, style: "date" };
  const money = /^\$(-?\d{1,13}\.\d{2})$/.exec(text);
  if (money && Number(money[1]).toFixed(2) === money[1])
    return { kind: "number", value: String(Number(money[1])), style: "currency" };
  if (/^-?\d{1,13}\.\d{2}$/.test(text) && Number(text).toFixed(2) === text)
    return { kind: "number", value: String(Number(text)), style: "fixed2" };
  return { kind: "text", text };
}

/**
 * The cells of a CSV document as the gate's CSV path sees it (every LF or CRLF line is a
 * row, cells split on commas, empty cells omitted), typed by `typedCell`.
 */
export function csvCells(csv: string): Map<string, XlsxCell> {
  const cells = new Map<string, XlsxCell>();
  csv.split(/\r?\n/).forEach((line, r) => {
    line.split(",").forEach((value, c) => {
      if (value !== "") cells.set(cellKey(r, c), typedCell(value));
    });
  });
  return cells;
}

/** The equivalent workbook of a CSV document: one sheet, the same cells, typed as Calc does. */
export function xlsxFromCsv(csv: string, options: XlsxOptions = {}): Uint8Array {
  return writeXlsx([{ name: "sheet", cells: csvCells(csv) }], options);
}

/** Entries of `xlsxFromCsv(csv)`, for corruption builders (partial save, missing part). */
export function xlsxEntriesFromCsv(csv: string): ZipEntryInput[] {
  return xlsxEntries([{ name: "sheet", cells: csvCells(csv) }]);
}

export const XLSX_MAIN_SHEET = "xl/worksheets/sheet1.xml";
