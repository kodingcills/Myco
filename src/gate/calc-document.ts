/**
 * Whole-document checks for the gate's Calc families (TIF-270 / M2-07).
 *
 * Outer-loop ruling R1: a Calc task is done only when the WHOLE saved document equals the
 * pristine fixture with the task's edits applied. A correct target cell next to collateral
 * damage (another cell changed, cleared, or a cell added) is not done. This module builds
 * the expected document from the operator's side only and diffs it against the parsed
 * persisted cells. The pristine document is the operator's sealed fixture when the spec
 * names one (the exact bytes the guest was given, digest-checked by the gate; TIF-270
 * round 3, ruling D1(a)), and otherwise the fixture regenerated on the host from the spec's
 * seed by `src/tasks/fixture.ts`.
 *
 * Independence: this is gate code. It imports nothing from `src/benchmark/grade/` (the
 * independent grader), and the grader imports nothing from here; both directions are
 * pinned by import-graph tests (`test/benchmark/independence.test.ts`,
 * `test/gate/calc-multistep.test.ts`).
 *
 * Refuted reasons name cells (A1 refs), never a cell value: neither the requested new value
 * nor what the operator's fixture holds there. The agent learns where the document is
 * wrong, not what belongs there. (A `verified` reason may restate the requested value,
 * which the agent was given in its task.)
 *
 * Row structure: `parseDocument` keeps every line as a row, so an interior blank line moves
 * every later record down and shows as collateral (round-2 D1), unlike the M1 reader
 * (`parseCsvSpreadsheet`), which drops empty lines before numbering rows. Trailing rows
 * that hold no content (blank lines, CRLF blank lines, `,,,,` rows at the end) are no
 * content, exactly as a trailing empty column is, so they change nothing (round-3 D2, in
 * agreement with the independent grader).
 *
 * Known false refutes (documented, pinned in `test/gate/calc-gate-grader-agreement.test.ts`):
 * the gate does not unquote RFC 4180 fields (`"4242"` is not `4242`), and it splits lines on
 * LF or CRLF only (a CR-only file is one line). The grader handles both, so it passes such
 * documents and the gate refutes them. Never a false done; soffice writes neither by
 * default for these values.
 */
import { cellRef } from "../core/filepersist.ts";
import { DATA_COLUMNS, FIXTURE_COLUMNS, generateFixture } from "../tasks/fixture.ts";
import { groundTruth, isAutoCorrectImmune, locateInFixture } from "../tasks/intent.ts";
import {
  looksLikeZip,
  type NumberColumnType,
  readXlsxDocument,
  XlsxError,
} from "./xlsx-document.ts";

/** A saved sheet as the gate reads it: non-empty cells by A1 ref. */
export interface ParsedDocument {
  readonly cells: Readonly<Record<string, string>>;
}

/**
 * Strict gate-side CSV parse. Lines split on LF or CRLF, and every line is a row, an empty
 * one included, so an interior blank line shifts the rows below it. Cells split on commas
 * exactly as `parseCsvSpreadsheet` does (empty cells omitted), so a document without
 * interior blank lines parses to the same cells as the M1 reader gives. Empty rows after
 * the last row with content hold no cells, so they never change the result: a document
 * with trailing blank or all-empty rows is the same document as one without (round-3 D2).
 */
export function parseDocument(text: string): ParsedDocument {
  const cells: Record<string, string> = {};
  text.split(/\r?\n/).forEach((line, r) => {
    line.split(",").forEach((value, c) => {
      if (value !== "") cells[cellRef(r, c)] = value;
    });
  });
  return { cells };
}

/** The persisted formats a Calc task can name (`spec.persistedFormat`; default `csv`). */
export const PERSISTED_FORMATS = ["csv", "xlsx"] as const;
export type PersistedFormat = (typeof PERSISTED_FORMATS)[number];

/** A saved document in the cell model, and how many sheets it holds (CSV: always 1). */
export interface SavedDocument extends ParsedDocument {
  readonly sheetCount: number;
  /**
   * xlsx only: every literal number cell, by A1 ref, with the column types it can stand for
   * (`numberDomain`, xlsx-document.ts). CSV has no stored kind: every cell is text.
   */
  readonly numbers?: Readonly<Record<string, readonly NumberColumnType[]>>;
  /**
   * xlsx only: literal number cells holding a date the gate does not judge, by A1 ref
   * (`isUngradedDate`, xlsx-document.ts: 1904 serial 0, a real day the grader denies).
   */
  readonly ungradedDates?: readonly string[];
}

/**
 * True when a saved document holds a stored number in a column whose type does not accept
 * it (verdict 7205644970, D3 VA-VD): a number in a text or key column, a non-integer or
 * date-styled number in an integer column, a number not date-styled as a real day in a date
 * column, a number that is not a `$` amount in a currency column. The independent grader
 * fails every such cell (it compares a stored number by its column's type), while the text
 * the gate renders for it can equal the expected text, so the family refuses a document it
 * would otherwise verify (`XLSX_NUMBER_DOMAIN`); a document the text comparison already
 * refutes stays refuted. A column's type is the fixture schema's
 * type for the column's header in the expected document; a column with no known header is
 * a text column, as the grader treats it.
 */
export function numberDomainRefusal(
  doc: SavedDocument,
  expected: ReadonlyMap<string, string>,
): boolean {
  for (const [ref, domain] of Object.entries(doc.numbers ?? {})) {
    const letters = /^([A-Z]+)[0-9]+$/.exec(ref)?.[1];
    if (letters === undefined) return true;
    const header = expected.get(`${letters}1`);
    const type = FIXTURE_COLUMNS.find((c) => c.name === header)?.type ?? "text";
    if (type === "text" || type === "key" || !domain.includes(type)) return true;
  }
  return false;
}

/** The saved bytes are not a readable document of the declared format. `code` only. */
export class DocumentReadError extends Error {
  override readonly name = "DocumentReadError";
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Read saved bytes in the task's declared format into the one cell model both formats
 * share (TIF-274 prerequisite). The format is the operator's (`spec.persistedFormat`), and
 * the bytes must be that format: zip bytes declared CSV are `CSV_IS_ZIP`, non-zip bytes
 * declared xlsx are `XLSX_NOT_ZIP`. The xlsx reader is `xlsx-document.ts`; its cells are the
 * text this CSV path holds for the same content, so both formats reach `diffDocument` alike.
 */
export function readSavedDocument(bytes: Uint8Array, format: PersistedFormat): SavedDocument {
  if (format === "xlsx") {
    try {
      return readXlsxDocument(bytes);
    } catch (error) {
      if (error instanceof XlsxError) throw new DocumentReadError(error.code);
      throw error;
    }
  }
  if (looksLikeZip(bytes)) throw new DocumentReadError("CSV_IS_ZIP");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentReadError("CSV_NOT_UTF8");
  }
  return { ...parseDocument(text), sheetCount: 1 };
}

/**
 * Cells of an operator's sealed fixture (the bytes the guest was given): CSV, or a
 * one-sheet xlsx workbook read into the same cell model (zip bytes are read as xlsx). Throws
 * when the gate cannot read it: a fixture the gate cannot read is an operator error, never
 * a verdict.
 */
export function fixtureCells(bytes: Uint8Array): Map<string, string> {
  const doc = readSavedDocument(bytes, looksLikeZip(bytes) ? "xlsx" : "csv");
  if (doc.sheetCount !== 1)
    throw new Error("a sealed fixture workbook must hold exactly one sheet");
  return new Map(Object.entries(doc.cells));
}

/** One edit: "set record `rowKey`, column `column`, to `newValue`". */
export interface CellEdit {
  readonly rowKey: string;
  readonly column: string;
  readonly newValue: string;
}

/** Cells (A1 ref → value) of the pristine fixture, header row included. Empty cells omitted. */
export function pristineCells(seed: string): Map<string, string> {
  const fixture = generateFixture(seed);
  const cells = new Map<string, string>();
  [fixture.header, ...fixture.rows].forEach((row, r) => {
    row.forEach((value, c) => {
      if (value !== "") cells.set(cellRef(r, c), value);
    });
  });
  return cells;
}

/** The A1 ref an edit targets. Throws if the edit does not target the fixture. */
export function targetRef(seed: string, edit: CellEdit): string {
  return groundTruth({ fixtureSeed: seed, ...edit }).cellRef;
}

/**
 * The expected document: the pristine fixture with `edits` applied, in order. `pristine`
 * is the operator's sealed fixture when the task has one; by default, the seed's fixture.
 */
export function expectedCells(
  seed: string,
  edits: readonly CellEdit[],
  pristine: ReadonlyMap<string, string> = pristineCells(seed),
): Map<string, string> {
  const cells = new Map(pristine);
  for (const edit of edits) cells.set(targetRef(seed, edit), edit.newValue);
  return cells;
}

/**
 * The expected document as CSV, in the fixture's own format. The harness uses this to
 * restore a guest document to a checkpoint (pristine + the first k edits) before a retry.
 */
export function documentCsv(seed: string, edits: readonly CellEdit[]): string {
  const fixture = generateFixture(seed);
  const rows = fixture.rows.map((row) => [...row]);
  for (const edit of edits) {
    const found = locateInFixture(seed, edit.rowKey, edit.column);
    if ("error" in found) throw new Error(`edit does not target the fixture: ${found.error}`);
    const row = rows[found.location.dataRowIndex];
    if (row) row[found.location.colIndex] = edit.newValue;
  }
  return `${[fixture.header, ...rows].map((row) => row.join(",")).join("\n")}\n`;
}

export interface DocumentDiff {
  /** Target refs whose persisted value is not the expected one (absent counts). */
  readonly targets: readonly string[];
  /** Non-target refs that differ from the expected document (changed, cleared or added). */
  readonly collateral: readonly string[];
}

/**
 * Diff persisted cells against an expected document over the union of both key sets, so a
 * cell the agent added is collateral just like one it changed or cleared.
 */
export function diffDocument(
  actual: Readonly<Record<string, string>>,
  expected: ReadonlyMap<string, string>,
  targets: ReadonlySet<string>,
): DocumentDiff {
  const targetDiffs: string[] = [];
  const collateral: string[] = [];
  const refs = new Set<string>([...expected.keys(), ...Object.keys(actual)]);
  for (const ref of refs) {
    const want = expected.get(ref);
    const got = Object.hasOwn(actual, ref) ? actual[ref] : undefined;
    if (want === got) continue;
    (targets.has(ref) ? targetDiffs : collateral).push(ref);
  }
  return { targets: targetDiffs, collateral };
}

const LISTED = 10;

/** "B5, D7 and 3 more": cell refs only, never values. */
export function listRefs(refs: readonly string[]): string {
  const shown = refs.slice(0, LISTED).join(", ");
  return refs.length > LISTED ? `${shown} and ${refs.length - LISTED} more` : shown;
}

export function collateralReason(collateral: readonly string[]): string {
  return `DOCUMENT_COLLATERAL: ${collateral.length} cell(s) the task does not target differ from the fixture (changed, cleared or added): ${listRefs(collateral)}`;
}

/** Characters this CSV format cannot hold in a cell (`parseDocument` splits on them). */
const CSV_UNSAFE = /[,\r\n"]/;

/**
 * Validate one edit of an operator spec against the fixture: it must target an existing
 * record and data column, and its value must survive the CSV round trip whole (non-empty,
 * no comma, quote or line break). With `strict`, the value must also differ from the
 * pristine cell (an edit that changes nothing cannot mark a checkpoint) and be immune to
 * Calc's input rewriting (M1-013), so the expected document is one real Calc can produce.
 */
export function checkEdit(seed: string, edit: unknown, strict: boolean): string | undefined {
  if (typeof edit !== "object" || edit === null) return "must be an object";
  const record = edit as Record<string, unknown>;
  for (const field of ["rowKey", "column", "newValue"] as const) {
    if (typeof record[field] !== "string") return `${field} must be a string`;
  }
  const { rowKey, column, newValue } = record as unknown as CellEdit;
  const found = locateInFixture(seed, rowKey, column);
  if ("error" in found) return `does not target the fixture: ${found.error}`;
  if (newValue === "" || CSV_UNSAFE.test(newValue)) {
    return "newValue must be non-empty, without a comma, quote or line break";
  }
  if (!strict) return undefined;
  const type = DATA_COLUMNS.find((c) => c.name === column)?.type ?? "text";
  if (!isAutoCorrectImmune(newValue, type)) {
    return `newValue ${JSON.stringify(newValue)} is not safe from Calc's input rewriting for a ${type} column`;
  }
  if (pristineCells(seed).get(targetRef(seed, { rowKey, column, newValue })) === newValue) {
    return "newValue equals the pristine cell, so the step would change nothing";
  }
  return undefined;
}
