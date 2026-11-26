/**
 * Independent grader for cross-app tasks (capability track P): PDF -> Calc -> Writer with a
 * snapshot of both documents after every step and at the end.
 *
 * Inputs are bytes and data only: the pristine sheet and the report template exactly as
 * handed to the guest (each pinned by SHA-256), the source notice's bytes (pinned, never
 * parsed), the steps (the intent), each column's type, and the snapshots the harness
 * captured. Never the agent's claim, the gate's verdict, or anything the gate computed.
 *
 * Independence from the gate (`src/gate/cross-app.ts`):
 *  - different expected-state derivation: the gate regenerates the pristine sheet from its
 *    seed and the report from the spec; the grader starts from the committed bytes it is
 *    handed and finds each target (row by key, column by header, report field by its
 *    `<label>:` line) in those bytes;
 *  - different readers: the sheet through this directory's RFC 4180 CSV reader
 *    (`sheet.ts`), the report through `report-text.ts`;
 *  - different code: nothing here imports outside `src/benchmark/grade/`
 *    (`test/benchmark/independence.test.ts`).
 *
 * Rule: the snapshot of step k must equal the pristine documents with the edits of steps
 * 1..k applied, both documents, every cell and every line; the end snapshot must equal them
 * with every step applied. `pass` needs every step and the end. The first step that fails
 * is reported (a later step cannot repair it). `ungradable` (could not look) is never a pass.
 */
import { type ColumnType, cellMatches, sha256 } from "./grade.ts";
import { fieldOf, ReportReadError, readReportLines } from "./report-text.ts";
import { cellKey, type Grid, readCsvGrid, refOf, SheetReadError } from "./sheet.ts";

export const CROSS_APP_GRADER_VERSION = "cross-app-grader/1";

export interface CrossAppGradeEdit {
  readonly rowKey: string;
  readonly column: string;
  readonly newValue: string;
}

export interface CrossAppGradeInput {
  readonly fixtureCsv: Uint8Array;
  readonly fixtureSha256: string;
  readonly reportTemplate: Uint8Array;
  readonly reportTemplateSha256: string;
  /** The source notice as captured beside the trial's evidence, or null if absent. */
  readonly source: Uint8Array | null;
  readonly sourceSha256: string;
  readonly steps: readonly {
    readonly app: "calc" | "writer";
    readonly edits: readonly CrossAppGradeEdit[];
  }[];
  readonly columnTypes: Readonly<Record<string, ColumnType>>;
  /** One per step, in order, then the end state. A null document was not captured. */
  readonly snapshots: readonly {
    readonly sheet: Uint8Array | null;
    readonly report: Uint8Array | null;
  }[];
}

export interface CrossAppStepGrade {
  /** 1-based step, or "end". */
  readonly step: number | "end";
  readonly pass: boolean;
  readonly sheetMismatches: readonly string[];
  readonly reportMismatches: readonly string[];
}

export interface CrossAppGradeResult {
  readonly graderVersion: string;
  readonly status: "pass" | "fail" | "ungradable";
  readonly reasons: readonly string[];
  /** The first failing step (or "end"); null on pass and when ungradable. */
  readonly firstFailure: number | "end" | null;
  readonly perStep: readonly CrossAppStepGrade[];
}

function ungradable(reason: string): CrossAppGradeResult {
  return {
    graderVersion: CROSS_APP_GRADER_VERSION,
    status: "ungradable",
    reasons: [reason],
    firstFailure: null,
    perStep: [],
  };
}

export function gradeCrossApp(input: CrossAppGradeInput): CrossAppGradeResult {
  if (sha256(input.fixtureCsv) !== input.fixtureSha256)
    return ungradable("pristine sheet bytes do not match the declared SHA-256");
  if (sha256(input.reportTemplate) !== input.reportTemplateSha256)
    return ungradable("report template bytes do not match the declared SHA-256");
  if (input.source === null) return ungradable("source notice was not captured");
  if (sha256(input.source) !== input.sourceSha256)
    return ungradable("source notice bytes do not match the declared SHA-256");
  if (input.snapshots.length !== input.steps.length + 1)
    return ungradable("expected one snapshot per step plus the end state");
  try {
    return gradeChecked(input);
  } catch (error) {
    const known = error instanceof SheetReadError || error instanceof ReportReadError;
    const name = error instanceof Error ? error.name : "non-Error throw";
    const message = error instanceof Error ? error.message : String(error);
    return ungradable(`${known ? "" : `grader error (${name}): `}${message}`);
  }
}

class Unsatisfiable extends Error {}

function gradeChecked(input: CrossAppGradeInput): CrossAppGradeResult {
  const pristine = readCsvGrid(input.fixtureCsv);
  const header: string[] = [];
  let maxRow = 0;
  for (const [key, cell] of pristine.cells) {
    const [r, c] = key.split(",").map(Number) as [number, number];
    maxRow = Math.max(maxRow, r);
    if (r === 0) header[c] = cell.kind === "text" ? cell.text : "";
  }
  const untyped = header.filter((h) => input.columnTypes[h] === undefined);
  if (header.length === 0 || untyped.length > 0)
    return ungradable(`column types missing for: ${untyped.join(", ") || "(no header)"}`);
  const textOf = (r: number, c: number) => {
    const cell = pristine.cells.get(cellKey(r, c));
    return cell?.kind === "text" ? cell.text : "";
  };
  /** Where an edit lands in the pristine sheet: by key in column A and by header. */
  const locate = (edit: CrossAppGradeEdit): [number, number] => {
    const col = header.indexOf(edit.column);
    const rows: number[] = [];
    for (let r = 1; r <= maxRow; r++) if (textOf(r, 0) === edit.rowKey) rows.push(r);
    if (col < 1 || header.indexOf(edit.column, col + 1) !== -1 || rows.length !== 1)
      throw new Unsatisfiable(`${edit.rowKey}/${edit.column} is not one editable cell`);
    return [rows[0] as number, col];
  };
  const template = readReportLines(input.reportTemplate);
  const fieldLine = (edit: CrossAppGradeEdit): number => {
    const want = `${edit.rowKey} ${edit.column}:`;
    const at = template.flatMap((line, i) => (line === want ? [i] : []));
    if (at.length !== 1) throw new Unsatisfiable(`the template has no single line ${want}`);
    return at[0] as number;
  };

  let plan: { calc: [number, number, string][]; writer: [number, string][] }[];
  try {
    const calc: [number, number, string][] = [];
    const writer: [number, string][] = [];
    plan = input.steps.map((step) => {
      for (const edit of step.edits) {
        if (step.app === "calc") calc.push([...locate(edit), edit.newValue]);
        else writer.push([fieldLine(edit), `${edit.rowKey} ${edit.column}`]);
      }
      return { calc: [...calc], writer: [...writer] };
    });
  } catch (error) {
    if (error instanceof Unsatisfiable) return ungradable(`intent unsatisfiable: ${error.message}`);
    throw error;
  }
  const values = new Map<number, string>();
  for (const step of input.steps)
    if (step.app === "writer")
      for (const edit of step.edits) values.set(fieldLine(edit), edit.newValue);

  const perStep: CrossAppStepGrade[] = [];
  const n = input.steps.length;
  for (let s = 0; s <= n; s++) {
    const k = s < n ? s : n - 1;
    const expect = plan[k] as (typeof plan)[number];
    const snap = input.snapshots[s] as CrossAppGradeInput["snapshots"][number];
    const label: number | "end" = s < n ? s + 1 : "end";
    if (snap.sheet === null || snap.report === null)
      return ungradable(`snapshot ${String(label)} is missing a document`);
    const sheet = readCsvGrid(snap.sheet);
    const report = readReportLines(snap.report);
    perStep.push({
      step: label,
      ...compare(pristine, sheet, header, input.columnTypes, expect, template, report, values),
    });
  }
  const failed = perStep.find((p) => !p.pass);
  const reasons = perStep
    .filter((p) => !p.pass)
    .map(
      (p) =>
        `${p.step === "end" ? "end state" : `step ${p.step}`}: ${p.sheetMismatches.length} sheet cell(s) and ${p.reportMismatches.length} report line(s) differ from the expected documents`,
    );
  return {
    graderVersion: CROSS_APP_GRADER_VERSION,
    status: failed ? "fail" : "pass",
    reasons,
    firstFailure: failed ? failed.step : null,
    perStep,
  };
}

function compare(
  pristine: Grid,
  sheet: Grid,
  header: readonly string[],
  types: Readonly<Record<string, ColumnType>>,
  expect: { calc: [number, number, string][]; writer: [number, string][] },
  template: readonly string[],
  report: readonly string[],
  values: ReadonlyMap<number, string>,
): Omit<CrossAppStepGrade, "step"> {
  const want = new Map<string, string>();
  for (const [key, cell] of pristine.cells) want.set(key, cell.kind === "text" ? cell.text : "");
  for (const [r, c, v] of expect.calc) want.set(cellKey(r, c), v);
  const keys = new Set([...want.keys(), ...sheet.cells.keys()]);
  const sheetMismatches: string[] = [];
  for (const key of keys) {
    const [r, c] = key.split(",").map(Number) as [number, number];
    const type = types[header[c] ?? ""] ?? "text";
    if (!cellMatches(want.get(key) ?? "", sheet.cells.get(key), type, sheet.dateSystem))
      sheetMismatches.push(refOf(r, c));
  }
  if (sheet.otherSheetCells > 0) sheetMismatches.push("(other sheets)");

  const filled = new Map(expect.writer.map(([line, label]) => [line, label]));
  const reportMismatches: string[] = [];
  const lines = Math.max(template.length, report.length);
  for (let i = 0; i < lines; i++) {
    const label = filled.get(i);
    if (label !== undefined) {
      if (fieldOf(report[i], label) !== values.get(i)) reportMismatches.push(`line ${i + 1}`);
    } else if (report[i] !== template[i]) {
      reportMismatches.push(`line ${i + 1}`);
    }
  }
  return {
    pass: sheetMismatches.length === 0 && reportMismatches.length === 0,
    sheetMismatches,
    reportMismatches,
  };
}
