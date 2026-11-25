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
 *   2. every entry's local header must agree with the central directory, and every part
 *      the reader uses must inflate to exactly its recorded size and CRC-32 (a cut or
 *      flipped body fails);
 *   3. every XML part the reader uses must be well-formed (`writer-xml.ts`); a part cut
 *      short and re-zipped with a fresh CRC still fails here.
 *
 * Bounded work (round-1 verifier D1/D2): only the parts the reader needs are inflated,
 * never past their declared size, under `ZIP_LIMITS`; an entry that declares a bomb-like
 * ratio fails the read even if unused; ODF row/column repeats are expanded under
 * `ODT_LIMITS`. Past a limit the read is `unreadable` (too large to read) or `corrupt`
 * (a table that cannot be a real one), never a verdict and never an unbounded allocation.
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

const MIB = 1024 * 1024;

/**
 * Read limits. A Writer document's XML parts are small: a few hundred pages of text is a
 * `content.xml` or `word/document.xml` of a few MiB. A document past these limits is not
 * read (`unreadable`), so a hostile file cannot make the oracle allocate without bound.
 */
export const ZIP_LIMITS = {
  /** Largest declared (inflated) size of one part the reader inflates. */
  maxPartBytes: 16 * MIB,
  /** Largest total inflated bytes across every part one read inflates. */
  maxTotalBytes: 32 * MIB,
  /**
   * Any entry, read or not, that declares more than `bombMinBytes` and more than
   * `maxRatio` times its compressed size is a decompression bomb, not office content:
   * a part that large is never one the reader inflates, and images, fonts and media of
   * that size deflate near 1:1. Smaller parts are bounded by the two limits above.
   */
  bombMinBytes: 16 * MIB,
  maxRatio: 100,
} as const;

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compSize: number;
  readonly size: number;
  readonly dataStart: number;
}

/**
 * A validated ZIP directory. Only the entries the reader asks for are ever inflated, each
 * once, bounded by its declared size and by `ZIP_LIMITS`; nothing else is decompressed.
 */
export class ZipPackage {
  private readonly cache = new Map<string, Uint8Array>();
  private inflated = 0;

  constructor(
    private readonly buf: Buffer,
    private readonly entries: ReadonlyMap<string, ZipEntry>,
  ) {}

  has(name: string): boolean {
    return this.entries.has(name);
  }

  get size(): number {
    return this.entries.size;
  }

  /** The entry's bytes, verified against its recorded size and CRC-32; undefined if absent. */
  read(name: string): Uint8Array | undefined {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    if (entry.size > ZIP_LIMITS.maxPartBytes) {
      unreadable(
        `entry ${name} declares ${entry.size} bytes, over the ${ZIP_LIMITS.maxPartBytes}-byte part limit`,
      );
    }
    if (this.inflated + entry.size > ZIP_LIMITS.maxTotalBytes) {
      unreadable(`reading ${name} would inflate over ${ZIP_LIMITS.maxTotalBytes} bytes in total`);
    }
    const raw = this.buf.subarray(entry.dataStart, entry.dataStart + entry.compSize);
    let data: Buffer;
    if (entry.method === 0) data = raw;
    else {
      try {
        // Never inflate past the declared size: a lying header fails here, not in memory.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
      } catch (error) {
        return corrupt(
          `entry ${name} does not inflate to its declared ${entry.size} bytes: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (data.length !== entry.size)
      corrupt(`entry ${name} inflates to ${data.length} bytes, expected ${entry.size}`);
    if (crc32(data) >>> 0 !== entry.crc >>> 0) corrupt(`entry ${name} fails its CRC-32 check`);
    this.inflated += entry.size;
    const out = new Uint8Array(data);
    this.cache.set(name, out);
    return out;
  }
}

/**
 * Reads and validates a ZIP archive's directory: end record, central directory, local
 * headers, duplicates, encryption, compression method and declared sizes. Inflates nothing.
 */
export function readZipPackage(bytes: Uint8Array): ZipPackage {
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

  const entries = new Map<string, ZipEntry>();
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
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localName = buf.toString("utf8", localOffset + 30, localOffset + 30 + localNameLen);
    if (localName !== name) corrupt(`local header names ${localName}, directory names ${name}`);
    const dataStart = localOffset + 30 + localNameLen + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compSize > cenOffset) corrupt(`entry ${name} overruns the archive`);
    if (method !== 0 && method !== 8)
      unreadable(`entry ${name} uses unsupported compression method ${method}`);
    if (method === 0 && size !== compSize)
      corrupt(`stored entry ${name} records ${size} bytes but holds ${compSize}`);
    if (size > ZIP_LIMITS.bombMinBytes && size > ZIP_LIMITS.maxRatio * compSize) {
      unreadable(
        `entry ${name} declares ${size} bytes from ${compSize} compressed (over ${ZIP_LIMITS.maxRatio}:1): a decompression bomb, not a document part`,
      );
    }
    entries.set(name, { name, method, crc, compSize, size, dataStart });
  }
  return new ZipPackage(buf, entries);
}

function xmlPart(zip: ZipPackage, name: string): XmlElement {
  const bytes = zip.read(name);
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
  zip: ZipPackage,
  relsPath: string,
  baseDir: string,
  type: string,
): string | undefined {
  if (!zip.has(relsPath)) return undefined;
  const rels = xmlPart(zip, relsPath);
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

function readDocxStyles(zip: ZipPackage, path: string | undefined) {
  const styles = new Map<string, DocxStyle>();
  let defaultId: string | null = null;
  if (path === undefined || !zip.has(path)) return { styles, defaultId, present: false };
  const root = xmlPart(zip, path);
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
  const rows = flattenSdt(tbl, ["w:tr"]).map((tr) => {
    // w:gridBefore / w:gridAfter skip grid columns, shifting every cell name in the row.
    const trPr = firstChild(tr, "w:trPr");
    const shifted =
      trPr !== undefined &&
      (firstChild(trPr, "w:gridBefore") !== undefined ||
        firstChild(trPr, "w:gridAfter") !== undefined);
    return flattenSdt(tr, ["w:tc"]).map((tc): WriterCell => {
      const tcPr = firstChild(tc, "w:tcPr");
      const span = Number(
        tcPr === undefined ? 1 : (firstChild(tcPr, "w:gridSpan")?.attrs["w:val"] ?? 1),
      );
      // w:hMerge is the legacy horizontal merge; like w:vMerge it makes names ambiguous.
      const merged =
        tcPr !== undefined &&
        (firstChild(tcPr, "w:vMerge") !== undefined || firstChild(tcPr, "w:hMerge") !== undefined);
      const { text, nested } = docxCellText(tc, st);
      return { text, complex: span !== 1 || merged || nested || shifted };
    });
  });
  return { kind: "table", rows };
}

const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const WORD_MAIN_CT =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

/**
 * The content type `[Content_Types].xml` gives the main part: an Override for its part
 * name (OPC compares part names case-insensitively), else the Default for its extension.
 * Word refuses a package whose main part is not a WordprocessingML document, so the
 * oracle does too (`unreadable`), rather than reading `w:document` out of, say, a
 * template or a part declared as a spreadsheet.
 */
function requireWordMainType(zip: ZipPackage, mainPath: string): void {
  const types = xmlPart(zip, "[Content_Types].xml");
  if (types.name !== "Types" || types.attrs.xmlns !== CT_NS)
    unreadable("[Content_Types].xml is not an OPC content-types part");
  const partName = `/${mainPath}`.toLowerCase();
  const ext = mainPath.slice(mainPath.lastIndexOf(".") + 1).toLowerCase();
  const override = childElements(types, "Override").find(
    (o) => o.attrs.PartName?.toLowerCase() === partName,
  );
  const type =
    override?.attrs.ContentType ??
    childElements(types, "Default").find((d) => d.attrs.Extension?.toLowerCase() === ext)?.attrs
      .ContentType;
  if (type !== WORD_MAIN_CT) {
    unreadable(
      `[Content_Types].xml declares ${mainPath} as ${JSON.stringify(type ?? null)}, not a WordprocessingML document`,
    );
  }
}

function readDocx(zip: ZipPackage, filePath: string): WriterDocument {
  const mainPath = relTarget(zip, "_rels/.rels", "", REL_OFFICE_DOC);
  if (mainPath === undefined) return corrupt("_rels/.rels names no main document part");
  requireWordMainType(zip, mainPath);
  const root = xmlPart(zip, mainPath);
  if (root.name !== "w:document")
    unreadable(`${mainPath} root is <${root.name}>, not <w:document>`);
  requireNamespaces(root, mainPath, { w: W_NS });
  const slash = mainPath.lastIndexOf("/");
  const dir = slash < 0 ? "" : mainPath.slice(0, slash + 1);
  const relsPath = `${dir}_rels/${mainPath.slice(slash + 1)}.rels`;
  const st = readDocxStyles(zip, relTarget(zip, relsPath, dir, REL_STYLES));
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

/**
 * Expansion limits for one `.odt` read. ODF compresses repeated rows, columns and spaces
 * into attributes (`table:number-rows-repeated`, `table:number-columns-repeated`,
 * `text:s/@text:c`), so a 1.6 KB file can describe 200 million cells. Writer tables are
 * small (a long report's largest table is a few thousand cells), so the reader counts the
 * cells a table expands to before building any of them, and stops past these bounds.
 */
export const ODT_LIMITS = {
  /** Largest value of one repeat or span attribute. */
  maxRepeat: 1024,
  /** Most cells one table may expand to (a row with no cells counts as one). */
  maxTableCells: 50_000,
  /** Most cells all tables in the document may expand to, nested tables included. */
  maxDocumentCells: 200_000,
  /** Most spaces all `text:s` elements in the document may expand to. */
  maxSpaces: 1_000_000,
} as const;

interface OdfStyles {
  /** Automatic paragraph style name -> parent common style name (or null). */
  readonly automatic: Map<string, string | null>;
  /** Common paragraph style name -> display name. */
  readonly common: Map<string, string>;
  /** What is left of this read's `ODT_LIMITS` document budgets (mutated as it is spent). */
  readonly budget: { cells: number; spaces: number };
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

function odtText(el: XmlElement, styles: OdfStyles): string {
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
        styles.budget.spaces -= c;
        if (styles.budget.spaces < 0)
          unreadable(`text:s expands to more than ${ODT_LIMITS.maxSpaces} spaces in total`);
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
        out += odtText(child, styles);
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
    text: odtText(el, styles),
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
  if (!Number.isInteger(n) || n < 1 || n > ODT_LIMITS.maxRepeat)
    corrupt(`invalid ${what} ${JSON.stringify(raw)}`);
  return n;
}

/** The table's distinct row elements with their repeat counts (nothing expanded). */
function odtRows(el: XmlElement): { row: XmlElement; times: number }[] {
  const out: { row: XmlElement; times: number }[] = [];
  for (const c of childElements(el)) {
    if (c.name === "table:table-row") {
      out.push({ row: c, times: repeat(c.attrs["table:number-rows-repeated"], "rows-repeated") });
    } else if (
      ["table:table-header-rows", "table:table-rows", "table:table-row-group"].includes(c.name)
    ) {
      out.push(...odtRows(c));
    }
  }
  return out;
}

const isOdtCell = (el: XmlElement): boolean =>
  el.name === "table:table-cell" || el.name === "table:covered-table-cell";

function odtTable(el: XmlElement, styles: OdfStyles): WriterTable {
  const rows = odtRows(el);
  // Count the expanded size first, from attributes alone, so a repeat bomb is refused
  // before a single cell is built.
  let total = 0;
  for (const { row, times } of rows) {
    let width = 0;
    for (const tc of childElements(row)) {
      if (isOdtCell(tc))
        width += repeat(tc.attrs["table:number-columns-repeated"], "columns-repeated");
    }
    total += times * Math.max(1, width);
    if (total > ODT_LIMITS.maxTableCells) {
      return unreadable(
        `a table expands to more than ${ODT_LIMITS.maxTableCells} cells (row and column repeats)`,
      );
    }
  }
  styles.budget.cells -= total;
  if (styles.budget.cells < 0) {
    return unreadable(
      `the document's tables expand to more than ${ODT_LIMITS.maxDocumentCells} cells`,
    );
  }
  // Each distinct row and cell is read once; repeats share the same (immutable) objects.
  const out: (readonly WriterCell[])[] = [];
  for (const { row, times } of rows) {
    const cells: WriterCell[] = [];
    for (const tc of childElements(row)) {
      if (!isOdtCell(tc)) continue;
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
      const cell: WriterCell = {
        text,
        complex: tc.name === "table:covered-table-cell" || spanned || nested,
      };
      for (
        let i = repeat(tc.attrs["table:number-columns-repeated"], "columns-repeated");
        i > 0;
        i--
      )
        cells.push(cell);
    }
    for (let i = 0; i < times; i++) out.push(cells);
  }
  return { kind: "table", rows: out };
}

function readOdt(zip: ZipPackage, filePath: string): WriterDocument {
  const content = xmlPart(zip, "content.xml");
  if (content.name !== "office:document-content") {
    unreadable(`content.xml root is <${content.name}>, not <office:document-content>`);
  }
  requireNamespaces(content, "content.xml", ODF_NS);
  const automatic = new Map<string, string>();
  collectStyles(firstChild(content, "office:automatic-styles"), automatic, false);
  const common = new Map<string, string>();
  if (zip.has("styles.xml")) {
    const styles = xmlPart(zip, "styles.xml");
    requireNamespaces(styles, "styles.xml", { office: ODF_NS.office, style: ODF_NS.style });
    collectStyles(firstChild(styles, "office:styles"), common, true);
  }
  const styles: OdfStyles = {
    automatic: new Map([...automatic].map(([k, v]) => [k, v === "" ? null : v])),
    common,
    budget: { cells: ODT_LIMITS.maxDocumentCells, spaces: ODT_LIMITS.maxSpaces },
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
    const zip = readZipPackage(bytes);
    const mimetype = zip.read("mimetype");
    if (mimetype !== undefined) {
      const type = new TextDecoder().decode(mimetype).trim();
      if (type !== ODT_MIMETYPE)
        return unreadable(`package mimetype is ${type}, not a Writer text document`);
      return readOdt(zip, filePath);
    }
    if (zip.has("[Content_Types].xml")) return readDocx(zip, filePath);
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
