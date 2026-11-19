/**
 * calc-record-edit task family (M1-009 / TIF-13).
 *
 * Guarded program (ADR-0004, steps as data): open fixture, locate record row
 * + column header, set cell, save, close — expressed against the AppAdapter
 * interface with pre/postconditions per step. Runs end-to-end against the
 * fake app in CI; the same step sequence drives real Calc via the UIA adapter
 * on the Windows VM (only the adapter and fixture converter swap).
 */

import type { AppAdapter } from "../core/adapter.ts";
import type { TaskFamily } from "../core/eval.ts";
import { type Program, predicate } from "../core/program.ts";
import { findNode } from "../core/state.ts";
import type { PersistedState, TaskIntent, Verdict, Verifier } from "../core/verify.ts";
import {
  type CalcRecordEditParams,
  type GroundTruth,
  groundTruth,
  locateInFixture,
} from "./intent.ts";

export const TASK_ID = "calc-record-edit";

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export function intentFor(params: CalcRecordEditParams): TaskIntent {
  return {
    taskId: TASK_ID,
    params: { ...params },
    describe: `set record ${params.rowKey}, column ${params.column}, to "${params.newValue}" and save`,
  };
}

/**
 * Validate the intent against the fixture it targets — host-side, from
 * fixtureSeed + params only (ADR-0005). Used as the program's locate guard:
 * an invalid-target intent (nonexistent row or unknown column) aborts with a
 * structured GuardFailure instead of acting blindly.
 */
export function validateIntent(
  params: CalcRecordEditParams,
): { ok: true } | { ok: false; error: string } {
  const found = locateInFixture(params.fixtureSeed, params.rowKey, params.column);
  return "error" in found ? { ok: false, error: found.error } : { ok: true };
}

// ---------------------------------------------------------------------------
// Guarded program
// ---------------------------------------------------------------------------

/**
 * Build the guarded program for one intent against an adapter.
 *
 * Steps (ADR-0004 closed action union, per-step guards):
 *  0. open    — open the fixture document (click the target cell's document
 *     node; against the fake the app opens the file at construction, on
 *     Windows this is the Calc `open` op) with precondition: document open at
 *     the fixture path.
 *  1. locate  — click the target cell to focus it; preconditions: document
 *     open, target cell present with its pristine fixture value (proves the
 *     record row + column header located correctly, and that no prior edit
 *     landed); postcondition: target cell focused.
 *  2. set     — set the cell to newValue; precondition: target focused;
 *     postcondition: cell holds newValue in observed state.
 *  3. save    — ctrl+s; precondition: cell holds newValue; postcondition:
 *     document not dirty.
 *  4. close   — ctrl+w; precondition: document not dirty; postcondition:
 *     cell keeps newValue (the fake does not clear facts.documentPath on
 *     ctrl+w, so the closed-document fact is not asserted here).
 */
export function programFor(_adapter: AppAdapter, params: CalcRecordEditParams): Program {
  // Invalid-target intents (ADR-0005 corruption class) must abort with a
  // structured GuardFailure, not throw at program-build time: this predicate
  // is step 0's precondition, and the runner records its failure.
  const validation = validateIntent(params);
  const intentTargetsExistingCell = predicate(
    `intent targets an existing record and column (fixture "${params.fixtureSeed}")`,
    () => validation.ok,
    () => (validation.ok ? "intent valid" : `invalid target: ${validation.error}`),
  );
  if (!validation.ok) {
    // No valid target: a single locate step whose precondition fails. The
    // runner aborts with GuardFailure{phase: "precondition"} before acting.
    return {
      name: "calc-record-edit",
      steps: [
        {
          action: { kind: "waitFor", predicate: () => false, timeoutMs: 0 },
          preconditions: [intentTargetsExistingCell],
          postconditions: [],
        },
      ],
    };
  }
  const gt = groundTruth(params);
  const ref = gt.cellRef;
  const cellPresent = predicate(
    `cell ${ref} present in grid`,
    (s) => findNode(s, ref) !== undefined,
    (s) => `cell ${ref} ${findNode(s, ref) === undefined ? "missing" : "present"}`,
  );

  const cellPristine = predicate(
    `cell ${ref} located at record ${params.rowKey}, column ${params.column}, holds fixture value "${gt.previousValue}"`,
    (s) => findNode(s, ref)?.value === gt.previousValue,
    (s) => `value=${JSON.stringify(findNode(s, ref)?.value ?? "<missing>")}`,
  );

  const cellFocused = predicate(
    `cell ${ref} focused`,
    (s) => s.facts.focusedNodeId === ref,
    (s) => `focused=${JSON.stringify(s.facts.focusedNodeId)}`,
  );

  const cellHasNewValue = predicate(
    `cell ${ref} holds "${gt.expectedValue}"`,
    (s) => findNode(s, ref)?.value === gt.expectedValue,
    (s) => `value=${JSON.stringify(findNode(s, ref)?.value ?? "<missing>")}`,
  );

  const notDirty = predicate(
    "document not dirty after save",
    (s) => !s.facts.dirty,
    (s) => `dirty=${String(s.facts.dirty)}`,
  );

  const anyDocumentOpen = predicate(
    "some document open",
    (s) => s.facts.documentPath !== null,
    (s) => `documentPath=${JSON.stringify(s.facts.documentPath)}`,
  );

  return {
    name: "calc-record-edit",
    steps: [
      {
        // `open` against the fake is a click on the grid's first cell — the
        // app opens its document at construction. On Windows this step's
        // action is the Calc launch+open op; the precondition (document open)
        // is what makes a failed open abort the program.
        action: { kind: "click", ref: { nodeId: "A1" } },
        preconditions: [anyDocumentOpen],
        postconditions: [anyDocumentOpen],
      },
      {
        // `locate`: focus the record row's cell under the column header. The
        // pristine-value precondition is the real row/column location proof:
        // it fails unless the cell at this A1 ref holds exactly the fixture
        // value host-side ground truth predicts for (rowKey, column).
        action: { kind: "click", ref: { nodeId: ref } },
        preconditions: [intentTargetsExistingCell, anyDocumentOpen, cellPresent, cellPristine],
        postconditions: [cellFocused],
      },
      {
        action: { kind: "setValue", ref: { nodeId: ref }, value: gt.expectedValue },
        preconditions: [cellFocused, cellPristine],
        postconditions: [cellHasNewValue],
      },
      {
        action: { kind: "keyPress", keys: "ctrl+s" },
        preconditions: [cellHasNewValue],
        postconditions: [notDirty],
        isSave: true,
      },
      {
        // `close`: against the fake, ctrl+w is a non-save key press (no-op
        // bump); the postcondition proves the edit survived close in the
        // observed state. The persisted-file proof is the verifier's job.
        action: { kind: "keyPress", keys: "ctrl+w" },
        preconditions: [notDirty, cellHasNewValue],
        postconditions: [cellHasNewValue],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Verifier (ADR-0002: pure function over (PersistedState, TaskIntent))
// ---------------------------------------------------------------------------

/**
 * Family verifier. Expected value comes from host-side ground truth
 * (fixtureSeed + params), never from adapter/runner claims. `uncertain` on
 * unreadable persisted state is handled one level up in the eval harness
 * (PersistedStateReadError → uncertain), matching the existing contract; this
 * verifier also marks a *missing target cell* in an otherwise-readable file
 * as `uncertain` when the fixture is larger than the parse found — a truncated
 * read is "could not look", not "provably absent".
 */
export const calcRecordEditVerifier: Verifier = {
  verify(persisted: PersistedState, intent: TaskIntent): Verdict {
    const params = normalizeParams(intent.params);
    let gt: GroundTruth;
    try {
      gt = groundTruth(params);
    } catch {
      return {
        status: "uncertain",
        reasons: [
          "could not look: ground truth not computable from intent params (invalid rowKey or column?)",
        ],
      };
    }
    const actual = persisted.cells[gt.cellRef];
    if (actual === undefined) {
      return {
        status: "uncertain",
        reasons: [
          `could not look: cell ${gt.cellRef} absent from persisted state at ${persisted.filePath}`,
        ],
      };
    }
    if (actual !== gt.expectedValue) {
      return {
        status: "refuted",
        reasons: [
          `cell ${gt.cellRef} expected "${gt.expectedValue}" (record ${params.rowKey}, column ${params.column}) but ${persisted.filePath} has "${actual}"`,
        ],
      };
    }
    return {
      status: "verified",
      reasons: [
        `cell ${gt.cellRef} (record ${params.rowKey}, column ${params.column}) persisted as "${actual}"`,
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// TaskFamily wiring (src/core/eval.ts contract)
// ---------------------------------------------------------------------------

/**
 * The family as consumed by the eval harness. `satisfiedBy` is the
 * host-computed ground truth checked against the independently parsed
 * persisted state — used for false-success accounting, distinct from the
 * verifier's verdict.
 */
export const calcRecordEditFamily: TaskFamily = {
  taskId: TASK_ID,
  intentFor(params: Record<string, unknown>): TaskIntent {
    return intentFor(normalizeParams(params));
  },
  programFor(adapter: AppAdapter, params: Record<string, unknown>): Program {
    return programFor(adapter, normalizeParams(params));
  },
  satisfiedBy(persisted: PersistedState, params: Record<string, unknown>): boolean {
    const gt = groundTruth(normalizeParams(params));
    return persisted.cells[gt.cellRef] === gt.expectedValue;
  },
};

export function normalizeParams(params: Record<string, unknown>): CalcRecordEditParams {
  const fixtureSeed = String(params.fixtureSeed ?? "");
  const rowKey = String(params.rowKey ?? "");
  const column = String(params.column ?? "");
  const newValue = String(params.newValue ?? "");
  const out: CalcRecordEditParams = { fixtureSeed, rowKey, column, newValue };
  return out;
}
