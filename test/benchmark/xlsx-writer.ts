/**
 * Test-only `.xlsx` writer. Builds the OOXML parts LibreOffice Calc writes (shared
 * strings for text, date styles via numFmt, currency as numbers) so the grader's reader
 * is exercised on Calc-shaped workbooks without a guest. Not used by src/.
 */
import { deflateRawSync } from "node:zlib";

export type TestCell =
  | { t: "s"; v: string }
  | { t: "n"; v: number; style?: "date" | "currency" | "general" }
  | { t: "str-formula"; f: string; v: string }
  | { t: "n-formula"; f: string; v: number }
  | { t: "inline"; v: string }
  | { t: "b"; v: boolean };

export interface TestWorkbook {
  /** Cells by A1 reference, first sheet. */
  readonly cells: Readonly<Record<string, TestCell>>;
  readonly extraSheet?: Readonly<Record<string, TestCell>>;
  readonly date1904?: boolean;
  /** Use a custom date numFmt (LibreOffice writes YYYY-MM-DD as id 164) instead of builtin 14. */
  readonly customDateFormat?: boolean;
  readonly deflate?: boolean;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zip(files: Record<string, string | Buffer>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

export function buildXlsx(book: TestWorkbook): Buffer {
  const shared: string[] = [];
  const sharedIndex = (s: string) => {
    let i = shared.indexOf(s);
    if (i < 0) i = shared.push(s) - 1;
    return i;
  };
  // Style indices: 0 general, 1 date, 2 currency.
  const sheetXml = (cells: Readonly<Record<string, TestCell>>) => {
    const byRow = new Map<number, string[]>();
    for (const [ref, cell] of Object.entries(cells)) {
      const row = Number(/\d+$/.exec(ref)?.[0]);
      let xml: string;
      switch (cell.t) {
        case "s":
          xml = `<c r="${ref}" t="s"><v>${sharedIndex(cell.v)}</v></c>`;
          break;
        case "n": {
          const s = cell.style === "date" ? ' s="1"' : cell.style === "currency" ? ' s="2"' : "";
          xml = `<c r="${ref}"${s} t="n"><v>${cell.v}</v></c>`;
          break;
        }
        case "str-formula":
          xml = `<c r="${ref}" t="str"><f>${esc(cell.f)}</f><v>${esc(cell.v)}</v></c>`;
          break;
        case "n-formula":
          xml = `<c r="${ref}"><f>${esc(cell.f)}</f><v>${cell.v}</v></c>`;
          break;
        case "inline":
          xml = `<c r="${ref}" t="inlineStr"><is><t>${esc(cell.v)}</t></is></c>`;
          break;
        case "b":
          xml = `<c r="${ref}" t="b"><v>${cell.v ? 1 : 0}</v></c>`;
          break;
      }
      byRow.set(row, [...(byRow.get(row) ?? []), xml]);
    }
    const rows = [...byRow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([r, cs]) => `<row r="${r}">${cs.join("")}</row>`)
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="5" width="12"/></cols><sheetData>${rows}</sheetData></worksheet>`;
  };
  const sheet1 = sheetXml(book.cells);
  const sheet2 = book.extraSheet ? sheetXml(book.extraSheet) : undefined;
  const sheets = `<sheet name="Sheet1" sheetId="1" r:id="rId2"/>${sheet2 ? '<sheet name="Sheet2" sheetId="2" r:id="rId3"/>' : ""}`;
  const dateFmtId = book.customDateFormat ? 164 : 14;
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${book.date1904 ? ' date1904="true"' : ""}/><sheets>${sheets}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="styles" Target="styles.xml"/><Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet1.xml"/>${sheet2 ? '<Relationship Id="rId3" Type="worksheet" Target="worksheets/sheet2.xml"/>' : ""}<Relationship Id="rId4" Type="sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="YYYY\\-MM\\-DD"/><numFmt numFmtId="165" formatCode="[$$-409]#,##0.00;[RED]\\-[$$-409]#,##0.00"/></numFmts><cellXfs count="3"><xf numFmtId="0" fontId="0"/><xf numFmtId="${dateFmtId}" fontId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": sheet1,
  };
  if (sheet2) files["xl/worksheets/sheet2.xml"] = sheet2;
  files["xl/sharedStrings.xml"] =
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`;
  return zip(files, book.deflate ?? true);
}

/** Serial day number for an ISO date in the 1900 system (dates after 1900-03-01). */
export function isoToSerial(iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/**
 * The workbook Calc would hold after importing a fixture CSV: text as shared strings,
 * integers as numbers, ISO dates as date-formatted serials, `$` amounts as currency numbers.
 */
export function calcImport(csv: string): Record<string, TestCell> {
  const cells: Record<string, TestCell> = {};
  csv
    .trimEnd()
    .split("\n")
    .forEach((line, r) => {
      line.split(",").forEach((v, c) => {
        const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
        cells[ref] = toCalcCell(v);
      });
    });
  return cells;
}

export function toCalcCell(v: string): TestCell {
  if (/^-?\d+$/.test(v)) return { t: "n", v: Number(v) };
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { t: "n", v: isoToSerial(v), style: "date" };
  const money = /^\$(-?\d+(?:\.\d+)?)$/.exec(v);
  if (money) return { t: "n", v: Number(money[1]), style: "currency" };
  return { t: "s", v };
}
