/**
 * #503's round-3 verifier probes P01-P53 (comment 7191885535 on #503), rebuilt on the PR's
 * own base: the REAL LibreOffice workbook `exact.lo.xlsx` (EMP-0003 qty := 4242, so C4 is
 * the target), with only the change shown.
 *
 * Numbering. The verdict numbers P01-P15, P21, P45, P46, P50 and P53 explicitly; those rows
 * are its exact shapes. The verifier's harness was not committed, and the verdict lists its
 * other allowlist-edge probes by description only ("Refused", "Refuted", "Verified, and the
 * grader passes"), so those take the remaining numbers in the order the verdict lists them
 * (P16-P20, P22-P44, P47-P49). P51 and P52 are the two numbers that list does not fill; this
 * PR fills them with two more shapes outside LibreOffice's grammar, marked "(filled)".
 */
import {
  editOnce,
  LO_BASE,
  loEdit,
  loText,
  loWith,
  MAIN,
  ROOT_RELS,
  SHEET1,
  SST,
  WB_RELS,
  WORKBOOK,
} from "./xlsx-lo-mutate.ts";

export const C4 = '<c r="C4" s="0" t="n"><v>4242</v></c>';
export const D4 = '<c r="D4" s="1" t="n"><v>45447</v></c>';

/** C4 replaced by `cell`. */
const c4 = (cell: string) => loEdit(SHEET1, C4, cell);
/** C4 as an inline string with `is` as its <is>. */
const inline = (is: string) => c4(`<c r="C4" s="0" t="inlineStr">${is}</c>`);
/** C4 as shared string 198 (one past LibreOffice's 198 strings), with `si` appended. */
const shared = (si: string, cell = '<c r="C4" s="0" t="s"><v>198</v></c>') =>
  loWith({
    [SHEET1]: editOnce(loText(SHEET1), C4, cell),
    [SST]: editOnce(loText(SST), "</sst>", `${si}</sst>`),
  });

export interface Probe503 {
  readonly id: string;
  readonly change: string;
  readonly build: () => Uint8Array;
  /** "explicit": the verdict's own numbered shape; "listed": by description; "filled". */
  readonly source: "explicit" | "listed" | "filled";
}

export const PROBES_503: readonly Probe503[] = [
  {
    id: "P01",
    source: "explicit",
    change: "<!--<sheetData>…decoy A1…</sheetData>--> before the real <sheetData>",
    build: () =>
      loEdit(
        SHEET1,
        "<sheetData>",
        '<!--<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>decoy</t></is></c></row></sheetData>--><sheetData>',
      ),
  },
  {
    id: "P02",
    source: "explicit",
    change: "C4 <is><t>42<!-- x -->42</t></is>",
    build: () => inline("<is><t>42<!-- x -->42</t></is>"),
  },
  {
    id: "P03",
    source: "explicit",
    change: "C4 <v>42<!-- x -->42</v>",
    build: () => c4('<c r="C4" s="0" t="n"><v>42<!-- x -->42</v></c>'),
  },
  {
    id: "P04",
    source: "explicit",
    change: '<!--<c r="Z99" …>x</c>--> after C4',
    build: () => c4(`${C4}<!--<c r="Z99" t="inlineStr"><is><t>x</t></is></c>-->`),
  },
  {
    id: "P05",
    source: "explicit",
    change: '<!--<sheet … r:id="rId3"/>--> inside <sheets>',
    build: () =>
      loEdit(
        WORKBOOK,
        "</sheets>",
        '<!--<sheet name="hidden" sheetId="2" state="visible" r:id="rId3"/>--></sheets>',
      ),
  },
  {
    id: "P06",
    source: "explicit",
    change: `C4 <c r="C4" t='inlineStr'><is><t>4242</t></is></c> (single quotes)`,
    build: () => c4(`<c r="C4" t='inlineStr'><is><t>4242</t></is></c>`),
  },
  {
    id: "P07",
    source: "explicit",
    change: "C4 t='s' on a shared cell (index 198 = \"4242\")",
    build: () => shared("<si><t>4242</t></si>", `<c r="C4" s="0" t='s'><v>198</v></c>`),
  },
  {
    id: "P08",
    source: "explicit",
    change: "C4 <v >4242</v >",
    build: () => c4('<c r="C4" s="0" t="n"><v >4242</v ></c>'),
  },
  {
    id: "P09",
    source: "explicit",
    change: "C4 <is ><t>4242</t></is >",
    build: () => inline("<is ><t>4242</t></is >"),
  },
  {
    id: "P10",
    source: "explicit",
    change: "<si > in the sst (C4 -> that string)",
    build: () => shared("<si ><t>4242</t></si>"),
  },
  {
    id: "P11",
    source: "explicit",
    change: 'C4 <v xmlns:q="urn:q">4242</v>',
    build: () => c4('<c r="C4" s="0" t="n"><v xmlns:q="urn:q">4242</v></c>'),
  },
  {
    id: "P12",
    source: "explicit",
    change: 'C4 <x:c xmlns:x="…/main" …><x:v>4242</x:v></x:c>',
    build: () => c4(`<x:c xmlns:x="${MAIN}" r="C4" s="0" t="n"><x:v>4242</x:v></x:c>`),
  },
  {
    id: "P13",
    source: "explicit",
    change: 'C4 <c xmlns:x="…/main" …><x:v>4242</x:v></c>',
    build: () => c4(`<c xmlns:x="${MAIN}" r="C4" s="0" t="n"><x:v>4242</x:v></c>`),
  },
  {
    id: "P14",
    source: "explicit",
    change: "sharedStrings relationship targets ss2.xml (a copy); decoy xl/sharedStrings.xml left",
    build: () =>
      loWith({
        [WB_RELS]: editOnce(loText(WB_RELS), 'Target="sharedStrings.xml"', 'Target="ss2.xml"'),
        "xl/ss2.xml": loText(SST),
        [SST]: editOnce(
          loText(SST),
          '<t xml:space="preserve">EMP-0001</t>',
          '<t xml:space="preserve">DECOY</t>',
        ),
      }),
  },
  {
    id: "P15",
    source: "explicit",
    change:
      "officeDocument relationship targets xl/wb2.xml (a copy); decoy xl/workbook.xml lists two sheets",
    build: () =>
      loWith({
        [ROOT_RELS]: editOnce(loText(ROOT_RELS), 'Target="xl/workbook.xml"', 'Target="xl/wb2.xml"'),
        "xl/wb2.xml": loText(WORKBOOK),
        [WORKBOOK]: editOnce(
          loText(WORKBOOK),
          "</sheets>",
          '<sheet name="decoy" sheetId="2" state="visible" r:id="rId3"/></sheets>',
        ),
      }),
  },
  {
    id: "P16",
    source: "listed",
    change: "CDATA in <t>",
    build: () => inline("<is><t><![CDATA[4242]]></t></is>"),
  },
  {
    id: "P17",
    source: "listed",
    change: "rPh in <si>",
    build: () => shared('<si><t>4242</t><rPh sb="0" eb="1"><t>9</t></rPh></si>'),
  },
  {
    id: "P18",
    source: "listed",
    change: "nested content in rPr",
    build: () => inline("<is><r><rPr><b><i/></b></rPr><t>4242</t></r></is>"),
  },
  {
    id: "P19",
    source: "listed",
    change: 't="x"',
    build: () => c4('<c r="C4" s="0" t="x"><v>4242</v></c>'),
  },
  {
    id: "P20",
    source: "listed",
    change: "unexpected attribute on <c> (cm)",
    build: () => c4('<c r="C4" s="0" t="n" cm="1"><v>4242</v></c>'),
  },
  {
    id: "P21",
    source: "explicit",
    change: "C4 <v>&#52;242</v>",
    build: () => c4('<c r="C4" s="0" t="n"><v>&#52;242</v></c>'),
  },
  {
    id: "P22",
    source: "listed",
    change: "unexpected attribute on <is>",
    build: () => inline('<is x="1"><t>4242</t></is>'),
  },
  {
    id: "P23",
    source: "listed",
    change: "unexpected attribute on <si>",
    build: () => shared('<si x="1"><t>4242</t></si>'),
  },
  {
    id: "P24",
    source: "listed",
    change: "unexpected attribute on <r>",
    build: () => inline('<is><r x="1"><t>4242</t></r></is>'),
  },
  {
    id: "P25",
    source: "listed",
    change: "unexpected attribute on <t>",
    build: () => inline('<is><t x="1">4242</t></is>'),
  },
  {
    id: "P26",
    source: "listed",
    change: "xml:space via another prefix bound to the XML namespace",
    build: () =>
      inline(
        '<is><t xmlns:q="http://www.w3.org/XML/1998/namespace" q:space="preserve">4242</t></is>',
      ),
  },
  { id: "P27", source: "listed", change: "empty <si/>", build: () => shared("<si/>") },
  { id: "P28", source: "listed", change: "empty <si></si>", build: () => shared("<si></si>") },
  {
    id: "P29",
    source: "listed",
    change: "a raw duplicate t",
    build: () => c4('<c r="C4" s="0" t="n" t="s"><v>4242</v></c>'),
  },
  {
    id: "P30",
    source: "listed",
    change: "a 2 MB run",
    build: () => inline(`<is><t>${"4".repeat(2_000_000)}</t></is>`),
  },
  {
    id: "P31",
    source: "listed",
    change: 'padded xml:space ("default ")',
    build: () => inline('<is><t xml:space="default ">4242</t></is>'),
  },
  {
    id: "P32",
    source: "listed",
    change: 't="d" with a numeric value',
    build: () => c4('<c r="C4" s="0" t="d"><v>4242</v></c>'),
  },
  {
    id: "P33",
    source: "listed",
    change: "&lt;/t&gt; inside <t>",
    build: () => inline("<is><t>42&lt;/t&gt;42</t></is>"),
  },
  {
    id: "P34",
    source: "listed",
    change: "date serial 60 in D4",
    build: () => loEdit(SHEET1, D4, '<c r="D4" s="1" t="n"><v>60</v></c>'),
  },
  {
    id: "P35",
    source: "listed",
    change: "entity &#52;242 in <t>",
    build: () => inline("<is><t>&#52;242</t></is>"),
  },
  {
    id: "P36",
    source: "listed",
    change: "an empty <t/> run",
    build: () => inline("<is><r><t/></r><r><t>4242</t></r></is>"),
  },
  {
    id: "P37",
    source: "listed",
    change: 't="str" (no formula)',
    build: () => c4('<c r="C4" s="0" t="str"><v>4242</v></c>'),
  },
  {
    id: "P38",
    source: "listed",
    change: "whitespace between <c> children",
    build: () => c4('<c r="C4" s="0" t="n"> <v>4242</v> </c>'),
  },
  {
    id: "P39",
    source: "listed",
    change: "a comment between <c> children",
    build: () => c4('<c r="C4" s="0" t="n"><!-- x --><v>4242</v></c>'),
  },
  {
    id: "P40",
    source: "listed",
    change: "a huge <dimension> (A1:ZZZZ99999999999)",
    build: () =>
      loEdit(SHEET1, '<dimension ref="A1:E76"/>', '<dimension ref="A1:ZZZZ99999999999"/>'),
  },
  {
    id: "P41",
    source: "listed",
    change: "04242",
    build: () => c4('<c r="C4" s="0" t="n"><v>04242</v></c>'),
  },
  {
    id: "P42",
    source: "listed",
    change: "4.242E3",
    build: () => c4('<c r="C4" s="0" t="n"><v>4.242E3</v></c>'),
  },
  {
    id: "P43",
    source: "listed",
    change: 's="00"',
    build: () => c4('<c r="C4" s="00" t="n"><v>4242</v></c>'),
  },
  {
    id: "P44",
    source: "listed",
    change: "CRLF between cells",
    build: () => c4(`${C4}\r\n`),
  },
  {
    id: "P45",
    source: "explicit",
    change: "r='C4'",
    build: () => c4(`<c r='C4' s="0" t="n"><v>4242</v></c>`),
  },
  {
    id: "P46",
    source: "explicit",
    change: "D4 (date column) s='1' single-quoted",
    build: () => loEdit(SHEET1, D4, `<c r="D4" s='1' t="n"><v>45447</v></c>`),
  },
  {
    id: "P47",
    source: "listed",
    change: "a tab inside a tag",
    build: () => c4('<c\tr="C4" s="0" t="n"><v>4242</v></c>'),
  },
  {
    id: "P48",
    source: "listed",
    change: "a newline inside a tag",
    build: () => c4('<c r="C4"\ns="0" t="n"><v>4242</v></c>'),
  },
  {
    id: "P49",
    source: "listed",
    change: 't="&#110;"',
    build: () => c4('<c r="C4" s="0" t="&#110;"><v>4242</v></c>'),
  },
  {
    id: "P50",
    source: "explicit",
    change: 'C4 <v>&#49;98</v> as a shared index (198 = "4242")',
    build: () => shared("<si><t>4242</t></si>", '<c r="C4" s="0" t="s"><v>&#49;98</v></c>'),
  },
  {
    id: "P51",
    source: "filled",
    change: "(filled) a processing instruction inside <sheetData>",
    build: () => loEdit(SHEET1, "<sheetData>", "<sheetData><?pi x?>"),
  },
  {
    id: "P52",
    source: "filled",
    change: "(filled) a UTF-8 BOM before the worksheet's XML declaration",
    build: () => loWith({ [SHEET1]: `﻿${loText(SHEET1)}` }),
  },
  {
    id: "P53",
    source: "explicit",
    change: "<x:si> in the sst (C4 -> that string)",
    build: () => shared(`<x:si xmlns:x="${MAIN}"><x:t>4242</x:t></x:si>`),
  },
];

export { LO_BASE };
