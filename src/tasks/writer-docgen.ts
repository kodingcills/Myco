/**
 * Host-side Writer document generator (TIF-99 / M2-08).
 *
 * Serialises a `WriterDocSpec` to `.docx` (WordprocessingML, transitional) or `.odt`
 * (OpenDocument text) bytes, deterministically and without LibreOffice, and derives the
 * damaged variants the oracle must never verify: a truncated file, a flipped byte, and a
 * "partially saved" package whose main XML part is cut short but re-zipped with a valid
 * CRC (so only the XML well-formedness check can catch it).
 *
 * Test-document generation only: the oracle never compares against these bytes, and the
 * read path (`src/verify/writer-reader.ts`) is written against the formats, not against
 * this generator. `scripts/writer-lo-fixtures.ts` round-trips these documents through
 * headless LibreOffice so the reader is also tested on real LibreOffice output.
 */

import { crc32, deflateRawSync } from "node:zlib";
import {
  CUSTOM_STYLES,
  headingStyle,
  type WriterDocSpec,
  type WriterParagraphSpec,
  type WriterTableSpec,
} from "./writer-doc-edit.ts";

// ---------------------------------------------------------------------------
// Minimal deterministic ZIP writer
// ---------------------------------------------------------------------------

export interface ZipEntryInput {
  readonly name: string;
  readonly data: Uint8Array;
  /** Store uncompressed (ODF requires this for `mimetype`). */
  readonly store?: boolean;
  /**
   * Already-deflated body with its true CRC-32 and inflated size; `data` is then ignored.
   * Lets a test build an honest archive whose entries inflate far beyond the file size
   * (a ZIP bomb) without ever holding the inflated bytes.
   */
  readonly deflated?: { readonly body: Uint8Array; readonly crc: number; readonly size: number };
}

/** Fixed DOS timestamp (1980-01-01 00:00) so output is byte-stable. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function writeZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const pre = entry.deflated;
    const data = Buffer.from(entry.data);
    const body =
      pre !== undefined ? Buffer.from(pre.body) : entry.store ? data : deflateRawSync(data);
    const method = pre === undefined && entry.store ? 0 : 8;
    const crc = pre !== undefined ? pre.crc >>> 0 : crc32(data) >>> 0;
    const size = pre !== undefined ? pre.size : data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cen = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cen.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cen, end]));
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Word's style ids: "Heading 2" -> "Heading2", "Myco Note" -> "MycoNote". */
function docxStyleId(display: string): string {
  return display.replace(/[^A-Za-z0-9]/g, "");
}

function docxRuns(text: string): string {
  return text
    .split("\n")
    .map((line, i) => {
      const parts = line
        .split("\t")
        .map((seg) => (seg === "" ? "" : `<w:t xml:space="preserve">${esc(seg)}</w:t>`))
        .join("<w:tab/>");
      return `${i > 0 ? "<w:br/>" : ""}${parts}`;
    })
    .map((inner) => `<w:r>${inner}</w:r>`)
    .join("");
}

function docxParagraph(p: WriterParagraphSpec): string {
  return `<w:p><w:pPr><w:pStyle w:val="${docxStyleId(p.style)}"/></w:pPr>${docxRuns(p.text)}</w:p>`;
}

function docxTable(t: WriterTableSpec): string {
  const cols = Math.max(...t.rows.map((r) => r.length));
  const grid = Array.from({ length: cols }, () => '<w:gridCol w:w="3000"/>').join("");
  const rows = t.rows
    .map(
      (row) =>
        `<w:tr>${row
          .map(
            (text) =>
              `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableContents"/></w:pPr>${docxRuns(text)}</w:p></w:tc>`,
          )
          .join("")}</w:tr>`,
    )
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/></w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

function docxStyles(): string {
  const styles = [
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`,
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (l) =>
        `<w:style w:type="paragraph" w:styleId="Heading${l}"><w:name w:val="heading ${l}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="${l - 1}"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`,
    ),
    ...CUSTOM_STYLES.map(
      (s) =>
        `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${docxStyleId(s)}"><w:name w:val="${esc(s)}"/><w:basedOn w:val="Normal"/></w:style>`,
    ),
    `<w:style w:type="paragraph" w:customStyle="1" w:styleId="TableContents"><w:name w:val="Table Contents"/><w:basedOn w:val="Normal"/></w:style>`,
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${W}">${styles.join("")}</w:styles>`;
}

export function docxDocumentXml(spec: WriterDocSpec): string {
  const body = spec.blocks
    .map((b) => (b.kind === "paragraph" ? docxParagraph(b) : docxTable(b)))
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
}

export const DOCX_MAIN_PART = "word/document.xml";

export function docxEntries(spec: WriterDocSpec): ZipEntryInput[] {
  return [
    {
      name: "[Content_Types].xml",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
    },
    {
      name: "word/_rels/document.xml.rels",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
      ),
    },
    { name: DOCX_MAIN_PART, data: utf8(docxDocumentXml(spec)) },
    { name: "word/styles.xml", data: utf8(docxStyles()) },
  ];
}

export function writeDocx(spec: WriterDocSpec): Uint8Array {
  return writeZip(docxEntries(spec));
}

// ---------------------------------------------------------------------------
// ODT
// ---------------------------------------------------------------------------

const ODF_ROOT_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';

/** ODF style names are NCNames: "Myco Note" -> "Myco_20_Note". */
function odfStyleName(display: string): string {
  return display.replace(
    /[^A-Za-z0-9-]/g,
    (c) => `_${c.charCodeAt(0).toString(16).padStart(2, "0")}_`,
  );
}

/** ODF collapses white space, so runs of spaces, tabs and newlines are elements. */
function odfInline(text: string): string {
  let out = "";
  let spaces = 0;
  const flush = (): void => {
    if (spaces === 0) return;
    out += spaces === 1 ? " " : ` <text:s text:c="${spaces - 1}"/>`;
    spaces = 0;
  };
  for (const ch of text) {
    if (ch === " ") {
      spaces++;
      continue;
    }
    flush();
    if (ch === "\t") out += "<text:tab/>";
    else if (ch === "\n") out += "<text:line-break/>";
    else out += esc(ch);
  }
  if (spaces > 0) out += spaces === 1 ? "<text:s/>" : `<text:s text:c="${spaces}"/>`;
  return out;
}

function odtParagraph(p: WriterParagraphSpec): string {
  const style = odfStyleName(p.style);
  return p.headingLevel === null
    ? `<text:p text:style-name="${style}">${odfInline(p.text)}</text:p>`
    : `<text:h text:style-name="${style}" text:outline-level="${p.headingLevel}">${odfInline(p.text)}</text:h>`;
}

function odtTable(t: WriterTableSpec, index: number): string {
  const cols = Math.max(...t.rows.map((r) => r.length));
  const rows = t.rows
    .map(
      (row) =>
        `<table:table-row>${row
          .map(
            (text) =>
              `<table:table-cell office:value-type="string"><text:p text:style-name="Table_20_Contents">${odfInline(text)}</text:p></table:table-cell>`,
          )
          .join("")}</table:table-row>`,
    )
    .join("");
  return `<table:table table:name="Table${index + 1}"><table:table-column table:number-columns-repeated="${cols}"/>${rows}</table:table>`;
}

export function odtContentXml(spec: WriterDocSpec): string {
  let tables = 0;
  const body = spec.blocks
    .map((b) => (b.kind === "paragraph" ? odtParagraph(b) : odtTable(b, tables++)))
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${ODF_ROOT_NS} office:version="1.3"><office:automatic-styles/><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
}

function odtStylesXml(): string {
  const para = (display: string, extra = ""): string =>
    `<style:style style:name="${odfStyleName(display)}" style:display-name="${esc(display)}" style:family="paragraph"${extra}/>`;
  const styles = [
    `<style:style style:name="Standard" style:family="paragraph" style:class="text"/>`,
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) =>
      para(
        headingStyle(l),
        ` style:parent-style-name="Standard" style:default-outline-level="${l}"`,
      ),
    ),
    ...CUSTOM_STYLES.map((s) => para(s, ' style:parent-style-name="Standard"')),
    para("Table Contents", ' style:parent-style-name="Standard"'),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${ODF_ROOT_NS} office:version="1.3"><office:styles>${styles.join("")}</office:styles></office:document-styles>`;
}

export const ODT_MAIN_PART = "content.xml";

export function odtEntries(spec: WriterDocSpec): ZipEntryInput[] {
  return [
    { name: "mimetype", data: utf8("application/vnd.oasis.opendocument.text"), store: true },
    {
      name: "META-INF/manifest.xml",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
      ),
    },
    { name: ODT_MAIN_PART, data: utf8(odtContentXml(spec)) },
    { name: "styles.xml", data: utf8(odtStylesXml()) },
  ];
}

export function writeOdt(spec: WriterDocSpec): Uint8Array {
  return writeZip(odtEntries(spec));
}

export type WriterFormat = "docx" | "odt";

export function writeWriterDocument(spec: WriterDocSpec, format: WriterFormat): Uint8Array {
  return format === "docx" ? writeDocx(spec) : writeOdt(spec);
}

// ---------------------------------------------------------------------------
// Damaged variants (none may ever be verified)
// ---------------------------------------------------------------------------

/** The first `fraction` of the bytes: a save interrupted mid-write. */
export function truncated(bytes: Uint8Array, fraction: number): Uint8Array {
  return bytes.slice(0, Math.floor(bytes.length * fraction));
}

/** One byte inverted at `offset`: bit rot or a torn write inside a compressed entry. */
export function flippedByte(bytes: Uint8Array, offset: number): Uint8Array {
  const out = bytes.slice();
  out[offset] = (out[offset] ?? 0) ^ 0xff;
  return out;
}

/**
 * A package whose main XML part holds only its first `fraction` of bytes, re-zipped with
 * a correct CRC: the ZIP is valid, the document is not.
 */
export function partiallySaved(
  spec: WriterDocSpec,
  format: WriterFormat,
  fraction: number,
): Uint8Array {
  const main = format === "docx" ? DOCX_MAIN_PART : ODT_MAIN_PART;
  const entries = (format === "docx" ? docxEntries(spec) : odtEntries(spec)).map((e) =>
    e.name === main ? { ...e, data: e.data.slice(0, Math.floor(e.data.length * fraction)) } : e,
  );
  return writeZip(entries);
}

/** A package with the main XML part missing (a save that never wrote the body). */
export function withoutMainPart(spec: WriterDocSpec, format: WriterFormat): Uint8Array {
  const main = format === "docx" ? DOCX_MAIN_PART : ODT_MAIN_PART;
  return writeZip(
    (format === "docx" ? docxEntries(spec) : odtEntries(spec)).filter((e) => e.name !== main),
  );
}
