/**
 * The raw-byte pre-scan (src/gate/xlsx-prescan.ts), on hand-built byte strings. Every rule
 * has an accepting row (what LibreOffice writes) and refusing rows with the exact code, so
 * removing any one rule fails a row here (the mutation table in the PR pins that).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readZipEntries } from "../../src/gate/xlsx-document.ts";
import {
  type ContentPartKind,
  contentKindOf,
  LO_ROOTS,
  type PrescanCode,
  prescanXmlPart,
} from "../../src/gate/xlsx-prescan.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The root start tag LibreOffice writes for `kind` (extra attributes appended). */
function root(kind: ContentPartKind, extra = ""): string {
  const spec = LO_ROOTS[kind];
  return `<${spec.root}${spec.xmlns.map(([n, v]) => ` ${n}="${v}"`).join("")}${extra}>`;
}
const close = (kind: ContentPartKind) => `</${LO_ROOTS[kind].root}>`;

const sheet = (data: string, head = DECL) =>
  `${head}${root("worksheet")}<sheetData>${data}</sheetData>${close("worksheet")}`;
const sst = (items: string) =>
  `${DECL}${root("sst", ' count="1" uniqueCount="1"')}${items}${close("sst")}`;
const workbook = (inner: string) => `${DECL}${root("workbook")}${inner}${close("workbook")}`;

const C4 = '<row r="4"><c r="C4" s="0" t="n"><v>4242</v></c></row>';
const scan = (xml: string, kind?: ContentPartKind) => prescanXmlPart(enc(xml), kind);

describe("accepts what LibreOffice writes", () => {
  it("a worksheet, a shared-string table, a workbook with its loext extLst", () => {
    expect(scan(sheet(C4), "worksheet")).toBeUndefined();
    expect(
      scan(
        sst('<si><t xml:space="preserve">A&amp;B &lt;x&gt; &quot;q&quot; it&apos;s</t></si>'),
        "sst",
      ),
    ).toBeUndefined();
    expect(
      scan(
        workbook(
          '<sheets><sheet name="s" sheetId="1" state="visible" r:id="rId3"/></sheets><extLst><ext xmlns:loext="http://schemas.libreoffice.org/" uri="{7626C862-2A13-11E5-B345-FEFF819CDC9F}"><loext:extCalcPr stringRefSyntax="CalcA1"/></ext></extLst>',
        ),
        "workbook",
      ),
    ).toBeUndefined();
  });

  it("both XML declarations LibreOffice writes, with or without the LF after them", () => {
    expect(scan(sheet(C4, '<?xml version="1.0" encoding="UTF-8"?>'), "worksheet")).toBeUndefined();
    expect(
      scan(sheet(C4, '<?xml version="1.0" encoding="UTF-8"?>\n'), "worksheet"),
    ).toBeUndefined();
  });

  it("UTF-8 text in a cell (bytes >= 0x80 are never delimiters)", () => {
    expect(scan(sst("<si><t>Zoë Ångström €</t></si>"), "sst")).toBeUndefined();
  });

  it("every part of every committed LibreOffice fixture", () => {
    const dir = join(import.meta.dirname, "../fixtures/calc-xlsx-writers");
    const files = ["exact", "pristine", "collateral", "roundtrip-exact"].map((n) => `${n}.lo.xlsx`);
    for (const file of files) {
      const entries = readZipEntries(readFileSync(join(dir, file)));
      for (const [name, bytes] of entries)
        expect([file, name, prescanXmlPart(bytes, contentKindOf(name))]).toEqual([
          file,
          name,
          undefined,
        ]);
    }
  });
});

/** [description, xml, kind, code]: each must be refused with exactly that code. */
const REFUSED: readonly [string, string, ContentPartKind | undefined, PrescanCode][] = [
  // The XML declaration
  ["no declaration", sheet(C4, ""), "worksheet", "XLSX_PRESCAN_DECL"],
  ["a BOM before the declaration", sheet(C4, `﻿${DECL}`), "worksheet", "XLSX_PRESCAN_DECL"],
  [
    "a single-quoted declaration",
    sheet(C4, "<?xml version='1.0' encoding='UTF-8'?>"),
    "worksheet",
    "XLSX_PRESCAN_DECL",
  ],
  [
    "another encoding",
    sheet(C4, '<?xml version="1.0" encoding="ISO-8859-1"?>'),
    "worksheet",
    "XLSX_PRESCAN_DECL",
  ],
  ["a PI first", sheet(C4, '<?evil x="1"?>'), "worksheet", "XLSX_PRESCAN_PI"],
  // Comments
  ["a comment in <t>", sst("<si><t>42<!-- x -->42</t></si>"), "sst", "XLSX_PRESCAN_COMMENT"],
  [
    "a comment in <v>",
    sheet('<row r="4"><c r="C4" t="n"><v>42<!-- x -->42</v></c></row>'),
    "worksheet",
    "XLSX_PRESCAN_COMMENT",
  ],
  [
    "a commented-out sheetData",
    `${DECL}${root("worksheet")}<!--<sheetData></sheetData>--><sheetData>${C4}</sheetData>${close("worksheet")}`,
    "worksheet",
    "XLSX_PRESCAN_COMMENT",
  ],
  [
    "a comment in a package part",
    `${DECL}<Types><!-- --></Types>`,
    undefined,
    "XLSX_PRESCAN_COMMENT",
  ],
  // CDATA, DTD, PIs
  ["CDATA in <t>", sst("<si><t><![CDATA[id]]></t></si>"), "sst", "XLSX_PRESCAN_CDATA"],
  [
    "a DOCTYPE",
    `${DECL}<!DOCTYPE sst [<!ENTITY a "x">]>${root("sst")}${close("sst")}`,
    "sst",
    "XLSX_PRESCAN_DTD",
  ],
  ["a PI after the declaration", sheet(`<?x y?>${C4}`), "worksheet", "XLSX_PRESCAN_PI"],
  // Quote style
  [
    "a single-quoted attribute",
    sheet(`<row r="4"><c r="C4" t='inlineStr'><is><t>4242</t></is></c></row>`),
    "worksheet",
    "XLSX_PRESCAN_QUOTE",
  ],
  [
    "a single-quoted r",
    sheet(`<row r="4"><c r='C4'><v>1</v></c></row>`),
    "worksheet",
    "XLSX_PRESCAN_QUOTE",
  ],
  // Whitespace inside tags
  [
    "space before > in an open tag",
    sheet('<row r="4"><c r="C4"><v >4242</v></c></row>'),
    "worksheet",
    "XLSX_PRESCAN_TAG_SPACE",
  ],
  [
    "space before > in a close tag",
    sheet('<row r="4"><c r="C4"><v>4242</v ></c></row>'),
    "worksheet",
    "XLSX_PRESCAN_TAG_SPACE",
  ],
  [
    "space before />",
    sheet('<row r="4"><c r="C4" /></row>'),
    "worksheet",
    "XLSX_PRESCAN_TAG_SPACE",
  ],
  [
    "space after the last attribute",
    sheet('<row r="4" ><c r="C4"/></row>'),
    "worksheet",
    "XLSX_PRESCAN_TAG_SPACE",
  ],
  [
    "two spaces between attributes",
    sheet('<row r="4"><c  r="C4"/></row>'),
    "worksheet",
    "XLSX_PRESCAN_TAG_SPACE",
  ],
  [
    "a tab between attributes",
    sheet('<row r="4"><c\tr="C4"/></row>'),
    "worksheet",
    "XLSX_PRESCAN_TAG_SPACE",
  ],
  [
    "a newline between attributes",
    sheet('<row r="4"><c\nr="C4"/></row>'),
    "worksheet",
    "XLSX_PRESCAN_TAG_SPACE",
  ],
  ["space around =", sheet('<row r="4"><c r ="C4"/></row>'), "worksheet", "XLSX_PRESCAN_TAG_SPACE"],
  ["space after =", sheet('<row r="4"><c r= "C4"/></row>'), "worksheet", "XLSX_PRESCAN_TAG_SPACE"],
  ["<si > in the sst", sst("<si ><t>a</t></si>"), "sst", "XLSX_PRESCAN_TAG_SPACE"],
  // Namespaces
  [
    "xmlns on <v>",
    sheet('<row r="4"><c r="C4"><v xmlns:q="urn:q">4242</v></c></row>'),
    "worksheet",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "a prefixed cell bound to main",
    sheet(`<row r="4"><x:c xmlns:x="${MAIN}" r="C4"><x:v>4242</x:v></x:c></row>`),
    "worksheet",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "a prefixed <v> in an unprefixed cell",
    sheet('<row r="4"><c r="C4"><x:v>4242</x:v></c></row>'),
    "worksheet",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "a default xmlns on <row>",
    sheet('<row xmlns="urn:o" r="4"/>'),
    "worksheet",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "a prefixed <si>",
    sst(`<x:si xmlns:x="${MAIN}"><x:t>a</x:t></x:si>`),
    "sst",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  ["a prefixed root", `${DECL}<x:sst xmlns:x="${MAIN}"></x:sst>`, "sst", "XLSX_PRESCAN_NAMESPACE"],
  [
    "a missing root declaration",
    `${DECL}<worksheet xmlns="${MAIN}"></worksheet>`,
    "worksheet",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "an extra root declaration",
    `${DECL}<sst xmlns="${MAIN}" xmlns:q="urn:q"></sst>`,
    "sst",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "a root declaration with another URI",
    `${DECL}<workbook xmlns="${MAIN}" xmlns:r="urn:not-rel"></workbook>`,
    "workbook",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "root declarations in another order",
    `${DECL}<workbook xmlns:r="${REL}" xmlns="${MAIN}"></workbook>`,
    "workbook",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "a prefixed attribute on the root (mc:Ignorable)",
    `${DECL}<sst xmlns="${MAIN}" mc:Ignorable="x14ac"></sst>`,
    "sst",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "the wrong root element",
    `${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}"></worksheet>`,
    "workbook",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "a prefixed attribute other than r:id on <sheet>",
    workbook('<sheets><sheet name="s" sheetId="1" q:id="rId3"/></sheets>'),
    "workbook",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "r:id on an element other than <sheet>",
    sheet('<row r="4" r:id="rId1"/>'),
    "worksheet",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "xmlns:loext outside an <ext> in <extLst>",
    workbook('<sheets xmlns:loext="http://schemas.libreoffice.org/"/>'),
    "workbook",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "a prefixed element in a relationships part",
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><p:Relationship/></Relationships>`,
    "rels",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  [
    "a prefixed element in the sst, even in an extLst",
    sst(`<extLst><x:ext xmlns:x="${MAIN}"/></extLst>`),
    "sst",
    "XLSX_PRESCAN_NAMESPACE",
  ],
  // Entity and character references
  [
    "a character reference in <v>",
    sheet('<row r="4"><c r="C4"><v>&#52;242</v></c></row>'),
    "worksheet",
    "XLSX_PRESCAN_ENTITY",
  ],
  [
    "a predefined escape in <v>",
    sheet('<row r="4"><c r="C4"><v>&amp;</v></c></row>'),
    "worksheet",
    "XLSX_PRESCAN_ENTITY",
  ],
  ["a decimal reference in <t>", sst("<si><t>&#52;242</t></si>"), "sst", "XLSX_PRESCAN_ENTITY"],
  ["a hex reference in <t>", sst("<si><t>&#x34;242</t></si>"), "sst", "XLSX_PRESCAN_ENTITY"],
  [
    "LibreOffice's own &#9; (tab) in <t>",
    sst("<si><t>a&#9;b</t></si>"),
    "sst",
    "XLSX_PRESCAN_ENTITY",
  ],
  [
    "LibreOffice's own &#10; (newline) in <t>",
    sst("<si><t>a&#10;b</t></si>"),
    "sst",
    "XLSX_PRESCAN_ENTITY",
  ],
  ["a custom entity", sst("<si><t>&custom;</t></si>"), "sst", "XLSX_PRESCAN_ENTITY"],
  ["a bare ampersand", sst("<si><t>a & b</t></si>"), "sst", "XLSX_PRESCAN_ENTITY"],
  [
    "a reference in an attribute",
    sheet('<row r="4"><c r="C4" t="&#110;"><v>1</v></c></row>'),
    "worksheet",
    "XLSX_PRESCAN_ENTITY",
  ],
  // Text inside structure, empty values
  [
    "whitespace between cells",
    sheet('<row r="4"><c r="C4"><v>1</v></c>\n<c r="D4"><v>2</v></c></row>'),
    "worksheet",
    "XLSX_PRESCAN_TEXT",
  ],
  [
    "CRLF between rows",
    sheet(`${C4}\r\n${C4.replace(/4/g, "5")}`),
    "worksheet",
    "XLSX_PRESCAN_TEXT",
  ],
  [
    "whitespace between <c> children",
    sheet('<row r="4"><c r="C4"> <v>1</v></c></row>'),
    "worksheet",
    "XLSX_PRESCAN_TEXT",
  ],
  ["text directly in <si>", sst("<si>x<t>a</t></si>"), "sst", "XLSX_PRESCAN_TEXT"],
  [
    "whitespace between <si>",
    sst("<si><t>a</t></si>\n<si><t>b</t></si>"),
    "sst",
    "XLSX_PRESCAN_TEXT",
  ],
  ["an empty <t/>", sst("<si><r><t/></r><r><t>a</t></r></si>"), "sst", "XLSX_PRESCAN_SYNTAX"],
  [
    "an empty <v/>",
    sheet('<row r="4"><c r="C4" t="n"><v/></c></row>'),
    "worksheet",
    "XLSX_PRESCAN_SYNTAX",
  ],
  // Anything else outside the grammar
  ["a literal > in text", sst("<si><t>a>b</t></si>"), "sst", "XLSX_PRESCAN_SYNTAX"],
  [
    "a literal > in an attribute value",
    sheet('<row r="4" x="a>b"/>'),
    "worksheet",
    "XLSX_PRESCAN_SYNTAX",
  ],
  [
    "a close tag with a stray byte before its >",
    sheet('<row r="4"><c r="C4"><v>1</v=</c></row>'),
    "worksheet",
    "XLSX_PRESCAN_SYNTAX",
  ],
  [
    "a value opened by a byte other than a double quote",
    sheet('<row r=a4"/>'),
    "worksheet",
    "XLSX_PRESCAN_SYNTAX",
  ],
  [
    "a part ending with its root unclosed",
    `${DECL}${root("sst", ' count="1" uniqueCount="1"')}<si><t>a</t></si>`,
    "sst",
    "XLSX_PRESCAN_SYNTAX",
  ],
  ["a declaration and no root", DECL, "sst", "XLSX_PRESCAN_SYNTAX"],
  ["mismatched tags", sheet('<row r="4"></rows>'), "worksheet", "XLSX_PRESCAN_SYNTAX"],
  ["a cut part", sheet(C4).slice(0, 200), "worksheet", "XLSX_PRESCAN_SYNTAX"],
  ["text after the root", `${sheet(C4)}x`, "worksheet", "XLSX_PRESCAN_SYNTAX"],
  ["a second root", `${sheet(C4)}<worksheet/>`, "worksheet", "XLSX_PRESCAN_SYNTAX"],
  ["an unquoted attribute", sheet("<row r=4/>"), "worksheet", "XLSX_PRESCAN_SYNTAX"],
  ["a name starting with a digit", sheet("<1row/>"), "worksheet", "XLSX_PRESCAN_SYNTAX"],
];

describe("refuses everything outside the grammar, with a code", () => {
  it.each(REFUSED)("%s", (_d, xml, kind, code) => {
    expect(scan(xml, kind)).toBe(code);
  });

  it("every code has a refusing row", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../../src/gate/xlsx-prescan.ts"),
      "utf8",
    );
    const union = /export type PrescanCode =([^;]+);/.exec(source)?.[1] ?? "";
    const declared = [...union.matchAll(/"(XLSX_[A-Z_]+)"/g)].map((m) => m[1]).sort();
    expect([...new Set(REFUSED.map((r) => r[3]))].sort()).toEqual(declared);
  });

  it("the one LF LibreOffice writes before a package root's closing tag is accepted", () => {
    const rels = `${DECL}${root("rels")}<Relationship Id="rId1" Type="t" Target="x"/>\n${close("rels")}`;
    expect(scan(rels, "rels")).toBeUndefined();
    expect(scan(rels.replace("\n</", "\n\n</"), "rels")).toBe("XLSX_PRESCAN_TEXT");
    expect(scan(rels.replace("<Relationship ", "\n<Relationship "), "rels")).toBe(
      "XLSX_PRESCAN_TEXT",
    );
  });

  it("generic parts (docProps, theme) get the grammar but no namespace pin", () => {
    const theme = `${DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="x"><a:themeElements/></a:theme>`;
    expect(scan(theme)).toBeUndefined();
    expect(scan(theme.replace("<a:themeElements/>", "<!-- -->"))).toBe("XLSX_PRESCAN_COMMENT");
  });

  it("pins the kinds by LibreOffice's fixed names", () => {
    expect(contentKindOf("xl/workbook.xml")).toBe("workbook");
    expect(contentKindOf("xl/worksheets/sheet1.xml")).toBe("worksheet");
    expect(contentKindOf("xl/worksheets/sheet12.xml")).toBe("worksheet");
    expect(contentKindOf("xl/worksheets/sheet0.xml")).toBeUndefined();
    expect(contentKindOf("xl/sharedStrings.xml")).toBe("sst");
    expect(contentKindOf("xl/styles.xml")).toBe("styles");
    expect(contentKindOf("[Content_Types].xml")).toBe("types");
    expect(contentKindOf("_rels/.rels")).toBe("rels");
    expect(contentKindOf("xl/_rels/workbook.xml.rels")).toBe("rels");
    expect(contentKindOf("docProps/app.xml")).toBeUndefined();
  });
});
