import type { Action, AppAdapter } from "../core/adapter.ts";
import type { TaskFamily } from "../core/eval.ts";
import { type Program, predicate } from "../core/program.ts";
import { findNode } from "../core/state.ts";
import type { PersistedState, TaskIntent, Verdict, Verifier } from "../core/verify.ts";

export const setCellFamily: TaskFamily = {
  taskId: "fake-set-cell",
  intentFor(params: Record<string, unknown>): TaskIntent {
    const ref = String(params.cell ?? "B2");
    return {
      taskId: "fake-set-cell",
      params,
      describe: `set ${ref} to "${String(params.value ?? "")}" and save`,
    };
  },
  programFor(adapter: AppAdapter, params: Record<string, unknown>): Program {
    const ref = String(params.cell ?? "B2");
    const value = String(params.value ?? `v${String(params.trial ?? 0)}`);
    void adapter;
    const cellIsBlank = predicate(
      `cell ${ref} is blank before edit`,
      (s) => (findNode(s, ref)?.value ?? "") === "",
      (s) => `value=${JSON.stringify(findNode(s, ref)?.value ?? "<missing>")}`,
    );
    const cellHasValue = predicate(
      `cell ${ref} holds "${value}"`,
      (s) => findNode(s, ref)?.value === value,
      (s) => `value=${JSON.stringify(findNode(s, ref)?.value ?? "<missing>")}`,
    );
    const targetStillFocused = predicate(
      `cell ${ref} still focused before save`,
      (s) => s.facts.focusedNodeId === ref,
      (s) => `focused=${String(s.facts.focusedNodeId)}`,
    );
    return {
      name: "set-cell-and-save",
      steps: [
        {
          action: { kind: "click", ref },
          preconditions: [cellIsBlank],
          postconditions: [targetStillFocused],
        },
        {
          action: { kind: "setValue", ref, value },
          preconditions: [targetStillFocused],
          postconditions: [cellHasValue],
        },
        {
          action: { kind: "keyPress", keys: "ctrl+s" },
          preconditions: [cellHasValue, targetStillFocused],
          postconditions: [],
          isSave: true,
        },
      ],
    };
  },
  satisfiedBy(persisted: PersistedState, params: Record<string, unknown>): boolean {
    const ref = String(params.cell ?? "B2");
    const value = String(params.value ?? `v${String(params.trial ?? 0)}`);
    return persisted.cells[ref] === value;
  },
};

export const cellVerifier: Verifier = {
  verify(persisted: PersistedState, intent: TaskIntent): Verdict {
    const ref = String(intent.params.cell ?? "B2");
    const value = String(intent.params.value ?? `v${String(intent.params.trial ?? 0)}`);
    const actual = persisted.cells[ref];
    if (persisted.cells[ref] === undefined) {
      return {
        status: "refuted",
        reasons: [`cell ${ref} missing or blank in ${persisted.filePath}`],
      };
    }
    if (actual !== value) {
      return {
        status: "refuted",
        reasons: [`cell ${ref} expected "${value}" but persisted file has "${actual}"`],
      };
    }
    return { status: "verified", reasons: [`cell ${ref} persisted as "${actual}"`] };
  },
};

export type { Action };
