/**
 * The gate's cross-app family `cross-app-steps` (capability track P, tier 2): a task that
 * spans apps (PDF -> Calc -> Writer), verified end to end with a checkpoint per step.
 *
 * Evidence (all host captures, taken by the harness after the agent stopped each step;
 * layout in `src/tasks/cross-app.ts`):
 *  - `step-<k>/sheet.csv`, `step-<k>/report.txt`: both task documents as persisted after
 *    step k, for every step;
 *  - `end/sheet.csv`, `end/report.txt`: both documents after the agent's last stop (the end
 *    state; `end/sheet.csv` is the task's `stateFile`);
 *  - `source.pdf`: the sealed source notice. The gate checks its digest against the spec
 *    before this family runs (FIXTURE_MISMATCH otherwise) and never parses it.
 *
 * Decision rule (version 1):
 *  - step k's own check: BOTH snapshots of step k equal the documents expected after steps
 *    1..k exactly (the whole-document rule of TIF-270, per document): every cell of the sheet
 *    is the pristine fixture's or a calc edit of steps 1..k; every line of the report is the
 *    template's, with exactly the writer fields of steps 1..k filled. Anything else is a
 *    failure: a wrong or missing edit of step k is TARGET_MISMATCH, any other difference
 *    (a cell or line changed, cleared or added, an earlier step's edit broken, a later
 *    step's edit made early) is DOCUMENT_COLLATERAL;
 *  - checkpoint k holds iff the own checks of steps 1..k all hold. A later step can never
 *    mask an earlier failure: a step-1 snapshot that is wrong refutes checkpoint 1 and
 *    every later checkpoint, whatever the later snapshots hold;
 *  - the last checkpoint also needs the end state (both end documents) to equal the
 *    documents expected after every step;
 *  - `verified` iff every checkpoint holds. A refuted result carries the codes and reasons
 *    of the FIRST failing check (the step where the trial went wrong), the list of every
 *    step whose own snapshot fails, and the refuted checkpoints. The gate computes
 *    `lastVerified` from the checkpoints itself; the one-retry harness restores it.
 *
 * Formats: the sheet is CSV, read by the gate's strict Calc reader (`parseDocument`; the gate
 * stays CSV-only for Calc). The report is plain UTF-8 text, read by `parseReport` below
 * under the hardened-parsing rules of docs/gate/cross-app.md: strict UTF-8 (fatal decode),
 * at most one leading BOM, no control character but TAB, no bare CR, bounded line count and
 * length, and every refusal a StateCorruptError (the gate answers `uncertain`, never a
 * verdict). No container, no XML, no entity expansion: nothing to inflate or recurse.
 *
 * Reasons name cells (A1 refs) and report lines by number and label, never a value: the
 * agent learns where a document is wrong, not what belongs there.
 *
 * Independence: gate code. It imports nothing from `src/benchmark/` (the independent
 * grader has its own cross-app readers, `src/benchmark/grade/cross-app.ts`); pinned by
 * `test/benchmark/independence.test.ts`.
 */
import {
  CROSS_APP_FAMILY,
  type CrossAppEdit,
  type CrossAppSpec,
  crossAppEvidenceFiles,
  END_DIR,
  editsThrough,
  fieldLabel,
  REPORT_FILE,
  REPORT_HEADER_LINES,
  reportAt,
  reportFields,
  SHEET_FILE,
  stepDir,
} from "../tasks/cross-app.ts";
import { type CheckpointVerdict, isSafeId, type OracleDetailCode } from "./api.ts";
import {
  checkEdit,
  collateralReason,
  diffDocument,
  expectedCells,
  listRefs,
  parseDocument,
  targetRef,
} from "./calc-document.ts";
import type { OracleFamily, OracleOutput } from "./families.ts";
import { StateCorruptError } from "./state-corrupt.ts";

export const CROSS_APP_MIN_STEPS = 2;
export const CROSS_APP_MAX_STEPS = 10;
export const CROSS_APP_MAX_EDITS_PER_STEP = 10;
export const REPORT_MAX_LINES = 10_000;
export const REPORT_MAX_LINE_LENGTH = 10_000;
const REPORT_VALUE_MAX = 200;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A C0 control other than TAB, LF and CR (line ends are handled apart), or DEL. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
      return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The report reader (plain text, hardened)
// ---------------------------------------------------------------------------

/**
 * Read a persisted report into lines. Refusals are StateCorruptError ("could not look"):
 *  - bytes that are not UTF-8 (fatal decode), or a second BOM;
 *  - a control character other than TAB, or a CR that does not end a line (CR-only files);
 *  - more than REPORT_MAX_LINES lines, or a line longer than REPORT_MAX_LINE_LENGTH.
 * Normalisation, and nothing else: one leading BOM is dropped (Writer's "Text (encoded)"
 * filter writes one), lines split on LF or CRLF, trailing spaces and tabs of a line are
 * dropped, and trailing empty lines are no content (as trailing empty CSV rows are).
 */
export function parseReport(bytes: Uint8Array): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StateCorruptError("report is not valid UTF-8");
  }
  if (text.startsWith("\ufeff")) text = text.slice(1);
  if (text.includes("\ufeff")) throw new StateCorruptError("report holds a byte-order mark inside");
  if (hasControl(text)) throw new StateCorruptError("report holds a control character");
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => line.includes("\r")))
    throw new StateCorruptError("report holds a carriage return that does not end a line");
  if (lines.length > REPORT_MAX_LINES + 1) throw new StateCorruptError("report has too many lines");
  if (lines.some((line) => line.length > REPORT_MAX_LINE_LENGTH))
    throw new StateCorruptError("report has a line that is too long");
  const trimmed = lines.map((line) => line.replace(/[ \t]+$/, ""));
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
  return trimmed;
}

/** The value a field line holds: the text after `<label>:` and its spaces; null if not that field. */
function fieldValue(line: string | undefined, label: string): string | null {
  if (line === undefined || !line.startsWith(`${label}:`)) return null;
  return line.slice(label.length + 1).replace(/^[ \t]+/, "");
}

export interface ReportDiff {
  /** Labels of the step's own fields that do not hold the expected value. */
  readonly targets: readonly string[];
  /** 1-based line numbers that differ otherwise (changed, removed or added). */
  readonly collateral: readonly string[];
}

/**
 * Diff a persisted report against the expected one, line by line. Field lines (after the
 * template's header) compare by value under their label; every other line compares exactly.
 */
export function diffReport(
  actual: readonly string[],
  expected: readonly string[],
  labels: readonly string[],
  stepLabels: ReadonlySet<string>,
): ReportDiff {
  const targets: string[] = [];
  const collateral: string[] = [];
  const length = Math.max(actual.length, expected.length);
  for (let i = 0; i < length; i++) {
    const label = i >= REPORT_HEADER_LINES ? labels[i - REPORT_HEADER_LINES] : undefined;
    if (label === undefined) {
      if (actual[i] !== expected[i]) collateral.push(String(i + 1));
      continue;
    }
    const want = fieldValue(expected[i], label);
    const got = fieldValue(actual[i], label);
    if (want !== null && got === want) continue;
    if (stepLabels.has(label)) targets.push(label);
    else collateral.push(String(i + 1));
  }
  return { targets, collateral };
}

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportValueProblem(value: unknown, what: string): string | undefined {
  if (typeof value !== "string" || value === "") return `${what} must be a non-empty string`;
  if (value.length > REPORT_VALUE_MAX) return `${what} is longer than ${REPORT_VALUE_MAX}`;
  if (hasControl(value) || /[\r\n\t\ufeff]/.test(value))
    return `${what} must be one line without control characters`;
  if (value.trim() !== value) return `${what} must not start or end with whitespace`;
  return undefined;
}

export function checkCrossAppSpec(spec: unknown): string | undefined {
  if (!isObject(spec)) return "spec must be an object";
  const { fixtureSeed, source, reportTitle, steps } = spec;
  if (typeof fixtureSeed !== "string" || fixtureSeed === "")
    return "spec.fixtureSeed must be a non-empty string";
  if (!isObject(source)) return "spec.source must be an object { file, sha256 }";
  if (typeof source.file !== "string" || !isSafeId(source.file))
    return "spec.source.file must be a plain file name";
  if (typeof source.sha256 !== "string" || !SHA256_HEX.test(source.sha256))
    return "spec.source.sha256 must be a lowercase sha256 hex digest";
  const titleProblem = reportValueProblem(reportTitle, "spec.reportTitle");
  if (titleProblem) return titleProblem;
  if (
    !Array.isArray(steps) ||
    steps.length < CROSS_APP_MIN_STEPS ||
    steps.length > CROSS_APP_MAX_STEPS
  )
    return `spec.steps must be an array of ${CROSS_APP_MIN_STEPS}-${CROSS_APP_MAX_STEPS} steps`;
  const cells = new Set<string>();
  const labels = new Set<string>();
  const entered: CrossAppEdit[] = [];
  for (const [index, step] of steps.entries()) {
    const where = `spec.steps[${index}]`;
    if (!isObject(step)) return `${where} must be an object`;
    if (step.app !== "calc" && step.app !== "writer")
      return `${where}.app must be "calc" or "writer"`;
    const { edits } = step;
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > CROSS_APP_MAX_EDITS_PER_STEP)
      return `${where}.edits must be an array of 1-${CROSS_APP_MAX_EDITS_PER_STEP} edits`;
    const thisStep: CrossAppEdit[] = [];
    for (const [j, raw] of edits.entries()) {
      const at = `${where}.edits[${j}]`;
      if (step.app === "calc") {
        const problem = checkEdit(fixtureSeed, raw, true);
        if (problem) return `${at} ${problem}`;
        const edit = raw as CrossAppEdit;
        const ref = targetRef(fixtureSeed, edit);
        if (cells.has(ref)) return `${at} targets cell ${ref} again`;
        cells.add(ref);
        thisStep.push(edit);
        continue;
      }
      if (!isObject(raw)) return `${at} must be an object`;
      const { rowKey, column, newValue } = raw;
      if (typeof rowKey !== "string" || typeof column !== "string")
        return `${at} rowKey and column must be strings`;
      const valueProblem = reportValueProblem(newValue, `${at}.newValue`);
      if (valueProblem) return valueProblem;
      const label = fieldLabel({ rowKey, column });
      if (labels.has(label)) return `${at} fills the report line ${label} again`;
      labels.add(label);
      // The data flows PDF -> Calc -> Writer: a report field states a value an EARLIER calc
      // step entered, so a writer step can only be checked once its source is checkpointed.
      if (
        !entered.some((e) => e.rowKey === rowKey && e.column === column && e.newValue === newValue)
      )
        return `${at} must report a value an earlier calc step entered`;
    }
    entered.push(...thisStep);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The family
// ---------------------------------------------------------------------------

interface Snapshot {
  readonly sheet: Readonly<Record<string, string>>;
  readonly report: readonly string[];
}

interface CheckResult {
  readonly name: string;
  readonly codes: readonly OracleDetailCode[];
  readonly reasons: readonly string[];
}

function utf8(bytes: Uint8Array, file: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StateCorruptError(`${file} is not valid UTF-8`);
  }
}

function snapshot(states: ReadonlyMap<string, Uint8Array>, dir: string): Snapshot {
  const sheetPath = `${dir}/${SHEET_FILE}`;
  const reportPath = `${dir}/${REPORT_FILE}`;
  const sheetBytes = states.get(sheetPath);
  const reportBytes = states.get(reportPath);
  // The gate reads every file `stateFiles` lists before `decide` runs; a missing one here is
  // a gate/family disagreement, an operator error (ORACLE_ERROR), never a verdict.
  if (sheetBytes === undefined || reportBytes === undefined)
    throw new Error(`the gate did not supply ${dir}'s snapshot`);
  let report: string[];
  try {
    report = parseReport(reportBytes);
  } catch (error) {
    if (error instanceof StateCorruptError)
      throw new StateCorruptError(`${reportPath}: ${error.message}`);
    throw error;
  }
  return { sheet: parseDocument(utf8(sheetBytes, sheetPath)).cells, report };
}

/** One check: a snapshot against the documents expected after steps 1..k. */
function check(
  spec: CrossAppSpec,
  name: string,
  snap: Snapshot,
  k: number,
  ownStep: number,
): CheckResult {
  const { calc } = editsThrough(spec, k);
  const own = spec.steps[ownStep - 1];
  const stepCells = new Set(
    own?.app === "calc" ? own.edits.map((e) => targetRef(spec.fixtureSeed, e)) : [],
  );
  const stepLabels = new Set(own?.app === "writer" ? own.edits.map((e) => fieldLabel(e)) : []);
  const sheet = diffDocument(snap.sheet, expectedCells(spec.fixtureSeed, calc), stepCells);
  const report = diffReport(
    snap.report,
    parseReport(new TextEncoder().encode(reportAt(spec, k))),
    reportFields(spec).map((e) => fieldLabel(e)),
    stepLabels,
  );
  const codes: OracleDetailCode[] = [];
  const reasons: string[] = [];
  if (sheet.targets.length > 0 || report.targets.length > 0) codes.push("TARGET_MISMATCH");
  if (sheet.collateral.length > 0 || report.collateral.length > 0)
    codes.push("DOCUMENT_COLLATERAL");
  for (const ref of sheet.targets) {
    const edit = own?.edits.find((e) => targetRef(spec.fixtureSeed, e) === ref);
    reasons.push(
      `${name} (${SHEET_FILE}): TARGET_MISMATCH: cell ${ref}${edit ? ` (record ${edit.rowKey}, column ${edit.column})` : ""} does not hold the requested value`,
    );
  }
  for (const label of report.targets)
    reasons.push(
      `${name} (${REPORT_FILE}): TARGET_MISMATCH: the report line ${label} does not hold the requested value`,
    );
  if (sheet.collateral.length > 0)
    reasons.push(`${name} (${SHEET_FILE}): ${collateralReason(sheet.collateral)}`);
  if (report.collateral.length > 0)
    reasons.push(
      `${name} (${REPORT_FILE}): DOCUMENT_COLLATERAL: ${report.collateral.length} line(s) the step does not target differ from the expected report (changed, removed or added): line ${listRefs(report.collateral)}`,
    );
  return { name, codes, reasons };
}

export const crossAppFamily: OracleFamily = {
  id: CROSS_APP_FAMILY,
  version: "1",
  checkSpec: checkCrossAppSpec,
  sealedFixture(spec) {
    const { source } = spec as CrossAppSpec;
    return { file: source.file, sha256: source.sha256 };
  },
  stateFiles(spec) {
    return crossAppEvidenceFiles((spec as CrossAppSpec).steps.length);
  },
  decide(_bytes, rawSpec, _ref, inputs): OracleOutput {
    const spec = rawSpec as CrossAppSpec;
    // The sealed notice: the gate checked its digest before calling; refuse to decide
    // without it (the agent must have been given the registered source).
    if (!inputs?.fixture) throw new Error("the gate did not supply the sealed source notice");
    const states = inputs.states;
    if (!states) throw new Error("the gate did not supply the step snapshots");
    const n = spec.steps.length;
    const steps = spec.steps.map((_, i) =>
      check(spec, `step ${i + 1}`, snapshot(states, stepDir(i + 1)), i + 1, i + 1),
    );
    const end = check(spec, "end state", snapshot(states, END_DIR), n, n);
    const ok = (c: CheckResult) => c.codes.length === 0;
    const checkpoints: CheckpointVerdict[] = steps.map((_, i) => {
      const k = i + 1;
      const holds = steps.slice(0, k).every(ok) && (k < n || ok(end));
      return { checkpoint: k, verdict: holds ? "verified" : "refuted" };
    });
    if (checkpoints.every((cp) => cp.verdict === "verified")) {
      return {
        status: "verified",
        reasons: [
          `all ${n} checkpoints hold: each step's snapshot of ${SHEET_FILE} and ${REPORT_FILE} equals the documents expected after it, and so does the end state`,
        ],
        checkpoints,
      };
    }
    const first = [...steps, end].find((c) => !ok(c)) as CheckResult;
    const failingSteps = steps.flatMap((c, i) => (ok(c) ? [] : [String(i + 1)]));
    const refuted = checkpoints.filter((cp) => cp.verdict === "refuted").map((cp) => cp.checkpoint);
    const reasons = [
      ...first.reasons,
      ...(failingSteps.length > 0
        ? [`steps whose own snapshot fails: ${listRefs(failingSteps)}`]
        : []),
      ...(ok(end) ? [] : ["the end state differs from the documents expected after every step"]),
      `checkpoints refuted: ${listRefs(refuted.map(String))} (checkpoint k needs steps 1..k; a later step never repairs an earlier one)`,
    ];
    return { status: "refuted", reasons, codes: [...first.codes], checkpoints };
  },
};
