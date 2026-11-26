/**
 * Fixed part names and relationships (src/gate/xlsx-parts.ts): unit rows on plain records,
 * then end to end on a real LibreOffice workbook, where each refusal is a shape #503
 * verified (P14, P15) or could have.
 */
import { describe, expect, it } from "vitest";
import {
  checkPartNames,
  checkRelationships,
  FIXED_PARTS,
  type RawRelationship,
} from "../../src/gate/xlsx-parts.ts";
import {
  editOnce,
  gateOn,
  graderOn,
  LO_BASE,
  loEdit,
  loParts,
  loText,
  loWith,
  ROOT_RELS,
  SHEET1,
  SST,
  STYLES,
  TYPES,
  WB_RELS,
  WORKBOOK,
} from "./xlsx-lo-mutate.ts";

const OD = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rel = (id: string, type: string, target: string, extra = 0): RawRelationship => ({
  id,
  type: type.startsWith("http") ? type : `${OD}/${type}`,
  target,
  extraAttributes: extra,
});

const LO_NAMES = loParts().map(([n]) => n);
const ROOT = [
  rel("rId1", "officeDocument", "xl/workbook.xml"),
  rel(
    "rId2",
    "http://schemas.openxmlformats.org/officedocument/2006/relationships/metadata/core-properties",
    "docProps/core.xml",
  ),
  rel("rId3", "extended-properties", "docProps/app.xml"),
];
const WB = [
  rel("rId1", "theme", "theme/theme1.xml"),
  rel("rId2", "styles", "styles.xml"),
  rel("rId3", "worksheet", "worksheets/sheet1.xml"),
  rel("rId4", "sharedStrings", "sharedStrings.xml"),
];
const OVERRIDES = LO_NAMES.filter((n) => n !== TYPES).map((n) => `/${n}`);
const base: {
  names: string[];
  rootRels: RawRelationship[];
  workbookRels: RawRelationship[];
  sheetIds: (string | undefined)[];
  overrides: (string | undefined)[];
} = {
  names: LO_NAMES,
  rootRels: ROOT,
  workbookRels: WB,
  sheetIds: ["rId3"],
  overrides: OVERRIDES,
};

describe("checkPartNames", () => {
  it("accepts exactly LibreOffice's parts", () => {
    expect(LO_NAMES.sort()).toEqual([...FIXED_PARTS, SHEET1].sort());
    expect(checkPartNames(LO_NAMES)).toBeUndefined();
    expect(checkPartNames([...LO_NAMES, "xl/worksheets/sheet2.xml"])).toBeUndefined();
  });

  it.each([
    "xl/ss2.xml",
    "xl/wb2.xml",
    "xl/worksheets/sheet0.xml",
    "xl/worksheets/sheet01.xml",
    "xl/worksheets/Sheet1.xml",
    "xl/worksheets/_rels/sheet1.xml.rels",
    "xl/media/image1.png",
    "xl/drawings/drawing1.xml",
    "xl/theme/theme2.xml",
    "docProps/custom.xml",
    "xl/sharedstrings.xml",
    "workbook.xml",
  ])("refuses %s (XLSX_PART_UNEXPECTED)", (name) => {
    expect(checkPartNames([...LO_NAMES, name])).toBe("XLSX_PART_UNEXPECTED");
  });
});

describe("checkRelationships", () => {
  it("accepts LibreOffice's relationships", () => {
    expect(checkRelationships(base)).toBeUndefined();
    // The standard package URI for core-properties (as the generator writes it) too.
    const pkg = [
      ROOT[0] as RawRelationship,
      rel(
        "rId2",
        "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
        "docProps/core.xml",
      ),
      ROOT[2] as RawRelationship,
    ];
    expect(checkRelationships({ ...base, rootRels: pkg })).toBeUndefined();
  });

  const swapWb = (k: number, r: RawRelationship) => WB.map((x, i) => (i === k ? r : x));
  it.each<[string, Partial<typeof base>, string]>([
    [
      "a missing Target",
      { workbookRels: swapWb(1, { ...(WB[1] as RawRelationship), target: undefined }) },
      "XLSX_REL_TARGET",
    ],
    [
      "a missing Id",
      { workbookRels: swapWb(1, { ...(WB[1] as RawRelationship), id: undefined }) },
      "XLSX_REL_TARGET",
    ],
    [
      "an extra attribute (TargetMode)",
      { workbookRels: swapWb(1, rel("rId2", "styles", "styles.xml", 1)) },
      "XLSX_REL_TARGET",
    ],
    [
      "an unknown type",
      { workbookRels: [...WB, rel("rId9", "hyperlink", "styles.xml")] },
      "XLSX_REL_TARGET",
    ],
    [
      "sharedStrings moved to a copy (P14)",
      { workbookRels: swapWb(3, rel("rId4", "sharedStrings", "ss2.xml")) },
      "XLSX_REL_TARGET",
    ],
    [
      "officeDocument moved to a copy (P15)",
      { rootRels: [rel("rId1", "officeDocument", "xl/wb2.xml"), ...ROOT.slice(1)] },
      "XLSX_REL_TARGET",
    ],
    [
      "an absolute target",
      { workbookRels: swapWb(1, rel("rId2", "styles", "/xl/styles.xml")) },
      "XLSX_REL_TARGET",
    ],
    [
      "a ./ target",
      { workbookRels: swapWb(1, rel("rId2", "styles", "./styles.xml")) },
      "XLSX_REL_TARGET",
    ],
    [
      "a worksheet type aimed at the sst",
      { workbookRels: swapWb(2, rel("rId3", "worksheet", "sharedStrings.xml")) },
      "XLSX_REL_TARGET",
    ],
    [
      "a duplicate id",
      { workbookRels: [...WB, rel("rId3", "worksheet", "worksheets/sheet2.xml")] },
      "XLSX_REL_TARGET",
    ],
    [
      "two relationships to one part",
      { workbookRels: [...WB, rel("rId9", "worksheet", "worksheets/sheet1.xml")] },
      "XLSX_REL_TARGET",
    ],
    [
      "a second officeDocument",
      { rootRels: [...ROOT, rel("rId9", "officeDocument", "xl/workbook.xml")] },
      "XLSX_REL_TARGET",
    ],
    ["a <sheet> naming no relationship", { sheetIds: ["rId9"] }, "XLSX_REL_TARGET"],
    ["a <sheet> naming the styles relationship", { sheetIds: ["rId2"] }, "XLSX_REL_TARGET"],
    ["two <sheet>s naming one worksheet", { sheetIds: ["rId3", "rId3"] }, "XLSX_REL_TARGET"],
    ["a <sheet> without r:id", { sheetIds: [undefined] }, "XLSX_REL_TARGET"],
    [
      "a worksheet relationship no <sheet> names",
      {
        names: [...LO_NAMES, "xl/worksheets/sheet2.xml"],
        workbookRels: [...WB, rel("rId9", "worksheet", "worksheets/sheet2.xml")],
      },
      "XLSX_PART_UNREFERENCED",
    ],
    [
      "a decoy entry nothing references",
      { names: [...LO_NAMES, "xl/worksheets/sheet2.xml"] },
      "XLSX_PART_UNREFERENCED",
    ],
    [
      "the canonical sst left behind when its relationship is gone",
      { workbookRels: WB.slice(0, 3) },
      "XLSX_PART_UNREFERENCED",
    ],
    [
      "an override naming a missing part",
      { overrides: [...OVERRIDES, "/xl/ghost.xml"] },
      "XLSX_PART_UNREFERENCED",
    ],
    [
      "an override without a leading slash",
      { overrides: [...OVERRIDES, "xl/styles.xml"] },
      "XLSX_PART_UNREFERENCED",
    ],
  ])("%s", (_name, change, code) => {
    expect(checkRelationships({ ...base, ...change })).toBe(code);
  });
});

describe("end to end on a real LibreOffice workbook: never verified", () => {
  const cases: [string, () => Uint8Array, string][] = [
    [
      "P14: sharedStrings relationship to a copy, decoy left at xl/sharedStrings.xml",
      () =>
        loWith({
          [WB_RELS]: editOnce(loText(WB_RELS), 'Target="sharedStrings.xml"', 'Target="ss2.xml"'),
          "xl/ss2.xml": loText(SST),
        }),
      "XLSX_PART_UNEXPECTED",
    ],
    [
      "P15: officeDocument relationship to a copy, decoy xl/workbook.xml with two sheets",
      () =>
        loWith({
          [ROOT_RELS]: editOnce(
            loText(ROOT_RELS),
            'Target="xl/workbook.xml"',
            'Target="xl/wb2.xml"',
          ),
          "xl/wb2.xml": loText(WORKBOOK),
        }),
      "XLSX_PART_UNEXPECTED",
    ],
    [
      "the sst relationship aimed at a second worksheet name",
      () =>
        loWith({
          [WB_RELS]: editOnce(
            loText(WB_RELS),
            'Target="sharedStrings.xml"',
            'Target="worksheets/sheet2.xml"',
          ),
          "xl/worksheets/sheet2.xml": loText(SST),
        }),
      // The sst bytes at a worksheet name fail the worksheet's pinned root first.
      "XLSX_PRESCAN_NAMESPACE",
    ],
    [
      "a decoy second worksheet, referenced by nothing",
      () => loWith({ "xl/worksheets/sheet2.xml": loText(SHEET1) }),
      "XLSX_PART_UNREFERENCED",
    ],
    [
      "a decoy worksheet with its relationship but no <sheet>",
      () =>
        loWith({
          [WB_RELS]: editOnce(
            loText(WB_RELS),
            "\n</Relationships>",
            `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>\n</Relationships>`,
          ),
          "xl/worksheets/sheet2.xml": loText(SHEET1),
        }),
      "XLSX_PART_UNREFERENCED",
    ],
    [
      "the styles relationship dropped, xl/styles.xml left in place",
      () =>
        loEdit(WB_RELS, /<Relationship Id="rId2" Type="[^"]*\/styles" Target="styles.xml"\/>/, ""),
      "XLSX_PART_UNREFERENCED",
    ],
    [
      "an absolute relationship target to the same part",
      () => loEdit(WB_RELS, 'Target="styles.xml"', 'Target="/xl/styles.xml"'),
      "XLSX_REL_TARGET",
    ],
    [
      "a worksheet relationships part",
      () =>
        loWith({
          "xl/worksheets/_rels/sheet1.xml.rels": loText(ROOT_RELS),
        }),
      "XLSX_PART_UNEXPECTED",
    ],
    [
      "a decoy content-type override",
      () =>
        loEdit(
          TYPES,
          "\n</Types>",
          '<Override PartName="/xl/ghost.xml" ContentType="application/xml"/>\n</Types>',
        ),
      "XLSX_PART_UNREFERENCED",
    ],
  ];

  it.each(cases)("%s", async (_name, build, code) => {
    const bytes = build();
    expect(await gateOn(bytes)).toEqual({
      verdict: "uncertain",
      reasonCodes: ["STATE_CORRUPT"],
      reasons: [`could not look: persisted document is not a readable xlsx document (${code})`],
    });
  });

  it("the base workbook itself verifies, and the grader passes it", async () => {
    expect(LO_BASE).toBe("exact.lo.xlsx");
    const bytes = loWith({});
    expect((await gateOn(bytes)).verdict).toBe("verified");
    expect(graderOn(bytes)).toBe("pass");
    expect(loText(STYLES)).toContain("<styleSheet");
  });
});
