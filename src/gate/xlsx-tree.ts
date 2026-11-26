/**
 * The element tree of every pinned part, pinned to LibreOffice's (gate-integrity PR, round 1,
 * D1 V1-V5).
 *
 * The gate's reader finds what it reads by walking down from the root (`sheetData` as a
 * direct child of `worksheet`, `cellXfs` as a direct child of `styleSheet`, and so on). The
 * independent grader does not walk a tree: it regex-scans the WHOLE text of each part and
 * takes the first (or, for numFmt and Relationship, the last) match. So an in-grammar decoy
 * nested inside an element the reader skips (a `<sheetData>` inside `<sheetPr>`, a
 * `<workbookPr date1904="true">` inside `<fileVersion>`, a `<cellXfs>` inside `<fonts>`, a
 * `<numFmt>` inside `<borders>`, a `<Relationship>` inside a `<Relationship>`) was invisible
 * to the gate and read by the grader.
 *
 * Here every element of a pinned part (workbook, worksheet, shared strings, styles, content
 * types, relationships) must sit at a path LibreOffice writes: for each parent path, an
 * allowlist of child local names. An element whose path is not a key below must have NO
 * element children (a leaf: `<v>`, `<t>`, `<f>`, `<Relationship>`, `<Override>`, `<Default>`,
 * `<numFmt>`, `<xf>`'s `<alignment>` ...). Every element is in the root's namespace, except
 * the one foreign element LibreOffice writes (`loext:extCalcPr`, in the workbook's
 * `<extLst>`). So every `sheetData`, `row`, `c`, `sheet`, `sheets`, `workbookPr`, `cellXfs`,
 * `numFmts`, `numFmt`, `xf`, `si`, `Relationship`, `Override` and `Default` in a pinned part
 * is at its canonical path, and no element can hide anything below a leaf.
 *
 * docProps and the theme are not pinned (no reader, the gate's or the grader's, looks inside
 * them), but none of them may hold an element with one of the names either reader reads
 * structurally (`DECOY_NAMES`), anywhere.
 *
 * The allowlist is LibreOffice 24.2's output for the committed fixtures
 * (test/fixtures/calc-xlsx-writers/*.lo.xlsx, test/fixtures/calc-xlsx-lo-grammar/), plus:
 * the cell and string shapes the cell reader already accepts (inline strings and rich-text
 * runs, `<f>`), and the formatting-only leaves of a font, fill and border record that
 * LibreOffice writes when a cell is formatted (bold, colour). None of the additions is a
 * name either reader reads structurally, and all are leaves.
 *
 * Pure function over the parsed tree; codes only.
 */
import type { XmlElement } from "./xlsx-document.ts";
import type { ContentPartKind } from "./xlsx-prescan.ts";

export type TreeCode = "XLSX_TREE_ELEMENT";

/** Run-property leaves (`<rPr>` in a rich-text run, and a `<font>` record in styles). */
const RUN_PROPERTIES = [
  "b",
  "i",
  "u",
  "sz",
  "color",
  "rFont",
  "name",
  "family",
  "scheme",
  "strike",
  "vertAlign",
  "charset",
  "outline",
  "shadow",
  "condense",
  "extend",
];
const STRING_ITEM = { "": ["t", "r"], r: ["rPr", "t"], "r/rPr": RUN_PROPERTIES } as const;

/** Prefix every key of a sub-schema with `at/`. */
function under(at: string, schema: Readonly<Record<string, readonly string[]>>) {
  return Object.fromEntries(
    Object.entries(schema).map(([k, v]) => [k === "" ? at : `${at}/${k}`, v]),
  );
}

/**
 * Allowed children by parent path (local names, `/`-joined from the root). A path that is
 * not a key holds no element children.
 */
export const LO_TREES: Readonly<
  Record<ContentPartKind, Readonly<Record<string, readonly string[]>>>
> = {
  workbook: {
    workbook: [
      "fileVersion",
      "workbookPr",
      "workbookProtection",
      "bookViews",
      "sheets",
      "calcPr",
      "extLst",
    ],
    "workbook/bookViews": ["workbookView"],
    "workbook/sheets": ["sheet"],
    "workbook/extLst": ["ext"],
    "workbook/extLst/ext": ["extCalcPr"],
  },
  worksheet: {
    worksheet: [
      "sheetPr",
      "dimension",
      "sheetViews",
      "sheetFormatPr",
      "cols",
      "sheetData",
      "printOptions",
      "pageMargins",
      "pageSetup",
      "headerFooter",
    ],
    "worksheet/sheetPr": ["pageSetUpPr"],
    "worksheet/sheetViews": ["sheetView"],
    "worksheet/sheetViews/sheetView": ["selection"],
    "worksheet/cols": ["col"],
    "worksheet/sheetData": ["row"],
    "worksheet/sheetData/row": ["c"],
    "worksheet/sheetData/row/c": ["f", "v", "is"],
    ...under("worksheet/sheetData/row/c/is", STRING_ITEM),
    "worksheet/headerFooter": ["oddHeader", "oddFooter"],
  },
  sst: {
    sst: ["si"],
    ...under("sst/si", STRING_ITEM),
  },
  styles: {
    styleSheet: ["numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles"],
    "styleSheet/numFmts": ["numFmt"],
    "styleSheet/fonts": ["font"],
    "styleSheet/fonts/font": RUN_PROPERTIES,
    "styleSheet/fills": ["fill"],
    "styleSheet/fills/fill": ["patternFill"],
    "styleSheet/fills/fill/patternFill": ["fgColor", "bgColor"],
    "styleSheet/borders": ["border"],
    "styleSheet/borders/border": ["left", "right", "top", "bottom", "diagonal"],
    "styleSheet/borders/border/left": ["color"],
    "styleSheet/borders/border/right": ["color"],
    "styleSheet/borders/border/top": ["color"],
    "styleSheet/borders/border/bottom": ["color"],
    "styleSheet/borders/border/diagonal": ["color"],
    "styleSheet/cellStyleXfs": ["xf"],
    "styleSheet/cellStyleXfs/xf": ["alignment", "protection"],
    "styleSheet/cellXfs": ["xf"],
    "styleSheet/cellXfs/xf": ["alignment", "protection"],
    "styleSheet/cellStyles": ["cellStyle"],
  },
  types: { Types: ["Default", "Override"] },
  rels: { Relationships: ["Relationship"] },
};

/** The one element outside the root's namespace LibreOffice writes, by full path. */
const FOREIGN: ReadonlyMap<string, string> = new Map([
  ["workbook/extLst/ext/extCalcPr", "http://schemas.libreoffice.org/"],
]);

/**
 * Element names the gate's reader or the independent grader reads structurally. None may
 * appear anywhere in a part that is not pinned (docProps, the theme).
 */
export const DECOY_NAMES: ReadonlySet<string> = new Set([
  "workbook",
  "worksheet",
  "styleSheet",
  "sst",
  "Types",
  "Relationships",
  "sheetData",
  "row",
  "c",
  "f",
  "v",
  "is",
  "t",
  "r",
  "si",
  "sheet",
  "sheets",
  "workbookPr",
  "cellXfs",
  "numFmts",
  "numFmt",
  "xf",
  "Relationship",
  "Override",
  "Default",
]);

/**
 * Is every element of a pinned part's tree at a path LibreOffice writes? `root` must already
 * be the part's root (its name and namespace are checked by the caller).
 */
export function checkTree(root: XmlElement, kind: ContentPartKind): TreeCode | undefined {
  const schema = LO_TREES[kind];
  if (!Object.hasOwn(schema, root.local)) return "XLSX_TREE_ELEMENT";
  const walk = (element: XmlElement, path: string): TreeCode | undefined => {
    const allowed = Object.hasOwn(schema, path) ? schema[path] : undefined;
    for (const c of element.children) {
      if (typeof c === "string") continue;
      const at = `${path}/${c.local}`;
      if (allowed === undefined || !allowed.includes(c.local)) return "XLSX_TREE_ELEMENT";
      if (c.ns !== (FOREIGN.get(at) ?? root.ns)) return "XLSX_TREE_ELEMENT";
      const bad = walk(c, at);
      if (bad) return bad;
    }
    return undefined;
  };
  return walk(root, root.local);
}

/** Does a part no reader looks inside (docProps, the theme) hold no decoy element name? */
export function checkUnpinnedTree(root: XmlElement): TreeCode | undefined {
  const walk = (element: XmlElement): TreeCode | undefined => {
    if (DECOY_NAMES.has(element.local)) return "XLSX_TREE_ELEMENT";
    for (const c of element.children) {
      if (typeof c === "string") continue;
      const bad = walk(c);
      if (bad) return bad;
    }
    return undefined;
  };
  return walk(root);
}
