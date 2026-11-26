/**
 * Track R: replay a compiled workflow on a fresh fixture, then have the gate verify it and
 * the independent grader grade it.
 *
 * Order, and what each step may see:
 *  1. bind the parameters (refused: no run);
 *  2. the fresh fixture's header must be the workflow's (refused: no run);
 *  3. R5: certify the bound derived oracle on this fixture (failed: no gate is built, the
 *     outcome is `refused` SELFTEST_FAILED; a derived oracle that did not pass never
 *     verifies anything);
 *  4. the actuator edits a working copy and saves; it never sees the evidence root;
 *  5. per-trial capture: after the actuator returned, the saved bytes are copied into
 *     `<evidenceRoot>/<runId>/doc.csv` beside the sealed fixture `fixture.csv`;
 *  6. one gate, bound to this one trial (`assignment`), with the derived family registered
 *     in the harness's own family map, gets only taskId/runId/claim (myco.gate/v1);
 *  7. the independent grader (`src/benchmark/grade/`, no shared code with the gate) grades
 *     the same captured bytes against the same fixture bytes. It takes one intent, so a
 *     single-edit workflow is graded and a multi-edit one is reported `not-applicable`
 *     (never counted as a pass).
 *
 * The report is labelled `derived` and carries `r1Evidence: false` as constants: nothing a
 * replay produces is R1 evidence, and a simulated replay is never evidence of anything.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ColumnType, GRADER_VERSION, grade } from "../benchmark/grade/grade.ts";
import { GATE_API_VERSION, type GateResult } from "../gate/api.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../gate/gate.ts";
import { type SelfTestSummary, selfTestSummary } from "../oracle-selftest/authoring.ts";
import { BindingError, bindWorkflow, type Compiled, inferKind } from "./compile.ts";
import {
  a1,
  CsvDocumentError,
  locateKeyed,
  parseA1,
  parseCsvRows,
  serializeCsvRows,
  sha256Hex,
} from "./csv.ts";
import {
  certifyDerivedOracle,
  DERIVED_FAMILY_ID,
  DERIVED_TRUST_LABEL,
  type DerivedTaskSpec,
  derivedWorkflowFamily,
} from "./derived-oracle.ts";
import { assertClean } from "./scrub.ts";

export const REPLAY_SCHEMA = "myco.workflow-replay/1";
export const STATE_FILE = "doc.csv";
export const FIXTURE_FILE = "fixture.csv";

/** Applies resolved cell edits to a document and saves it. Never sees the evidence root. */
export interface WorkflowActuator {
  readonly name: string;
  run(
    docPath: string,
    edits: ReadonlyArray<{ readonly cell: string; readonly value: string }>,
  ): { readonly ok: boolean; readonly error?: string };
}

/** The $0 actuator: edits the CSV on disk and saves. Optionally misbehaves, for tests. */
export function hermeticActuator(
  fault?: "skip-save" | "wrong-cell" | "collateral",
): WorkflowActuator {
  return {
    name: fault ? `hermetic-csv(${fault})` : "hermetic-csv",
    run(docPath, edits) {
      if (fault === "skip-save") return { ok: true };
      const rows = parseCsvRows(readFileSync(docPath));
      for (const [i, e] of edits.entries()) {
        const at = parseA1(e.cell);
        if (at === undefined) return { ok: false, error: "bad cell ref" };
        let r = at.row;
        const c = at.col;
        if (fault === "wrong-cell" && i === 0) r = r + 1 < rows.length ? r + 1 : r - 1;
        const row = rows[r] as string[];
        row[c] = e.value;
      }
      if (fault === "collateral") {
        const row = rows[rows.length - 1] as string[];
        row[1] = `${row[1]}X`;
      }
      writeFileSync(docPath, serializeCsvRows(rows));
      return { ok: true };
    },
  };
}

export type RefusalCode = "BINDING_REFUSED" | "FIXTURE_MISMATCH" | "SELFTEST_FAILED";

export interface ReplayReport {
  readonly schema: typeof REPLAY_SCHEMA;
  readonly workflowId: string;
  readonly trust: "derived";
  readonly label: typeof DERIVED_TRUST_LABEL;
  readonly r1Evidence: false;
  readonly simulated: boolean;
  readonly taskId: string;
  readonly runId: string;
  readonly outcome: "replayed" | "refused";
  readonly refusal: { readonly code: RefusalCode; readonly detail: string } | null;
  readonly bindings: Readonly<Record<string, string>>;
  readonly edits: number;
  readonly selfTest: SelfTestSummary | null;
  readonly actuator: {
    readonly name: string;
    readonly ok: boolean;
    readonly error?: string;
  } | null;
  readonly fixtureSha256: string;
  readonly persistedSha256: string | null;
  readonly gate: {
    readonly family: string | null;
    readonly familyVersion: string | null;
    readonly verdict: GateResult["verdict"];
    readonly accepted: boolean;
    readonly reasonCodes: readonly string[];
  } | null;
  readonly grade:
    | { readonly status: "pass" | "fail" | "ungradable"; readonly graderVersion: string }
    | { readonly status: "not-applicable"; readonly why: string }
    | null;
  /** Gate accepted iff grader passed; null when either did not decide. */
  readonly agree: boolean | null;
}

export interface ReplayOptions {
  readonly compiled: Compiled;
  readonly bindings?: Readonly<Record<string, string>>;
  /** The fresh fixture (CSV bytes) the replay starts from. */
  readonly fixture: Uint8Array;
  readonly actuator: WorkflowActuator;
  readonly evidenceRoot: string;
  readonly runId: string;
  readonly taskId?: string;
  /** Column types for the grader; by default inferred from the fixture's columns. */
  readonly columnTypes?: Readonly<Record<string, ColumnType>>;
  readonly claim?: string;
}

export async function replayWorkflow(options: ReplayOptions): Promise<ReplayReport> {
  const { compiled, fixture, actuator, evidenceRoot, runId } = options;
  const workflow = compiled.workflow;
  const taskId = options.taskId ?? `derived-${workflow.workflowId}`;
  const bindings = { ...(options.bindings ?? {}) };
  const fixtureSha256 = sha256Hex(fixture);
  const base = {
    schema: REPLAY_SCHEMA,
    workflowId: workflow.workflowId,
    trust: "derived",
    label: DERIVED_TRUST_LABEL,
    r1Evidence: false,
    simulated: workflow.simulated,
    taskId,
    runId,
    // Values are withheld until the bindings passed validation: a refused binding may be the
    // very value the report must not carry.
    bindings: Object.fromEntries(Object.keys(bindings).map((k) => [k, "(withheld)"])),
    fixtureSha256,
  } as const;
  const refused = (
    code: RefusalCode,
    detail: string,
    extra: Partial<ReplayReport> = {},
  ): ReplayReport =>
    finish({
      ...base,
      outcome: "refused",
      refusal: { code, detail },
      edits: 0,
      selfTest: null,
      actuator: null,
      persistedSha256: null,
      gate: null,
      grade: null,
      agree: null,
      ...extra,
    });

  let bound: ReturnType<typeof bindWorkflow>;
  try {
    bound = bindWorkflow(compiled, bindings);
  } catch (error) {
    if (error instanceof BindingError) return refused("BINDING_REFUSED", error.message);
    throw error;
  }
  let fxRows: string[][];
  try {
    fxRows = parseCsvRows(fixture);
  } catch (error) {
    return refused(
      "FIXTURE_MISMATCH",
      error instanceof CsvDocumentError ? error.message : "fixture unreadable",
    );
  }
  if (JSON.stringify(fxRows[0] ?? []) !== JSON.stringify(workflow.header)) {
    return refused("FIXTURE_MISMATCH", "the fixture's header is not the workflow's");
  }
  const resolved: { cell: string; value: string }[] = [];
  for (const e of bound.edits) {
    const at = locateKeyed(fxRows, e.rowKey, e.column);
    if ("error" in at)
      return refused(
        "BINDING_REFUSED",
        `record ${e.rowKey}, column ${e.column}: ${at.error} in the fixture`,
      );
    resolved.push({ cell: a1(at.row, at.col), value: e.value });
  }

  // R5 before anything can verify.
  const cert = certifyDerivedOracle(bound.oracle, bound.edits, fixture);
  const selfTest = selfTestSummary(cert.report);
  if (!cert.pass) {
    return refused(
      "SELFTEST_FAILED",
      cert.report.reasons.slice(0, 3).join("; ") || "self-test failed",
      {
        edits: bound.edits.length,
        selfTest,
      },
    );
  }

  // Act on a working copy; capture after the actuator returned.
  const runDir = join(evidenceRoot, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, FIXTURE_FILE), fixture);
  const work = mkdtempSync(join(tmpdir(), "myco-replay-"));
  let act: { ok: boolean; error?: string };
  let persisted: Uint8Array | null = null;
  try {
    const doc = join(work, STATE_FILE);
    writeFileSync(doc, fixture);
    try {
      act = actuator.run(doc, resolved);
    } catch (error) {
      act = { ok: false, error: error instanceof Error ? error.name : "actuator threw" };
    }
    if (existsSync(doc)) {
      copyFileSync(doc, join(runDir, STATE_FILE));
      persisted = new Uint8Array(readFileSync(join(runDir, STATE_FILE)));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // One gate, bound to this trial, with the derived family in the harness's own map.
  const spec: DerivedTaskSpec = { oracle: bound.oracle, fixtureFile: FIXTURE_FILE, fixtureSha256 };
  const tasks = buildRegistry(
    [{ id: taskId, family: DERIVED_FAMILY_ID, stateFile: STATE_FILE, spec }],
    new Map([[DERIVED_FAMILY_ID, derivedWorkflowFamily]]),
  );
  const gate = createGate({
    tasks,
    reader: fileEvidenceReader(evidenceRoot),
    assignment: { taskId, runId },
  });
  const result = await gate.check({
    apiVersion: GATE_API_VERSION,
    taskId,
    runId,
    claim: options.claim ?? "Done: replayed the recorded workflow and saved.",
  });

  // The independent grader, on the same captured bytes and fixture bytes.
  let graded: ReplayReport["grade"];
  if (bound.edits.length !== 1) {
    graded = {
      status: "not-applicable",
      why: "the independent grader takes one intent; this workflow makes several edits",
    };
  } else {
    const header = workflow.header;
    const columnTypes: Record<string, ColumnType> = { ...(options.columnTypes ?? {}) };
    header.forEach((name, c) => {
      columnTypes[name] ??= c === 0 ? "key" : inferKind(fxRows.slice(1).map((r) => r[c] ?? ""));
    });
    const edit = bound.edits[0] as (typeof bound.edits)[number];
    const g = grade({
      fixtureCsv: fixture,
      fixtureSha256,
      persisted: persisted === null ? null : { format: "csv", bytes: persisted },
      intent: { rowKey: edit.rowKey, column: edit.column, newValue: edit.value },
      columnTypes,
    });
    graded = { status: g.status, graderVersion: g.graderVersion };
  }
  const decided = graded.status === "pass" || graded.status === "fail";
  return finish({
    ...base,
    bindings,
    outcome: "replayed",
    refusal: null,
    edits: bound.edits.length,
    selfTest,
    actuator: { name: actuator.name, ok: act.ok, ...(act.error ? { error: act.error } : {}) },
    persistedSha256: persisted === null ? null : sha256Hex(persisted),
    gate: {
      family: result.oracle?.family ?? null,
      familyVersion: result.oracle?.version ?? null,
      verdict: result.verdict,
      accepted: result.accepted,
      reasonCodes: [...result.reasonCodes],
    },
    grade: graded,
    agree:
      decided && result.verdict !== "uncertain"
        ? result.accepted === (graded.status === "pass")
        : null,
  });
}

function finish(report: ReplayReport): ReplayReport {
  assertClean(report);
  return report;
}

export { GRADER_VERSION };
