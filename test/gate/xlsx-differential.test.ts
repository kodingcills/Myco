/**
 * Requirement (d): a differential property test. From the REAL LibreOffice workbooks in
 * test/fixtures/calc-xlsx-writers/ (exact, roundtrip-exact, pristine, collateral), a seeded
 * generator builds many variants per mutation family, and every variant goes through both
 * judges: the gate (real read path) and the independent grader (its own reader). The
 * property, on every variant: gate VERIFIED implies grader PASS.
 *
 * Families: comments, quote style, whitespace in tags, namespace prefixes, entity
 * references, relocated parts, decoy parts, nested/duplicated text runs, v+is on one cell,
 * nested decoys (round 2: an in-grammar decoy element inside a random container element of
 * its part, the shape behind round 1's V1-V5), comment decoys (round 2, a byte-level family:
 * a decoy archive in the EOCD comment, between entries or in front, plain comments, stray
 * signatures, trailing bytes; round 1's V6), and a control family of in-grammar edits
 * (attribute order, rich-run splits) so the property is not vacuous: those still verify,
 * and the grader passes them. The two round-2 families also count how many variants fool
 * the grader (it does not pass a variant of a base it passes): they are live attacks.
 *
 * Round 3 (verdict 7204800200, D2) adds one family per value mechanism the tree pin does not
 * cover: attribute names (decoy names on a random element of any part, and a date1904-named
 * attribute on <workbookPr>: T3), multi-section format codes (T2), odd `<v>` contents in
 * every cell type (T1: "", " ", "+1", "1e3", "0x10", ".5", "1.", "-0", "Infinity", "NaN"
 * and spellings of the requested value), and boolean, error, inline-string and other
 * cell-type variants. 400 variants each over the 4 real bases, each live.
 *
 * Deterministic: a fixed seed per (family, base), so a failure names a reproducible variant.
 */
import { describe, expect, it } from "vitest";
import { writeZip } from "../../src/tasks/writer-docgen.ts";
import { gateOn, graderOn, loParts, MAIN } from "./xlsx-lo-mutate.ts";
import { writerBytes } from "./xlsx-writer-files.ts";
import { entryEnds, withComment, withCommentDecoy, withGap } from "./xlsx-zip-surgery.ts";

const BASES = [
  "exact.lo.xlsx",
  "roundtrip-exact.lo.xlsx",
  "pristine.lo.xlsx",
  "collateral.lo.xlsx",
];
/** Variants per (family, base). */
const PER = 100;

type Parts = [string, string][];
type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;

const SHEET = "xl/worksheets/sheet1.xml";
const SST = "xl/sharedStrings.xml";
const WORKBOOK = "xl/workbook.xml";
const WB_RELS = "xl/_rels/workbook.xml.rels";
const ROOT_RELS = "_rels/.rels";
const PINNED = [SHEET, SST, WORKBOOK, "xl/styles.xml", WB_RELS, ROOT_RELS, "[Content_Types].xml"];

const get = (parts: Parts, name: string) => parts.find(([n]) => n === name)?.[1] as string;
const set = (parts: Parts, name: string, text: string): Parts =>
  parts.some(([n]) => n === name)
    ? parts.map(([n, t]) => [n, n === name ? text : t])
    : [...parts, [name, text]];
const drop = (parts: Parts, name: string): Parts => parts.filter(([n]) => n !== name);
const zip = (parts: Parts) =>
  writeZip(parts.map(([name, text]) => ({ name, data: new TextEncoder().encode(text) })));

/** Every match of `re` in `text`, as [index, match]. */
function matches(text: string, re: RegExp): [number, RegExpExecArray][] {
  const out: [number, RegExpExecArray][] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (let m = g.exec(text); m; m = g.exec(text)) out.push([m.index, m]);
  return out;
}
const splice = (text: string, at: number, del: number, ins: string) =>
  text.slice(0, at) + ins + text.slice(at + del);

/** A random start tag (not the declaration) in a random pinned part. */
function randomTag(rng: Rng, parts: Parts, names = PINNED) {
  const name = pick(rng, names);
  const text = get(parts, name);
  const tags = matches(text, /<[A-Za-z][^<>]*>/);
  const [at, m] = pick(rng, tags);
  return { name, text, at, tag: m[0] };
}

/** A random cell element in the worksheet. */
function randomCell(rng: Rng, text: string, only?: RegExp) {
  const cells = matches(text, /<c r="([A-Z]+\d+)"[^>]*>(?:<v>[^<]*<\/v>)?<\/c>/).filter(
    ([, m]) => !only || only.test(m[0]),
  );
  return pick(rng, cells);
}

type Mutator = (rng: Rng, parts: Parts) => Parts;

const FAMILIES: Record<string, Mutator> = {
  comments(rng, parts) {
    const kind = pick(rng, ["tag-boundary", "in-text", "wrap-cell", "before-sheetData"]);
    if (kind === "in-text") {
      const name = pick(rng, [SHEET, SST]);
      const text = get(parts, name);
      const [at, m] = pick(rng, matches(text, /<(v|t)( [^>]*)?>([^<]+)</));
      const cut = at + m[0].indexOf(">") + 1 + Math.floor(rng() * ((m[3] as string).length + 1));
      return set(parts, name, splice(text, cut, 0, "<!-- x -->"));
    }
    if (kind === "wrap-cell") {
      const text = get(parts, SHEET);
      const [at, m] = randomCell(rng, text);
      return set(parts, SHEET, splice(text, at, m[0].length, `<!--${m[0]}-->`));
    }
    if (kind === "before-sheetData") {
      const text = get(parts, SHEET);
      return set(
        parts,
        SHEET,
        text.replace("<sheetData>", '<!--<sheetData><row r="1"/></sheetData>--><sheetData>'),
      );
    }
    const { name, text, at } = randomTag(rng, parts);
    return set(parts, name, splice(text, at, 0, "<!---->"));
  },

  quoteStyle(rng, parts) {
    const { name, text, at, tag } = randomTag(rng, parts);
    const attrs = matches(tag, / ([A-Za-z:]+)="([^"]*)"/);
    if (attrs.length === 0) return set(parts, name, splice(text, at + tag.length - 1, 0, " a='1'"));
    const [aAt, a] = pick(rng, attrs);
    const quoted = ` ${a[1]}='${a[2]}'`;
    return set(parts, name, splice(text, at + aAt, a[0].length, quoted));
  },

  whitespaceInTags(rng, parts) {
    const { name, text, at, tag } = randomTag(rng, parts);
    const ws = pick(rng, [" ", "\t", "\n", "\r\n", "  "]);
    const where = pick(rng, ["before-close", "between-attrs", "around-eq", "close-tag"]);
    if (where === "close-tag") {
      const closes = matches(text, /<\/[A-Za-z:]+>/);
      const [cAt, c] = pick(rng, closes);
      return set(parts, name, splice(text, cAt + c[0].length - 1, 0, ws));
    }
    if (where === "around-eq") {
      const eq = tag.indexOf("=");
      if (eq > 0) return set(parts, name, splice(text, at + eq + (rng() < 0.5 ? 0 : 1), 0, ws));
    }
    if (where === "between-attrs") {
      const sp = tag.indexOf(" ");
      if (sp > 0)
        return set(
          parts,
          name,
          splice(text, at + sp, 1, ` ${ws}`.slice(0, 1) === " " && ws === " " ? "  " : ws),
        );
    }
    const end = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1;
    return set(parts, name, splice(text, at + end, 0, ws));
  },

  namespacePrefixes(rng, parts) {
    const kind = pick(rng, [
      "prefix-cell",
      "prefix-v",
      "prefix-si",
      "xmlns-on-element",
      "root-extra",
      "root-drop",
    ]);
    if (kind === "prefix-cell") {
      const text = get(parts, SHEET);
      const [at, m] = randomCell(rng, text);
      const prefixed = m[0]
        .replace("<c ", `<x:c xmlns:x="${MAIN}" `)
        .replace("</c>", "</x:c>")
        .replace(/<(\/?)v>/g, "<$1x:v>");
      return set(parts, SHEET, splice(text, at, m[0].length, prefixed));
    }
    if (kind === "prefix-v") {
      const text = get(parts, SHEET);
      const [at, m] = randomCell(rng, text, /<v>/);
      const v = m[0].replace("<v>", `<x:v xmlns:x="${MAIN}">`).replace("</v>", "</x:v>");
      return set(parts, SHEET, splice(text, at, m[0].length, v));
    }
    if (kind === "prefix-si") {
      const text = get(parts, SST);
      const [at, m] = pick(rng, matches(text, /<si>(.*?)<\/si>/));
      const si = `<x:si xmlns:x="${MAIN}">${(m[1] as string).replace(/<(\/?)t\b/g, "<$1x:t")}</x:si>`;
      return set(parts, SST, splice(text, at, m[0].length, si));
    }
    if (kind === "xmlns-on-element") {
      const { name, text, at, tag } = randomTag(rng, parts, [SHEET, SST, WORKBOOK]);
      const decl = pick(rng, [' xmlns:q="urn:q"', ` xmlns="${MAIN}"`, ' xmlns="urn:other"']);
      const end = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1;
      return set(parts, name, splice(text, at + end, 0, decl));
    }
    const name = pick(rng, [SHEET, SST, WORKBOOK]);
    const text = get(parts, name);
    if (kind === "root-extra")
      return set(parts, name, text.replace(`xmlns="${MAIN}"`, `xmlns="${MAIN}" xmlns:x="${MAIN}"`));
    return set(
      parts,
      name,
      text.replace(/ xmlns:[a-z0-9]+="[^"]*"/, "").replace(`xmlns="${MAIN}" `, ""),
    );
  },

  entityReferences(rng, parts) {
    const name = pick(rng, [SHEET, SST, SHEET]);
    const text = get(parts, name);
    const [at, m] = pick(rng, matches(text, /<(v|t)( [^>]*)?>([^<&]+)</));
    const body = m[3] as string;
    const k = Math.floor(rng() * body.length);
    const ch = body.charCodeAt(k);
    const ref = pick(rng, [`&#${ch};`, `&#x${ch.toString(16)};`, `&#0${ch};`, "&amp;", "&custom;"]);
    const start = at + m[0].indexOf(">") + 1;
    return set(parts, name, splice(text, start + k, 1, ref));
  },

  relocatedParts(rng, parts) {
    const which = pick(rng, ["sst", "styles", "workbook", "sheet"]);
    const leaveDecoy = rng() < 0.5;
    const tweak = (t: string) => (rng() < 0.5 ? t : t.replace(/<v>(\d+)<\/v>/, "<v>0</v>"));
    if (which === "workbook") {
      const to = pick(rng, ["xl/wb2.xml", "xl/workbook2.xml", "workbook.xml"]);
      let next = set(
        parts,
        ROOT_RELS,
        get(parts, ROOT_RELS).replace('Target="xl/workbook.xml"', `Target="${to}"`),
      );
      next = set(next, to, get(parts, WORKBOOK));
      return leaveDecoy ? next : drop(next, WORKBOOK);
    }
    const where: Record<string, [string, string]> = {
      sst: [SST, "sharedStrings.xml"],
      styles: ["xl/styles.xml", "styles.xml"],
      sheet: [SHEET, "worksheets/sheet1.xml"],
    };
    const [from, rel] = where[which] as [string, string];
    const to = pick(rng, [
      "ss2.xml",
      "worksheets/sheet2.xml",
      "strings/x.xml",
      `/${from}`,
      `./${rel}`,
    ]);
    let next = set(
      parts,
      WB_RELS,
      get(parts, WB_RELS).replace(`Target="${rel}"`, `Target="${to}"`),
    );
    const toName = to.startsWith("/") ? to.slice(1) : to.startsWith("./") ? from : `xl/${to}`;
    next = set(next, toName, get(parts, from));
    if (toName !== from)
      next = leaveDecoy ? set(next, from, tweak(get(parts, from))) : drop(next, from);
    return next;
  },

  decoyParts(rng, parts) {
    const name = pick(rng, [
      "xl/worksheets/sheet2.xml",
      "xl/sharedStrings2.xml",
      "xl/worksheets/_rels/sheet1.xml.rels",
      "docProps/custom.xml",
      "xl/workbook.xml.bak",
      "xl/media/image1.png",
      "customXml/item1.xml",
    ]);
    const source = pick(rng, [SHEET, SST, WORKBOOK]);
    let next = set(parts, name, get(parts, source));
    if (name === "xl/worksheets/sheet2.xml" && rng() < 0.5) {
      // With a relationship but no <sheet>, or a <sheet> too (a real second sheet).
      next = set(
        next,
        WB_RELS,
        get(next, WB_RELS).replace(
          "\n</Relationships>",
          `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>\n</Relationships>`,
        ),
      );
      if (rng() < 0.5)
        next = set(
          next,
          WORKBOOK,
          get(next, WORKBOOK).replace(
            "</sheets>",
            '<sheet name="d" sheetId="2" state="visible" r:id="rId9"/></sheets>',
          ),
        );
    }
    if (rng() < 0.3) {
      next = set(
        next,
        "[Content_Types].xml",
        get(next, "[Content_Types].xml").replace(
          "\n</Types>",
          `<Override PartName="/${name}" ContentType="application/xml"/>\n</Types>`,
        ),
      );
    }
    return next;
  },

  textRuns(rng, parts) {
    const text = get(parts, SST);
    const [at, m] = pick(rng, matches(text, /<si><t xml:space="preserve">([^<]*)<\/t><\/si>/));
    const s = m[1] as string;
    const cut = Math.floor(rng() * (s.length + 1));
    const t = (x: string) => `<t xml:space="preserve">${x}</t>`;
    const kind = pick(rng, [
      "two-t",
      "nested-t",
      "t-and-r",
      "r-in-t",
      "split-runs-dup",
      "empty-si",
    ]);
    const si = {
      "two-t": `<si>${t(s.slice(0, cut))}${t(s.slice(cut))}</si>`,
      "nested-t": `<si><t xml:space="preserve">${s.slice(0, cut)}${t(s.slice(cut))}</t></si>`,
      "t-and-r": `<si>${t(s)}<r>${t("9")}</r></si>`,
      "r-in-t": `<si><t xml:space="preserve"><r>${t(s)}</r></t></si>`,
      "split-runs-dup": `<si><r>${t(s)}</r><r>${t(s)}</r></si>`,
      "empty-si": "<si></si>",
    }[kind] as string;
    return set(parts, SST, splice(text, at, m[0].length, si));
  },

  vPlusIs(rng, parts) {
    const text = get(parts, SHEET);
    const target = rng() < 0.6;
    const [at, m] = target
      ? (matches(text, /<c r="C4"[^>]*>(?:<v>[^<]*<\/v>)?<\/c>/)[0] as [number, RegExpExecArray])
      : randomCell(rng, text);
    const ref = m[1] ?? "C4";
    const value = pick(rng, ["4242", "9", ""]);
    const is = `<is><t>${value}</t></is>`;
    const s = / s="(\d+)"/.exec(m[0])?.[1] ?? "0";
    const v = /<v>([^<]*)<\/v>/.exec(m[0])?.[1] ?? "4242";
    const cell = pick(rng, [
      `<c r="${ref}" s="${s}" t="inlineStr"><v>${v}</v>${is}</c>`,
      `<c r="${ref}" s="${s}" t="inlineStr">${is}<v>${v}</v></c>`,
      `<c r="${ref}" s="${s}" t="n"><v>${v}</v>${is}</c>`,
      `<c r="${ref}" s="${s}" t="s"><v>${v}</v>${is}</c>`,
      `<c r="${ref}" s="${s}" t="inlineStr">${is}${is}</c>`,
    ]);
    return set(parts, SHEET, splice(text, at, m[0].length, cell));
  },

  /** In-grammar edits: they must not change either judge's reading. */
  control(rng, parts) {
    const kind = pick(rng, ["attr-order", "rich-split", "identity"]);
    if (kind === "attr-order") {
      const text = get(parts, SHEET);
      const [at, m] = randomCell(rng, text);
      const reordered = m[0].replace(
        /<c r="([A-Z]+\d+)" s="(\d+)" t="([a-z]+)">/,
        '<c t="$3" s="$2" r="$1">',
      );
      return set(parts, SHEET, splice(text, at, m[0].length, reordered));
    }
    if (kind === "rich-split") {
      const text = get(parts, SST);
      const [at, m] = pick(rng, matches(text, /<si><t xml:space="preserve">([^<]{2,})<\/t><\/si>/));
      const s = m[1] as string;
      const cut = 1 + Math.floor(rng() * (s.length - 1));
      const t = (x: string) => `<t xml:space="preserve">${x}</t>`;
      return set(
        parts,
        SST,
        splice(
          text,
          at,
          m[0].length,
          `<si><r>${t(s.slice(0, cut))}</r><r>${t(s.slice(cut))}</r></si>`,
        ),
      );
    }
    return parts;
  },
};

const OD = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const STYLES = "xl/styles.xml";
const TYPES = "[Content_Types].xml";

/** A copy of the part's own sheetData with C4 set to 1 (the edited cell, wrong). */
function sheetDataC4Wrong(sheet: string): string {
  const data = /<sheetData>[\s\S]*<\/sheetData>/.exec(sheet)?.[0] ?? "<sheetData/>";
  return data.replace(/(<c r="C4"[^>]*>)<v>[^<]*<\/v>/, "$1<v>1</v>");
}

/**
 * Round 2, nested decoys: in-grammar elements either reader reads structurally, each in the
 * part where the grader's whole-text regex would find it.
 */
const NESTED_DECOYS: [string, (parts: Parts) => string][] = [
  [SHEET, () => "<sheetData/>"],
  [SHEET, (p) => sheetDataC4Wrong(get(p, SHEET))],
  [SHEET, () => '<row r="4"><c r="C4" s="0" t="n"><v>1</v></c></row>'],
  [SHEET, () => '<c r="C4" s="0" t="n"><v>1</v></c>'],
  [WORKBOOK, () => '<workbookPr date1904="true"/>'],
  [WORKBOOK, () => '<sheets><sheet name="d" sheetId="1" state="visible" r:id="rId2"/></sheets>'],
  [WORKBOOK, () => '<sheet name="d" sheetId="9" state="visible" r:id="rId2"/>'],
  [STYLES, () => '<cellXfs count="1"><xf numFmtId="0"/></cellXfs>'],
  [STYLES, () => '<cellXfs count="0"></cellXfs>'],
  [STYLES, () => '<numFmt numFmtId="165" formatCode="0"/>'],
  [STYLES, () => '<numFmts count="1"><numFmt numFmtId="165" formatCode="0"/></numFmts>'],
  [STYLES, () => '<xf numFmtId="0"/>'],
  [SST, () => '<si><t xml:space="preserve">decoy</t></si>'],
  [WB_RELS, () => `<Relationship Id="rId3" Type="${OD}/worksheet" Target="styles.xml"/>`],
  [WB_RELS, () => `<Relationship Id="rId4" Type="${OD}/sharedStrings" Target="styles.xml"/>`],
  [TYPES, () => '<Override PartName="/xl/workbook.xml" ContentType="application/xml"/>'],
];

/** Round 2: put a decoy inside a random element of its part (start or end of its content). */
function nestedDecoys(rng: Rng, parts: Parts): Parts {
  const [name, make] = pick(rng, NESTED_DECOYS);
  const decoy = make(parts);
  const text = get(parts, name);
  const [at, m] = pick(rng, matches(text, /<([A-Za-z][A-Za-z0-9:]*)((?: [^<>]*?)?)(\/?)>/));
  const tag = m[0];
  const qname = m[1] as string;
  if (m[3] === "/") {
    // A self-closing container is opened up to hold the decoy.
    return set(
      parts,
      name,
      splice(text, at, tag.length, `${tag.slice(0, -2)}>${decoy}</${qname}>`),
    );
  }
  if (rng() < 0.5) return set(parts, name, splice(text, at + tag.length, 0, decoy));
  // Before the matching end tag (the first one after the start tag: the containers here do
  // not nest an element of their own name).
  const close = text.indexOf(`</${qname}>`, at);
  return set(parts, name, splice(text, close, 0, decoy));
}

// ---------------------------------------------------------------------------
// Round 3 (verdict 7204800200, D2): one family per value mechanism the grader derives that
// the element-tree pin does not cover. Each is live (many variants fool the grader on the
// bases it passes) and none may verify where the grader does not pass.
// ---------------------------------------------------------------------------

/** Every part of the base, pinned or not (docProps and the theme included). */
const allNames = (parts: Parts) => parts.map(([n]) => n);

/**
 * Attribute names to put on an element: names that end in date1904 after `-`/`.` (the
 * grader's `\bdate1904`), date1904 itself, every attribute name the grader reads (`r`, `s`,
 * `t`, `numFmtId`, `formatCode`, `Id`, `Target`, `r:id`), lookalikes, and plain unknowns.
 */
const ATTR_NAMES = [
  "x-date1904",
  "a.date1904",
  "x.y-date1904",
  "_-date1904",
  "date1904",
  "Date1904",
  "xdate1904",
  "r",
  "s",
  "t",
  "numFmtId",
  "formatCode",
  "Id",
  "Target",
  "Type",
  "r:id",
  "x-r",
  "a.s",
  "x-numFmtId",
  "count",
  "foo",
  "x14ac:dyDescent",
  "xr:uid",
];
const ATTR_VALUES = ["1", "true", "0", "14", "165", "C4", "rId2", "worksheets/sheet1.xml", ""];

/** An attribute (name, value) added to a random element of a random part, any part. */
function attributeNames(rng: Rng, parts: Parts): Parts {
  const name = pick(rng, allNames(parts));
  const text = get(parts, name);
  const [at, m] = pick(rng, matches(text, /<([A-Za-z][A-Za-z0-9:]*)((?: [^<>]*?)?)(\/?)>/));
  const tag = m[0];
  // workbookPr gets a date1904-named attribute half the time: the shape behind T3.
  const forced = name === WORKBOOK && rng() < 0.5;
  const workbookPr = matches(text, /<workbookPr\b[^>]*?(\/?)>/)[0];
  const [where, el] = forced && workbookPr ? workbookPr : [at, m];
  const attr = forced
    ? pick(rng, ["x-date1904", "a.date1904", "x.y-date1904", "date1904"])
    : pick(rng, ATTR_NAMES);
  const value = forced ? pick(rng, ["1", "true"]) : pick(rng, ATTR_VALUES);
  const elTag = el[0];
  const end = elTag.endsWith("/>") ? elTag.length - 2 : elTag.length - 1;
  // Before the existing attributes or after them.
  const head = elTag.indexOf(" ");
  const insertAt = rng() < 0.5 || head < 0 ? end : head;
  void tag;
  return set(parts, name, splice(text, where + insertAt, 0, ` ${attr}="${value}"`));
}

/** Format-code sections: plain numbers, dates (y, d), times, quoted/escaped/bracketed d. */
const SECTIONS = [
  "General",
  "0",
  "0.00",
  "#,##0",
  "[Red]0",
  "\\-0",
  "@",
  "yyyy\\-mm\\-dd",
  "d",
  "yy",
  "D",
  "[Red]yyyy",
  "mm",
  "h:mm",
  "[h]:mm",
  "&quot;d&quot;",
  "\\d",
  "[$-409]0",
  "[$$-409]#,##0.00",
  "",
];

/** A random numFmt's code replaced by a 1-4 section code (first section often the original). */
function formatSections(rng: Rng, parts: Parts): Parts {
  const text = get(parts, STYLES);
  const [at, m] = pick(rng, matches(text, /formatCode="([^"]*)"/));
  const n = 1 + Math.floor(rng() * 4);
  const sections = Array.from({ length: n }, () => pick(rng, SECTIONS));
  if (rng() < 0.5) sections[0] = m[1] as string;
  return set(parts, STYLES, splice(text, at, m[0].length, `formatCode="${sections.join(";")}"`));
}

/** `<v>` contents a numeric reading may take differently from the canonical spelling. */
const V_CONTENTS = [
  "",
  " ",
  "\n",
  "\t",
  "+1",
  "1e3",
  "1E3",
  "0x10",
  ".5",
  "1.",
  "-0",
  "Infinity",
  "-Infinity",
  "NaN",
  "4242",
  " 4242",
  "4242 ",
  "+4242",
  "04242",
  "4242.",
  "4242.0",
  "4.242e3",
  "4.242E+3",
  "0x1092",
  "0b1",
  "1_000",
  "true",
  "1",
  "0",
];

/** A random cell's (often the target's) `<v>` set to an odd content, its type kept or dropped. */
function vContents(rng: Rng, parts: Parts): Parts {
  const text = get(parts, SHEET);
  const t = pick(rng, [' t="n"', ' t="n"', "", ' t="b"', ' t="e"', ' t="s"']);
  if (rng() < 0.4) {
    // A NEW cell one column past the grid, where the pristine fixture holds nothing (the
    // shape of T1), with the dimension widened to match (or, sometimes, left stale).
    const [rowAt, row] = pick(rng, matches(text, /<row r="(\d+)"[^>]*>[\s\S]*?<\/row>/));
    const close = rowAt + row[0].length - "</row>".length;
    const v = rng() < 0.5 ? pick(rng, ["", " ", "\n", "\t"]) : pick(rng, V_CONTENTS);
    const added = splice(text, close, 0, `<c r="F${row[1]}" s="0"${t}><v>${v}</v></c>`);
    return set(
      parts,
      SHEET,
      rng() < 0.9
        ? added.replace(/<dimension ref="A1:[A-Z]+(\d+)"\/>/, '<dimension ref="A1:F$1"/>')
        : added,
    );
  }
  const target = matches(text, /<c r="C4"[^>]*>(?:<v>[^<]*<\/v>)?<\/c>/)[0];
  const [at, m] = rng() < 0.5 && target ? target : randomCell(rng, text, /t="n"|t="s"/);
  const ref = /r="([A-Z]+\d+)"/.exec(m[0])?.[1] as string;
  const s = / s="(\d+)"/.exec(m[0])?.[1] ?? "0";
  const v = pick(rng, V_CONTENTS);
  return set(
    parts,
    SHEET,
    splice(text, at, m[0].length, `<c r="${ref}" s="${s}"${t}><v>${v}</v></c>`),
  );
}

/** Boolean, error, inline-string and other cell-type variants of a random (or target) cell. */
function cellTypes(rng: Rng, parts: Parts): Parts {
  const text = get(parts, SHEET);
  const target = matches(text, /<c r="C4"[^>]*>(?:<v>[^<]*<\/v>)?<\/c>/)[0];
  const [at, m] = rng() < 0.5 && target ? target : randomCell(rng, text);
  const ref = /r="([A-Z]+\d+)"/.exec(m[0])?.[1] as string;
  const s = / s="(\d+)"/.exec(m[0])?.[1] ?? "0";
  const v = /<v>([^<]*)<\/v>/.exec(m[0])?.[1] ?? "4242";
  const shown = pick(rng, ["4242", v, "1", "TRUE", "#N/A", ""]);
  const cell = pick(rng, [
    `<c r="${ref}" s="${s}" t="b"><v>${pick(rng, ["0", "1", " 1", "true", "2"])}</v></c>`,
    `<c r="${ref}" s="${s}" t="b"/>`,
    `<c r="${ref}" s="${s}" t="e"><v>${pick(rng, ["#N/A", "#VALUE!", "4242", v])}</v></c>`,
    `<c r="${ref}" s="${s}" t="e"/>`,
    `<c r="${ref}" s="${s}" t="inlineStr"><is><t>${shown}</t></is></c>`,
    `<c r="${ref}" s="${s}" t="inlineStr"><is><r><t>${shown.slice(0, 2)}</t></r><r><t>${shown.slice(2)}</t></r></is></c>`,
    `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve"> ${shown}</t></is></c>`,
    `<c r="${ref}" s="${s}" t="inlineStr"/>`,
    `<c r="${ref}" s="${s}" t="str"><v>${shown}</v></c>`,
    `<c r="${ref}" s="${s}" t="str"><f>${shown}</f><v>${shown}</v></c>`,
    `<c r="${ref}" s="${s}" t="d"><v>2020-01-01</v></c>`,
    `<c r="${ref}" s="${s}" t="${pick(rng, ["B", "N", "inlinestr", "x", ""])}"><v>${v}</v></c>`,
    `<c r="${ref}" s="${s}"><f>${v}</f><v>${v}</v></c>`,
    `<c r="${ref}" s="${s}" t="n"/>`,
    `<c r="${ref}" s="${s}" t="s"/>`,
  ]);
  return set(parts, SHEET, splice(text, at, m[0].length, cell));
}

/** A byte-level family: from the base archive's bytes. */
type ByteMutator = (rng: Rng, base: Uint8Array) => Uint8Array;

/** Round 2, comment decoys: the EOCD comment and bytes no entry covers (round 1, V6). */
const commentDecoys: ByteMutator = (rng, base) => {
  const decoy = writerBytes(pick(rng, BASES));
  const junk = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(rng() * 256));
  const kind = pick(rng, [
    "decoy-in-comment",
    "decoy-in-comment",
    "plain-comment",
    "stray-eocd-in-comment",
    "decoy-between-entries",
    "decoy-in-front",
    "junk-between-entries",
    "trailing-bytes",
  ]);
  if (kind === "decoy-in-comment") return withCommentDecoy(base, decoy, Math.floor(rng() * 4));
  if (kind === "plain-comment") return withComment(base, junk(1 + Math.floor(rng() * 64)));
  if (kind === "stray-eocd-in-comment") {
    const sig = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
    return withComment(base, new Uint8Array([...junk(Math.floor(rng() * 8)), ...sig, ...junk(18)]));
  }
  const ends = entryEnds(base);
  if (kind === "decoy-between-entries") return withGap(base, pick(rng, ends), decoy);
  if (kind === "decoy-in-front") return withGap(base, 0, decoy);
  if (kind === "junk-between-entries")
    return withGap(base, pick(rng, ends), junk(1 + Math.floor(rng() * 32)));
  const out = new Uint8Array(base.length + 1 + Math.floor(rng() * 32));
  out.set(base, 0);
  out.set(junk(out.length - base.length), base.length);
  return out;
};

const BYTE_FAMILIES: Record<string, ByteMutator> = { commentDecoys };
FAMILIES.nestedDecoys = nestedDecoys;
FAMILIES.attributeNames = attributeNames;
FAMILIES.formatSections = formatSections;
FAMILIES.vContents = vContents;
FAMILIES.cellTypes = cellTypes;
/** The round-3 value-mechanism families (verdict 7204800200, D2). */
const ROUND3 = ["attributeNames", "formatSections", "vContents", "cellTypes"];
/** Families whose liveness is counted (graderFooled): the decoy and value families. */
const LIVE = ["nestedDecoys", "commentDecoys", ...ROUND3];
const ALL_FAMILIES = [...Object.keys(FAMILIES), ...Object.keys(BYTE_FAMILIES)];

interface Tally {
  variants: number;
  verified: number;
  refused: number;
  refuted: number;
  /** Variants the grader does not pass, of a base the grader passes (a live decoy). */
  graderFooled: number;
  unsound: string[];
}

async function runFamily(family: string): Promise<Tally> {
  const tally: Tally = {
    variants: 0,
    verified: 0,
    refused: 0,
    refuted: 0,
    graderFooled: 0,
    unsound: [],
  };
  const live = LIVE.includes(family);
  for (const [b, base] of BASES.entries()) {
    const parts = loParts(base);
    const baseBytes = writerBytes(base);
    const basePasses = live && graderOn(baseBytes) === "pass";
    const rng = mulberry32(0x5eed + b * 1000 + family.length * 7919 + family.charCodeAt(0));
    for (let k = 0; k < PER; k++) {
      const byteMutate = BYTE_FAMILIES[family];
      const bytes = byteMutate
        ? byteMutate(rng, baseBytes)
        : zip((FAMILIES[family] as Mutator)(rng, parts));
      const gate = await gateOn(bytes);
      tally.variants++;
      const graded = gate.verdict === "verified" || basePasses ? graderOn(bytes) : undefined;
      if (basePasses && graded !== "pass") tally.graderFooled++;
      if (gate.verdict === "verified") {
        tally.verified++;
        if (graded !== "pass") tally.unsound.push(`${family}/${base}#${k}`);
      } else if (gate.verdict === "refuted") tally.refuted++;
      else tally.refused++;
    }
  }
  return tally;
}

const TALLIES: Record<string, Tally> = {};

describe("differential property: gate VERIFIED implies grader PASS, on every variant", () => {
  it.each(ALL_FAMILIES)(
    "%s",
    async (family) => {
      const tally = await runFamily(family);
      TALLIES[family] = tally;
      expect(tally.variants).toBe(BASES.length * PER);
      expect(tally.unsound).toEqual([]);
    },
    120_000,
  );

  it("the variant count, and the property is not vacuous", () => {
    const total = Object.values(TALLIES).reduce((n, t) => n + t.variants, 0);
    // 16 families x 4 real LibreOffice bases x 100 variants.
    expect(total).toBe(ALL_FAMILIES.length * BASES.length * PER);
    expect(total).toBe(6_400);
    // The two round-2 families (at least 200 variants each) and the four round-3 value
    // families (at least 300 each), over the 4 real bases: live (many of their variants fool
    // the grader on the bases it passes), yet none verifies where the grader does not pass.
    for (const family of LIVE) {
      const t = TALLIES[family] as Tally;
      expect(t.variants).toBeGreaterThanOrEqual(ROUND3.includes(family) ? 300 : 200);
      expect([family, t.graderFooled > 0]).toEqual([family, true]);
      expect([family, t.unsound]).toEqual([family, []]);
    }
    // The control family's in-grammar edits verify on the two exact bases (and the grader
    // passes them, above): the gate still says yes when it should.
    expect((TALLIES.control as Tally).verified).toBeGreaterThanOrEqual(2 * PER);
    // Every attack family is refused or refuted on every variant: none verifies at all.
    // (nestedDecoys aside: a decoy can land where it is the only element of its name at its
    // canonical path, e.g. a <numFmts> appended to a styles part that has none; both judges
    // then read the same element. Its verified variants are covered by the property above.)
    // The round-3 value families aside too: each also makes in-grammar edits both judges
    // read alike (an allowed attribute, a format code whose sections agree, the canonical
    // spelling of the requested value, an inline string equal to it).
    for (const family of ALL_FAMILIES.filter(
      (f) => f !== "control" && f !== "nestedDecoys" && !ROUND3.includes(f),
    ))
      expect([family, (TALLIES[family] as Tally).verified]).toEqual([family, 0]);
  });
});

describe("tally (printed: one TALLY line per family)", () => {
  it("every variant is counted once", () => {
    const counted = Object.values(TALLIES).reduce(
      (n, t) => n + t.verified + t.refuted + t.refused,
      0,
    );
    expect(counted).toBe(ALL_FAMILIES.length * BASES.length * PER);
    // Printed on every run, so the counts are in the test output.
    process.stdout.write(
      `${Object.entries(TALLIES)
        .map(
          ([f, t]) =>
            `TALLY ${f} variants=${t.variants} verified=${t.verified} refuted=${t.refuted} refused=${t.refused} graderFooled=${t.graderFooled} violations=${t.unsound.length}`,
        )
        .join("\n")}\n`,
    );
  });
});
