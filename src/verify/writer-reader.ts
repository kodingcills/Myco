/**
 * Host-only Writer read path (TIF-99 / M2-08): a saved `.docx` or `.odt` file to a
 * normalised `WriterDocument`.
 *
 * The contract mirrors the Calc persisted-state reader (`src/core/filepersist.ts`):
 * a read that cannot establish the document throws `PersistedStateReadError` with cause
 * `missing` (no file), `unreadable` (a file the oracle does not read: not a Writer
 * document, encrypted, an unsupported dialect) or `corrupt` (a damaged or partially
 * saved file). The oracle maps every one of those to `uncertain`, never to a verdict.
 *
 * What makes a partially saved file fail closed, in order:
 *   1. the ZIP end-of-central-directory record must be present (a truncated tail fails);
 *   2. every entry's local header must agree with the central directory, and its
 *      inflated bytes must match the recorded size and CRC-32 (a cut or flipped body fails);
 *   3. every XML part the reader uses must be well-formed (`writer-xml.ts`); a part cut
 *      short and re-zipped with a fresh CRC still fails here.
 *
 * No LibreOffice is needed: the read is pure TypeScript over the bytes, so it runs on
 * any host and in CI.
 */

import { readFileSync } from "node:fs";
import { crc32, inflateRawSync } from "node:zlib";
import { PersistedStateReadError } from "../core/filepersist.ts";
import {
  childElements,
  firstChild,
  parseXml,
  type XmlElement,
  XmlSyntaxError,
} from "./writer-xml.ts";

// ---------------------------------------------------------------------------
// Normalised document
// ---------------------------------------------------------------------------

export interface WriterParagraph {
  readonly kind: "paragraph";
  readonly text: string;
  /**
   * Paragraph style display name ("Myco Note", "Heading 2"; Word's built-in names are as
   * stored, e.g. "heading 2"). null when the paragraph uses the document default style.
   */
  readonly styleName: string | null;
  /** False when the paragraph names a style the file does not define. */
  readonly styleResolved: boolean;
  /** Outline level 1..9, or null for body text. */
  readonly headingLevel: number | null;
  /** False when the level depends on a style the file does not define. */
  readonly levelKnown: boolean;
}

export interface WriterCell {
  readonly text: string;
  /** Merged (spanned or covered) or holding a nested table: its address is ambiguous. */
  readonly complex: boolean;
}

export interface WriterTable {
  readonly kind: "table";
  readonly rows: readonly (readonly WriterCell[])[];
}

export type WriterBlock = WriterParagraph | WriterTable;

export interface WriterDocument {
  readonly format: "docx" | "odt";
  readonly filePath: string;
  readonly blocks: readonly WriterBlock[];
}

export function documentParagraphs(doc: WriterDocument): WriterParagraph[] {
  return doc.blocks.filter((b): b is WriterParagraph => b.kind === "paragraph");
}

export function documentTables(doc: WriterDocument): WriterTable[] {
  return doc.blocks.filter((b): b is WriterTable => b.kind === "table");
}

// ---------------------------------------------------------------------------
// Strict ZIP reader
// ---------------------------------------------------------------------------

type ReadCause = "missing" | "unreadable" | "corrupt";

class ReadFailure extends Error {
  constructor(
    readonly cause: ReadCause,
    message: string,
  ) {
    super(message);
  }
}

const corrupt = (message: string): never => {
  throw new ReadFailure("corrupt", message);
};
const unreadable = (message: string): never => {
  throw new ReadFailure("unreadable", message);
};

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Reads every entry of a ZIP archive, verifying sizes and CRC-32. */
export function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length === 0) corrupt("the file is empty");
  if (buf.length < 22) corrupt("too short to be a ZIP archive");
  // The EOCD record sits at the end, followed by at most a 65535-byte comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    if (buf.readUInt32LE(0) === LOC_SIG) corrupt("ZIP end record missing (truncated save?)");
    unreadable("not a ZIP archive, so not a .docx or .odt document");
  }
  const disk = buf.readUInt16LE(eocd + 4);
  const count = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || count !== buf.readUInt16LE(eocd + 8))
    unreadable("multi-disk ZIP archives are not supported");
  if (count === 0xffff || cenOffset === 0xffffffff) unreadable("ZIP64 archives are not supported");
  if (cenOffset + cenSize !== eocd) corrupt("ZIP central directory does not end at the end record");

  const entries = new Map<string, Uint8Array>();
  let at = cenOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || buf.readUInt32LE(at) !== CEN_SIG)
      corrupt(`ZIP central directory entry ${n} is damaged`);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (at > eocd) corrupt(`ZIP central directory entry ${name} overruns the directory`);
    if (flags & 0x1) unreadable(`entry ${name} is encrypted`);
    if (entries.has(name)) corrupt(`duplicate ZIP entry ${name}`);
    if (localOffset + 30 > cenOffset || buf.readUInt32LE(localOffset) !== LOC_SIG) {
      corrupt(`local header of ${name} is damaged`);
    }
    const localName = buf.toString(
      "utf8",
      localOffset + 30,
      localOffset + 30 + buf.readUInt16LE(localOffset + 26),
    );
    if (localName !== name) corrupt(`local header names ${localName}, directory names ${name}`);
    const dataStart =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compSize > cenOffset) corrupt(`entry ${name} overruns the archive`);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch (error) {
        return corrupt(
          `entry ${name} does not inflate: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else return unreadable(`entry ${name} uses unsupported compression method ${method}`);
    if (data.length !== size)
      corrupt(`entry ${name} inflates to ${data.length} bytes, expected ${size}`);
    if (crc32(data) >>> 0 !== crc >>> 0) corrupt(`entry ${name} fails its CRC-32 check`);
    entries.set(name, new Uint8Array(data));
  }
  return entries;
}

function xmlPart(entries: Map<string, Uint8Array>, name: string): XmlElement {
  const bytes = entries.get(name);
  if (bytes === undefined) return corrupt(`${name} is missing from the package`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return corrupt(`${name} is not valid UTF-8`);
  }
  try {
    return parseXml(text);
  } catch (error) {
    if (error instanceof XmlSyntaxError)
      return corrupt(`${name} is not well-formed XML: ${error.message}`);
    throw error;
  }
}

function requireNamespaces(root: XmlElement, part: string, expected: Record<string, string>): void {
  for (const [prefix, uri] of Object.entries(expected)) {
    const got = root.attrs[`xmlns:${prefix}`];
    if (got !== uri) {
      unreadable(
        `${part} does not bind prefix ${prefix} to ${uri} on its root (got ${JSON.stringify(got ?? null)})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// DOCX (WordprocessingML, transitional)
// ---------------------------------------------------------------------------

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_OFFICE_DOC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const REL_STYLES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";

function resolvePartPath(baseDir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${baseDir}${target}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

function relTarget(
  entries: Map<string, Uint8Array>,
  relsPath: string,
  baseDir: string,
  type: string,
): string | undefined {
  if (!entries.has(relsPath)) return undefined;
  const rels = xmlPart(entries, relsPath);
  for (const rel of childElements(rels, "Relationship")) {
    if (
      rel.attrs.Type === type &&
      rel.attrs.TargetMode !== "External" &&
      rel.attrs.Target !== undefined
    ) {
      return resolvePartPath(baseDir, rel.attrs.Target);
    }
  }
  return undefined;
}

interface DocxStyle {
  readonly name: string | null;
  readonly basedOn: string | null;
  readonly outlineLvl: number | null;
}

function outlineOf(pPr: XmlElement | undefined): number | null {
  const lvl = pPr === undefined ? undefined : firstChild(pPr, "w:outlineLvl")?.attrs["w:val"];
  if (lvl === undefined) return null;
  const n = Number(lvl);
  if (!Number.isInteger(n) || n < 0 || n > 9)
    corrupt(`invalid w:outlineLvl ${JSON.stringify(lvl)}`);
  return n;
}

function readDocxStyles(entries: Map<string, Uint8Array>, path: string | undefined) {
  const styles = new Map<string, DocxStyle>();
  let defaultId: string | null = null;
  if (path === undefined || !entries.has(path)) return { styles, defaultId, present: false };
  const root = xmlPart(entries, path);
  requireNamespaces(root, path, { w: W_NS });
  for (const s of childElements(root, "w:style")) {
    if (s.attrs["w:type"] !== "paragraph") continue;
    const id = s.attrs["w:styleId"];
    if (id === undefined) continue;
    if (s.attrs["w:default"] === "1" || s.attrs["w:default"] === "true") defaultId = id;
    styles.set(id, {
      name: firstChild(s, "w:name")?.attrs["w:val"] ?? null,
      basedOn: firstChild(s, "w:basedOn")?.attrs["w:val"] ?? null,
      outlineLvl: outlineOf(firstChild(s, "w:pPr")),
    });
  }
  return { styles, defaultId, present: true };
}

/** Elements whose text is not the paragraph's visible text. */
const DOCX_SKIP = new Set([
  "w:pPr",
  "w:rPr",
  "w:del",
  "w:delText",
  "w:moveFrom",
  "w:instrText",
  "w:drawing",
  "w:pict",
  "w:object",
  "w:footnoteReference",
  "w:endnoteReference",
  "w:commentReference",
  "mc:AlternateContent",
]);

function docxText(el: XmlElement): string {
  let out = "";
  for (const child of el.children) {
    if (typeof child === "string") continue; // only w:t carries text
    if (DOCX_SKIP.has(child.name)) continue;
    switch (child.name) {
      case "w:t":
        out += child.children.filter((c): c is string => typeof c === "string").join("");
        break;
      case "w:tab":
        out += "\t";
        break;
      case "w:br":
      case "w:cr":
        out += "\n";
        break;
      case "w:noBreakHyphen":
        out += "-";
        break;
      case "w:tbl":
        break; // nested tables are not paragraph text
      default:
        out += docxText(child);
    }
  }
  return out;
}

function docxParagraph(p: XmlElement, st: ReturnType<typeof readDocxStyles>): WriterParagraph {
  const pPr = firstChild(p, "w:pPr");
  const styleId =
    (pPr === undefined ? undefined : firstChild(pPr, "w:pStyle")?.attrs["w:val"]) ?? st.defaultId;
  const direct = outlineOf(pPr);
  let styleName: string | null = null;
  let styleResolved = true;
  let styleLvl: number | null = null;
  let chainComplete = true;
  if (styleId !== null) {
    const style = st.styles.get(styleId);
    if (style === undefined) {
      styleResolved = false;
    } else {
      styleName = style.name ?? styleId;
      // Walk the basedOn chain for an inherited outline level (guarding cycles).
      const seen = new Set<string>();
      let cur: DocxStyle | undefined = style;
      let curId = styleId;
      while (cur !== undefined && !seen.has(curId)) {
        seen.add(curId);
        if (cur.outlineLvl !== null) {
          styleLvl = cur.outlineLvl;
          break;
        }
        if (cur.basedOn === null) break;
        curId = cur.basedOn;
        cur = st.styles.get(curId);
        if (cur === undefined) chainComplete = false;
      }
      if (styleLvl === null && style.name !== null) {
        const m = /^heading ([1-9])$/i.exec(style.name);
        if (m !== null) styleLvl = Number(m[1]) - 1;
      }
    }
  }
  const lvl = direct ?? styleLvl;
  return {
    kind: "paragraph",
    text: docxText(p),
    styleName,
    styleResolved,
    headingLevel: lvl === null || lvl === 9 ? null : lvl + 1,
    levelKnown: direct !== null || (styleResolved && chainComplete),
  };
}

function docxCellText(
  tc: XmlElement,
  st: ReturnType<typeof readDocxStyles>,
): { text: string; nested: boolean } {
  const lines: string[] = [];
  let nested = false;
  const walk = (el: XmlElement): void => {
    for (const c of childElements(el)) {
      if (c.name === "w:p") lines.push(docxParagraph(c, st).text);
      else if (c.name === "w:tbl") nested = true;
      else if (c.name === "w:sdt") {
        const content = firstChild(c, "w:sdtContent");
        if (content !== undefined) walk(content);
      }
    }
  };
  walk(tc);
  return { text: lines.join("\n"), nested };
}

function flattenSdt(el: XmlElement, names: readonly string[]): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of childElements(el)) {
    if (names.includes(c.name)) out.push(c);
    else if (c.name === "w:sdt") {
      const content = firstChild(c, "w:sdtContent");
      if (content !== undefined) out.push(...flattenSdt(content, names));
    } else if (c.name === "w:customXml") out.push(...flattenSdt(c, names));
  }
  return out;
}

function docxTable(tbl: XmlElement, st: ReturnType<typeof readDocxStyles>): WriterTable {
  const rows = flattenSdt(tbl, ["w:tr"]).map((tr) =>
    flattenSdt(tr, ["w:tc"]).map((tc): WriterCell => {
      const tcPr = firstChild(tc, "w:tcPr");
      const span = Number(
        tcPr === undefined ? 1 : (firstChild(tcPr, "w:gridSpan")?.attrs["w:val"] ?? 1),
      );
      const vMerge = tcPr !== undefined && firstChild(tcPr, "w:vMerge") !== undefined;
      const { text, nested } = docxCellText(tc, st);
      return { text, complex: span !== 1 || vMerge || nested };
    }),
  );
  return { kind: "table", rows };
}

function readDocx(entries: Map<string, Uint8Array>, filePath: string): WriterDocument {
  const mainPath = relTarget(entries, "_rels/.rels", "", REL_OFFICE_DOC);
  if (mainPath === undefined) return corrupt("_rels/.rels names no main document part");
  const root = xmlPart(entries, mainPath);
  if (root.name !== "w:document")
    unreadable(`${mainPath} root is <${root.name}>, not <w:document>`);
  requireNamespaces(root, mainPath, { w: W_NS });
  const slash = mainPath.lastIndexOf("/");
  const dir = slash < 0 ? "" : mainPath.slice(0, slash + 1);
  const relsPath = `${dir}_rels/${mainPath.slice(slash + 1)}.rels`;
  const st = readDocxStyles(entries, relTarget(entries, relsPath, dir, REL_STYLES));
  const body = firstChild(root, "w:body");
  if (body === undefined) return corrupt(`${mainPath} has no <w:body>`);
  const blocks = flattenSdt(body, ["w:p", "w:tbl"]).map((el) =>
    el.name === "w:p" ? docxParagraph(el, st) : docxTable(el, st),
  );
  return { format: "docx", filePath, blocks };
}

// ---------------------------------------------------------------------------
// ODT (OpenDocument text)
// ---------------------------------------------------------------------------

export const ODT_MIMETYPE = "application/vnd.oasis.opendocument.text";
const ODF_NS = {
  office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
  style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
  table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
};

/** ODF encodes characters outside NCName in style names as `_xx_` hex (e.g. `_20_`). */
function decodeOdfStyleName(name: string): string {
  return name.replace(/_([0-9A-Fa-f]{2})_/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

interface OdfStyles {
  /** Automatic paragraph style name -> parent common style name (or null). */
  readonly automatic: Map<string, string | null>;
  /** Common paragraph style name -> display name. */
  readonly common: Map<string, string>;
}

function collectStyles(
  container: XmlElement | undefined,
  into: Map<string, string>,
  display: boolean,
): void {
  if (container === undefined) return;
  for (const s of childElements(container, "style:style")) {
    if (s.attrs["style:family"] !== "paragraph" || s.attrs["style:name"] === undefined) continue;
    const name = s.attrs["style:name"];
    into.set(
      name,
      display
        ? (s.attrs["style:display-name"] ?? decodeOdfStyleName(name))
        : (s.attrs["style:parent-style-name"] ?? ""),
    );
  }
}

const ODT_SKIP = new Set([
  "office:annotation",
  "office:annotation-end",
  "text:note",
  "text:tracked-changes",
  "draw:frame",
  "draw:custom-shape",
  "text:ruby-text",
]);

function odtText(el: XmlElement): string {
  let out = "";
  for (const child of el.children) {
    if (typeof child === "string") {
      out += child.replace(/[ \t\r\n]+/g, " "); // ODF §6.1.2 white-space collapsing
      continue;
    }
    if (ODT_SKIP.has(child.name)) continue;
    switch (child.name) {
      case "text:s": {
        const c = Number(child.attrs["text:c"] ?? 1);
        if (!Number.isInteger(c) || c < 1)
          corrupt(`invalid text:c ${JSON.stringify(child.attrs["text:c"])}`);
        out += " ".repeat(c);
        break;
      }
      case "text:tab":
        out += "\t";
        break;
      case "text:line-break":
        out += "\n";
        break;
      default:
        out += odtText(child);
    }
  }
  return out;
}

function odtParagraph(el: XmlElement, styles: OdfStyles): WriterParagraph {
  const styleRef = el.attrs["text:style-name"];
  let styleName: string | null = null;
  let styleResolved = true;
  if (styleRef !== undefined) {
    let common: string | null = styleRef;
    if (styles.automatic.has(styleRef)) {
      const parent = styles.automatic.get(styleRef) ?? "";
      common = parent === "" ? null : parent;
    }
    if (common !== null) {
      const display = styles.common.get(common);
      if (display === undefined) styleResolved = false;
      else styleName = display;
    }
  }
  let headingLevel: number | null = null;
  if (el.name === "text:h") {
    const raw = el.attrs["text:outline-level"] ?? "1";
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 10)
      corrupt(`invalid text:outline-level ${JSON.stringify(raw)}`);
    headingLevel = n;
  }
  return {
    kind: "paragraph",
    text: odtText(el),
    styleName,
    styleResolved,
    headingLevel,
    levelKnown: true,
  };
}

function odtFlatten(el: XmlElement, styles: OdfStyles, out: WriterBlock[]): void {
  for (const c of childElements(el)) {
    switch (c.name) {
      case "text:p":
      case "text:h":
        out.push(odtParagraph(c, styles));
        break;
      case "table:table":
        out.push(odtTable(c, styles));
        break;
      case "text:list":
      case "text:list-item":
      case "text:list-header":
      case "text:section":
        odtFlatten(c, styles, out);
        break;
      default:
        break; // sequence decls, generated indexes, tracked-change regions, frames
    }
  }
}

function repeat(raw: string | undefined, what: string): number {
  const n = Number(raw ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 1024) corrupt(`invalid ${what} ${JSON.stringify(raw)}`);
  return n;
}

function odtRows(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of childElements(el)) {
    if (c.name === "table:table-row") {
      for (let i = repeat(c.attrs["table:number-rows-repeated"], "rows-repeated"); i > 0; i--)
        out.push(c);
    } else if (
      ["table:table-header-rows", "table:table-rows", "table:table-row-group"].includes(c.name)
    ) {
      out.push(...odtRows(c));
    }
  }
  return out;
}

function odtTable(el: XmlElement, styles: OdfStyles): WriterTable {
  const rows = odtRows(el).map((tr) => {
    const cells: WriterCell[] = [];
    for (const tc of childElements(tr)) {
      if (tc.name !== "table:table-cell" && tc.name !== "table:covered-table-cell") continue;
      const inner: WriterBlock[] = [];
      odtFlatten(tc, styles, inner);
      const nested = inner.some((b) => b.kind === "table");
      const text = inner
        .filter((b): b is WriterParagraph => b.kind === "paragraph")
        .map((p) => p.text)
        .join("\n");
      const spanned =
        repeat(tc.attrs["table:number-columns-spanned"], "columns-spanned") !== 1 ||
        repeat(tc.attrs["table:number-rows-spanned"], "rows-spanned") !== 1;
      const complex = tc.name === "table:covered-table-cell" || spanned || nested;
      for (
        let i = repeat(tc.attrs["table:number-columns-repeated"], "columns-repeated");
        i > 0;
        i--
      ) {
        cells.push({ text, complex });
      }
    }
    return cells;
  });
  return { kind: "table", rows };
}

function readOdt(entries: Map<string, Uint8Array>, filePath: string): WriterDocument {
  const content = xmlPart(entries, "content.xml");
  if (content.name !== "office:document-content") {
    unreadable(`content.xml root is <${content.name}>, not <office:document-content>`);
  }
  requireNamespaces(content, "content.xml", ODF_NS);
  const automatic = new Map<string, string>();
  collectStyles(firstChild(content, "office:automatic-styles"), automatic, false);
  const common = new Map<string, string>();
  if (entries.has("styles.xml")) {
    const styles = xmlPart(entries, "styles.xml");
    requireNamespaces(styles, "styles.xml", { office: ODF_NS.office, style: ODF_NS.style });
    collectStyles(firstChild(styles, "office:styles"), common, true);
  }
  const styles: OdfStyles = {
    automatic: new Map([...automatic].map(([k, v]) => [k, v === "" ? null : v])),
    common,
  };
  const text = firstChild(firstChild(content, "office:body") ?? content, "office:text");
  if (text === undefined) return corrupt("content.xml has no <office:body><office:text>");
  const blocks: WriterBlock[] = [];
  odtFlatten(text, styles, blocks);
  return { format: "odt", filePath, blocks };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Parses the bytes of a saved Writer document. Throws `PersistedStateReadError`. */
export function parseWriterDocument(bytes: Uint8Array, filePath: string): WriterDocument {
  try {
    const entries = readZipEntries(bytes);
    const mimetype = entries.get("mimetype");
    if (mimetype !== undefined) {
      const type = new TextDecoder().decode(mimetype).trim();
      if (type !== ODT_MIMETYPE)
        return unreadable(`package mimetype is ${type}, not a Writer text document`);
      return readOdt(entries, filePath);
    }
    if (entries.has("[Content_Types].xml")) return readDocx(entries, filePath);
    return unreadable("neither an OpenDocument nor an OOXML package");
  } catch (error) {
    if (error instanceof ReadFailure) {
      throw new PersistedStateReadError(filePath, error.cause, `${filePath}: ${error.message}`);
    }
    throw error;
  }
}

/** Reads a saved Writer document from disk. Throws `PersistedStateReadError`. */
export function readWriterDocument(filePath: string): WriterDocument {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PersistedStateReadError(
      filePath,
      code === "ENOENT" ? "missing" : "unreadable",
      `cannot read ${filePath}: ${code ?? "read failed"}`,
    );
  }
  return parseWriterDocument(new Uint8Array(bytes), filePath);
}
