/**
 * Round 1 of the gate-integrity PR (verdict comment 7203828539, D1): six shapes, built from
 * the REAL LibreOffice fixture, that the gate verified while the independent grader failed
 * them. Each row here is the verifier's edit verbatim, run through the real read path
 * (`gateOn`) and the grader (`graderOn`). The gate must never verify any of them.
 *
 * Two mechanisms:
 *  - zip (V6): a decoy archive in the EOCD comment, which a reader scanning back for the last
 *    EOCD signature (the grader) takes; and, more generally, bytes no entry covers;
 *  - tree (V1-V5): an in-grammar decoy nested inside an element the gate's reader skipped,
 *    which the grader's whole-text regex finds.
 *
 * Each probe has a named mutant of `src/gate/xlsx-document.ts` that it kills (listed in the
 * PR's round-2 comment); the mutants were run by hand, one at a time.
 */
import { describe, expect, it } from "vitest";
import {
  parseXml,
  readXlsxDocument,
  readZipEntries,
  XlsxError,
} from "../../src/gate/xlsx-document.ts";
import { checkTree, checkUnpinnedTree, DECOY_NAMES, LO_TREES } from "../../src/gate/xlsx-tree.ts";
import {
  editOnce,
  gateOn,
  graderOn,
  LO_BASE,
  loEdit,
  loText,
  loWith,
  SHEET1,
  STYLES,
  TYPES,
  WB_RELS,
  WORKBOOK,
} from "./xlsx-lo-mutate.ts";
import { writerBytes } from "./xlsx-writer-files.ts";
import { entryEnds, withComment, withCommentDecoy, withGap } from "./xlsx-zip-surgery.ts";

const EXACT = writerBytes(LO_BASE);
const PRISTINE = writerBytes("pristine.lo.xlsx");

function zipCode(bytes: Uint8Array): string {
  try {
    readZipEntries(bytes);
    return "read";
  } catch (error) {
    if (error instanceof XlsxError) return error.code;
    throw error;
  }
}

describe("baseline: the unmodified LibreOffice fixture", () => {
  it("verifies, and the grader passes it", async () => {
    expect((await gateOn(EXACT)).verdict).toBe("verified");
    expect(graderOn(EXACT)).toBe("pass");
  });
});

describe("zip: every byte is accounted for, and the EOCD carries no comment (V6)", () => {
  it("V6: a complete decoy archive (pristine.lo.xlsx) in the real EOCD's comment, plus one pad byte", async () => {
    const bytes = withCommentDecoy(EXACT, PRISTINE, 1);
    // The shape is live: the grader reads the decoy (the unedited workbook) and fails it.
    expect(graderOn(bytes)).toBe("fail");
    const gate = await gateOn(bytes);
    expect(gate.verdict).toBe("uncertain");
    expect(gate.reasonCodes).toContain("STATE_CORRUPT");
    expect(gate.reasons.join(" ")).toContain("XLSX_ZIP_MALFORMED");
    expect(zipCode(bytes)).toBe("XLSX_ZIP_MALFORMED");
  });

  it("V6 with no pad byte, and with the decoy as the whole comment, is refused too", () => {
    expect(zipCode(withCommentDecoy(EXACT, PRISTINE, 0))).toBe("XLSX_ZIP_MALFORMED");
    expect(zipCode(withCommentDecoy(EXACT, EXACT, 3))).toBe("XLSX_ZIP_MALFORMED");
  });

  it("any EOCD comment is refused, even a plain one (LibreOffice writes none)", () => {
    expect(zipCode(withComment(EXACT, new TextEncoder().encode("x")))).toBe("XLSX_ZIP_MALFORMED");
    // A comment holding only an EOCD signature (the stray-signature shape).
    const sig = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
    expect(zipCode(withComment(EXACT, sig))).toBe("XLSX_ZIP_MALFORMED");
  });

  it("bytes no entry covers are refused: junk between entries, offsets fixed so the grader still reads it", async () => {
    const ends = entryEnds(EXACT);
    for (const at of [ends[0] as number, ends[3] as number, ends[ends.length - 1] as number]) {
      const bytes = withGap(EXACT, at, new TextEncoder().encode("JUNK-NOBODY-COVERS"));
      // The grader reads every entry through its offsets, so the shape is otherwise intact.
      expect(graderOn(bytes)).toBe("pass");
      expect(zipCode(bytes)).toBe("XLSX_ZIP_MALFORMED");
      expect((await gateOn(bytes)).verdict).toBe("uncertain");
    }
  });

  it("a whole decoy archive hidden in a gap between entries is refused", () => {
    const ends = entryEnds(EXACT);
    expect(zipCode(withGap(EXACT, ends[2] as number, PRISTINE))).toBe("XLSX_ZIP_MALFORMED");
  });

  it("a data descriptor that does not repeat the central directory's values is refused", () => {
    // LibreOffice sets bit 3 and writes `PK\x07\x08` + CRC + sizes after each entry's data.
    const bytes = EXACT.slice();
    const view = new DataView(bytes.buffer);
    const descriptor = (entryEnds(EXACT)[0] as number) - 16;
    expect(view.getUint32(descriptor, true)).toBe(0x08074b50);
    view.setUint32(descriptor + 8, view.getUint32(descriptor + 8, true) + 1, true);
    expect(zipCode(bytes)).toBe("XLSX_ZIP_MALFORMED");
  });

  it("all four LibreOffice fixtures still read (every byte covered, no comment)", () => {
    for (const name of [
      "exact.lo.xlsx",
      "pristine.lo.xlsx",
      "collateral.lo.xlsx",
      "roundtrip-exact.lo.xlsx",
    ])
      expect(zipCode(writerBytes(name)), name).toBe("read");
  });
});

const OD = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A full copy of the real sheetData with C4 (the edited cell, 4242) set back to 1. */
function sheetDataCopyC4Wrong(): string {
  const sheet = loText(SHEET1);
  const data = /<sheetData>[\s\S]*<\/sheetData>/.exec(sheet)?.[0] as string;
  return editOnce(
    data,
    '<c r="C4" s="0" t="n"><v>4242</v></c>',
    '<c r="C4" s="0" t="n"><v>1</v></c>',
  );
}

/**
 * Round 1, V1-V5, verbatim, plus the variants the verifier's nested-decoy family drew. Each
 * row: [label, bytes, the grader's status on them].
 */
const TREE_PROBES: [string, () => Uint8Array, string][] = [
  [
    "V1: <sheetData/> nested inside <sheetPr> (before the real <sheetData>)",
    () =>
      loEdit(
        SHEET1,
        '<pageSetUpPr fitToPage="false"/></sheetPr>',
        '<pageSetUpPr fitToPage="false"/><sheetData/></sheetPr>',
      ),
    "fail",
  ],
  [
    "V1 (copy): a full sheetData copy with C4 wrong, nested inside <sheetPr>",
    () =>
      loEdit(
        SHEET1,
        '<pageSetUpPr fitToPage="false"/></sheetPr>',
        `<pageSetUpPr fitToPage="false"/>${sheetDataCopyC4Wrong()}</sheetPr>`,
      ),
    "fail",
  ],
  [
    'V2: <fileVersion appName="Calc"><workbookPr date1904="true"/></fileVersion>',
    () =>
      loEdit(
        WORKBOOK,
        '<fileVersion appName="Calc"/>',
        '<fileVersion appName="Calc"><workbookPr date1904="true"/></fileVersion>',
      ),
    "fail",
  ],
  [
    'V3: <cellXfs count="1"><xf numFmtId="0"/></cellXfs> nested in <fonts>',
    () => loEdit(STYLES, "</fonts>", '<cellXfs count="1"><xf numFmtId="0"/></cellXfs></fonts>'),
    "fail",
  ],
  [
    'V3 (empty): an empty <cellXfs count="0"></cellXfs> nested in <fonts>',
    () => loEdit(STYLES, "</fonts>", '<cellXfs count="0"></cellXfs></fonts>'),
    "fail",
  ],
  [
    'V4: <numFmt numFmtId="165" formatCode="0"/> nested in <borders>',
    () => loEdit(STYLES, "</borders>", '<numFmt numFmtId="165" formatCode="0"/></borders>'),
    "fail",
  ],
  [
    "V5: the rId4 <Relationship> made non-empty, holding a rId3 worksheet relationship to styles.xml",
    () =>
      loEdit(
        WB_RELS,
        `Target="sharedStrings.xml"/>`,
        `Target="sharedStrings.xml"><Relationship Id="rId3" Type="${OD}/worksheet" Target="styles.xml"/></Relationship>`,
      ),
    "ungradable",
  ],
  // Found while building round 2's nested-decoy family: a names-only allowlist still let a
  // SECOND singleton through at its canonical path. The reader takes the first; the grader
  // takes the last <numFmt> in the text, and any <workbookPr> carrying date1904.
  [
    'V7: a second <numFmts> after the real one, redefining 165 (the date style) as "0"',
    () =>
      loEdit(
        STYLES,
        "</numFmts>",
        '</numFmts><numFmts count="1"><numFmt numFmtId="165" formatCode="0"/></numFmts>',
      ),
    "fail",
  ],
  [
    'V7: a second <workbookPr date1904="true"/> after the real one',
    () =>
      loEdit(
        WORKBOOK,
        "<workbookProtection/>",
        '<workbookPr date1904="true"/><workbookProtection/>',
      ),
    "fail",
  ],
];

describe("tree: every element of a pinned part sits at a path LibreOffice writes (V1-V5, V7)", () => {
  it.each(TREE_PROBES)(
    "%s: the grader is fooled, the gate refuses",
    async (_label, build, graded) => {
      const bytes = build();
      // The shape is live: the grader reads the decoy.
      expect(graderOn(bytes)).toBe(graded);
      const gate = await gateOn(bytes);
      expect(gate.verdict).toBe("uncertain");
      expect(gate.reasonCodes).toEqual(["STATE_CORRUPT"]);
      expect(gate.reasons.join(" ")).toContain("XLSX_TREE_ELEMENT");
    },
  );

  it("a canonical name nested anywhere else in a pinned part is refused (one row per name)", async () => {
    // Each structural name the grader or the reader reads, dropped inside <cols> (worksheet),
    // <bookViews> (workbook), <fills> (styles): never at its canonical path.
    const where: [string, string, string][] = [
      [SHEET1, "</cols>", "worksheet"],
      [WORKBOOK, "</bookViews>", "workbook"],
      [STYLES, "</fills>", "styles"],
    ];
    for (const [part, anchor] of where)
      for (const name of [
        "sheetData",
        "row",
        "c",
        "sheet",
        "sheets",
        "workbookPr",
        "cellXfs",
        "numFmts",
        "numFmt",
        "xf",
        "si",
        "Relationship",
        "Override",
        "Default",
      ]) {
        const bytes = loEdit(part, anchor, `<${name}/>${anchor}`);
        const gate = await gateOn(bytes);
        expect(gate.verdict, `${name} in ${part}`).toBe("uncertain");
        expect(gate.reasons.join(" "), `${name} in ${part}`).toContain("XLSX_");
      }
  });

  it("no element may sit inside a <Relationship>, <Override> or <Default>", async () => {
    const override = loEdit(
      TYPES,
      '<Default Extension="png" ContentType="image/png"/>',
      '<Default Extension="png" ContentType="image/png"><Override PartName="/xl/workbook.xml" ContentType="application/xml"/></Default>',
    );
    const inOverride = loEdit(
      TYPES,
      /<Override PartName="\/xl\/workbook.xml" ContentType="([^"]*)"\/>/,
      '<Override PartName="/xl/workbook.xml" ContentType="$1"><Default Extension="xml" ContentType="application/xml"/></Override>',
    );
    const rootRel = loWith({
      "_rels/.rels": editOnce(
        loText("_rels/.rels"),
        /Target="xl\/workbook.xml"\/>/,
        'Target="xl/workbook.xml"><Relationship Id="rIdX" Type="x" Target="y"/></Relationship>',
      ),
    });
    for (const bytes of [override, inOverride, rootRel]) {
      const gate = await gateOn(bytes);
      expect(gate.verdict).toBe("uncertain");
      expect(gate.reasons.join(" ")).toContain("XLSX_TREE_ELEMENT");
    }
  });

  it("docProps and the theme (read by no one) may hold no decoy name anywhere", async () => {
    const app = loText("docProps/app.xml");
    const bytes = loWith({
      "docProps/app.xml": editOnce(app, "<TotalTime>", "<sheetData/><TotalTime>"),
    });
    const gate = await gateOn(bytes);
    expect(gate.verdict).toBe("uncertain");
    expect(gate.reasons.join(" ")).toContain("XLSX_TREE_ELEMENT");
    const theme = loText("xl/theme/theme1.xml");
    const themed = loWith({
      "xl/theme/theme1.xml": editOnce(
        theme,
        "</a:themeElements>",
        "<a:sheetData/></a:themeElements>",
      ),
    });
    expect((await gateOn(themed)).verdict).toBe("uncertain");
  });

  it("checkTree unit rows: the namespace rule, the root rule, and leaves", () => {
    const enc = (x: string) => parseXml(new TextEncoder().encode(x));
    const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    // An allowed path in another namespace (the pre-scan refuses the declaration first in a
    // workbook; checkTree refuses it on its own too).
    expect(
      checkTree(enc(`<sst xmlns="${MAIN}"><si xmlns="urn:x"><t>a</t></si></sst>`), "sst"),
    ).toBe("XLSX_TREE_ELEMENT");
    expect(checkTree(enc(`<sst xmlns="${MAIN}"><si><t>a</t></si></sst>`), "sst")).toBeUndefined();
    // The one foreign element LibreOffice writes, and only there.
    const wb = (inner: string) =>
      enc(
        `<workbook xmlns="${MAIN}"><sheets><sheet/></sheets><extLst><ext xmlns:loext="http://schemas.libreoffice.org/">${inner}</ext></extLst></workbook>`,
      );
    expect(checkTree(wb("<loext:extCalcPr/>"), "workbook")).toBeUndefined();
    expect(checkTree(wb("<extCalcPr/>"), "workbook")).toBe("XLSX_TREE_ELEMENT");
    // A root the schema does not know.
    expect(checkTree(enc(`<worksheet xmlns="${MAIN}"/>`), "sst")).toBe("XLSX_TREE_ELEMENT");
    expect(checkTree(enc(`<toString xmlns="${MAIN}"/>`), "sst")).toBe("XLSX_TREE_ELEMENT");
    // Text in a leaf is fine; an element in a leaf is not.
    expect(checkTree(enc(`<sst xmlns="${MAIN}"><si><t>a<b/></t></si></sst>`), "sst")).toBe(
      "XLSX_TREE_ELEMENT",
    );
    expect(
      checkUnpinnedTree(enc("<Properties><TotalTime>0</TotalTime></Properties>")),
    ).toBeUndefined();
    for (const name of DECOY_NAMES)
      expect(checkUnpinnedTree(enc(`<Properties><x><${name}/></x></Properties>`)), name).toBe(
        "XLSX_TREE_ELEMENT",
      );
  });

  it("every LibreOffice fixture's tree is inside the allowlist (no path of theirs is refused)", () => {
    for (const name of [
      "exact.lo.xlsx",
      "pristine.lo.xlsx",
      "collateral.lo.xlsx",
      "roundtrip-exact.lo.xlsx",
    ])
      expect(() => readXlsxDocument(writerBytes(name)), name).not.toThrow();
    expect(Object.keys(LO_TREES).sort()).toEqual([
      "rels",
      "sst",
      "styles",
      "types",
      "workbook",
      "worksheet",
    ]);
  });
});

/** The reader's own code on `bytes` ("read" when it accepts them). */
function readCode(bytes: Uint8Array): string {
  try {
    readXlsxDocument(bytes);
    return "read";
  } catch (error) {
    if (error instanceof XlsxError) return error.code;
    throw error;
  }
}

describe("round 1's two surviving mutants (both guards from #503), now pinned by their own code", () => {
  // The element-tree pin runs last and would refuse both shapes too (XLSX_TREE_ELEMENT), so
  // each row pins the EARLIER guard's own code: removing that guard changes the code.
  it('a <sheet> hidden outside <sheets> is XLSX_XML_UNSUPPORTED (the countNamed(workbook, "sheet") guard)', async () => {
    for (const [anchor, hidden] of [
      ["</bookViews>", '<sheet name="h" sheetId="2" state="visible" r:id="rId3"/></bookViews>'],
      [
        '<fileVersion appName="Calc"/>',
        '<fileVersion appName="Calc"><sheet name="h" sheetId="2" state="visible" r:id="rId3"/></fileVersion>',
      ],
    ] as const) {
      const bytes = loEdit(WORKBOOK, anchor, hidden);
      expect(readCode(bytes)).toBe("XLSX_XML_UNSUPPORTED");
      expect((await gateOn(bytes)).verdict).toBe("uncertain");
    }
  });

  it("two <dimension> elements are XLSX_CELL_MALFORMED (the dims.length > 1 guard), even when the first is right", async () => {
    const sheet = loText(SHEET1);
    const dim = /<dimension ref="[^"]*"\/>/.exec(sheet)?.[0] as string;
    for (const second of [dim, '<dimension ref="A1"/>']) {
      const bytes = loEdit(SHEET1, dim, `${dim}${second}`);
      expect(readCode(bytes)).toBe("XLSX_CELL_MALFORMED");
      expect((await gateOn(bytes)).verdict).toBe("uncertain");
    }
  });
});
