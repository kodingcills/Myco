/**
 * The gate's own `.xlsx` reader (TIF-274 prerequisite; outer-loop ruling 08:38Z, option (a)).
 *
 * Every fc-v1 task specifies `persistedFormat: "xlsx"`, so the gate must decide a trial from
 * the saved workbook itself, on the same whole-document rule and the SAME cell model as the
 * CSV path (`calc-document.ts`): non-empty cells by A1 ref, each as the fixture's own text.
 * This module turns workbook bytes into that model; `calc-document.ts` compares it.
 *
 * Independence: this is gate code. It imports nothing from `src/benchmark/grade/` (the
 * independent grader, which has its own zip and sheet readers), and the grader imports
 * nothing from here. Both directions are pinned by `test/gate/xlsx-independence.test.ts`.
 * The two readers differ on purpose in code (own zip walk, own XML tokenizer, own date
 * arithmetic) so a bug in one is not silently the other's.
 *
 * Hardening (all failures are an `XlsxError` carrying a CODE only, never a path or a value;
 * the family turns it into `uncertain` STATE_CORRUPT):
 *  - input size and zip entry count are checked before anything is inflated;
 *  - every entry's declared sizes are checked (per-entry cap, compression-ratio cap,
 *    total-uncompressed cap) for ALL entries before ANY entry is inflated; inflation is then
 *    bounded by the declared size (`maxOutputLength`) and checked against it and the CRC;
 *  - entry names are a strict allowlist: no absolute path, backslash, `.`/`..` segment,
 *    empty segment or non-ASCII; duplicates (case-insensitive) are refused; relationship
 *    targets that climb above the package root are refused;
 *  - encrypted entries, ZIP64, multi-disk archives, overlapping entries and trailing or
 *    leading junk are refused;
 *  - no external links (`xl/externalLinks/`, any `TargetMode="External"` relationship), no
 *    macros (`vbaProject.bin`, macro-enabled content types, macro sheets, ActiveX), no
 *    embedded objects; the workbook part's content type must be the plain SpreadsheetML
 *    workbook type;
 *  - XML: UTF-8 only, no DTD or entity declarations, no CDATA, no processing instructions,
 *    strict entity references, XML 1.0 characters only, well-formed nesting.
 *
 *  - XML namespaces are resolved in scope (Namespaces in XML 1.0): a part's root and its
 *    elements are matched by namespace URI and local name, whatever prefix the writer chose
 *    and wherever it declared it (openpyxl declares `xmlns:r` on each `<sheet>`); an unbound
 *    prefix or a duplicate expanded attribute name is XLSX_XML_MALFORMED.
 *
 * Formulas are NEVER evaluated. A formula cell is a formula marker (the formula text and its
 * cached value), which equals no literal cell: a formula where the pristine fixture holds a
 * literal, in the target or in any other cell, is refuted, never verified on its cached
 * value (round 2, D2; the independent grader fails it too). A formula with no cached value
 * is `uncertain` (XLSX_FORMULA_UNCACHED).
 *
 * The cell model (parity with the CSV path). A cell becomes the text the fixture CSV holds
 * for the same content, and a number becomes that text only when the stored value is
 * EXACTLY the value the text denotes:
 *  - shared, inline and formula-string cells: their text, exactly (no trimming, no
 *    `_xHHHH_` unescaping); an empty string is an empty cell, as in CSV;
 *  - a number in a General (or text `@`) format: its shortest round-trip decimal ("451");
 *  - a number in a fixed format (`0`, `#,##0.00`, optionally `$`-prefixed): `$` if the
 *    format carries the dollar sign, then the value with the format's decimals ("$45678.90"),
 *    provided the value is exact at that many decimals; thousands grouping is display only
 *    and is not rendered (the fixture has none);
 *  - a number in a date format: the ISO day "YYYY-MM-DD" (1900 or 1904 date system). A
 *    serial no real day has (below 1, the phantom 1900-02-29 = serial 60, past 9999-12-31)
 *    is the impossible-date marker, which equals no expected cell: refuted (R1's
 *    impossible-date rule, as an impossible date written as text is refuted on the CSV
 *    path). A serial with a time of day is not a date and is refuted the same way;
 *  - booleans, error values, numbers whose format the gate does not render (percent,
 *    scientific, fractions, times, literal text, another currency) and numbers not exact
 *    at their format's decimals become markers that equal no expected cell: refuted.
 *    (The independent grader never matches a boolean or an error either.)
 * Markers start with U+0000 followed by a line feed. Neither can occur in a cell the gate
 * expects: XML 1.0 cannot carry U+0000, and the CSV path splits rows on line feeds.
 *
 * Sheets: the reader returns the first worksheet's cells and the number of sheets in the
 * workbook. The fixture is one sheet; the family refutes any other sheet set
 * (SHEET_SET_MISMATCH).
 */
import { crc32, inflateRawSync } from "node:zlib";
import { cellRef } from "../core/filepersist.ts";
import {
  checkPartNames,
  checkRelationships,
  type PartsCode,
  type RawRelationship,
} from "./xlsx-parts.ts";
import { contentKindOf, type PrescanCode, prescanXmlPart } from "./xlsx-prescan.ts";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Caps, all checked before any entry is inflated. A LibreOffice-saved 200-row fixture is
 * about 10 KiB on disk, about a dozen entries, and well under 100 KiB inflated; each cap
 * leaves two to three orders of magnitude of headroom while bounding memory.
 */
export const XLSX_LIMITS = {
  /** Bytes of the workbook file itself (the evidence reader's own cap is 16 MiB). */
  maxFileBytes: 8 * 1024 * 1024,
  /** Zip entries (LibreOffice writes 9-12, Excel 10-15). */
  maxEntries: 64,
  /** Declared uncompressed bytes of one entry. */
  maxEntryBytes: 8 * 1024 * 1024,
  /** Declared uncompressed bytes of all entries together. */
  maxTotalBytes: 16 * 1024 * 1024,
  /**
   * Largest uncompressed:compressed ratio for an entry larger than `ratioGraceBytes`.
   * Office XML deflates 5-20x; 100x is Apache POI's default zip-bomb threshold.
   */
  maxRatio: 100,
  /** Entries up to this declared size skip the ratio check (they cannot amount to a bomb). */
  ratioGraceBytes: 256 * 1024,
  /** XML element nesting depth. SpreadsheetML needs fewer than 10. */
  maxXmlDepth: 64,
} as const;

/** Why a workbook was refused. Agent-facing: codes only. */
export type XlsxErrorCode =
  | "XLSX_TOO_LARGE"
  | "XLSX_NOT_ZIP"
  | "XLSX_ZIP_MALFORMED"
  | "XLSX_ZIP64"
  | "XLSX_TOO_MANY_ENTRIES"
  | "XLSX_ENTRY_TOO_LARGE"
  | "XLSX_TOTAL_TOO_LARGE"
  | "XLSX_RATIO_EXCEEDED"
  | "XLSX_UNSAFE_ENTRY_NAME"
  | "XLSX_DUPLICATE_ENTRY"
  | "XLSX_ENCRYPTED"
  | "XLSX_UNSUPPORTED_METHOD"
  | "XLSX_INFLATE_FAILED"
  | "XLSX_CRC_MISMATCH"
  | "XLSX_NOT_WORKBOOK"
  | "XLSX_CONTENT_TYPE"
  | "XLSX_MACROS"
  | "XLSX_EXTERNAL_LINK"
  | "XLSX_EMBEDDED_OBJECT"
  | "XLSX_UNSAFE_PART"
  | "XLSX_DTD"
  | "XLSX_XML_MALFORMED"
  | "XLSX_XML_UNSUPPORTED"
  | "XLSX_CELL_MALFORMED"
  | "XLSX_FORMULA_UNCACHED"
  | "XLSX_STYLE_MALFORMED"
  | "XLSX_NUMFMT_UNSUPPORTED"
  | PrescanCode
  | PartsCode;

export class XlsxError extends Error {
  override readonly name = "XlsxError";
  constructor(readonly code: XlsxErrorCode) {
    super(code);
  }
}

function fail(code: XlsxErrorCode): never {
  throw new XlsxError(code);
}

// ---------------------------------------------------------------------------
// Zip container
// ---------------------------------------------------------------------------

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

/** True when `bytes` start like a zip archive (local header, or an empty archive's EOCD). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}

/** A path segment: ASCII letters, digits and `_ . - [ ]` (for `[Content_Types].xml`). */
const NAME_SEGMENT = /^[A-Za-z0-9_.[\]-]+$/;

/** Is `name` a safe zip entry / part name (relative, no traversal, strict alphabet)? */
export function isSafeEntryName(name: string): boolean {
  if (name === "" || name.length > 255) return false;
  const segments = name.split("/");
  return segments.every((s) => NAME_SEGMENT.test(s) && s !== "." && s !== "..");
}

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly dataStart: number;
  readonly spanStart: number;
  readonly spanEnd: number;
}

/**
 * Read every entry of the archive. All structural checks and all size caps run over the
 * whole central directory first; only then is anything inflated.
 */
export function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length > XLSX_LIMITS.maxFileBytes) fail("XLSX_TOO_LARGE");
  if (bytes.length < 22 || !looksLikeZip(bytes)) fail("XLSX_NOT_ZIP");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) =>
    at >= 0 && at + 2 <= bytes.length ? view.getUint16(at, true) : fail("XLSX_ZIP_MALFORMED");
  const u32 = (at: number) =>
    at >= 0 && at + 4 <= bytes.length ? view.getUint32(at, true) : fail("XLSX_ZIP_MALFORMED");

  // End of central directory: the comment length must reach exactly the end of the file,
  // so a signature inside the comment or trailing junk cannot be taken for it.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(i) === EOCD_SIG && i + 22 + u16(i + 20) === bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail("XLSX_ZIP_MALFORMED");
  if (eocd >= 20 && u32(eocd - 20) === ZIP64_LOCATOR_SIG) fail("XLSX_ZIP64");
  const disk = u16(eocd + 4);
  const cdDisk = u16(eocd + 6);
  const onDisk = u16(eocd + 8);
  const total = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail("XLSX_ZIP64");
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) fail("XLSX_ZIP_MALFORMED");
  // Entry count, before any entry is parsed.
  if (total > XLSX_LIMITS.maxEntries) fail("XLSX_TOO_MANY_ENTRIES");
  if (cdOffset + cdSize !== eocd) fail("XLSX_ZIP_MALFORMED");

  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let declaredTotal = 0;
  let at = cdOffset;
  for (let n = 0; n < total; n++) {
    if (u32(at) !== CENTRAL_SIG) fail("XLSX_ZIP_MALFORMED");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const compressedSize = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const diskStart = u16(at + 34);
    const localOffset = u32(at + 42);
    if (at + 46 + nameLength > eocd) fail("XLSX_ZIP_MALFORMED");
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (at > eocd) fail("XLSX_ZIP_MALFORMED");

    // Bit 0: encrypted; bit 6: strong encryption; bit 13: masked central directory.
    // Method 99 is WinZip AES.
    if (flags & 0x2041 || method === 99) fail("XLSX_ENCRYPTED");
    if (method !== 0 && method !== 8) fail("XLSX_UNSUPPORTED_METHOD");
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff)
      fail("XLSX_ZIP64");
    if (diskStart !== 0) fail("XLSX_ZIP_MALFORMED");
    let name = "";
    for (const b of nameBytes) {
      if (b < 0x21 || b > 0x7e) fail("XLSX_UNSAFE_ENTRY_NAME");
      name += String.fromCharCode(b);
    }
    if (!isSafeEntryName(name)) fail("XLSX_UNSAFE_ENTRY_NAME");
    const folded = name.toLowerCase();
    if (seen.has(folded)) fail("XLSX_DUPLICATE_ENTRY");
    seen.add(folded);

    // Size caps on the declared sizes, before inflating anything.
    if (size > XLSX_LIMITS.maxEntryBytes) fail("XLSX_ENTRY_TOO_LARGE");
    if (method === 0 && compressedSize !== size) fail("XLSX_ZIP_MALFORMED");
    if (size > XLSX_LIMITS.ratioGraceBytes && size > compressedSize * XLSX_LIMITS.maxRatio)
      fail("XLSX_RATIO_EXCEEDED");
    declaredTotal += size;
    if (declaredTotal > XLSX_LIMITS.maxTotalBytes) fail("XLSX_TOTAL_TOO_LARGE");

    // The local header must agree with the central one.
    if (u32(localOffset) !== LOCAL_SIG) fail("XLSX_ZIP_MALFORMED");
    const localFlags = u16(localOffset + 6);
    if (localFlags & 0x41) fail("XLSX_ENCRYPTED");
    if (u16(localOffset + 8) !== method) fail("XLSX_ZIP_MALFORMED");
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    if (localNameLength !== nameLength) fail("XLSX_ZIP_MALFORMED");
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (localName.length !== nameBytes.length || localName.some((b, i) => b !== nameBytes[i]))
      fail("XLSX_ZIP_MALFORMED");
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) fail("XLSX_ZIP_MALFORMED");
    entries.push({
      name,
      method,
      crc,
      compressedSize,
      size,
      dataStart,
      spanStart: localOffset,
      spanEnd: dataEnd,
    });
  }
  if (at !== eocd) fail("XLSX_ZIP_MALFORMED");
  // Entries may not overlap (overlap is how quine-style bombs reuse data).
  const spans = [...entries].sort((a, b) => a.spanStart - b.spanStart);
  for (let i = 1; i < spans.length; i++) {
    if ((spans[i] as CentralEntry).spanStart < (spans[i - 1] as CentralEntry).spanEnd)
      fail("XLSX_ZIP_MALFORMED");
  }

  // Every check passed: inflate, bounded by the declared size, then verify size and CRC.
  const out = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const raw = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let data: Uint8Array;
    if (entry.method === 0) data = raw;
    else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
      } catch {
        fail("XLSX_INFLATE_FAILED");
      }
    }
    if (data.length !== entry.size) fail("XLSX_INFLATE_FAILED");
    if (crc32(data) >>> 0 !== entry.crc) fail("XLSX_CRC_MISMATCH");
    out.set(entry.name, data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// XML (a small strict tokenizer: enough for SpreadsheetML, refuses everything else)
// ---------------------------------------------------------------------------

export interface XmlElement {
  /** The qualified name as written (`x:workbook`, `c`). */
  readonly name: string;
  /** The local name (the qualified name without its prefix). */
  readonly local: string;
  /** The namespace URI the element's prefix (or the default namespace) is bound to in scope. */
  readonly ns: string | undefined;
  /** Attributes by qualified name as written. */
  readonly attrs: ReadonlyMap<string, string>;
  /** Prefix -> namespace URI bindings in scope at this element ("" = the default namespace). */
  readonly scope: ReadonlyMap<string, string>;
  readonly children: readonly (XmlElement | string)[];
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const BASE_SCOPE: ReadonlyMap<string, string> = new Map([["xml", XML_NS]]);

/** Split a qualified name into [prefix, local]; more than one colon is malformed. */
function splitQName(qname: string): [string | undefined, string] {
  const parts = qname.split(":");
  if (parts.length === 1) return [undefined, qname];
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") fail("XLSX_XML_MALFORMED");
  return [parts[0], parts[1] as string];
}

/**
 * The namespace scope of an element: its parent's bindings plus the element's own `xmlns`
 * and `xmlns:p` declarations (Namespaces in XML 1.0). Undeclaring a prefix, rebinding `xml`
 * or `xmlns`, or binding anything to their URIs is malformed. Every prefix used by the
 * element or its attributes must be bound, and no two attributes may share an expanded name.
 */
function elementScope(
  qname: string,
  attrs: ReadonlyMap<string, string>,
  parent: ReadonlyMap<string, string>,
): { scope: ReadonlyMap<string, string>; ns: string | undefined; local: string } {
  let scope: Map<string, string> | undefined;
  const own = () => {
    scope ??= new Map(parent);
    return scope;
  };
  for (const [key, value] of attrs) {
    if (key === "xmlns") {
      if (value === XML_NS || value === XMLNS_NS) fail("XLSX_XML_MALFORMED");
      if (value === "") own().delete("");
      else own().set("", value);
    } else if (key.startsWith("xmlns:")) {
      const [, prefix] = splitQName(key);
      if (prefix === "xmlns" || value === "" || value === XMLNS_NS) fail("XLSX_XML_MALFORMED");
      if ((prefix === "xml") !== (value === XML_NS)) fail("XLSX_XML_MALFORMED");
      own().set(prefix, value);
    }
  }
  const inScope: ReadonlyMap<string, string> = scope ?? parent;
  const [prefix, local] = splitQName(qname);
  if (prefix === "xmlns") fail("XLSX_XML_MALFORMED");
  const ns = prefix === undefined ? inScope.get("") : inScope.get(prefix);
  if (prefix !== undefined && ns === undefined) fail("XLSX_XML_MALFORMED");
  const expanded = new Set<string>();
  for (const key of attrs.keys()) {
    if (key === "xmlns" || key.startsWith("xmlns:")) continue;
    const [p, l] = splitQName(key);
    const uri = p === undefined ? "" : inScope.get(p);
    if (uri === undefined) fail("XLSX_XML_MALFORMED");
    const name = `{${uri}}${l}`;
    if (expanded.has(name)) fail("XLSX_XML_MALFORMED");
    expanded.add(name);
  }
  return { scope: inScope, ns, local };
}

/** The value of the attribute `{uri}local` on `element`, under whatever prefix is in scope. */
function nsAttr(element: XmlElement, uri: string, local: string): string | undefined {
  for (const [key, value] of element.attrs) {
    const colon = key.indexOf(":");
    if (colon < 0 || key.startsWith("xmlns:")) continue;
    if (key.slice(colon + 1) === local && element.scope.get(key.slice(0, colon)) === uri)
      return value;
  }
  return undefined;
}

function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

const ENTITY = /&(?:#x([0-9A-Fa-f]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos));/g;
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode character and the five predefined entity references; anything else is refused. */
function decodeText(raw: string): string {
  if (raw.replace(ENTITY, "").includes("&")) fail("XLSX_XML_MALFORMED");
  return raw.replace(ENTITY, (_m, hex?: string, dec?: string, named?: string) => {
    if (named !== undefined) return NAMED[named] as string;
    const cp = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec as string, 10);
    if (!isXmlChar(cp)) fail("XLSX_XML_MALFORMED");
    return String.fromCodePoint(cp);
  });
}

const NAME = "[A-Za-z_][A-Za-z0-9_.:-]*";
const OPEN_TAG = new RegExp(
  `<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`,
  "y",
);
const CLOSE_TAG = new RegExp(`</(${NAME})\\s*>`, "y");
const ATTR = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, "g");
/**
 * The XML declaration, by its grammar: a version, then optionally `encoding` (UTF-8 only)
 * and `standalone`. Any other declaration (a non-UTF-8 encoding, unknown pseudo-attributes)
 * is refused.
 */
const XML_DECL =
  /^<\?xml\s+version\s*=\s*(["'])1\.[0-9]+\1(?:\s+encoding\s*=\s*(["'])utf-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/i;

/** Parse one XML part. UTF-8 only; no DTD, CDATA or processing instructions. */
export function parseXml(bytes: Uint8Array): XmlElement {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    fail("XLSX_XML_MALFORMED");
  }
  for (const ch of text) {
    if (!isXmlChar(ch.codePointAt(0) as number)) fail("XLSX_XML_MALFORMED");
  }
  // A declaration outside the grammar is not consumed here, so the tokenizer meets it as a
  // processing instruction and refuses it (XLSX_XML_UNSUPPORTED) below.
  const decl = XML_DECL.exec(text);
  let i = decl ? decl[0].length : 0;

  interface Building {
    name: string;
    local: string;
    ns: string | undefined;
    attrs: Map<string, string>;
    scope: ReadonlyMap<string, string>;
    children: (XmlElement | string)[];
  }
  const stack: Building[] = [];
  let root: XmlElement | undefined;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    const end = lt < 0 ? text.length : lt;
    if (end > i) {
      const chunk = text.slice(i, end);
      const top = stack[stack.length - 1];
      if (top) top.children.push(decodeText(chunk));
      else if (chunk.trim() !== "") fail("XLSX_XML_MALFORMED");
      i = end;
      continue;
    }
    if (text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      if (close < 0) fail("XLSX_XML_MALFORMED");
      i = close + 3;
      continue;
    }
    if (text.startsWith("<!DOCTYPE", i) || text.startsWith("<!ENTITY", i)) fail("XLSX_DTD");
    if (text.startsWith("<!", i) || text.startsWith("<?", i)) fail("XLSX_XML_UNSUPPORTED");
    if (text.startsWith("</", i)) {
      CLOSE_TAG.lastIndex = i;
      const m = CLOSE_TAG.exec(text);
      const top = stack.pop();
      if (!m || !top || top.name !== m[1]) fail("XLSX_XML_MALFORMED");
      i = CLOSE_TAG.lastIndex;
      const done: XmlElement = top;
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(done);
      else if (root) fail("XLSX_XML_MALFORMED");
      else root = done;
      continue;
    }
    OPEN_TAG.lastIndex = i;
    let m: RegExpExecArray | null;
    try {
      m = OPEN_TAG.exec(text);
    } catch (error) {
      // A pathological tag (an unterminated one with ~1M attributes) can overflow the regex
      // engine's stack. That is malformed input, reported as a code like any other.
      if (error instanceof RangeError) fail("XLSX_XML_MALFORMED");
      throw error;
    }
    if (!m) fail("XLSX_XML_MALFORMED");
    i = OPEN_TAG.lastIndex;
    const attrs = new Map<string, string>();
    for (const a of (m[2] as string).matchAll(ATTR)) {
      const key = a[1] as string;
      if (attrs.has(key)) fail("XLSX_XML_MALFORMED");
      attrs.set(key, decodeText(a[2] ?? a[3] ?? ""));
    }
    const name = m[1] as string;
    const { scope, ns, local } = elementScope(
      name,
      attrs,
      stack[stack.length - 1]?.scope ?? BASE_SCOPE,
    );
    const element: Building = { name, local, ns, attrs, scope, children: [] };
    if (stack.length === 0 && root) fail("XLSX_XML_MALFORMED");
    if (m[3] === "/") {
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(element);
      else root = element;
    } else {
      if (stack.length >= XLSX_LIMITS.maxXmlDepth) fail("XLSX_XML_UNSUPPORTED");
      stack.push(element);
    }
  }
  if (stack.length > 0 || !root) fail("XLSX_XML_MALFORMED");
  return root;
}

/** Children of `parent` named `local` in `parent`'s own namespace (whatever the prefix). */
function elements(parent: XmlElement, local: string): XmlElement[] {
  return parent.children.filter(
    (c): c is XmlElement => typeof c !== "string" && c.local === local && c.ns === parent.ns,
  );
}

function child(parent: XmlElement, name: string): XmlElement | undefined {
  return elements(parent, name)[0];
}

/** Elements anywhere below `element` whose local name (prefix ignored) is `local`. */
function countNamed(element: XmlElement, local: string): number {
  let n = 0;
  for (const c of element.children) {
    if (typeof c === "string") continue;
    if (c.local === local) n++;
    n += countNamed(c, local);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Package (content types, relationships)
// ---------------------------------------------------------------------------

const NS = {
  main: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  pkgRel: "http://schemas.openxmlformats.org/package/2006/relationships",
  types: "http://schemas.openxmlformats.org/package/2006/content-types",
} as const;
const REL_TYPE = {
  officeDocument: `${NS.rel}/officeDocument`,
  worksheet: `${NS.rel}/worksheet`,
  sharedStrings: `${NS.rel}/sharedStrings`,
  styles: `${NS.rel}/styles`,
} as const;
const WORKBOOK_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

/** The part's root must be `{ns}local`, under any prefix (or the default namespace). */
function rootIn(element: XmlElement, ns: string, local: string): XmlElement {
  if (element.local !== local || element.ns !== ns) fail("XLSX_NOT_WORKBOOK");
  return element;
}

interface Relationship {
  readonly type: string;
  readonly target: string;
}

/** Resolve a relationship target against the part that owns it; refuse escaping the root. */
function resolvePart(owner: string, target: string): string {
  const parts = target.startsWith("/") ? [] : owner.split("/").slice(0, -1);
  for (const seg of target.replace(/^\//, "").split("/")) {
    if (seg === "..") {
      if (parts.length === 0) fail("XLSX_UNSAFE_PART");
      parts.pop();
    } else if (seg !== "." && seg !== "") parts.push(seg);
  }
  const name = parts.join("/");
  if (!isSafeEntryName(name)) fail("XLSX_UNSAFE_PART");
  return name;
}

/** The relationships part of `owner` (`a/b.xml` → `a/_rels/b.xml.rels`), by id. */
function relationships(
  entries: ReadonlyMap<string, Uint8Array>,
  owner: string,
): Map<string, Relationship> {
  const slash = owner.lastIndexOf("/");
  const relsName = `${owner.slice(0, slash + 1)}_rels/${owner.slice(slash + 1)}.rels`;
  const out = new Map<string, Relationship>();
  const bytes = entries.get(relsName);
  if (!bytes) return out;
  const root = rootIn(parseXml(bytes), NS.pkgRel, "Relationships");
  for (const rel of elements(root, "Relationship")) {
    const id = rel.attrs.get("Id");
    const type = rel.attrs.get("Type");
    const target = rel.attrs.get("Target");
    if (id === undefined || type === undefined || target === undefined || out.has(id))
      fail("XLSX_NOT_WORKBOOK");
    if (rel.attrs.get("TargetMode") === "External") fail("XLSX_EXTERNAL_LINK");
    out.set(id, { type, target: resolvePart(owner, target) });
  }
  return out;
}

/** Refuse active or linked content anywhere in the package, by entry name (no parsing). */
function refuseActiveNames(entries: ReadonlyMap<string, Uint8Array>): void {
  for (const name of entries.keys()) {
    const lower = name.toLowerCase();
    if (
      lower.endsWith("vbaproject.bin") ||
      lower.includes("/activex/") ||
      lower.includes("macrosheets/")
    )
      fail("XLSX_MACROS");
    if (lower.includes("/externallinks/")) fail("XLSX_EXTERNAL_LINK");
    if (lower.includes("/embeddings/")) fail("XLSX_EMBEDDED_OBJECT");
  }
}

/** Refuse an external relationship target in any relationships part (after the pre-scan). */
function refuseExternalTargets(entries: ReadonlyMap<string, Uint8Array>): void {
  for (const name of entries.keys()) {
    if (!name.endsWith(".rels")) continue;
    // Parse every relationships part: an external target anywhere is refused.
    const root = rootIn(parseXml(entries.get(name) as Uint8Array), NS.pkgRel, "Relationships");
    for (const rel of elements(root, "Relationship")) {
      if (rel.attrs.get("TargetMode") === "External") fail("XLSX_EXTERNAL_LINK");
    }
  }
}

/** A relationships part's relationships as written (no resolution), for xlsx-parts.ts. */
function rawRelationships(bytes: Uint8Array | undefined): RawRelationship[] {
  if (!bytes) return [];
  const root = rootIn(parseXml(bytes), NS.pkgRel, "Relationships");
  return elements(root, "Relationship").map((rel) => ({
    id: rel.attrs.get("Id"),
    type: rel.attrs.get("Type"),
    target: rel.attrs.get("Target"),
    extraAttributes: [...rel.attrs.keys()].filter((k) => !["Id", "Type", "Target"].includes(k))
      .length,
  }));
}

/** The content type the package declares for `part` (Override, else Default by extension). */
function contentTypeOf(types: XmlElement, part: string): string | undefined {
  for (const o of elements(types, "Override")) {
    if (o.attrs.get("PartName")?.toLowerCase() === `/${part}`.toLowerCase())
      return o.attrs.get("ContentType");
  }
  const ext = part.slice(part.lastIndexOf(".") + 1).toLowerCase();
  for (const d of elements(types, "Default")) {
    if (d.attrs.get("Extension")?.toLowerCase() === ext) return d.attrs.get("ContentType");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Number formats and the cell model
// ---------------------------------------------------------------------------

/** Marker prefix: U+0000 cannot occur in XML text, LF cannot occur in a CSV-path cell. */
const MARK = "\u0000\n";
export const MARKERS = {
  boolean: `${MARK}BOOLEAN`,
  error: `${MARK}ERROR`,
  impossibleDate: `${MARK}IMPOSSIBLE_DATE`,
  dateTime: `${MARK}DATE_WITH_TIME`,
  numberFormat: `${MARK}UNRENDERED_NUMBER_FORMAT`,
  inexact: `${MARK}INEXACT_AT_FORMAT_DECIMALS`,
  /** Prefix of a formula cell: the formula and its cached value follow (never evaluated). */
  formula: `${MARK}FORMULA\n`,
} as const;

/** How the gate renders a number in a given format. */
export type NumberClass =
  | { readonly kind: "general" }
  | { readonly kind: "fixed"; readonly decimals: number; readonly currency: boolean }
  | { readonly kind: "date" }
  | { readonly kind: "unrendered" };

/** Built-in number formats (ECMA-376 Part 1, 18.8.30) the gate interprets. Others: uncertain. */
const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  5: '"$"#,##0_);("$"#,##0)',
  6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)',
  8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

/** The first section of a format code (sections split on `;` outside quotes). */
function firstSection(code: string): string {
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "\\" && !quoted) i++;
    else if (ch === '"') quoted = !quoted;
    else if (ch === ";" && !quoted) return code.slice(0, i);
  }
  return code;
}

/** Classify a format code (the gate's own rules; see the module comment). */
export function classifyFormat(code: string): NumberClass {
  const section = firstSection(code).trim();
  if (section === "" || /^general$/i.test(section) || section === "@") return { kind: "general" };
  // Date and time tokens, outside quoted text, escapes and bracketed tags.
  const bare = section
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "");
  if (/[yd]/i.test(bare)) return { kind: "date" };
  if (/[hs]/i.test(bare) || /\[[hms]+\]/i.test(section) || /AM\/PM|A\/P/i.test(section))
    return { kind: "unrendered" };
  // Fixed-point grammar after normalising the dollar sign, padding, fill and colours.
  let normal = section
    .replace(/\[(?:black|blue|cyan|green|magenta|red|white|yellow|color\d{1,2})\]/gi, "")
    .replace(/_./g, "")
    .replace(/\*./g, "");
  let foreign = false;
  normal = normal.replace(/\[\$([^\]-]*)(?:-[0-9A-Fa-f]+)?\]/g, (_m, symbol: string) => {
    if (symbol === "$") return "$";
    if (symbol !== "") foreign = true;
    return "";
  });
  normal = normal.replace(/"\$"|\\\$/g, "$");
  if (foreign) return { kind: "unrendered" };
  const m = /^(\$?)[#0?,]*0[#0?,]*(?:\.(0+))?$|^(\$?)[#?,]+(?:\.(0+))?$/.exec(normal);
  if (!m) return { kind: "unrendered" };
  const dollar = (m[1] ?? m[3] ?? "") === "$";
  const decimals = (m[2] ?? m[4] ?? "").length;
  return { kind: "fixed", decimals, currency: dollar };
}

/** Largest serial that is a real day: 9999-12-31 in each date system. */
const MAX_SERIAL = { 1900: 2_958_465, 1904: 2_957_003 } as const;

/**
 * The ISO day of a whole serial in a date system, or null when no real day has it. The
 * 1900 system counts 1900-02-29 (serial 60), a day that never existed; serials after it are
 * one day ahead of a plain count from 1899-12-31.
 */
export function serialDay(serial: number, system: 1900 | 1904): string | null {
  if (!Number.isInteger(serial) || serial > MAX_SERIAL[system]) return null;
  let epoch: number;
  if (system === 1904) {
    if (serial < 0) return null;
    epoch = Date.UTC(1904, 0, 1);
  } else {
    if (serial < 1 || serial === 60) return null;
    epoch = serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  }
  const day = new Date(epoch + serial * 86_400_000);
  const y = day.getUTCFullYear();
  if (y < 1900 || y > 9999) return null;
  return `${String(y).padStart(4, "0")}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
}

/** Render a stored number as the CSV path's cell text (see the module comment). */
export function renderNumber(value: number, cls: NumberClass, system: 1900 | 1904): string {
  switch (cls.kind) {
    case "general":
      return Object.is(value, -0) ? "0" : String(value);
    case "fixed": {
      const text = value.toFixed(cls.decimals);
      if (Number(text) !== value || /e/i.test(text)) return MARKERS.inexact;
      return `${cls.currency ? "$" : ""}${text}`;
    }
    case "date": {
      if (!Number.isInteger(value)) {
        return serialDay(Math.floor(value), system) === null
          ? MARKERS.impossibleDate
          : MARKERS.dateTime;
      }
      return serialDay(value, system) ?? MARKERS.impossibleDate;
    }
    case "unrendered":
      return MARKERS.numberFormat;
  }
}

function readStyles(xml: XmlElement | undefined): NumberClass[] {
  if (!xml) return [{ kind: "general" }];
  const custom = new Map<number, string>();
  const numFmts = child(xml, "numFmts");
  for (const f of numFmts ? elements(numFmts, "numFmt") : []) {
    const id = Number(f.attrs.get("numFmtId"));
    const code = f.attrs.get("formatCode");
    if (!Number.isInteger(id) || code === undefined) fail("XLSX_STYLE_MALFORMED");
    custom.set(id, code);
  }
  const cellXfs = child(xml, "cellXfs");
  if (!cellXfs) return [{ kind: "general" }];
  return elements(cellXfs, "xf").map((xf) => {
    const raw = xf.attrs.get("numFmtId") ?? "0";
    if (!/^\d{1,5}$/.test(raw)) fail("XLSX_STYLE_MALFORMED");
    const id = Number(raw);
    const code = custom.get(id) ?? BUILTIN_FORMATS[id];
    if (code === undefined) fail("XLSX_NUMFMT_UNSUPPORTED");
    return classifyFormat(code);
  });
}

// ---------------------------------------------------------------------------
// Cell and string structure: an allowlist of the shapes real writers produce (round 3, D6).
// Anything else is refused with a code; the reader never guesses how an app would read it.
// ---------------------------------------------------------------------------

/** SpreadsheetML elements the cell reader knows; a known one out of place is malformed. */
const KNOWN_CELL_ELEMENTS: ReadonlySet<string> = new Set([
  "row",
  "c",
  "f",
  "v",
  "is",
  "t",
  "r",
  "rPr",
]);
/** Run-property children (formatting only; no content). */
const RUN_PROPERTIES: ReadonlySet<string> = new Set([
  "b",
  "i",
  "u",
  "sz",
  "color",
  "rFont",
  "family",
  "scheme",
  "strike",
  "vertAlign",
  "charset",
  "outline",
  "shadow",
  "condense",
  "extend",
]);
const NO_ATTRS: ReadonlySet<string> = new Set();
/** The attributes LibreOffice and openpyxl write on `<c>` (no `cm`, `vm`, `ph`). */
const CELL_ATTRS: ReadonlySet<string> = new Set(["r", "s", "t"]);
const TEXT_ATTRS: ReadonlySet<string> = new Set(["xml:space"]);

/** An element where the allowlist has no place for it: unknown, or known but misplaced. */
function misplaced(element: XmlElement): never {
  fail(KNOWN_CELL_ELEMENTS.has(element.local) ? "XLSX_CELL_MALFORMED" : "XLSX_XML_UNSUPPORTED");
}

/** Only namespace declarations and the `allowed` attributes may appear on `element`. */
function onlyAttrs(element: XmlElement, allowed: ReadonlySet<string>): void {
  for (const key of element.attrs.keys()) {
    if (key === "xmlns" || key.startsWith("xmlns:")) continue;
    if (!allowed.has(key)) fail("XLSX_CELL_MALFORMED");
  }
}

/**
 * The element children of a structural element (one that holds elements, not text). Text
 * between them must be whitespace; an element in another namespace is unsupported.
 */
function structuralChildren(element: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of element.children) {
    if (typeof c === "string") {
      if (!/^[ \t\r\n]*$/.test(c)) fail("XLSX_CELL_MALFORMED");
      continue;
    }
    if (c.ns !== NS.main) fail("XLSX_XML_UNSUPPORTED");
    out.push(c);
  }
  return out;
}

/** The text of a text-only element (`<v>`, `<t>`, `<f>`): any element child is malformed. */
function textOnly(element: XmlElement): string {
  let out = "";
  for (const c of element.children) {
    if (typeof c !== "string") fail("XLSX_CELL_MALFORMED");
    out += c;
  }
  return out;
}

/** `<t>`: text only, with at most `xml:space`. */
function textElement(t: XmlElement): string {
  onlyAttrs(t, TEXT_ATTRS);
  const space = t.attrs.get("xml:space");
  if (space !== undefined && space !== "preserve" && space !== "default")
    fail("XLSX_CELL_MALFORMED");
  return textOnly(t);
}

/** `<rPr>`: run-property elements only, each empty (formatting attributes, no content). */
function checkRunProperties(rPr: XmlElement): void {
  onlyAttrs(rPr, NO_ATTRS);
  for (const p of structuralChildren(rPr)) {
    if (!RUN_PROPERTIES.has(p.local)) fail("XLSX_XML_UNSUPPORTED");
    if (structuralChildren(p).length > 0) fail("XLSX_CELL_MALFORMED");
  }
}

/**
 * Text of a shared-string item (`<si>`) or inline string (`<is>`). Exactly two shapes are
 * accepted: one `<t>`, or one or more runs `<r>` each holding an optional `<rPr>` then
 * exactly one `<t>` (concatenated). Anything else (an empty item, several `<t>`, a mix of
 * `<t>` and `<r>`, phonetic runs, an unknown element) is refused.
 */
function stringItem(item: XmlElement): string {
  onlyAttrs(item, NO_ATTRS);
  const kids = structuralChildren(item);
  if (kids.length === 0) fail("XLSX_CELL_MALFORMED");
  const first = kids[0] as XmlElement;
  if (first.local === "t") {
    if (kids.length !== 1) misplaced(kids[1] as XmlElement);
    return textElement(first);
  }
  let out = "";
  for (const run of kids) {
    if (run.local !== "r") misplaced(run);
    onlyAttrs(run, NO_ATTRS);
    const parts = structuralChildren(run);
    let at = 0;
    if (parts[at]?.local === "rPr") checkRunProperties(parts[at++] as XmlElement);
    const t = parts[at++];
    if (t === undefined) fail("XLSX_CELL_MALFORMED");
    if (t.local !== "t") misplaced(t);
    if (at !== parts.length) misplaced(parts[at] as XmlElement);
    out += textElement(t);
  }
  return out;
}

/** The shared-string table: `<sst>` holds `<si>` items only, each checked like `<is>`. */
function sharedStrings(sst: XmlElement): string[] {
  return structuralChildren(sst).map((si) => (si.local === "si" ? stringItem(si) : misplaced(si)));
}

/** A cell's parts, after its shape has been checked. */
interface CellParts {
  readonly t: string;
  readonly f: XmlElement | undefined;
  readonly v: string | undefined;
  readonly is: XmlElement | undefined;
}

/**
 * `<c>`: attributes `r`, `s`, `t` only; children `<f>?`, `<v>?`, `<is>?`, in that order, at
 * most one each. `<is>` only on an `inlineStr` cell with no `<f>` or `<v>`, and no `<v>` on
 * an `inlineStr` cell.
 */
function cellParts(c: XmlElement): CellParts {
  onlyAttrs(c, CELL_ATTRS);
  const t = c.attrs.get("t") ?? "n";
  let f: XmlElement | undefined;
  let v: string | undefined;
  let is: XmlElement | undefined;
  let stage = 0;
  for (const k of structuralChildren(c)) {
    const order = k.local === "f" ? 1 : k.local === "v" ? 2 : k.local === "is" ? 3 : 0;
    if (order === 0) misplaced(k);
    if (order <= stage) fail("XLSX_CELL_MALFORMED");
    stage = order;
    if (order === 1) {
      textOnly(k);
      f = k;
    } else if (order === 2) {
      onlyAttrs(k, NO_ATTRS);
      v = textOnly(k);
    } else is = k;
  }
  if (is !== undefined && (t !== "inlineStr" || f !== undefined || v !== undefined))
    fail("XLSX_CELL_MALFORMED");
  if (t === "inlineStr" && v !== undefined) fail("XLSX_CELL_MALFORMED");
  return { t, f, v, is };
}

const MAX_COL = 16_384;
const MAX_ROW = 1_048_576;

/** "B3" -> [row, col], 0-based; refuses anything outside the sheet grid. */
function parseCellRef(ref: string): [number, number] {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (!m) fail("XLSX_CELL_MALFORMED");
  let col = 0;
  for (const ch of m[1] as string) col = col * 26 + ch.charCodeAt(0) - 64;
  const row = Number(m[2]);
  if (col > MAX_COL || row > MAX_ROW) fail("XLSX_CELL_MALFORMED");
  return [row - 1, col - 1];
}

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
function readSheetCells(
  sheet: XmlElement,
  shared: readonly string[],
  styles: readonly NumberClass[],
  system: 1900 | 1904,
): Record<string, string> {
  const sheetDataList = elements(sheet, "sheetData");
  if (sheetDataList.length !== 1) fail("XLSX_NOT_WORKBOOK");
  const sheetData = sheetDataList[0] as XmlElement;
  const cells: Record<string, string> = {};
  const seen = new Set<string>();
  let [minR, minC, maxR, maxC] = [Infinity, Infinity, -1, -1];
  // sheetData -> row* -> c*: every element below is checked against the allowlist, so no
  // cell can hide in an element the reader skips.
  for (const row of structuralChildren(sheetData)) {
    if (row.local !== "row") misplaced(row);
    const rowAttr = row.attrs.get("r");
    for (const c of structuralChildren(row)) {
      if (c.local !== "c") misplaced(c);
      const ref = c.attrs.get("r");
      if (ref === undefined) fail("XLSX_CELL_MALFORMED");
      const [r, col] = parseCellRef(ref);
      if (rowAttr !== undefined && String(r + 1) !== rowAttr) fail("XLSX_CELL_MALFORMED");
      const key = cellRef(r, col);
      if (seen.has(key)) fail("XLSX_CELL_MALFORMED");
      seen.add(key);
      [minR, minC, maxR, maxC] = [
        Math.min(minR, r),
        Math.min(minC, col),
        Math.max(maxR, r),
        Math.max(maxC, col),
      ];
      const value = cellValue(c, shared, styles, system);
      if (value !== "") cells[key] = value;
    }
  }
  // <dimension> must be the range LibreOffice writes for these cells ("A1" when there are
  // none): a huge or stale dimension is not its output.
  const dims = elements(sheet, "dimension");
  if (dims.length > 1) fail("XLSX_CELL_MALFORMED");
  if (dims.length === 1) {
    const want =
      maxR < 0
        ? "A1"
        : minR === maxR && minC === maxC
          ? cellRef(minR, minC)
          : `${cellRef(minR, minC)}:${cellRef(maxR, maxC)}`;
    if ((dims[0] as XmlElement).attrs.get("ref") !== want) fail("XLSX_CELL_MALFORMED");
  }
  return cells;
}

/**
 * One cell in the gate's cell model ("" = empty). A formula cell is a formula marker that
 * carries the formula and its cached value: it never equals a literal expected cell, so a
 * formula the pristine fixture does not hold (in the target or anywhere else) is refuted,
 * as the independent grader fails it (round 2, D2). Formulas are never evaluated.
 */
function cellValue(
  c: XmlElement,
  shared: readonly string[],
  styles: readonly NumberClass[],
  system: 1900 | 1904,
): string {
  const parts = cellParts(c);
  const value = literalValue(c, parts, shared, styles, system);
  if (parts.f === undefined) return value;
  const fAttrs = [...parts.f.attrs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${MARKERS.formula}${JSON.stringify([fAttrs, textOnly(parts.f), parts.t, value])}`;
}

/** A shared-string index: a canonical decimal (no sign, no leading zero, no space). */
const SHARED_INDEX = /^(?:0|[1-9][0-9]{0,8})$/;

/** A cell's value as a literal: its stored (for a formula, cached) value, rendered. */
function literalValue(
  c: XmlElement,
  { t, f, v, is }: CellParts,
  shared: readonly string[],
  styles: readonly NumberClass[],
  system: 1900 | 1904,
): string {
  // A formula with no cached value: the gate cannot know what the document holds without
  // evaluating it, which it never does.
  if (f !== undefined && v === undefined) fail("XLSX_FORMULA_UNCACHED");
  const sRaw = c.attrs.get("s") ?? "0";
  // A canonical index, as LibreOffice writes it (no leading zero: s="00" is refused).
  if (!/^(?:0|[1-9]\d{0,5})$/.test(sRaw)) fail("XLSX_STYLE_MALFORMED");
  const style = styles[Number(sRaw)];
  if (style === undefined && sRaw !== "0") fail("XLSX_STYLE_MALFORMED");
  switch (t) {
    case "s": {
      if (v === undefined) return "";
      if (!SHARED_INDEX.test(v)) fail("XLSX_CELL_MALFORMED");
      const text = shared[Number(v)];
      if (text === undefined) fail("XLSX_CELL_MALFORMED");
      return text;
    }
    case "inlineStr":
      return is === undefined ? "" : stringItem(is);
    case "str":
      // A formula's string result: LibreOffice never writes t="str" without the formula.
      if (f === undefined) fail("XLSX_CELL_MALFORMED");
      return v ?? "";
    case "b":
      if (v === undefined) return "";
      if (v !== "0" && v !== "1") fail("XLSX_CELL_MALFORMED");
      return MARKERS.boolean;
    case "e":
      return MARKERS.error;
    case "d":
      // LibreOffice never writes t="d" (it stores a date as a styled number). #503 read an ISO
      // day here and verified it while the grader called the cell ungradable: refused.
      return fail("XLSX_CELL_MALFORMED");
    case "n": {
      if (v === undefined || v === "") return "";
      if (!NUMBER.test(v)) fail("XLSX_CELL_MALFORMED");
      const value = Number(v);
      if (!Number.isFinite(value)) fail("XLSX_CELL_MALFORMED");
      // The canonical spelling only (LibreOffice writes `4242`, never `04242` or `4.242E3`).
      if (String(value) !== v) fail("XLSX_CELL_MALFORMED");
      return renderNumber(value, style ?? { kind: "general" }, system);
    }
    default:
      fail("XLSX_CELL_MALFORMED");
  }
}

// ---------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------

/** A saved workbook in the gate's cell model. */
export interface XlsxDocument {
  /** Non-empty cells of the first worksheet, by A1 ref, in the CSV path's cell model. */
  readonly cells: Readonly<Record<string, string>>;
  /** Sheets in the workbook (worksheets, chart sheets, dialog sheets). */
  readonly sheetCount: number;
}

/**
 * Read a workbook's bytes into the gate's cell model. Throws `XlsxError` (a code only) on
 * anything malformed, truncated, encrypted, oversized, active or of an unexpected type.
 */
export function readXlsxDocument(bytes: Uint8Array): XlsxDocument {
  const entries = readZipEntries(bytes);
  const typesBytes = entries.get("[Content_Types].xml");
  if (!typesBytes) fail("XLSX_NOT_WORKBOOK");
  refuseActiveNames(entries);
  // LibreOffice's fixed part names only (see xlsx-parts.ts); no other entry is looked at.
  const partsRefusal = checkPartNames(entries.keys());
  if (partsRefusal) fail(partsRefusal);
  // Raw-byte pre-scan of EVERY part, before any XML parsing (see xlsx-prescan.ts). Every
  // entry the part-name check lets through is an XML part.
  for (const [name, data] of entries) {
    const refusal = prescanXmlPart(data, contentKindOf(name));
    if (refusal) fail(refusal);
  }
  refuseExternalTargets(entries);
  const types = rootIn(parseXml(typesBytes), NS.types, "Types");
  for (const node of [...elements(types, "Override"), ...elements(types, "Default")]) {
    const ct = node.attrs.get("ContentType")?.toLowerCase() ?? "";
    if (ct.includes("macroenabled") || ct.includes("vbaproject")) fail("XLSX_MACROS");
  }

  const office = [...relationships(entries, "").values()].filter(
    (r) => r.type === REL_TYPE.officeDocument,
  );
  if (office.length !== 1) fail("XLSX_NOT_WORKBOOK");
  const workbookName = (office[0] as Relationship).target;
  if (contentTypeOf(types, workbookName) !== WORKBOOK_CONTENT_TYPE) fail("XLSX_CONTENT_TYPE");
  const workbookBytes = entries.get(workbookName);
  if (!workbookBytes) fail("XLSX_NOT_WORKBOOK");
  const workbook = rootIn(parseXml(workbookBytes), NS.main, "workbook");
  const rels = relationships(entries, workbookName);

  const pr = child(workbook, "workbookPr")?.attrs.get("date1904");
  let system: 1900 | 1904;
  if (pr === undefined || pr === "0" || pr === "false") system = 1900;
  else if (pr === "1" || pr === "true") system = 1904;
  else fail("XLSX_NOT_WORKBOOK");

  const sheetsEls = elements(workbook, "sheets");
  if (sheetsEls.length !== 1) fail("XLSX_NOT_WORKBOOK");
  const sheets = elements(sheetsEls[0] as XmlElement, "sheet");
  if (sheets.length === 0) fail("XLSX_NOT_WORKBOOK");
  // No sheet may hide elsewhere (for example inside an mc:AlternateContent branch).
  if (countNamed(workbook, "sheet") !== sheets.length) fail("XLSX_XML_UNSUPPORTED");
  const sheetRels = sheets.map((s) => {
    // r:id is in the relationships namespace, under whatever prefix is in scope at the
    // <sheet> (declared on the root, on <sheets>, or on the <sheet> itself, as openpyxl does).
    const id = nsAttr(s, NS.rel, "id");
    const rel = id === undefined ? undefined : rels.get(id);
    if (!rel) fail("XLSX_NOT_WORKBOOK");
    if (rel.type.endsWith("/macrosheet") || rel.type.endsWith("/xlMacrosheet")) fail("XLSX_MACROS");
    return rel;
  });
  const relsRefusal = checkRelationships({
    names: entries.keys(),
    rootRels: rawRelationships(entries.get("_rels/.rels")),
    workbookRels: rawRelationships(entries.get("xl/_rels/workbook.xml.rels")),
    sheetIds: sheets.map((s) => s.attrs.get("r:id")),
    overrides: elements(types, "Override").map((o) => o.attrs.get("PartName")),
  });
  if (relsRefusal) fail(relsRefusal);
  const first = sheetRels[0] as Relationship;
  if (first.type !== REL_TYPE.worksheet) fail("XLSX_NOT_WORKBOOK");

  const sharedRel = [...rels.values()].filter((r) => r.type === REL_TYPE.sharedStrings);
  const stylesRel = [...rels.values()].filter((r) => r.type === REL_TYPE.styles);
  if (sharedRel.length > 1 || stylesRel.length > 1) fail("XLSX_NOT_WORKBOOK");
  const part = (rel: Relationship | undefined) => {
    if (!rel) return undefined;
    const b = entries.get(rel.target);
    if (!b) fail("XLSX_NOT_WORKBOOK");
    return parseXml(b);
  };
  const sstXml = part(sharedRel[0]);
  const shared = sstXml ? sharedStrings(rootIn(sstXml, NS.main, "sst")) : [];
  const stylesXml = part(stylesRel[0]);
  const styles = readStyles(stylesXml ? rootIn(stylesXml, NS.main, "styleSheet") : undefined);

  const sheetXml = part(first) as XmlElement;
  const cells = readSheetCells(rootIn(sheetXml, NS.main, "worksheet"), shared, styles, system);
  return { cells, sheetCount: sheets.length };
}
