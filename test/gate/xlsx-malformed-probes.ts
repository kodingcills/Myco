/**
 * Round 3, D6: malformed cell and string structure. Each probe is LibreOffice's own exact
 * workbook (`test/fixtures/calc-xlsx-writers/exact.lo.xlsx`, the verifier's base) with only
 * the target cell C4 changed, and, for a shared-string probe, one item appended to the
 * shared-string table. The gate must refuse every one with the listed code: it accepts
 * only the narrow shapes real writers produce and never guesses how an app would read the
 * rest. Shared by `xlsx-document.test.ts` (codes, through the gate) and the soundness table
 * in `xlsx-parity.test.ts` (against the independent grader).
 */
import { readZipEntries, type XlsxErrorCode } from "../../src/gate/xlsx-document.ts";
import { writeZip } from "../../src/tasks/writer-docgen.ts";
import { writerBytes } from "./xlsx-writer-files.ts";

export interface StructureProbe {
  readonly name: string;
  /** The target cell's XML; `REF` = its reference, `SI` = the appended item's index. */
  readonly cell: string;
  /** Appended to the shared-string table, before `</sst>`. */
  readonly sst?: string;
}

export interface MalformedProbe extends StructureProbe {
  readonly code: XlsxErrorCode;
  /**
   * What the independent grader made of it in the round-2 verdict (comment 7190857934),
   * for the eight probes the gate wrongly verified there. `fail` rows are the false
   * VERIFIEDs this round closes.
   */
  readonly grader?: "pass" | "fail" | "ungradable";
}

const TARGET = "C4";
const LO_TARGET_CELL = `<c r="${TARGET}" s="0" t="n"><v>4242</v></c>`;
const EXACT_CELL = '<c r="REF" s="0" t="n"><v>4242</v></c>';
const SHEET = "xl/worksheets/sheet1.xml";
const SST = "xl/sharedStrings.xml";

/** LibreOffice's exact workbook with the probe applied (entries repacked in order). */
export function probeWorkbook(probe: StructureProbe): Uint8Array {
  const entries = readZipEntries(writerBytes("exact.lo.xlsx"));
  const text = (name: string) => new TextDecoder().decode(entries.get(name));
  const sst = text(SST);
  const index = (sst.match(/<si>/g) ?? []).length;
  const sheet = text(SHEET);
  if (!sheet.includes(LO_TARGET_CELL)) throw new Error("target cell not found");
  const patched = new Map<string, string>([
    [
      SHEET,
      sheet.replace(
        LO_TARGET_CELL,
        probe.cell.replaceAll("REF", TARGET).replaceAll("SI", String(index)),
      ),
    ],
  ]);
  if (probe.sst !== undefined) patched.set(SST, sst.replace("</sst>", `${probe.sst}</sst>`));
  return writeZip(
    [...entries].map(([name, data]) => {
      const next = patched.get(name);
      return { name, data: next === undefined ? data : new TextEncoder().encode(next) };
    }),
  );
}

/** Shapes real writers produce: each must still read as 4242 and verify (no over-refusal). */
export const ACCEPTED: StructureProbe[] = [
  { name: "number (LibreOffice's own cell)", cell: EXACT_CELL },
  { name: "inline string, one <t>", cell: '<c r="REF" t="inlineStr"><is><t>4242</t></is></c>' },
  {
    name: 'inline string, <t xml:space="preserve">',
    cell: '<c r="REF" t="inlineStr"><is><t xml:space="preserve">4242</t></is></c>',
  },
  {
    name: "inline rich runs, one with <rPr>",
    cell: '<c r="REF" t="inlineStr"><is><r><rPr><b/><sz val="10"/></rPr><t>42</t></r><r><t>42</t></r></is></c>',
  },
  {
    name: "inline string, whitespace between elements",
    cell: '<c r="REF" t="inlineStr">\n  <is>\n    <t>4242</t>\n  </is>\n</c>',
  },
  {
    name: "shared string, one <t>",
    cell: '<c r="REF" s="0" t="s"><v>SI</v></c>',
    sst: "<si><t>4242</t></si>",
  },
  {
    name: "shared string, rich runs",
    cell: '<c r="REF" s="0" t="s"><v>SI</v></c>',
    sst: '<si><r><rPr><i/></rPr><t xml:space="preserve">42</t></r><r><t>42</t></r></si>',
  },
];

const INLINE = (is: string) => `<c r="REF" s="0" t="inlineStr">${is}</c>`;
const SHARED = '<c r="REF" s="0" t="s"><v>SI</v></c>';

export const MALFORMED: MalformedProbe[] = [
  // The eight probes of the round-2 verdict (D6), verbatim on C4.
  {
    name: "c01: <v> before <is> on an inlineStr cell",
    cell: INLINE("<v>999</v><is><t>4242</t></is>"),
    code: "XLSX_CELL_MALFORMED",
    grader: "pass",
  },
  {
    name: "c02: <v> after <is> on an inlineStr cell",
    cell: INLINE("<is><t>4242</t></is><v>999</v>"),
    code: "XLSX_CELL_MALFORMED",
    grader: "pass",
  },
  {
    name: "c05: <t> inside <v>",
    cell: '<c r="REF" s="0" t="n"><v>42<t>99</t>42</v></c>',
    code: "XLSX_CELL_MALFORMED",
    grader: "ungradable",
  },
  {
    name: "c12: two <t> in one inline run",
    cell: INLINE("<is><r><t>42</t><t>99</t></r><r><t>42</t></r></is>"),
    code: "XLSX_CELL_MALFORMED",
    grader: "fail",
  },
  {
    name: "c15: <v> inside <v>",
    cell: '<c r="REF" s="0" t="n"><v>42<v>9</v>42</v></c>',
    code: "XLSX_CELL_MALFORMED",
    grader: "ungradable",
  },
  {
    name: "c16: <t> inside an inline <t>",
    cell: INLINE("<is><t>42<t>9</t>42</t></is>"),
    code: "XLSX_CELL_MALFORMED",
    grader: "fail",
  },
  {
    name: "k02: <t> inside a shared <t>",
    cell: SHARED,
    sst: "<si><t>42<t>99</t>42</t></si>",
    code: "XLSX_CELL_MALFORMED",
    grader: "fail",
  },
  {
    name: "k03: two <t> in one shared run",
    cell: SHARED,
    sst: "<si><r><t>42</t><t>99</t></r><r><t>42</t></r></si>",
    code: "XLSX_CELL_MALFORMED",
    grader: "fail",
  },
  // V15: several <t> directly in <is> / <si>.
  {
    name: "V15: two <t> in <is>",
    cell: INLINE("<is><t>99</t><t>4242</t></is>"),
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "two <t> in <si>",
    cell: SHARED,
    sst: "<si><t>42</t><t>42</t></si>",
    code: "XLSX_CELL_MALFORMED",
  },
  // A mix of <t> and <r>.
  {
    name: "<t> then <r> in <is>",
    cell: INLINE("<is><t>42</t><r><t>42</t></r></is>"),
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "<r> then <t> in <is>",
    cell: INLINE("<is><r><t>42</t></r><t>42</t></is>"),
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "<r> then <t> in <si>",
    cell: SHARED,
    sst: "<si><r><t>42</t></r><t>42</t></si>",
    code: "XLSX_CELL_MALFORMED",
  },
  // Empty or incomplete string structure.
  { name: "empty <is>", cell: INLINE("<is/>"), code: "XLSX_CELL_MALFORMED" },
  { name: "empty <si>", cell: SHARED, sst: "<si/>", code: "XLSX_CELL_MALFORMED" },
  {
    name: "empty run <r/>",
    cell: INLINE("<is><r/><r><t>4242</t></r></is>"),
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "run with <rPr> only",
    cell: INLINE("<is><r><rPr/></r><r><t>4242</t></r></is>"),
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "run with <rPr> after <t>",
    cell: INLINE("<is><r><t>4242</t><rPr/></r></is>"),
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "run with two <rPr>",
    cell: INLINE("<is><r><rPr/><rPr/><t>4242</t></r></is>"),
    code: "XLSX_CELL_MALFORMED",
  },
  // Text where only elements belong; an element where only text belongs.
  {
    name: "text directly in <c>",
    cell: '<c r="REF" s="0" t="n">42<v>4242</v></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "text directly in <is>",
    cell: INLINE("<is>42<t>42</t></is>"),
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "text directly in <r>",
    cell: INLINE("<is><r>42<t>42</t></r></is>"),
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "text directly in <si>",
    cell: SHARED,
    sst: "<si>42<t>42</t></si>",
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "a foreign-namespace element inside <t>",
    cell: INLINE('<is><t>42<x:y xmlns:x="urn:x"/>42</t></is>'),
    code: "XLSX_PRESCAN_NAMESPACE",
  },
  {
    name: "an element inside <f>",
    cell: '<c r="REF" s="0" t="n"><f>1<v/>+1</f><v>4242</v></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "content inside a run property",
    cell: INLINE("<is><r><rPr><b>99</b></rPr><t>4242</t></r></is>"),
    code: "XLSX_CELL_MALFORMED",
  },
  // Cell children: order, count, and <v>/<is> by cell type.
  {
    name: "<f> after <v>",
    cell: '<c r="REF" s="0" t="n"><v>4242</v><f>C3</f></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "two <v>",
    cell: '<c r="REF" s="0" t="n"><v>4242</v><v>1</v></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  { name: "<v> on an inlineStr cell", cell: INLINE("<v>4242</v>"), code: "XLSX_CELL_MALFORMED" },
  {
    name: '<is> on a t="n" cell',
    cell: '<c r="REF" s="0" t="n"><is><t>4242</t></is></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "<is> on a cell with no t",
    cell: '<c r="REF" s="0"><is><t>4242</t></is></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: '<is> on a t="str" cell',
    cell: '<c r="REF" s="0" t="str"><is><t>4242</t></is></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "<f> with <is>",
    cell: INLINE("<f>C3</f><is><t>4242</t></is>"),
    code: "XLSX_CELL_MALFORMED",
  },
  // Shared-string indexes: canonical decimals in range only.
  {
    name: "shared index out of range",
    cell: '<c r="REF" s="0" t="s"><v>999999</v></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "shared index with a leading zero",
    cell: '<c r="REF" s="0" t="s"><v>0SI</v></c>',
    sst: "<si><t>4242</t></si>",
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "shared index 1.0-style",
    cell: '<c r="REF" s="0" t="s"><v>SI.0</v></c>',
    sst: "<si><t>4242</t></si>",
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "shared index with a sign",
    cell: '<c r="REF" s="0" t="s"><v>+SI</v></c>',
    sst: "<si><t>4242</t></si>",
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "shared index with a space",
    cell: '<c r="REF" s="0" t="s"><v> SI</v></c>',
    sst: "<si><t>4242</t></si>",
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "shared index empty",
    cell: '<c r="REF" s="0" t="s"><v></v></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  // Unknown elements inside <c>, <is>, <si>, <r>, <rPr>, and <sst>.
  {
    name: "<extLst> inside <c>",
    cell: '<c r="REF" s="0" t="n"><v>4242</v><extLst/></c>',
    code: "XLSX_XML_UNSUPPORTED",
  },
  {
    name: "an unknown element inside <c>",
    cell: '<c r="REF" s="0" t="n"><x/><v>4242</v></c>',
    code: "XLSX_XML_UNSUPPORTED",
  },
  {
    name: "a foreign-namespace element inside <c>",
    cell: '<c r="REF" s="0" t="n"><v>4242</v><x:y xmlns:x="urn:x"/></c>',
    code: "XLSX_PRESCAN_NAMESPACE",
  },
  {
    name: "phonetic run <rPh> in <is> (the grader reads its text, LibreOffice skips it)",
    cell: INLINE('<is><t>4242</t><rPh sb="0" eb="1"><t>9</t></rPh></is>'),
    code: "XLSX_XML_UNSUPPORTED",
  },
  {
    name: "<phoneticPr> in <si>",
    cell: SHARED,
    sst: '<si><t>4242</t><phoneticPr fontId="0"/></si>',
    code: "XLSX_XML_UNSUPPORTED",
  },
  {
    name: "an unknown element inside <is>",
    cell: INLINE("<is><t>4242</t><x/></is>"),
    code: "XLSX_XML_UNSUPPORTED",
  },
  {
    name: "an unknown element inside <r>",
    cell: INLINE("<is><r><t>4242</t><x/></r></is>"),
    code: "XLSX_XML_UNSUPPORTED",
  },
  {
    name: "an unknown element inside <si>",
    cell: SHARED,
    sst: "<si><x/><t>4242</t></si>",
    code: "XLSX_XML_UNSUPPORTED",
  },
  {
    name: "a <t> inside <rPr>",
    cell: INLINE("<is><r><rPr><t>99</t></rPr><t>4242</t></r></is>"),
    code: "XLSX_XML_UNSUPPORTED",
  },
  {
    name: "a non-<si> item in <sst>",
    cell: EXACT_CELL,
    sst: "<extLst/>",
    code: "XLSX_XML_UNSUPPORTED",
  },
  // Attributes: only the ones real writers put there.
  {
    name: 'vm="1" on <c> (a rich value would replace <v>)',
    cell: '<c r="REF" s="0" t="n" vm="1"><v>4242</v></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: 'cm="1" on <c>',
    cell: '<c r="REF" s="0" t="n" cm="1"><v>4242</v></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "an attribute on <v>",
    cell: '<c r="REF" s="0" t="n"><v x="1">4242</v></c>',
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "an attribute on <is>",
    cell: INLINE('<is x="1"><t>4242</t></is>'),
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: "an unknown attribute on <t>",
    cell: INLINE('<is><t x="1">4242</t></is>'),
    code: "XLSX_CELL_MALFORMED",
  },
  {
    name: 'xml:space="bogus" on <t>',
    cell: INLINE('<is><t xml:space="bogus">4242</t></is>'),
    code: "XLSX_CELL_MALFORMED",
  },
  // V8: a duplicate raw attribute. Last-wins would read t="n" and verify 4242.
  {
    name: 'V8: duplicate t (t="s" t="n")',
    cell: '<c r="REF" s="0" t="s" t="n"><v>4242</v></c>',
    code: "XLSX_XML_MALFORMED",
  },
];
