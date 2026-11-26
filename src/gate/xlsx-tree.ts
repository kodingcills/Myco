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

export type TreeCode = "XLSX_TREE_ELEMENT" | "XLSX_TREE_ATTRIBUTE";

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
const STRING_ITEM = { "": ["t", "r*"], r: ["rPr", "t"], "r/rPr": RUN_PROPERTIES } as const;

/** Prefix every key of a sub-schema with `at/`. */
function under(at: string, schema: Readonly<Record<string, readonly string[]>>) {
  return Object.fromEntries(
    Object.entries(schema).map(([k, v]) => [k === "" ? at : `${at}/${k}`, v]),
  );
}

/**
 * Allowed children by parent path (local names, `/`-joined from the root). A path that is
 * not a key holds no element children. A name ending in `*` may repeat; any other child
 * appears at most once under its parent (LibreOffice writes one `<numFmts>`, one
 * `<cellXfs>`, one `<workbookPr>`, ...): a second one is where a decoy would sit, since the
 * reader takes the first and the grader, for `<numFmt>`, the last match in the text.
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
    "workbook/bookViews": ["workbookView*"],
    "workbook/sheets": ["sheet*"],
    "workbook/extLst": ["ext*"],
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
    "worksheet/sheetViews": ["sheetView*"],
    "worksheet/sheetViews/sheetView": ["selection*"],
    "worksheet/cols": ["col*"],
    "worksheet/sheetData": ["row*"],
    "worksheet/sheetData/row": ["c*"],
    "worksheet/sheetData/row/c": ["f", "v", "is"],
    ...under("worksheet/sheetData/row/c/is", STRING_ITEM),
    "worksheet/headerFooter": ["oddHeader", "oddFooter"],
  },
  sst: {
    sst: ["si*"],
    ...under("sst/si", STRING_ITEM),
  },
  styles: {
    styleSheet: ["numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles"],
    "styleSheet/numFmts": ["numFmt*"],
    "styleSheet/fonts": ["font*"],
    "styleSheet/fonts/font": RUN_PROPERTIES,
    "styleSheet/fills": ["fill*"],
    "styleSheet/fills/fill": ["patternFill"],
    "styleSheet/fills/fill/patternFill": ["fgColor", "bgColor"],
    "styleSheet/borders": ["border*"],
    "styleSheet/borders/border": ["left", "right", "top", "bottom", "diagonal"],
    "styleSheet/borders/border/left": ["color"],
    "styleSheet/borders/border/right": ["color"],
    "styleSheet/borders/border/top": ["color"],
    "styleSheet/borders/border/bottom": ["color"],
    "styleSheet/borders/border/diagonal": ["color"],
    "styleSheet/cellStyleXfs": ["xf*"],
    "styleSheet/cellStyleXfs/xf": ["alignment", "protection"],
    "styleSheet/cellXfs": ["xf*"],
    "styleSheet/cellXfs/xf": ["alignment", "protection"],
    "styleSheet/cellStyles": ["cellStyle*"],
  },
  types: { Types: ["Default*", "Override*"] },
  rels: { Relationships: ["Relationship*"] },
};

/** Attributes of a formatting-only leaf that names a colour (`<color>`, `<fgColor>`, ...). */
const COLOR_ATTRS = ["rgb", "theme", "tint", "indexed", "auto"];
/** Attributes of a run-property leaf, by name (`<sz val="10"/>`, `<color rgb=".."/>`). */
const RUN_PROPERTY_ATTRS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  RUN_PROPERTIES.map((p) => [p, p === "color" ? COLOR_ATTRS : ["val"]]),
);
/** Attributes of the elements of a string item (`<si>` or `<is>`), relative to the item. */
const STRING_ITEM_ATTRS = {
  "": [],
  t: ["xml:space"],
  r: [],
  "r/t": ["xml:space"],
  "r/rPr": [],
  ...Object.fromEntries(Object.entries(RUN_PROPERTY_ATTRS).map(([k, v]) => [`r/rPr/${k}`, v])),
} as const;
const XF_ALIGNMENT = [
  "horizontal",
  "vertical",
  "textRotation",
  "wrapText",
  "indent",
  "shrinkToFit",
];
const XF_PROTECTION = ["locked", "hidden"];
const XF_COMMON = [
  "numFmtId",
  "fontId",
  "fillId",
  "borderId",
  "applyFont",
  "applyBorder",
  "applyAlignment",
  "applyProtection",
  "applyNumberFormat",
];

/**
 * Allowed attributes by element path (the same paths as `LO_TREES`), round 3, D2 T3. Every
 * attribute of every element of a pinned part must be listed for its path; an element at a
 * path with no key here may carry no attribute at all. Namespace declarations count as
 * attributes: only the ones LibreOffice writes, where it writes them (the pre-scan pins
 * their values and order on the root).
 *
 * Why: the independent grader reads attributes by regex over a tag's text, and one of its
 * patterns (`\bdate1904` in `<workbookPr ...>`) also matches a NAME that merely ends in
 * `date1904` after `-` or `.` (`x-date1904="true"`, `a.date1904="1"`). The gate reads the
 * exact attribute only, so before this pin the two judges disagreed on the date system.
 * With every attribute name pinned to LibreOffice's, no name the gate ignores is left for
 * any grader pattern to match. `date1904` itself is allowed on `<workbookPr>` (LibreOffice
 * writes it for a 1904 workbook; the reader interprets it, and only "0", "1", "false",
 * "true").
 *
 * Taken from LibreOffice 24.2's output for the committed fixtures (every attribute it writes
 * on each path in test/fixtures/calc-xlsx-writers/*.lo.xlsx and calc-xlsx-lo-grammar/*.lo.xlsx),
 * plus the attributes of the formatting-only leaves `LO_TREES` adds (colour and run-property
 * leaves: `val`, or a colour's `rgb`/`theme`/`tint`/`indexed`/`auto`), `date1904`, and on
 * `<f>` the formula attributes the cell reader already carries into its formula marker
 * (`aca`, `t`, `ref`, `si`, `ca`: a formula cell never equals a literal expected cell).
 */
export const LO_ATTRS: Readonly<
  Record<ContentPartKind, Readonly<Record<string, readonly string[]>>>
> = {
  workbook: {
    workbook: ["xmlns", "xmlns:r"],
    "workbook/fileVersion": ["appName"],
    "workbook/workbookPr": ["backupFile", "showObjects", "dateCompatibility", "date1904"],
    "workbook/bookViews/workbookView": [
      "showHorizontalScroll",
      "showVerticalScroll",
      "showSheetTabs",
      "xWindow",
      "yWindow",
      "windowWidth",
      "windowHeight",
      "tabRatio",
      "firstSheet",
      "activeTab",
    ],
    "workbook/sheets/sheet": ["name", "sheetId", "state", "r:id"],
    "workbook/calcPr": ["iterateCount", "refMode", "iterate", "iterateDelta"],
    "workbook/extLst/ext": ["xmlns:loext", "uri"],
    "workbook/extLst/ext/extCalcPr": ["stringRefSyntax"],
  },
  worksheet: {
    worksheet: ["xmlns", "xmlns:r", "xmlns:xdr", "xmlns:x14", "xmlns:xr2", "xmlns:mc"],
    "worksheet/sheetPr": ["filterMode"],
    "worksheet/sheetPr/pageSetUpPr": ["fitToPage"],
    "worksheet/dimension": ["ref"],
    "worksheet/sheetViews/sheetView": [
      "showFormulas",
      "showGridLines",
      "showRowColHeaders",
      "showZeros",
      "rightToLeft",
      "tabSelected",
      "showOutlineSymbols",
      "defaultGridColor",
      "view",
      "topLeftCell",
      "colorId",
      "zoomScale",
      "zoomScaleNormal",
      "zoomScalePageLayoutView",
      "workbookViewId",
    ],
    "worksheet/sheetViews/sheetView/selection": ["pane", "activeCell", "activeCellId", "sqref"],
    "worksheet/sheetFormatPr": [
      "defaultColWidth",
      "defaultRowHeight",
      "zeroHeight",
      "outlineLevelRow",
      "outlineLevelCol",
    ],
    "worksheet/cols/col": [
      "collapsed",
      "customWidth",
      "hidden",
      "outlineLevel",
      "max",
      "min",
      "style",
      "width",
    ],
    "worksheet/sheetData/row": [
      "r",
      "customFormat",
      "ht",
      "hidden",
      "customHeight",
      "outlineLevel",
      "collapsed",
    ],
    "worksheet/sheetData/row/c": ["r", "s", "t"],
    "worksheet/sheetData/row/c/f": ["aca", "t", "ref", "si", "ca"],
    ...under("worksheet/sheetData/row/c/is", STRING_ITEM_ATTRS),
    "worksheet/printOptions": [
      "headings",
      "gridLines",
      "gridLinesSet",
      "horizontalCentered",
      "verticalCentered",
    ],
    "worksheet/pageMargins": ["left", "right", "top", "bottom", "header", "footer"],
    "worksheet/pageSetup": [
      "paperSize",
      "scale",
      "fitToWidth",
      "fitToHeight",
      "pageOrder",
      "orientation",
      "blackAndWhite",
      "draft",
      "cellComments",
      "firstPageNumber",
      "useFirstPageNumber",
      "horizontalDpi",
      "verticalDpi",
      "copies",
    ],
    "worksheet/headerFooter": ["differentFirst", "differentOddEven"],
  },
  sst: {
    sst: ["xmlns", "count", "uniqueCount"],
    ...under("sst/si", STRING_ITEM_ATTRS),
  },
  styles: {
    styleSheet: ["xmlns"],
    "styleSheet/numFmts": ["count"],
    "styleSheet/numFmts/numFmt": ["numFmtId", "formatCode"],
    "styleSheet/fonts": ["count"],
    ...Object.fromEntries(
      Object.entries(RUN_PROPERTY_ATTRS).map(([k, v]) => [`styleSheet/fonts/font/${k}`, v]),
    ),
    "styleSheet/fills": ["count"],
    "styleSheet/fills/fill/patternFill": ["patternType"],
    "styleSheet/fills/fill/patternFill/fgColor": COLOR_ATTRS,
    "styleSheet/fills/fill/patternFill/bgColor": COLOR_ATTRS,
    "styleSheet/borders": ["count"],
    "styleSheet/borders/border": ["diagonalUp", "diagonalDown"],
    ...Object.fromEntries(
      ["left", "right", "top", "bottom", "diagonal"].flatMap((side) => [
        [`styleSheet/borders/border/${side}`, ["style"]],
        [`styleSheet/borders/border/${side}/color`, COLOR_ATTRS],
      ]),
    ),
    "styleSheet/cellStyleXfs": ["count"],
    "styleSheet/cellStyleXfs/xf": XF_COMMON,
    "styleSheet/cellStyleXfs/xf/alignment": XF_ALIGNMENT,
    "styleSheet/cellStyleXfs/xf/protection": XF_PROTECTION,
    "styleSheet/cellXfs": ["count"],
    "styleSheet/cellXfs/xf": [...XF_COMMON, "xfId"],
    "styleSheet/cellXfs/xf/alignment": XF_ALIGNMENT,
    "styleSheet/cellXfs/xf/protection": XF_PROTECTION,
    "styleSheet/cellStyles": ["count"],
    "styleSheet/cellStyles/cellStyle": ["name", "xfId", "builtinId"],
  },
  types: {
    Types: ["xmlns"],
    "Types/Default": ["Extension", "ContentType"],
    "Types/Override": ["PartName", "ContentType"],
  },
  rels: {
    Relationships: ["xmlns"],
    "Relationships/Relationship": ["Id", "Type", "Target"],
  },
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
  const attrSchema = LO_ATTRS[kind];
  if (!Object.hasOwn(schema, root.local)) return "XLSX_TREE_ELEMENT";
  const walk = (element: XmlElement, path: string): TreeCode | undefined => {
    const allowed = Object.hasOwn(schema, path) ? schema[path] : undefined;
    // Every attribute name (namespace declarations included) must be LibreOffice's for this
    // path; a path with no key allows none.
    const attrsAllowed = Object.hasOwn(attrSchema, path) ? attrSchema[path] : undefined;
    for (const key of element.attrs.keys())
      if (!attrsAllowed?.includes(key)) return "XLSX_TREE_ATTRIBUTE";
    const once = new Set<string>();
    for (const c of element.children) {
      if (typeof c === "string") continue;
      const at = `${path}/${c.local}`;
      if (allowed === undefined) return "XLSX_TREE_ELEMENT";
      if (!allowed.includes(`${c.local}*`)) {
        if (!allowed.includes(c.local) || once.has(c.local)) return "XLSX_TREE_ELEMENT";
        once.add(c.local);
      }
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
