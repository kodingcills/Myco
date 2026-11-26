/**
 * Track R: the compiler. Turns a recording into a parameterized workflow and a derived
 * oracle, or refuses with a code.
 *
 * What the human did is read from TWO places and they must agree:
 *  - the document's before and after state on disk (the truth of what changed), and
 *  - the action log (how it changed: app-level cell edits, or GUI events as the fallback).
 * Every changed cell must be explained by the log: the last app-level edit of that cell
 * before the last save must hold exactly the saved value; a cell with no app-level edit is
 * accepted only when a GUI event touched it (marked `gui-fallback`). A change nothing
 * explains, an app-level edit the saved file contradicts, an edit after the last save, a
 * changed header, key or row structure, a cleared cell, or any redaction refuses the
 * whole recording. The compiler never guesses a workflow from a partial demonstration.
 *
 * Parameterization: every distinct record the human edited becomes a `record` parameter
 * (bound to a row key at replay), and every edited value a `value` parameter. Steps
 * address cells by record key and column header, never by A1 position, so a workflow
 * replays on a fresh fixture whose rows sit elsewhere.
 *
 * The derived oracle is three allowlisted assertion types (`types.ts`): the header is the
 * fixture's, each edited cell holds its bound value, and every other cell is the fixture's.
 * It is data, interpreted by `derived-oracle.ts`; nothing recorded is ever executed.
 */
import { isAutoCorrectImmune } from "../tasks/intent.ts";
import { a1, CSV_UNSAFE, locateKeyed, parseA1, sha256Hex } from "./csv.ts";
import { assertClean, findSensitive } from "./scrub.ts";
import {
  type BoundDerivedOracle,
  type ColumnKind,
  DERIVED_ORACLE_SCHEMA,
  type DerivedOracle,
  type KeyedEdit,
  RECORDING_SCHEMA,
  type Recording,
  type ValueRef,
  WORKFLOW_SCHEMA,
  type Workflow,
  type WorkflowParameter,
  type WorkflowStep,
} from "./types.ts";

export const COMPILE_ERRORS = [
  "RECORDING_MALFORMED",
  "NOT_OPERATOR_STARTED",
  "RECORDING_REDACTED",
  "HEADER_CHANGED",
  "STRUCTURE_CHANGED",
  "KEY_CHANGED",
  "NO_SAVE",
  "UNSAVED_TRAILING_EDITS",
  "NO_EDITS",
  "UNEXPLAINED_CHANGE",
  "LOG_CONTRADICTS_DOCUMENT",
  "CLEARED_CELL",
  "VALUE_NOT_REPLAYABLE",
] as const;
export type CompileErrorCode = (typeof COMPILE_ERRORS)[number];

export class CompileError extends Error {
  override readonly name = "CompileError";
  constructor(
    readonly code: CompileErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export interface Compiled {
  readonly workflow: Workflow;
  readonly oracle: DerivedOracle;
}

const KIND_PATTERNS: ReadonlyArray<readonly [ColumnKind, RegExp]> = [
  ["integer", /^-?\d+$/],
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["currency", /^\$-?\d+(?:\.\d{2})?$/],
];

/** A column's kind: the narrowest pattern every non-empty data value matches, else text. */
export function inferKind(values: readonly string[]): ColumnKind {
  const present = values.filter((v) => v !== "");
  if (present.length === 0) return "text";
  for (const [kind, re] of KIND_PATTERNS) if (present.every((v) => re.test(v))) return kind;
  return "text";
}

export function valueMatchesKind(value: string, kind: ColumnKind | "key"): boolean {
  if (kind === "text" || kind === "key") return true;
  const pattern = KIND_PATTERNS.find(([k]) => k === kind)?.[1];
  // An unknown kind matches nothing: fail closed.
  return pattern?.test(value) === true;
}

function cellAt(rows: Recording["before"]["rows"], r: number, c: number): string {
  return rows[r]?.[c] ?? "";
}

function checkShape(rec: Recording): void {
  const ok =
    typeof rec === "object" &&
    rec !== null &&
    rec.schema === RECORDING_SCHEMA &&
    rec.app === "calc" &&
    Array.isArray(rec.actions) &&
    Array.isArray(rec.redactions) &&
    Array.isArray(rec.before?.rows) &&
    Array.isArray(rec.after?.rows) &&
    typeof rec.simulated === "boolean";
  if (!ok) throw new CompileError("RECORDING_MALFORMED", "not a myco.recording/1 document");
}

/** Compile a recording. Throws `CompileError` with a code on any refusal. */
export function compileRecording(rec: Recording): Compiled {
  checkShape(rec);
  if (rec.consent?.startedBy !== "operator" || rec.consent?.indicatorShown !== true) {
    throw new CompileError(
      "NOT_OPERATOR_STARTED",
      "the recording was not operator-started and visible",
    );
  }
  if (rec.redactions.length > 0) {
    throw new CompileError(
      "RECORDING_REDACTED",
      `${rec.redactions.length} value(s) were redacted at capture; a redacted value cannot be replayed`,
    );
  }
  // A recording read back from disk is re-checked: the compiler never trusts that the
  // recorder ran.
  try {
    assertClean(rec);
  } catch {
    throw new CompileError(
      "RECORDING_REDACTED",
      "the recording holds a secret-shaped string or a host path",
    );
  }

  const before = rec.before.rows;
  const after = rec.after.rows;
  const header = before[0] ?? [];
  if (header.length < 2 || JSON.stringify(after[0] ?? []) !== JSON.stringify(header)) {
    throw new CompileError("HEADER_CHANGED", "the header row changed or is missing");
  }
  if (before.length !== after.length) {
    throw new CompileError("STRUCTURE_CHANGED", "rows were added or removed");
  }
  const width = header.length;
  for (let r = 0; r < after.length; r++) {
    if ((after[r]?.length ?? 0) > width || (before[r]?.length ?? 0) > width) {
      throw new CompileError("STRUCTURE_CHANGED", "a row has cells beyond the header");
    }
  }
  const keys = before.slice(1).map((row) => row[0] ?? "");
  if (new Set(keys).size !== keys.length || keys.some((k) => k === "")) {
    throw new CompileError("STRUCTURE_CHANGED", "record keys are not unique and non-empty");
  }

  // The last save bounds what was persisted.
  let lastSave = -1;
  rec.actions.forEach((a, i) => {
    if (a.kind === "save") lastSave = i;
  });
  if (lastSave === -1) throw new CompileError("NO_SAVE", "the demonstration never saved");
  if (rec.actions.slice(lastSave + 1).some((a) => a.kind === "cell-edit")) {
    throw new CompileError(
      "UNSAVED_TRAILING_EDITS",
      "the demonstration edited cells after its last save",
    );
  }
  const persisted = rec.actions.slice(0, lastSave);

  // Last app-level value per cell, and cells any GUI event touched, before the last save.
  const appValue = new Map<string, { value: string; seq: number }>();
  const guiFirst = new Map<string, number>();
  for (const a of persisted) {
    if (a.kind === "cell-edit") appValue.set(a.cell, { value: a.value, seq: a.seq });
    else if (a.kind === "gui" && a.cell !== null && !guiFirst.has(a.cell))
      guiFirst.set(a.cell, a.seq);
  }

  // Every app-level edit must agree with the saved document.
  for (const [cell, { value }] of appValue) {
    const at = parseA1(cell);
    if (at === undefined || cellAt(after, at.row, at.col) !== value) {
      throw new CompileError(
        "LOG_CONTRADICTS_DOCUMENT",
        `cell ${cell}: the app reported an edit the saved document does not hold`,
      );
    }
  }

  interface Change {
    row: number;
    col: number;
    value: string;
    evidence: "app" | "gui-fallback";
    seq: number;
  }
  const changes: Change[] = [];
  for (let r = 0; r < after.length; r++) {
    for (let c = 0; c < width; c++) {
      const was = cellAt(before, r, c);
      const now = cellAt(after, r, c);
      if (was === now) continue;
      const ref = a1(r, c);
      if (c === 0) throw new CompileError("KEY_CHANGED", `record key cell ${ref} changed`);
      if (now === "") throw new CompileError("CLEARED_CELL", `cell ${ref} was cleared`);
      const app = appValue.get(ref);
      const gui = guiFirst.get(ref);
      if (app !== undefined)
        changes.push({ row: r, col: c, value: now, evidence: "app", seq: app.seq });
      else if (gui !== undefined)
        changes.push({ row: r, col: c, value: now, evidence: "gui-fallback", seq: gui });
      else
        throw new CompileError(
          "UNEXPLAINED_CHANGE",
          `cell ${ref} changed and no recorded action explains it`,
        );
    }
  }
  if (changes.length === 0)
    throw new CompileError("NO_EDITS", "the saved document equals the original");
  changes.sort((x, y) => x.seq - y.seq || x.row - y.row || x.col - y.col);

  const kinds = header.map((_h, c) =>
    c === 0 ? "key" : inferKind(before.slice(1).map((row) => row[c] ?? "")),
  );
  const recordParam = new Map<string, string>();
  const parameters: WorkflowParameter[] = [];
  const steps: WorkflowStep[] = [];
  const multi = changes.length > 1;
  const distinctKeys = new Set(changes.map((ch) => cellAt(before, ch.row, 0))).size;
  changes.forEach((ch, i) => {
    const rowKey = cellAt(before, ch.row, 0);
    const column = header[ch.col] as string;
    const kind = kinds[ch.col] as ColumnKind;
    if (
      CSV_UNSAFE.test(ch.value) ||
      !valueMatchesKind(ch.value, kind) ||
      !isAutoCorrectImmune(ch.value, kind)
    ) {
      throw new CompileError(
        "VALUE_NOT_REPLAYABLE",
        `cell ${a1(ch.row, ch.col)}: the value cannot be replayed safely in a ${kind} column`,
      );
    }
    let rp = recordParam.get(rowKey);
    if (rp === undefined) {
      rp = distinctKeys > 1 ? `record_${recordParam.size + 1}` : "record";
      recordParam.set(rowKey, rp);
      parameters.push({ name: rp, role: "record", kind: "key", demonstrated: rowKey });
    }
    const vp = multi ? `${safeName(column)}_${i + 1}` : safeName(column);
    parameters.push({ name: vp, role: "value", kind, demonstrated: ch.value });
    steps.push({
      op: "set-cell",
      rowKey: { param: rp },
      column,
      value: { param: vp },
      evidence: ch.evidence,
    });
  });
  steps.push({ op: "save" });

  const recordingSha256 = sha256Hex(JSON.stringify(rec));
  const workflowId = `wf-${recordingSha256.slice(0, 12)}`;
  const workflow: Workflow = {
    schema: WORKFLOW_SCHEMA,
    workflowId,
    app: "calc",
    recordingSha256,
    simulated: rec.simulated,
    header: [...header],
    parameters,
    steps,
  };
  const oracle: DerivedOracle = {
    schema: DERIVED_ORACLE_SCHEMA,
    trust: "derived",
    workflowId,
    assertions: [
      { type: "header-equals-fixture" },
      ...steps.flatMap((s) =>
        s.op === "set-cell"
          ? [{ type: "cell-equals" as const, rowKey: s.rowKey, column: s.column, value: s.value }]
          : [],
      ),
      { type: "others-equal-fixture" },
    ],
  };
  assertClean(workflow);
  assertClean(oracle);
  return { workflow, oracle };
}

function safeName(column: string): string {
  const name = column.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z])/, "c_$1");
  return name.length > 0 ? name.slice(0, 40) : "value";
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

export class BindingError extends Error {
  override readonly name = "BindingError";
}

const RECORD_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Bind a workflow's parameters (`bindings` overrides the demonstrated values) and return
 * the edits it makes plus the bound derived oracle. Refuses unknown or invalid bindings,
 * secret-shaped values and two steps landing on one cell.
 */
export function bindWorkflow(
  compiled: Compiled,
  bindings: Readonly<Record<string, string>> = {},
): { edits: KeyedEdit[]; oracle: BoundDerivedOracle } {
  const { workflow, oracle } = compiled;
  const params = new Map(workflow.parameters.map((p) => [p.name, p]));
  for (const name of Object.keys(bindings)) {
    if (!params.has(name)) throw new BindingError(`unknown parameter ${JSON.stringify(name)}`);
  }
  const value = (ref: ValueRef): string => {
    const p = params.get(ref.param);
    if (p === undefined)
      throw new BindingError(`workflow references undeclared parameter ${ref.param}`);
    const v = Object.hasOwn(bindings, p.name) ? (bindings[p.name] as string) : p.demonstrated;
    if (typeof v !== "string" || v === "" || CSV_UNSAFE.test(v)) {
      throw new BindingError(
        `parameter ${p.name}: must be non-empty, without a comma, quote or line break`,
      );
    }
    if (findSensitive(v))
      throw new BindingError(`parameter ${p.name}: secret-shaped or host-path value refused`);
    if (p.role === "record" && !RECORD_KEY.test(v))
      throw new BindingError(`parameter ${p.name}: not a record key`);
    if (p.role === "value" && (!valueMatchesKind(v, p.kind) || !isAutoCorrectImmune(v, p.kind))) {
      throw new BindingError(`parameter ${p.name}: not a replayable ${p.kind} value`);
    }
    return v;
  };
  const edits: KeyedEdit[] = [];
  const seen = new Set<string>();
  for (const step of workflow.steps) {
    if (step.op !== "set-cell") continue;
    const edit = { rowKey: value(step.rowKey), column: step.column, value: value(step.value) };
    const key = `${edit.rowKey}\u0000${edit.column}`;
    if (seen.has(key)) throw new BindingError("two steps bind to the same cell");
    seen.add(key);
    edits.push(edit);
  }
  return {
    edits,
    oracle: {
      schema: oracle.schema,
      trust: "derived",
      workflowId: oracle.workflowId,
      assertions: oracle.assertions.map((a) =>
        a.type === "cell-equals" ? { ...a, rowKey: value(a.rowKey), value: value(a.value) } : a,
      ),
    },
  };
}

/** Apply keyed edits to a CSV document's rows (replay's expected document, self-test's control). */
export function applyEdits(
  rows: readonly (readonly string[])[],
  edits: readonly KeyedEdit[],
): string[][] {
  const out = rows.map((r) => [...r]);
  for (const e of edits) {
    const at = locateKeyed(out, e.rowKey, e.column);
    if ("error" in at) throw new BindingError(`edit ${e.rowKey}/${e.column}: ${at.error}`);
    const row = out[at.row] as string[];
    while (row.length <= at.col) row.push("");
    row[at.col] = e.value;
  }
  return out;
}
