/**
 * Raw-byte pre-scan of an xlsx XML part (TIF-274 prerequisite, replaces #503's D8 gap).
 *
 * #503 checked its allowlist on the PARSED tree. By then comments were gone, quoting and
 * whitespace inside tags were normalised, and namespace prefixes were resolved, so the gate
 * verified workbooks that a literal, regex-based reader (the independent grader) reads
 * differently. This module looks at the BYTES of every XML part BEFORE any parsing, and
 * accepts only the narrow serialisation LibreOffice Calc writes. Anything else is refused
 * with a code (the gate turns it into `uncertain` STATE_CORRUPT; never verified).
 *
 * It never emulates an XML reader: it is a strict, byte-level grammar. Bytes >= 0x80 (UTF-8
 * continuation and lead bytes) never collide with the ASCII delimiters it looks at, so it
 * works on the raw bytes without decoding them.
 *
 * Accepted byte grammar (derived from LibreOffice 24.2.7.2 `soffice --convert-to xlsx`
 * output; see docs/gate/xlsx-byte-grammar.md and test/fixtures/calc-xlsx-writers/):
 *
 *   part    := DECL LF? content
 *   DECL    := '<?xml version="1.0" encoding="UTF-8"?>'
 *            | '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
 *   content := ( text | open | close )*            exactly one root element, LF-only text
 *                                                  outside it
 *   text    := ( any byte except '<' '>' '&' | REF )*
 *   REF     := '&amp;' | '&lt;' | '&gt;' | '&quot;' | '&apos;'
 *   open    := '<' QNAME ( ' ' QNAME '="' value '"' )* ( '>' | '/>' )
 *   close   := '</' QNAME '>'
 *   value   := ( any byte except '"' '<' '>' '&' | REF )*
 *   QNAME   := NAME ( ':' NAME )?      NAME := [A-Za-z_] [A-Za-z0-9_.-]*
 *
 * and, in a <v> element, no '&' at all. In the PINNED parts, no text directly inside a
 * structure element (sheetData, row, c, is, si, r, rPr, sst, sheets, Relationships, Types;
 * the one LF LibreOffice writes before `</Types>` and `</Relationships>` aside), and no
 * self-closing <v/> or <t/>. In the PINNED parts (workbook, worksheet, shared
 * strings, styles, content types, relationships), also: the root element carries exactly LibreOffice's namespace
 * declarations, in LibreOffice's order; no other element declares a namespace; no element
 * name carries a prefix and no attribute carries one other than `r:id` on <sheet> and
 * `xml:space` on <t>, except inside a workbook, worksheet or styles <extLst> (where
 * LibreOffice writes `loext:`). docProps and the theme get the generic grammar only: no
 * reader looks inside them.
 */

/** Why the pre-scan refused a part. Codes only: never a path, never a value. */
export type PrescanCode =
  | "XLSX_PRESCAN_DECL"
  | "XLSX_PRESCAN_COMMENT"
  | "XLSX_PRESCAN_CDATA"
  | "XLSX_PRESCAN_DTD"
  | "XLSX_PRESCAN_PI"
  | "XLSX_PRESCAN_QUOTE"
  | "XLSX_PRESCAN_TAG_SPACE"
  | "XLSX_PRESCAN_NAMESPACE"
  | "XLSX_PRESCAN_ENTITY"
  | "XLSX_PRESCAN_TEXT"
  | "XLSX_PRESCAN_SYNTAX";

/** The parts whose element and namespace shape is pinned, beyond the generic grammar. */
export type ContentPartKind = "workbook" | "worksheet" | "sst" | "styles" | "types" | "rels";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * Root element and its namespace declarations, exactly as LibreOffice writes them, in order.
 * Any other declaration (an extra prefix, a missing one, a different URI) is refused.
 */
export const LO_ROOTS: Readonly<
  Record<ContentPartKind, { readonly root: string; readonly xmlns: readonly [string, string][] }>
> = {
  workbook: {
    root: "workbook",
    xmlns: [
      ["xmlns", MAIN],
      ["xmlns:r", REL],
    ],
  },
  worksheet: {
    root: "worksheet",
    xmlns: [
      ["xmlns", MAIN],
      ["xmlns:r", REL],
      ["xmlns:xdr", "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"],
      ["xmlns:x14", "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"],
      ["xmlns:xr2", "http://schemas.microsoft.com/office/spreadsheetml/2015/revision2"],
      ["xmlns:mc", "http://schemas.openxmlformats.org/markup-compatibility/2006"],
    ],
  },
  sst: { root: "sst", xmlns: [["xmlns", MAIN]] },
  styles: { root: "styleSheet", xmlns: [["xmlns", MAIN]] },
  types: {
    root: "Types",
    xmlns: [["xmlns", "http://schemas.openxmlformats.org/package/2006/content-types"]],
  },
  rels: {
    root: "Relationships",
    xmlns: [["xmlns", "http://schemas.openxmlformats.org/package/2006/relationships"]],
  },
};

/** The one namespace declaration LibreOffice writes below a root: on <ext> in an <extLst>. */
const EXT_XMLNS: readonly [string, string] = ["xmlns:loext", "http://schemas.libreoffice.org/"];

/**
 * Structure elements of the pinned parts: LibreOffice writes no text at all directly inside
 * them (not even whitespace), so any is refused (the grader and the gate would each have to
 * decide what it means).
 */
const STRUCTURAL: ReadonlySet<string> = new Set([
  "sheetData",
  "row",
  "c",
  "is",
  "si",
  "r",
  "rPr",
  "sst",
  "sheets",
  "Relationships",
  "Types",
]);
/** Elements LibreOffice never writes self-closing (an empty value or text). */
const NEVER_EMPTY: ReadonlySet<string> = new Set(["v", "t"]);

/** Prefixed attributes allowed outside an <extLst>, by element. */
const PREFIXED_ATTRS: Readonly<Record<string, string>> = { "r:id": "sheet", "xml:space": "t" };

const DECLS = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
].map((d) => Uint8Array.from(d, (c) => c.charCodeAt(0)));

const REFS = ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"].map((r) =>
  Uint8Array.from(r, (c) => c.charCodeAt(0)),
);

const LT = 0x3c; // <
const GT = 0x3e; // >
const AMP = 0x26; // &
const QUOT = 0x22; // "
const APOS = 0x27; // '
const SLASH = 0x2f; // /
const EQ = 0x3d; // =
const SP = 0x20;
const LF = 0x0a;
const COLON = 0x3a;

function startsWith(bytes: Uint8Array, at: number, lit: string): boolean {
  if (at + lit.length > bytes.length) return false;
  for (let k = 0; k < lit.length; k++) if (bytes[at + k] !== lit.charCodeAt(k)) return false;
  return true;
}

function matchesAt(bytes: Uint8Array, at: number, lit: Uint8Array): boolean {
  if (at + lit.length > bytes.length) return false;
  for (let k = 0; k < lit.length; k++) if (bytes[at + k] !== lit[k]) return false;
  return true;
}

const isNameStart = (b: number) =>
  (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f;
const isNameChar = (b: number) =>
  isNameStart(b) || (b >= 0x30 && b <= 0x39) || b === 0x2e || b === 0x2d;
const isSpace = (b: number | undefined) => b === SP || b === 0x09 || b === LF || b === 0x0d;

class Refusal {
  constructor(readonly code: PrescanCode) {}
}
function refuse(code: PrescanCode): never {
  throw new Refusal(code);
}

/** The length of the predefined escape at `at` (which holds '&'), or refuse. */
function refAt(bytes: Uint8Array, at: number): number {
  for (const ref of REFS) if (matchesAt(bytes, at, ref)) return ref.length;
  return refuse("XLSX_PRESCAN_ENTITY");
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let k = from; k < to; k++) s += String.fromCharCode(bytes[k] as number);
  return s;
}

/** Read a QNAME at `at`; returns [name, end]. Refuses anything that is not one. */
function qname(bytes: Uint8Array, at: number): [string, number] {
  let i = at;
  if (!isNameStart(bytes[i] ?? -1)) refuse("XLSX_PRESCAN_SYNTAX");
  while (isNameChar(bytes[i] ?? -1)) i++;
  if (bytes[i] === COLON) {
    i++;
    if (!isNameStart(bytes[i] ?? -1)) refuse("XLSX_PRESCAN_SYNTAX");
    while (isNameChar(bytes[i] ?? -1)) i++;
  }
  return [ascii(bytes, at, i), i];
}

interface Frame {
  readonly name: string;
  readonly inExt: boolean;
}

function checkElementNamespaces(
  kind: ContentPartKind,
  name: string,
  attrs: readonly [string, string][],
  stack: readonly Frame[],
): boolean {
  const parent = stack[stack.length - 1];
  const inExt = parent?.inExt === true || name === "extLst";
  if (stack.length === 0) {
    const spec = LO_ROOTS[kind];
    if (name !== spec.root) refuse("XLSX_PRESCAN_NAMESPACE");
    const decls = attrs.filter(([n]) => n === "xmlns" || n.startsWith("xmlns:"));
    if (decls.length !== spec.xmlns.length) refuse("XLSX_PRESCAN_NAMESPACE");
    decls.forEach(([n, v], k) => {
      const [en, ev] = spec.xmlns[k] as [string, string];
      if (n !== en || v !== ev) refuse("XLSX_PRESCAN_NAMESPACE");
    });
    for (const [n] of attrs)
      if (n.includes(":") && !n.startsWith("xmlns:")) refuse("XLSX_PRESCAN_NAMESPACE");
    return false;
  }
  if (name.includes(":") && (!inExt || kind === "sst" || kind === "types" || kind === "rels"))
    refuse("XLSX_PRESCAN_NAMESPACE");
  for (const [n, v] of attrs) {
    if (n === "xmlns" || n.startsWith("xmlns:")) {
      const allowed =
        kind === "workbook" &&
        name === "ext" &&
        parent?.name === "extLst" &&
        n === EXT_XMLNS[0] &&
        v === EXT_XMLNS[1];
      if (!allowed) refuse("XLSX_PRESCAN_NAMESPACE");
    } else if (n.includes(":") && !inExt && PREFIXED_ATTRS[n] !== name) {
      refuse("XLSX_PRESCAN_NAMESPACE");
    }
  }
  return inExt;
}

function scan(bytes: Uint8Array, kind: ContentPartKind | undefined): void {
  let i = -1;
  for (const decl of DECLS) if (matchesAt(bytes, 0, decl)) i = decl.length;
  if (i < 0) {
    if (startsWith(bytes, 0, "<?") && !startsWith(bytes, 0, "<?xml ")) refuse("XLSX_PRESCAN_PI");
    refuse("XLSX_PRESCAN_DECL");
  }
  const stack: Frame[] = [];
  let rootSeen = false;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    if (b !== LT) {
      // Text. Outside the root only LFs (LibreOffice writes one after the declaration and,
      // in the package parts, one before the closing tag).
      if (stack.length === 0 && b !== LF) refuse("XLSX_PRESCAN_SYNTAX");
      if (kind && STRUCTURAL.has(stack[stack.length - 1]?.name ?? "")) {
        // LibreOffice ends [Content_Types].xml and the .rels parts with "\n</Root>": that
        // one LF before the root's closing tag is the only text it writes in a structure.
        const closesRoot =
          b === LF && stack.length === 1 && bytes[i + 1] === LT && bytes[i + 2] === SLASH;
        if (!closesRoot) refuse("XLSX_PRESCAN_TEXT");
      }
      if (b === GT) refuse("XLSX_PRESCAN_SYNTAX");
      if (b === AMP) {
        // In <v> (a number, a shared-string index, a boolean, an error), no reference at all.
        if (stack[stack.length - 1]?.name === "v") refuse("XLSX_PRESCAN_ENTITY");
        i += refAt(bytes, i);
        continue;
      }
      i++;
      continue;
    }
    if (startsWith(bytes, i, "<!--")) refuse("XLSX_PRESCAN_COMMENT");
    if (startsWith(bytes, i, "<![CDATA[")) refuse("XLSX_PRESCAN_CDATA");
    if (startsWith(bytes, i, "<!")) refuse("XLSX_PRESCAN_DTD");
    if (startsWith(bytes, i, "<?")) refuse("XLSX_PRESCAN_PI");
    if (bytes[i + 1] === SLASH) {
      const [name, end] = qname(bytes, i + 2);
      if (isSpace(bytes[end])) refuse("XLSX_PRESCAN_TAG_SPACE");
      if (bytes[end] !== GT) refuse("XLSX_PRESCAN_SYNTAX");
      const top = stack.pop();
      if (!top || top.name !== name) refuse("XLSX_PRESCAN_SYNTAX");
      i = end + 1;
      continue;
    }
    if (stack.length === 0 && rootSeen) refuse("XLSX_PRESCAN_SYNTAX");
    const [name, nameEnd] = qname(bytes, i + 1);
    let j = nameEnd;
    const attrs: [string, string][] = [];
    let selfClosing = false;
    for (;;) {
      const c = bytes[j];
      if (c === GT) {
        j++;
        break;
      }
      if (c === SLASH) {
        if (bytes[j + 1] !== GT) refuse("XLSX_PRESCAN_SYNTAX");
        selfClosing = true;
        j += 2;
        break;
      }
      // Exactly one space, then an attribute name. Whitespace before '>' or '/>', a run of
      // spaces, or a tab/CR/LF anywhere in a tag is not what LibreOffice writes.
      if (c !== SP) {
        if (isSpace(c)) refuse("XLSX_PRESCAN_TAG_SPACE");
        refuse("XLSX_PRESCAN_SYNTAX");
      }
      j++;
      if (!isNameStart(bytes[j] ?? -1)) {
        if (isSpace(bytes[j]) || bytes[j] === GT || bytes[j] === SLASH)
          refuse("XLSX_PRESCAN_TAG_SPACE");
        refuse("XLSX_PRESCAN_SYNTAX");
      }
      const [attr, attrEnd] = qname(bytes, j);
      j = attrEnd;
      if (isSpace(bytes[j])) refuse("XLSX_PRESCAN_TAG_SPACE");
      if (bytes[j] !== EQ) refuse("XLSX_PRESCAN_SYNTAX");
      j++;
      if (isSpace(bytes[j])) refuse("XLSX_PRESCAN_TAG_SPACE");
      if (bytes[j] === APOS) refuse("XLSX_PRESCAN_QUOTE");
      if (bytes[j] !== QUOT) refuse("XLSX_PRESCAN_SYNTAX");
      j++;
      const valueStart = j;
      for (;;) {
        const v = bytes[j];
        if (v === undefined || v === LT || v === GT) refuse("XLSX_PRESCAN_SYNTAX");
        if (v === QUOT) break;
        if (v === AMP) j += refAt(bytes, j);
        else j++;
      }
      attrs.push([attr, ascii(bytes, valueStart, j)]);
      j++;
    }
    let inExt = false;
    if (kind) inExt = checkElementNamespaces(kind, name, attrs, stack);
    if (kind && selfClosing && NEVER_EMPTY.has(name)) refuse("XLSX_PRESCAN_SYNTAX");
    if (stack.length === 0) rootSeen = true;
    if (!selfClosing) stack.push({ name, inExt });
    i = j;
  }
  if (stack.length > 0 || !rootSeen) refuse("XLSX_PRESCAN_SYNTAX");
}

/**
 * Pre-scan one XML part's raw bytes. Returns `undefined` when the bytes are in the accepted
 * grammar, or the refusal code. `kind` pins the element and namespace shape of the content
 * parts; package parts (content types, relationships, docProps, theme) get the generic grammar.
 */
export function prescanXmlPart(bytes: Uint8Array, kind?: ContentPartKind): PrescanCode | undefined {
  try {
    scan(bytes, kind);
    return undefined;
  } catch (error) {
    if (error instanceof Refusal) return error.code;
    throw error;
  }
}

/** The pinned kind for an entry name at LibreOffice's fixed names, if it is one. */
export function contentKindOf(entryName: string): ContentPartKind | undefined {
  if (entryName === "[Content_Types].xml") return "types";
  if (entryName.endsWith(".rels")) return "rels";
  if (entryName === "xl/workbook.xml") return "workbook";
  if (entryName === "xl/sharedStrings.xml") return "sst";
  if (entryName === "xl/styles.xml") return "styles";
  if (/^xl\/worksheets\/sheet[1-9][0-9]*\.xml$/.test(entryName)) return "worksheet";
  return undefined;
}
