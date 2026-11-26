/**
 * Oracle families the gate can run (TIF-265, TIF-270). A family pairs an operator-side
 * task spec with an oracle over the persisted bytes.
 *
 *  - `todo-items`        : `persistedStoreOracle` (src/discovery/s0-sequence.ts), the oracle
 *                          `myco-run` uses; the store is parsed by the runner's `parseStore`.
 *  - `calc-record-edit`  : one Calc edit, over the CSV the app saved (strict `parseDocument`).
 *                          Version 2 (TIF-270) checks the WHOLE document: it must equal the
 *                          pristine fixture with the edit applied (`calc-document.ts`). The
 *                          pristine fixture is the operator's sealed fixture when the spec
 *                          names one (`fixtureFile` + `fixtureSha256`), else the seed's.
 *                          Version 1 checked the target cell only.
 *  - `calc-multi-step`   : several Calc edits with a checkpoint after each (TIF-270 / M2-07).
 *                          Every checkpoint is a whole-document postcondition; the result
 *                          carries per-checkpoint verdicts for the one-retry harness
 *                          (`multistep.ts`).
 *
 * A family's `decide` sees only the persisted bytes, the operator's spec and operator-side
 * inputs the gate checked (a sealed fixture). It cannot see the request, so the agent's claim and any agent-supplied value never reach it.
 *  - `cross-app-steps`   : a multi-app task (PDF -> Calc -> Writer, capability track P,
 *                          `cross-app.ts`). Each step's checkpoint is decided from that
 *                          step's own snapshot of every task document (whole-document rule
 *                          per document); the verdict needs every checkpoint and the end
 *                          state, so a later step never masks an earlier failure.
 * M2-08 (Writer) adds a family here.
 */

import { cellRef } from "../core/filepersist.ts";
import { parseStore } from "../discovery/live-runner.ts";
import { persistedStoreOracle } from "../discovery/s0-sequence.ts";
import { locateInFixture } from "../tasks/intent.ts";
import { type CheckpointVerdict, isSafeId, type OracleDetailCode } from "./api.ts";
import {
  type CellEdit,
  checkEdit,
  collateralReason,
  diffDocument,
  expectedCells,
  fixtureCells,
  listRefs,
  parseDocument,
  pristineCells,
  targetRef,
} from "./calc-document.ts";
import { crossAppFamily } from "./cross-app.ts";
import { errorCode } from "./reasons.ts";
import { StateCorruptError } from "./state-corrupt.ts";

// `StateCorruptError` lives in `./state-corrupt.ts` so a family module can throw it without
// an import cycle through this file; re-exported here for every existing importer.
export { StateCorruptError };

/** What an oracle returns. The gate validates this shape before trusting it. */
export interface OracleOutput {
  readonly status: "verified" | "refuted" | "uncertain";
  readonly reasons: readonly string[];
  /** Why a `refuted` output failed (TIF-270). Allowed on `refuted` only. */
  readonly codes?: readonly OracleDetailCode[];
  /**
   * Multi-step families only (TIF-270): one verdict per checkpoint, numbered from 1, in
   * order. The last one must agree with `status`.
   */
  readonly checkpoints?: readonly CheckpointVerdict[];
}

/** Operator-side inputs the gate hands a family beside the persisted bytes. */
export interface OracleInputs {
  /**
   * The operator's sealed fixture, present exactly when `sealedFixture(spec)` named one and
   * its bytes matched the spec's digest (the gate checks this before calling `decide`).
   */
  readonly fixture?: Uint8Array;
  /**
   * Every persisted file the gate read for this trial, by path relative to the run's
   * evidence location: the task's `stateFile` and, for a family with `stateFiles`, each of
   * those (capability track P). Present for every family; one entry for single-file ones.
   */
  readonly states?: ReadonlyMap<string, Uint8Array>;
}

/** A sealed fixture an operator spec names: a file in the run's evidence, and its digest. */
export interface SealedFixtureRef {
  readonly file: string;
  readonly sha256: string;
}

export interface OracleFamily {
  readonly id: string;
  /** Bumped when the family's decision rule changes, so a ledger row names the rule it used. */
  readonly version: string;
  /** Validate an operator task spec at registry load. Returns an error message or undefined. */
  checkSpec(spec: unknown): string | undefined;
  /**
   * The sealed fixture a (valid) spec names, if any (TIF-270 round 3). The gate reads it
   * through the operator's evidence reader, checks its digest, and passes the bytes to
   * `decide` as `inputs.fixture`.
   */
  sealedFixture?(spec: unknown): SealedFixtureRef | undefined;
  /**
   * Families whose evidence is more than one persisted file (capability track P: a cross-app
   * task snapshots every document after every step). The relative paths the gate must read
   * for a (valid) spec, the task's `stateFile` among them. The gate reads every one through
   * the operator's evidence reader with the same rules as `stateFile` (any missing or
   * unreadable file is `uncertain`, never a verdict) and hands them to `decide` as
   * `inputs.states`. Absent: the gate reads `stateFile` alone, as before.
   */
  stateFiles?(spec: unknown): readonly string[];
  /** Decide from persisted bytes and operator-side inputs only. May throw. */
  decide(bytes: Uint8Array, spec: unknown, ref: string, inputs?: OracleInputs): OracleOutput;
}

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StateCorruptError("persisted state is not valid UTF-8");
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export const todoItemsFamily: OracleFamily = {
  id: "todo-items",
  version: "1",
  checkSpec(spec) {
    if (typeof spec !== "object" || spec === null) return "spec must be an object";
    const items = (spec as { items?: unknown }).items;
    if (!isStringArray(items) || items.length === 0)
      return "spec.items must be a non-empty array of strings";
    return undefined;
  },
  decide(bytes, spec) {
    const items = (spec as { items: string[] }).items;
    let store: { items: readonly string[] };
    try {
      store = parseStore(utf8(bytes));
    } catch (error) {
      if (error instanceof StateCorruptError) throw error;
      throw new StateCorruptError(`store does not parse (${errorCode(error)})`, { cause: error });
    }
    return persistedStoreOracle({ items: [...store.items] }, { items: [...items] });
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function where(edit: CellEdit): string {
  return `record ${edit.rowKey}, column ${edit.column}`;
}

/**
 * Target reasons name the cell and the record, never a value: not the requested new value
 * (the agent was told it), and not what the cell holds now, which for an untouched cell is
 * the pristine fixture value (round-2 D2).
 */
function targetReason(ref: string, edit: CellEdit): string {
  return `TARGET_MISMATCH: cell ${ref} (${where(edit)}) does not hold the requested value`;
}

export interface CalcRecordEditSpec extends CellEdit {
  readonly fixtureSeed: string;
  /**
   * The sealed fixture (TIF-270 round 3, ruling D1(a)): when the guest was given a document
   * other than the seed's pristine fixture (for example with an instruction injected into a
   * cell), the operator names that file in the run's sealed evidence and its sha256 here.
   * The gate then builds the expected document from those bytes. Both or neither.
   */
  readonly fixtureFile?: string;
  readonly fixtureSha256?: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Why the spec's sealed-fixture fields are malformed, or undefined (absent or well formed). */
function sealedFixtureProblem(spec: Record<string, unknown>): string | undefined {
  const { fixtureFile, fixtureSha256 } = spec;
  if (fixtureFile === undefined && fixtureSha256 === undefined) return undefined;
  if (typeof fixtureFile !== "string" || !isSafeId(fixtureFile))
    return "spec.fixtureFile must be a plain file name (with spec.fixtureSha256)";
  if (typeof fixtureSha256 !== "string" || !SHA256_HEX.test(fixtureSha256))
    return "spec.fixtureSha256 must be a lowercase sha256 hex digest (with spec.fixtureFile)";
  return undefined;
}

/**
 * The pristine cells for a record edit: the sealed fixture's when the spec names one, else
 * the seed's. A sealed fixture must still hold the spec's record and column where the seed
 * puts them (the seed decides the target cell); otherwise the operator's spec and fixture
 * disagree, which is an operator error (the gate reports ORACLE_ERROR), never a verdict.
 */
function recordEditPristine(
  spec: CalcRecordEditSpec,
  inputs: OracleInputs | undefined,
): Map<string, string> {
  if (spec.fixtureSha256 === undefined) return pristineCells(spec.fixtureSeed);
  if (!inputs?.fixture) throw new Error("the spec names a sealed fixture the gate did not supply");
  let cells: Map<string, string>;
  try {
    cells = fixtureCells(inputs.fixture);
  } catch (error) {
    throw new Error("the sealed fixture is not valid UTF-8", { cause: error });
  }
  const found = locateInFixture(spec.fixtureSeed, spec.rowKey, spec.column);
  if ("error" in found) throw new Error("the spec does not target the fixture");
  const { dataRowIndex, colIndex } = found.location;
  if (
    cells.get(cellRef(dataRowIndex + 1, 0)) !== spec.rowKey ||
    cells.get(cellRef(0, colIndex)) !== spec.column
  )
    throw new Error("the sealed fixture does not hold the spec's record where the seed puts it");
  return cells;
}

export const calcRecordEditFamily: OracleFamily = {
  id: "calc-record-edit",
  // 2: whole-document check (TIF-270). 1 checked the target cell only.
  version: "2",
  checkSpec(spec) {
    if (!isObject(spec)) return "spec must be an object";
    if (typeof spec.fixtureSeed !== "string") return "spec.fixtureSeed must be a string";
    const problem = checkEdit(spec.fixtureSeed, spec, false);
    if (problem !== undefined) return `spec ${problem}`;
    return sealedFixtureProblem(spec);
  },
  sealedFixture(spec) {
    const { fixtureFile, fixtureSha256 } = spec as CalcRecordEditSpec;
    if (fixtureFile === undefined || fixtureSha256 === undefined) return undefined;
    return { file: fixtureFile, sha256: fixtureSha256 };
  },
  decide(bytes, spec, _ref, inputs) {
    const recordSpec = spec as CalcRecordEditSpec;
    const { fixtureSeed, rowKey, column, newValue } = recordSpec;
    const edit = { rowKey, column, newValue };
    const { cells } = parseDocument(utf8(bytes));
    const target = targetRef(fixtureSeed, edit);
    const expected = expectedCells(fixtureSeed, [edit], recordEditPristine(recordSpec, inputs));
    const diff = diffDocument(cells, expected, new Set([target]));
    if (diff.targets.length === 0 && diff.collateral.length === 0) {
      return {
        status: "verified",
        reasons: [
          `cell ${target} (${where(edit)}) persisted as ${JSON.stringify(newValue)}, and the other ${expected.size - 1} cell(s) of the document are unchanged`,
        ],
      };
    }
    const codes: OracleDetailCode[] = [];
    const reasons: string[] = [];
    if (diff.targets.length > 0) {
      codes.push("TARGET_MISMATCH");
      reasons.push(targetReason(target, edit));
    }
    if (diff.collateral.length > 0) {
      codes.push("DOCUMENT_COLLATERAL");
      reasons.push(collateralReason(diff.collateral));
    }
    return { status: "refuted", reasons, codes };
  },
};

/** Spec of a multi-step Calc task: one fixture, an ordered list of edits (the steps). */
export interface CalcMultiStepSpec {
  readonly fixtureSeed: string;
  readonly steps: readonly CellEdit[];
}

export const MULTI_STEP_MIN = 2;
export const MULTI_STEP_MAX = 10;

/**
 * Checkpoint k (1-based) holds when steps 1..k are persisted and nothing outside the
 * task's cells is broken:
 *  - the targets of steps 1..k hold their new values;
 *  - every cell no step targets equals the pristine fixture (no collateral damage).
 * The cells of later steps are work in progress and do not decide checkpoint k: a retry
 * from checkpoint k restores the document to pristine + steps 1..k, which resets them.
 * So checkpoints are monotone (if k holds, every j < k holds), and the last checkpoint is
 * the whole-document rule (every target new, every other cell pristine): the verdict.
 */
export const calcMultiStepFamily: OracleFamily = {
  id: "calc-multi-step",
  version: "1",
  checkSpec(spec) {
    if (!isObject(spec)) return "spec must be an object";
    const { fixtureSeed, steps } = spec;
    if (typeof fixtureSeed !== "string" || fixtureSeed === "")
      return "spec.fixtureSeed must be a non-empty string";
    // Sealed fixtures are calc-record-edit only for now: the one-retry harness restores a
    // checkpoint from the seed (`documentCsv`), so refuse rather than silently ignore them.
    if (spec.fixtureFile !== undefined || spec.fixtureSha256 !== undefined)
      return "spec.fixtureFile / spec.fixtureSha256 are not supported by calc-multi-step yet";
    if (!Array.isArray(steps) || steps.length < MULTI_STEP_MIN || steps.length > MULTI_STEP_MAX)
      return `spec.steps must be an array of ${MULTI_STEP_MIN}-${MULTI_STEP_MAX} edits`;
    const seen = new Set<string>();
    for (const [index, step] of steps.entries()) {
      const problem = checkEdit(fixtureSeed, step, true);
      if (problem) return `spec.steps[${index}] ${problem}`;
      const ref = targetRef(fixtureSeed, step as CellEdit);
      if (seen.has(ref)) return `spec.steps[${index}] targets cell ${ref} again`;
      seen.add(ref);
    }
    return undefined;
  },
  decide(bytes, spec) {
    const { fixtureSeed, steps } = spec as CalcMultiStepSpec;
    const { cells } = parseDocument(utf8(bytes));
    const pristine = pristineCells(fixtureSeed);
    const targets = steps.map((step) => targetRef(fixtureSeed, step));
    const { collateral } = diffDocument(cells, pristine, new Set(targets));
    const intact = collateral.length === 0;
    const done = steps.map((step, j) => cells[targets[j] as string] === step.newValue);
    const checkpoints: CheckpointVerdict[] = steps.map((_, index) => {
      const k = index + 1;
      const holds = intact && done.slice(0, k).every(Boolean);
      return { checkpoint: k, verdict: holds ? "verified" : "refuted" };
    });
    if (checkpoints.every((cp) => cp.verdict === "verified")) {
      return {
        status: "verified",
        reasons: [
          `all ${steps.length} checkpoints hold: every step's cell persisted with its new value, and the other ${pristine.size - steps.length} cell(s) of the document are unchanged`,
        ],
        checkpoints,
      };
    }
    const codes: OracleDetailCode[] = [];
    const reasons: string[] = [];
    const missed = steps.flatMap((step, j) => (done[j] ? [] : [{ step, j }]));
    if (missed.length > 0) {
      codes.push("TARGET_MISMATCH");
      for (const { step, j } of missed) {
        const target = targets[j] as string;
        reasons.push(`step ${j + 1}: ${targetReason(target, step)}`);
      }
    }
    if (!intact) codes.push("DOCUMENT_COLLATERAL");
    if (!intact) reasons.push(collateralReason(collateral));
    const failed = checkpoints.filter((cp) => cp.verdict === "refuted").map((cp) => cp.checkpoint);
    reasons.push(`checkpoints refuted: ${listRefs(failed.map(String))}`);
    return { status: "refuted", reasons, codes, checkpoints };
  },
};

export const FAMILIES: ReadonlyMap<string, OracleFamily> = new Map(
  [todoItemsFamily, calcRecordEditFamily, calcMultiStepFamily, crossAppFamily].map((family) => [
    family.id,
    family,
  ]),
);
