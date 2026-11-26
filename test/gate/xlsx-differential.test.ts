/**
 * Requirement (d): a differential property test. From the REAL LibreOffice workbooks in
 * test/fixtures/calc-xlsx-writers/ (exact, roundtrip-exact, pristine, collateral), a seeded
 * generator builds many variants per mutation family, and every variant goes through both
 * judges: the gate (real read path) and the independent grader (its own reader). The
 * property, on every variant: gate VERIFIED implies grader PASS.
 *
 * Families: comments, quote style, whitespace in tags, namespace prefixes, entity
 * references, relocated parts, decoy parts, nested/duplicated text runs, v+is on one cell,
 * and a control family of in-grammar edits (attribute order, rich-run splits) so the
 * property is not vacuous: those still verify, and the grader passes them.
 *
 * Deterministic: a fixed seed per (family, base), so a failure names a reproducible variant.
 */
import { describe, expect, it } from "vitest";
import { writeZip } from "../../src/tasks/writer-docgen.ts";
import { gateOn, graderOn, loParts, MAIN } from "./xlsx-lo-mutate.ts";

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

interface Tally {
  variants: number;
  verified: number;
  refused: number;
  refuted: number;
  unsound: string[];
}

async function runFamily(family: string): Promise<Tally> {
  const tally: Tally = { variants: 0, verified: 0, refused: 0, refuted: 0, unsound: [] };
  const mutate = FAMILIES[family] as Mutator;
  for (const [b, base] of BASES.entries()) {
    const parts = loParts(base);
    const rng = mulberry32(0x5eed + b * 1000 + family.length * 7919 + family.charCodeAt(0));
    for (let k = 0; k < PER; k++) {
      const bytes = zip(mutate(rng, parts));
      const gate = await gateOn(bytes);
      tally.variants++;
      if (gate.verdict === "verified") {
        tally.verified++;
        if (graderOn(bytes) !== "pass") tally.unsound.push(`${family}/${base}#${k}`);
      } else if (gate.verdict === "refuted") tally.refuted++;
      else tally.refused++;
    }
  }
  return tally;
}

const TALLIES: Record<string, Tally> = {};

describe("differential property: gate VERIFIED implies grader PASS, on every variant", () => {
  it.each(Object.keys(FAMILIES))(
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
    // 10 families x 4 real LibreOffice bases x 100 variants.
    expect(total).toBe(Object.keys(FAMILIES).length * BASES.length * PER);
    expect(total).toBe(4_000);
    // The control family's in-grammar edits verify on the two exact bases (and the grader
    // passes them, above): the gate still says yes when it should.
    expect((TALLIES.control as Tally).verified).toBeGreaterThanOrEqual(2 * PER);
    // Every attack family is refused or refuted on every variant: none verifies at all.
    for (const family of Object.keys(FAMILIES).filter((f) => f !== "control"))
      expect([family, (TALLIES[family] as Tally).verified]).toEqual([family, 0]);
  });
});

describe("tally (for the PR body; set XLSX_DIFF_TALLY=1 to print it)", () => {
  it("every variant is counted once", () => {
    const counted = Object.values(TALLIES).reduce(
      (n, t) => n + t.verified + t.refuted + t.refused,
      0,
    );
    expect(counted).toBe(Object.keys(FAMILIES).length * BASES.length * PER);
    if (process.env.XLSX_DIFF_TALLY === "1")
      process.stdout.write(
        `${Object.entries(TALLIES)
          .map(
            ([f, t]) =>
              `TALLY ${f} variants=${t.variants} verified=${t.verified} refuted=${t.refuted} refused=${t.refused}`,
          )
          .join("\n")}\n`,
      );
  });
});
