/**
 * Fixed part names and relationships (TIF-274 prerequisite, replaces #503's D8 gap).
 *
 * #503 found parts by following relationships wherever they pointed, and never looked at
 * entries no relationship referenced. The independent grader reads FIXED names
 * (`xl/workbook.xml`, `xl/sharedStrings.xml`, `xl/styles.xml`). So a relationship moved to a
 * copy, with a decoy left at the canonical name, made the two read different parts (P14,
 * P15). Here the package must be exactly the parts LibreOffice Calc writes, at the names it
 * writes them, each referenced by exactly the relationship LibreOffice writes for it:
 *
 *   [Content_Types].xml            required (missing: the reader's XLSX_NOT_WORKBOOK)
 *   _rels/.rels                    required: officeDocument -> xl/workbook.xml (exactly one),
 *                                  core-properties -> docProps/core.xml,
 *                                  extended-properties -> docProps/app.xml
 *   xl/workbook.xml                required
 *   xl/_rels/workbook.xml.rels     required: worksheet -> worksheets/sheetN.xml (one or more),
 *                                  styles -> styles.xml, sharedStrings -> sharedStrings.xml,
 *                                  theme -> theme/theme1.xml (each at most once)
 *   xl/worksheets/sheetN.xml       N >= 1, each referenced by a <sheet> of the workbook
 *   xl/styles.xml, xl/sharedStrings.xml, xl/theme/theme1.xml,
 *   docProps/core.xml, docProps/app.xml    optional
 *
 * Any other entry (XLSX_PART_UNEXPECTED), any relationship of another type or with another
 * target string, a duplicate id or a second relationship to one part (XLSX_REL_TARGET), and
 * any part, content-type override or worksheet relationship nothing references (a decoy;
 * XLSX_PART_UNREFERENCED) is refused. Codes only.
 *
 * Pure functions over names and plain relationship records: no XML here, so it cannot
 * diverge from the pre-scanned bytes the caller parsed.
 */

export type PartsCode = "XLSX_PART_UNEXPECTED" | "XLSX_REL_TARGET" | "XLSX_PART_UNREFERENCED";

const SHEET = /^xl\/worksheets\/sheet[1-9][0-9]*\.xml$/;

/** The entries a LibreOffice workbook may hold, besides its worksheets. */
export const FIXED_PARTS: ReadonlySet<string> = new Set([
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
  "xl/styles.xml",
  "xl/sharedStrings.xml",
  "xl/theme/theme1.xml",
  "docProps/core.xml",
  "docProps/app.xml",
]);

const OD = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * Relationship types, by owner, and the exact Target string each must carry (a function for
 * the worksheet, whose number varies). LibreOffice writes core-properties under the
 * lowercase `officedocument` URI; the package URI is the standard one: both are accepted.
 */
const ROOT_RELS: ReadonlyMap<string, string> = new Map([
  [`${OD}/officeDocument`, "xl/workbook.xml"],
  [`${OD}/extended-properties`, "docProps/app.xml"],
  [
    "http://schemas.openxmlformats.org/officedocument/2006/relationships/metadata/core-properties",
    "docProps/core.xml",
  ],
  [
    "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
    "docProps/core.xml",
  ],
]);
const WORKBOOK_RELS: ReadonlyMap<string, string | RegExp> = new Map<string, string | RegExp>([
  [`${OD}/worksheet`, /^worksheets\/sheet[1-9][0-9]*\.xml$/],
  [`${OD}/styles`, "styles.xml"],
  [`${OD}/sharedStrings`, "sharedStrings.xml"],
  [`${OD}/theme`, "theme/theme1.xml"],
]);

/** A relationship as written: its raw attributes, no resolution. */
export interface RawRelationship {
  readonly id: string | undefined;
  readonly type: string | undefined;
  readonly target: string | undefined;
  /** Any attribute besides Id, Type and Target (TargetMode included). */
  readonly extraAttributes: number;
}

/**
 * Every entry must be a fixed part or a worksheet. (A required part that is missing is the
 * reader's XLSX_NOT_WORKBOOK: there is no workbook to read.)
 */
export function checkPartNames(names: Iterable<string>): PartsCode | undefined {
  for (const name of names)
    if (!FIXED_PARTS.has(name) && !SHEET.test(name)) return "XLSX_PART_UNEXPECTED";
  return undefined;
}

/**
 * Check both relationship parts against LibreOffice's, and that every part is referenced.
 *
 * `rootRels` and `workbookRels` are the raw relationships of `_rels/.rels` and
 * `xl/_rels/workbook.xml.rels`; `sheetIds` the `r:id` of every `<sheet>` in the workbook, in
 * order; `overrides` every content-type Override PartName; `names` every entry.
 */
export function checkRelationships(input: {
  readonly names: Iterable<string>;
  readonly rootRels: readonly RawRelationship[];
  readonly workbookRels: readonly RawRelationship[];
  readonly sheetIds: readonly (string | undefined)[];
  readonly overrides: readonly (string | undefined)[];
}): PartsCode | undefined {
  const names = new Set(input.names);
  // The package's own parts are referenced by the package; everything else by a relationship.
  const referenced = new Set<string>([
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/_rels/workbook.xml.rels",
  ]);

  const walk = (
    rels: readonly RawRelationship[],
    allowed: ReadonlyMap<string, string | RegExp>,
    base: string,
  ): Map<string, string> | PartsCode => {
    const ids = new Map<string, string>();
    for (const rel of rels) {
      const { id, type, target } = rel;
      if (id === undefined || type === undefined || target === undefined) return "XLSX_REL_TARGET";
      if (rel.extraAttributes > 0) return "XLSX_REL_TARGET";
      const want = allowed.get(type);
      if (want === undefined) return "XLSX_REL_TARGET";
      if (typeof want === "string" ? target !== want : !want.test(target)) return "XLSX_REL_TARGET";
      const part = base + target;
      if (ids.has(id) || referenced.has(part)) return "XLSX_REL_TARGET";
      ids.set(id, part);
      referenced.add(part);
    }
    return ids;
  };

  const root = walk(input.rootRels, ROOT_RELS, "");
  if (typeof root === "string") return root;
  // (A second officeDocument relationship is a second relationship to xl/workbook.xml,
  // refused above; none at all is the reader's XLSX_NOT_WORKBOOK.)
  const workbook = walk(input.workbookRels, WORKBOOK_RELS, "xl/");
  if (typeof workbook === "string") return workbook;

  // Every worksheet relationship is a <sheet> of the workbook, and every <sheet> names one.
  const sheetParts = new Set<string>();
  for (const id of input.sheetIds) {
    const part = id === undefined ? undefined : workbook.get(id);
    if (part === undefined || !SHEET.test(part) || sheetParts.has(part)) return "XLSX_REL_TARGET";
    sheetParts.add(part);
  }
  for (const part of workbook.values())
    if (SHEET.test(part) && !sheetParts.has(part)) return "XLSX_PART_UNREFERENCED";

  // Every entry is referenced: no decoy left at a canonical or any other name. (A referenced
  // part that is missing is the reader's XLSX_NOT_WORKBOOK when it would read it.)
  for (const name of names) if (!referenced.has(name)) return "XLSX_PART_UNREFERENCED";
  // Every content-type override names an entry that is there.
  for (const o of input.overrides) {
    if (o === undefined || !o.startsWith("/") || !names.has(o.slice(1)))
      return "XLSX_PART_UNREFERENCED";
  }
  return undefined;
}
