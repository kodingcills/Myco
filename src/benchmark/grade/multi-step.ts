/**
 * Independent grader entry for multi-step Calc tasks (capability track K, `ms-long-v1`;
 * `docs/product/capability-spec.md`, "K. Recovery": "a multi-step grader entry in
 * `src/benchmark/grade/` under the same independence rule").
 *
 * Question it answers: does the FINAL document the trial left behind hold every step of the
 * task, and nothing else changed? K's primary metric is completion on the final captured
 * document, so this entry grades one document, not per-step snapshots.
 *
 * Inputs are bytes and data only: the pristine fixture bytes exactly as handed to the guest
 * (pinned by SHA-256), the persisted document bytes, the steps (the intent) and each
 * column's declared type. It never receives the agent's claim, the gate's verdict, the
 * gate's checkpoints or corrections, a trace, or which recovery tools ran:
 * `MultiStepGradeInput` has no field for them.
 *
 * Independence from the gate (`calc-multi-step`, `src/gate/families.ts`):
 *  - different expected-state derivation: the gate regenerates the fixture from its seed and
 *    locates targets with its own document code; this entry locates each target (row by key
 *    in column A, column by header) in the pristine bytes it is handed;
 *  - different readers and value semantics: this directory's CSV and xlsx readers and the
 *    false-completion grader's typed `cellMatches`;
 *  - different code: nothing here imports outside `src/benchmark/grade/`
 *    (`test/benchmark/independence.test.ts` walks every module in this directory).
 *
 * Rule: `pass` needs every step's target to hold its new value and every other cell (the
 * union of the pristine extent and the persisted content) to equal the pristine fixture, and
 * no content on other sheets. `fail`: the document does not satisfy that, including a step
 * that names no editable cell of the fixture. `ungradable` (could not look, or the intent is
 * ambiguous): fixture bytes not the declared ones, a step list that is not 1-32 well-formed
 * edits, two steps on one cell, a duplicate key or header, missing column types, or a
 * persisted document that is absent, unreadable or not its declared format. `ungradable` is
 * never a pass. `perStep` reports which steps hold, for the faulted / unfaulted and partial
 * completion reports; `status` stays strict.
 */
import { type ColumnType, cellMatches, sha256 } from "./grade.ts";
import { type Cell, cellKey, type Grid, readCsvGrid, readXlsxGrid, refOf } from "./sheet.ts";

export const MULTI_STEP_GRADER_VERSION = "multi-step-grader/1";
export const MULTI_STEP_GRADE_MAX_STEPS = 32;
const MAX_REPORTED_MISMATCHES = 20;
const COLUMN_TYPES: readonly ColumnType[] = ["key", "text", "integer", "date", "currency"];

export interface MultiStepGradeEdit {
  readonly rowKey: string;
  readonly column: string;
  readonly newValue: string;
}

export interface MultiStepGradeInput {
  /** Pristine fixture as CSV bytes, exactly as handed to the guest. */
  readonly fixtureCsv: Uint8Array;
  /** SHA-256 (hex) the task set declares for the fixture. */
  readonly fixtureSha256: string;
  /** The final document the trial left behind, or null if the harness did not capture it. */
  readonly persisted: { readonly format: "xlsx" | "csv"; readonly bytes: Uint8Array } | null;
  /** The task's steps, in order. */
  readonly steps: readonly MultiStepGradeEdit[];
  /** Declared type per header name; every header must be typed. */
  readonly columnTypes: Readonly<Record<string, ColumnType>>;
}

export interface MultiStepStepGrade {
  /** 1-based. */
  readonly step: number;
  /** A1 ref of the target, or null when the step names no editable cell. */
  readonly target: string | null;
  /** The target holds the new value (false when the step names no editable cell). */
  readonly satisfied: boolean;
}

export interface MultiStepGradeResult {
  readonly graderVersion: string;
  readonly status: "pass" | "fail" | "ungradable";
  readonly reasons: readonly string[];
  readonly fixtureSha256: string;
  readonly persistedSha256: string | null;
  /** Empty when ungradable. */
  readonly perStep: readonly MultiStepStepGrade[];
  /** Steps whose target holds its new value; null when ungradable. */
  readonly stepsSatisfied: number | null;
  /** Non-target cells that differ from the fixture; null when ungradable. */
  readonly collateralCount: number | null;
  /** First mismatching cells (capped), A1 refs; `mismatchCount` is the full count. */
  readonly mismatches: readonly string[];
  readonly mismatchCount: number;
}

function ungradable(
  input: MultiStepGradeInput,
  reason: string,
  persistedSha256: string | null,
): MultiStepGradeResult {
  return {
    graderVersion: MULTI_STEP_GRADER_VERSION,
    status: "ungradable",
    reasons: [reason],
    fixtureSha256: input.fixtureSha256,
    persistedSha256,
    perStep: [],
    stepsSatisfied: null,
    collateralCount: null,
    mismatches: [],
    mismatchCount: 0,
  };
}

const isEdit = (e: unknown): e is MultiStepGradeEdit =>
  typeof e === "object" &&
  e !== null &&
  typeof (e as MultiStepGradeEdit).rowKey === "string" &&
  typeof (e as MultiStepGradeEdit).column === "string" &&
  typeof (e as MultiStepGradeEdit).newValue === "string";

export function gradeMultiStep(input: MultiStepGradeInput): MultiStepGradeResult {
  const persistedSha256 = input.persisted === null ? null : sha256(input.persisted.bytes);
  if (sha256(input.fixtureCsv) !== input.fixtureSha256)
    return ungradable(input, "fixture bytes do not match the declared SHA-256", persistedSha256);
  const { steps } = input;
  if (
    !Array.isArray(steps) ||
    steps.length < 1 ||
    steps.length > MULTI_STEP_GRADE_MAX_STEPS ||
    !steps.every(isEdit)
  )
    return ungradable(
      input,
      `steps must be 1-${MULTI_STEP_GRADE_MAX_STEPS} edits of strings`,
      persistedSha256,
    );
  // Fail closed: any exception past this point costs this one trial, never a batch.
  try {
    return gradeChecked(input, persistedSha256);
  } catch (error) {
    const name = error instanceof Error ? error.name : "non-Error throw";
    const message = error instanceof Error ? error.message : String(error);
    return ungradable(input, `grader error (${name}): ${message}`, persistedSha256);
  }
}

const textOf = (cell: Cell | undefined) => (cell?.kind === "text" ? cell.text : "");

function gradeChecked(
  input: MultiStepGradeInput,
  persistedSha256: string | null,
): MultiStepGradeResult {
  let pristine: Grid;
  try {
    pristine = readCsvGrid(input.fixtureCsv);
  } catch (error) {
    return ungradable(
      input,
      `pristine fixture unreadable: ${(error as Error).message}`,
      persistedSha256,
    );
  }
  const header: string[] = [];
  let maxRow = 0;
  for (const [key, cell] of pristine.cells) {
    const [r, c] = key.split(",").map(Number) as [number, number];
    maxRow = Math.max(maxRow, r);
    if (r === 0) header[c] = textOf(cell);
  }
  const headers = Array.from(header, (h) => h ?? "");
  const untyped = headers.filter(
    (name) =>
      !Object.hasOwn(input.columnTypes, name) ||
      !COLUMN_TYPES.includes(input.columnTypes[name] as ColumnType),
  );
  if (headers.length === 0 || untyped.length > 0)
    return ungradable(
      input,
      `column types missing for: ${untyped.length > 0 ? untyped.map((n) => JSON.stringify(n)).join(", ") : "(no header row)"}`,
      persistedSha256,
    );

  // Locate every step's target in the pristine bytes.
  const targets: ({ row: number; col: number } | null)[] = [];
  const unsatisfiable: string[] = [];
  const seen = new Map<string, number>();
  for (const [index, step] of input.steps.entries()) {
    const col = headers.indexOf(step.column);
    const rows: number[] = [];
    for (let r = 1; r <= maxRow; r++)
      if (textOf(pristine.cells.get(cellKey(r, 0))) === step.rowKey) rows.push(r);
    if (headers.indexOf(step.column, col + 1) !== -1 || rows.length > 1)
      return ungradable(
        input,
        `step ${index + 1}: fixture is ambiguous for this step (duplicate key or header)`,
        persistedSha256,
      );
    const problems: string[] = [];
    if (col < 1) problems.push(`column ${JSON.stringify(step.column)} is not an editable column`);
    if (rows.length === 0)
      problems.push(`record ${JSON.stringify(step.rowKey)} is not in the fixture`);
    if (problems.length > 0) {
      unsatisfiable.push(...problems.map((p) => `step ${index + 1}: ${p}`));
      targets.push(null);
      continue;
    }
    const target = { row: rows[0] as number, col };
    const key = cellKey(target.row, target.col);
    const earlier = seen.get(key);
    if (earlier !== undefined)
      return ungradable(
        input,
        `steps ${earlier} and ${index + 1} target the same cell ${refOf(target.row, target.col)}`,
        persistedSha256,
      );
    seen.set(key, index + 1);
    targets.push(target);
  }

  if (input.persisted === null)
    return ungradable(input, "persisted document was not captured", persistedSha256);
  const bytes = input.persisted.bytes;
  const looksZip =
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04;
  if (looksZip !== (input.persisted.format === "xlsx"))
    return ungradable(
      input,
      `persisted document is declared ${input.persisted.format} but its bytes ${looksZip ? "are" : "are not"} a zip container`,
      persistedSha256,
    );
  let actual: Grid;
  try {
    actual = input.persisted.format === "xlsx" ? readXlsxGrid(bytes) : readCsvGrid(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return ungradable(input, `persisted document unreadable: ${message}`, persistedSha256);
  }

  // Expected document: pristine text with every step applied.
  const expected = new Map<string, string>();
  for (const [key, cell] of pristine.cells) expected.set(key, textOf(cell));
  const targetSteps = new Map<string, number>();
  input.steps.forEach((step, index) => {
    const t = targets[index];
    if (t === null || t === undefined) return;
    expected.set(cellKey(t.row, t.col), step.newValue);
    targetSteps.set(cellKey(t.row, t.col), index + 1);
  });
  const keys = [...new Set([...expected.keys(), ...actual.cells.keys()])]
    .map((k) => k.split(",").map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const mismatches: string[] = [];
  const missedSteps = new Set<number>();
  let collateral = 0;
  for (const [r, c] of keys) {
    const key = cellKey(r, c);
    // Every header is typed (checked above); cells beyond the header compare as text.
    const type =
      c < headers.length ? (input.columnTypes[headers[c] as string] as ColumnType) : "text";
    if (cellMatches(expected.get(key) ?? "", actual.cells.get(key), type, actual.dateSystem))
      continue;
    mismatches.push(refOf(r, c));
    const step = targetSteps.get(key);
    if (step === undefined) collateral++;
    else missedSteps.add(step);
  }

  const perStep: MultiStepStepGrade[] = input.steps.map((_, index) => {
    const t = targets[index];
    return {
      step: index + 1,
      target: t ? refOf(t.row, t.col) : null,
      satisfied: t ? !missedSteps.has(index + 1) : false,
    };
  });
  const reasons = unsatisfiable.map((r) => `intent unsatisfiable: ${r}`);
  if (actual.otherSheetCells > 0)
    reasons.push(`${actual.otherSheetCells} non-empty cell(s) on sheets other than the first`);
  const missed = perStep.filter((s) => s.target !== null && !s.satisfied).map((s) => s.step);
  if (missed.length > 0) reasons.push(`steps not held: ${missed.join(", ")}`);
  if (collateral > 0) reasons.push(`${collateral} cell(s) no step targets differ from the fixture`);
  return {
    graderVersion: MULTI_STEP_GRADER_VERSION,
    status: reasons.length === 0 ? "pass" : "fail",
    reasons,
    fixtureSha256: input.fixtureSha256,
    persistedSha256,
    perStep,
    stepsSatisfied: perStep.filter((s) => s.satisfied).length,
    collateralCount: collateral,
    mismatches: mismatches.slice(0, MAX_REPORTED_MISMATCHES),
    mismatchCount: mismatches.length,
  };
}
