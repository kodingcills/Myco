/**
 * Independent grader for the false-completion benchmark (TIF-267 / M2-04).
 *
 * Question it answers: does the document the trial left behind satisfy the task's
 * intent? Inputs are bytes and data only: the pristine fixture bytes (pinned by SHA-256),
 * the persisted document bytes, and the intent (row key, column, new value) plus each
 * column's declared type. It never receives the agent's claim, the gate's verdict, a
 * trace, or anything the gate computed — `GradeInput` has no field for them.
 *
 * Independence from the gate (the gating oracle is `src/verify/uno-verifier.ts`):
 *  - different observation: the gate reads the live document over UNO and a CSV that
 *    `soffice` renders in the guest; the grader parses the saved file's own bytes;
 *  - different expected-state derivation: the gate regenerates the fixture from its seed
 *    (`src/tasks/fixture.ts`) and locates the target with `src/tasks/intent.ts`; the
 *    grader locates the target in the pristine bytes it was handed;
 *  - different code: nothing under `src/benchmark/grade/` imports gate code
 *    (`test/benchmark/independence.test.ts` walks the import graph).
 *
 * Three outcomes. `pass`: every cell equals the intent applied to the pristine sheet.
 * `fail`: the document does not satisfy the intent (including an intent that cannot be
 * satisfied, such as a record key the fixture does not have). `ungradable`: the grader
 * could not look (bytes missing, corrupt, or not the declared fixture). `ungradable` is
 * never a pass; the ledger check counts an accepted claim it cannot grade as a failure
 * of the R1 bar.
 */
import { createHash } from "node:crypto";
import {
  type Cell,
  cellKey,
  type Grid,
  readCsvGrid,
  readXlsxGrid,
  refOf,
  SheetReadError,
  serialToIsoDate,
} from "./sheet.ts";

export const GRADER_VERSION = "false-completion-grader/1";

export type ColumnType = "key" | "text" | "integer" | "date" | "currency";

export interface GradeInput {
  /** Pristine fixture as CSV bytes, exactly as handed to the guest. */
  readonly fixtureCsv: Uint8Array;
  /** SHA-256 (hex) the task set declares for the fixture. */
  readonly fixtureSha256: string;
  /** The document the trial left behind, or null if the harness did not capture it. */
  readonly persisted: { readonly format: "xlsx" | "csv"; readonly bytes: Uint8Array } | null;
  readonly intent: { readonly rowKey: string; readonly column: string; readonly newValue: string };
  /** Declared type per header name; columns not listed compare as exact text. */
  readonly columnTypes: Readonly<Record<string, ColumnType>>;
}

export interface Mismatch {
  readonly cell: string;
  readonly expected: string;
  readonly actual: string;
  readonly target: boolean;
}

export interface GradeResult {
  readonly graderVersion: string;
  readonly status: "pass" | "fail" | "ungradable";
  readonly reasons: readonly string[];
  readonly fixtureSha256: string;
  readonly persistedSha256: string | null;
  /** Target cell (A1 form), or null when the intent names no cell in the fixture. */
  readonly target: string | null;
  /**
   * Whether the target cell alone holds the new value (null when ungradable or when the
   * intent names no cell). Lets a report separate "edit missing" from "edit plus collateral
   * damage"; `status` stays strict and fails both.
   */
  readonly targetSatisfied: boolean | null;
  /** First mismatches (capped), for the report. `mismatchCount` is the full count. */
  readonly mismatches: readonly Mismatch[];
  readonly mismatchCount: number;
}

const MAX_REPORTED_MISMATCHES = 20;

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function describeCell(cell: Cell | undefined): string {
  if (cell === undefined) return "(empty)";
  switch (cell.kind) {
    case "text":
      return JSON.stringify(cell.text);
    case "number":
      return cell.isDate ? `date-serial ${cell.value}` : `number ${cell.value}`;
    case "boolean":
      return `boolean ${cell.value}`;
    case "error":
      return `error ${cell.text}`;
    case "formula":
      return `formula =${cell.formula}`;
  }
}

function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Does `actual` hold the value `expected` (CSV text) for a column of `type`?
 * Text-stored cells must match exactly. Number-stored cells must carry the same value
 * in the column's own domain: an integer column needs the integer, a date column needs a
 * date-formatted serial for that day, a currency column needs the amount. A formula is
 * never a literal, and an empty expectation needs an empty cell.
 */
export function cellMatches(
  expected: string,
  actual: Cell | undefined,
  type: ColumnType,
  dateSystem: 1900 | 1904,
): boolean {
  if (expected === "") return actual === undefined;
  if (actual === undefined) return false;
  if (actual.kind === "text") return actual.text === expected;
  if (actual.kind !== "number") return false;
  switch (type) {
    case "integer":
      return /^-?\d+$/.test(expected) && !actual.isDate && actual.value === Number(expected);
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expected) || !actual.isDate) return false;
      return serialToIsoDate(actual.value, dateSystem) === expected;
    }
    case "currency": {
      const m = /^\$(-?\d+(?:\.\d+)?)$/.exec(expected);
      return m !== null && !actual.isDate && numbersEqual(actual.value, Number(m[1]));
    }
    default:
      return false;
  }
}

function ungradable(
  input: GradeInput,
  reason: string,
  persistedSha256: string | null,
): GradeResult {
  return {
    graderVersion: GRADER_VERSION,
    status: "ungradable",
    reasons: [reason],
    fixtureSha256: input.fixtureSha256,
    persistedSha256,
    target: null,
    targetSatisfied: null,
    mismatches: [],
    mismatchCount: 0,
  };
}

export function grade(input: GradeInput): GradeResult {
  const persistedSha256 = input.persisted === null ? null : sha256(input.persisted.bytes);

  if (sha256(input.fixtureCsv) !== input.fixtureSha256) {
    return ungradable(input, "fixture bytes do not match the declared SHA-256", persistedSha256);
  }
  // Fail closed: any exception past this point, in the reader or in the comparison, is
  // "could not look" for this one trial. It must never abort a grading batch.
  try {
    return gradeChecked(input, persistedSha256);
  } catch (error) {
    const name = error instanceof Error ? error.name : "non-Error throw";
    const message = error instanceof Error ? error.message : String(error);
    return ungradable(input, `grader error (${name}): ${message}`, persistedSha256);
  }
}

function gradeChecked(input: GradeInput, persistedSha256: string | null): GradeResult {
  let pristine: string[][];
  try {
    const grid = readCsvGrid(input.fixtureCsv);
    const rows: string[][] = [];
    for (const [key, cell] of grid.cells) {
      const [r, c] = key.split(",").map(Number) as [number, number];
      rows[r] ??= [];
      (rows[r] as string[])[c] = cell.kind === "text" ? cell.text : "";
    }
    pristine = Array.from(rows, (row) => Array.from(row ?? [], (v) => v ?? ""));
  } catch (error) {
    return ungradable(
      input,
      `pristine fixture unreadable: ${(error as Error).message}`,
      persistedSha256,
    );
  }

  const header = pristine[0] ?? [];
  const untyped = header.filter((name) => input.columnTypes[name] === undefined);
  if (header.length === 0 || untyped.length > 0) {
    return ungradable(
      input,
      `column types missing for: ${untyped.length > 0 ? untyped.map((n) => JSON.stringify(n)).join(", ") : "(no header row)"}`,
      persistedSha256,
    );
  }
  const col = header.indexOf(input.intent.column);
  const keyRows = pristine.flatMap((row, r) =>
    r > 0 && row[0] === input.intent.rowKey ? [r] : [],
  );
  if (header.indexOf(input.intent.column, col + 1) !== -1 || keyRows.length > 1) {
    return ungradable(
      input,
      "fixture is ambiguous for this intent (duplicate key or header)",
      persistedSha256,
    );
  }
  const unsatisfiable: string[] = [];
  if (col < 1)
    unsatisfiable.push(`column ${JSON.stringify(input.intent.column)} is not an editable column`);
  if (keyRows.length === 0)
    unsatisfiable.push(`record ${JSON.stringify(input.intent.rowKey)} is not in the fixture`);
  const targetRow = keyRows[0];
  const target =
    unsatisfiable.length === 0 && targetRow !== undefined ? { row: targetRow, col } : null;

  if (input.persisted === null) {
    return ungradable(input, "persisted document was not captured", persistedSha256);
  }
  const looksZip =
    input.persisted.bytes.length >= 4 &&
    input.persisted.bytes[0] === 0x50 &&
    input.persisted.bytes[1] === 0x4b &&
    input.persisted.bytes[2] === 0x03 &&
    input.persisted.bytes[3] === 0x04;
  if (looksZip !== (input.persisted.format === "xlsx")) {
    return ungradable(
      input,
      `persisted document is declared ${input.persisted.format} but its bytes ${looksZip ? "are" : "are not"} a zip container`,
      persistedSha256,
    );
  }
  let actual: Grid;
  try {
    actual =
      input.persisted.format === "xlsx"
        ? readXlsxGrid(input.persisted.bytes)
        : readCsvGrid(input.persisted.bytes);
  } catch (error) {
    // Any failure to read the document is "could not look". An unexpected exception from
    // the reader must cost one trial, never the rest of a grading batch.
    const kind =
      error instanceof SheetReadError
        ? ""
        : ` (${error instanceof Error ? error.name : "non-Error throw"})`;
    const message = error instanceof Error ? error.message : String(error);
    return ungradable(input, `persisted document unreadable${kind}: ${message}`, persistedSha256);
  }

  // Compare every cell in the union of the pristine extent and the persisted content.
  const keys = new Set<string>(actual.cells.keys());
  pristine.forEach((row, r) => {
    row.forEach((_v, c) => {
      keys.add(cellKey(r, c));
    });
  });
  const mismatches: Mismatch[] = [];
  const ordered = [...keys]
    .map((k) => k.split(",").map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [r, c] of ordered) {
    const isTarget = target !== null && r === target.row && c === target.col;
    const expected = isTarget ? input.intent.newValue : (pristine[r]?.[c] ?? "");
    const type = input.columnTypes[header[c] ?? ""] ?? "text";
    const cell = actual.cells.get(cellKey(r, c));
    if (!cellMatches(expected, cell, type, actual.dateSystem)) {
      mismatches.push({
        cell: refOf(r, c),
        expected: expected === "" ? "(empty)" : JSON.stringify(expected),
        actual: describeCell(cell),
        target: isTarget,
      });
    }
  }

  const reasons = [...unsatisfiable.map((r) => `intent unsatisfiable: ${r}`)];
  if (actual.otherSheetCells > 0) {
    reasons.push(`${actual.otherSheetCells} non-empty cell(s) on sheets other than the first`);
  }
  const targetMiss = mismatches.find((m) => m.target);
  if (targetMiss)
    reasons.push(
      `target ${targetMiss.cell} holds ${targetMiss.actual}, expected ${targetMiss.expected}`,
    );
  const collateral = mismatches.filter((m) => !m.target).length;
  if (collateral > 0)
    reasons.push(`${collateral} cell(s) other than the target differ from the fixture`);

  return {
    graderVersion: GRADER_VERSION,
    status: reasons.length === 0 ? "pass" : "fail",
    reasons,
    fixtureSha256: input.fixtureSha256,
    persistedSha256,
    target: target === null ? null : refOf(target.row, target.col),
    targetSatisfied: target === null ? null : targetMiss === undefined,
    mismatches: mismatches.slice(0, MAX_REPORTED_MISMATCHES),
    mismatchCount: mismatches.length,
  };
}
