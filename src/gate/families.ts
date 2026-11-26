/**
 * Oracle families the gate can run (TIF-265, TIF-270). A family pairs an operator-side
 * task spec with an oracle over the persisted bytes.
 *
 *  - `todo-items`        : `persistedStoreOracle` (src/discovery/s0-sequence.ts), the oracle
 *                          `myco-run` uses; the store is parsed by the runner's `parseStore`.
 *  - `calc-record-edit`  : one Calc edit, over the CSV the app saved (`parseCsvSpreadsheet`).
 *                          Version 2 (TIF-270) checks the WHOLE document: it must equal the
 *                          pristine fixture with the edit applied (`calc-document.ts`).
 *                          Version 1 checked the target cell only.
 *  - `calc-multi-step`   : several Calc edits with a checkpoint after each (TIF-270 / M2-07).
 *                          Every checkpoint is a whole-document postcondition; the result
 *                          carries per-checkpoint verdicts for the one-retry harness
 *                          (`multistep.ts`).
 *
 * A family's `decide` sees only the persisted bytes and the operator's spec. It cannot see
 * the request, so the agent's claim and any agent-supplied value never reach it.
 * M2-08 (Writer) adds a family here.
 */
import { parseCsvSpreadsheet } from "../core/filepersist.ts";
import { parseStore } from "../discovery/live-runner.ts";
import { persistedStoreOracle } from "../discovery/s0-sequence.ts";
import type { CheckpointVerdict, OracleDetailCode } from "./api.ts";
import {
  type CellEdit,
  checkEdit,
  collateralReason,
  diffDocument,
  expectedCells,
  listRefs,
  pristineCells,
  targetRef,
} from "./calc-document.ts";
import { errorCode } from "./reasons.ts";

/**
 * Thrown by `decide` when the persisted bytes do not parse as the family's format. The
 * message reaches the agent ("could not look: <message>"), so it must not carry a host
 * path or a raw error message; put the underlying error in `cause`, which the gate hands
 * to the operator only (`GateConfig.onDiagnostic`).
 */
export class StateCorruptError extends Error {
  override readonly name = "StateCorruptError";
}

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

export interface OracleFamily {
  readonly id: string;
  /** Bumped when the family's decision rule changes, so a ledger row names the rule it used. */
  readonly version: string;
  /** Validate an operator task spec at registry load. Returns an error message or undefined. */
  checkSpec(spec: unknown): string | undefined;
  /** Decide from persisted bytes and the operator's spec only. May throw. */
  decide(bytes: Uint8Array, spec: unknown, ref: string): OracleOutput;
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

/** Target reasons name the cell and what it holds now (the agent wrote it), never a fixture value. */
function targetReason(ref: string, edit: CellEdit, actual: string | undefined): string {
  return `TARGET_MISMATCH: cell ${ref} (${where(edit)}) does not hold the requested value; it ${
    actual === undefined ? "is empty" : `holds ${JSON.stringify(actual)}`
  }`;
}

export interface CalcRecordEditSpec extends CellEdit {
  readonly fixtureSeed: string;
}

export const calcRecordEditFamily: OracleFamily = {
  id: "calc-record-edit",
  // 2: whole-document check (TIF-270). 1 checked the target cell only.
  version: "2",
  checkSpec(spec) {
    if (!isObject(spec)) return "spec must be an object";
    if (typeof spec.fixtureSeed !== "string") return "spec.fixtureSeed must be a string";
    const problem = checkEdit(spec.fixtureSeed, spec, false);
    return problem === undefined ? undefined : `spec ${problem}`;
  },
  decide(bytes, spec, ref) {
    const { fixtureSeed, rowKey, column, newValue } = spec as CalcRecordEditSpec;
    const edit = { rowKey, column, newValue };
    const { cells } = parseCsvSpreadsheet(utf8(bytes), ref);
    const target = targetRef(fixtureSeed, edit);
    const expected = expectedCells(fixtureSeed, [edit]);
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
      reasons.push(targetReason(target, edit, cells[target]));
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
  decide(bytes, spec, ref) {
    const { fixtureSeed, steps } = spec as CalcMultiStepSpec;
    const { cells } = parseCsvSpreadsheet(utf8(bytes), ref);
    const pristine = pristineCells(fixtureSeed);
    const targets = steps.map((step) => targetRef(fixtureSeed, step));
    const { collateral } = diffDocument(cells, pristine, new Set(targets));
    const done = steps.map((step, j) => cells[targets[j] as string] === step.newValue);
    const checkpoints: CheckpointVerdict[] = steps.map((_, index) => {
      const k = index + 1;
      const holds = collateral.length === 0 && done.slice(0, k).every(Boolean);
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
        reasons.push(`step ${j + 1}: ${targetReason(target, step, cells[target])}`);
      }
    }
    if (collateral.length > 0) {
      codes.push("DOCUMENT_COLLATERAL");
      reasons.push(collateralReason(collateral));
    }
    const failed = checkpoints.filter((cp) => cp.verdict === "refuted").map((cp) => cp.checkpoint);
    reasons.push(`checkpoints refuted: ${listRefs(failed.map(String))}`);
    return { status: "refuted", reasons, codes, checkpoints };
  },
};

export const FAMILIES: ReadonlyMap<string, OracleFamily> = new Map(
  [todoItemsFamily, calcRecordEditFamily, calcMultiStepFamily].map((family) => [family.id, family]),
);
