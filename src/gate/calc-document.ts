/**
 * Whole-document checks for the gate's Calc families (TIF-270 / M2-07).
 *
 * Outer-loop ruling R1: a Calc task is done only when the WHOLE saved document equals the
 * pristine fixture with the task's edits applied. A correct target cell next to collateral
 * damage (another cell changed, cleared, or a cell added) is not done. This module builds
 * the expected document from the operator's spec alone (fixture seed + edits, regenerated
 * on the host by `src/tasks/fixture.ts`) and diffs it against the parsed persisted cells.
 *
 * Independence: this is gate code. It imports nothing from `src/benchmark/grade/` (the
 * independent grader), and the grader imports nothing from here; both directions are
 * pinned by import-graph tests (`test/benchmark/independence.test.ts`,
 * `test/gate/calc-document.test.ts`).
 *
 * Agent-facing reasons name cells (A1 refs), never a pristine value: the agent learns
 * where the document is wrong, not what the operator's fixture holds there.
 */
import { cellRef } from "../core/filepersist.ts";
import { DATA_COLUMNS, generateFixture } from "../tasks/fixture.ts";
import { groundTruth, isAutoCorrectImmune, locateInFixture } from "../tasks/intent.ts";

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

/** The expected document: the pristine fixture with `edits` applied, in order. */
export function expectedCells(seed: string, edits: readonly CellEdit[]): Map<string, string> {
  const cells = pristineCells(seed);
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

/** Characters this CSV format cannot hold in a cell (`parseCsvSpreadsheet` splits on them). */
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
