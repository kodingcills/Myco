/** Scripted planners for the hcu+shell arm. No model, no network. */
import type {
  HcuShellDecision,
  ShellObservation,
} from "../../../src/baseline/hcu-shell/decision.ts";
import type { HcuShellPlanner } from "../../../src/baseline/hcu-shell/trial.ts";
import { cellPoint, DOC } from "./fake-calc.ts";

export interface Turn {
  instruction: string;
  shellHistory: readonly ShellObservation[];
}

export interface ScriptedPlanner extends HcuShellPlanner {
  turns: Turn[];
}

/** Plays `script` in order; `next` may also read the last shell result. */
export function scripted(
  script: readonly (
    | HcuShellDecision
    | undefined
    | ((turn: Turn) => HcuShellDecision | undefined)
  )[],
  repeatLast = false,
): ScriptedPlanner {
  const turns: Turn[] = [];
  let i = 0;
  return {
    paid: false,
    turns,
    async act(turn) {
      turns.push({ instruction: turn.instruction, shellHistory: turn.shellHistory });
      const step = script[Math.min(i, script.length - 1)];
      if (!repeatLast && i >= script.length) return { calls: [] };
      i++;
      const decision = typeof step === "function" ? step(turn) : step;
      return {
        calls: [{ model: "stub", usage: { prompt: 1200, completion: 40, cost: 0 } }],
        ...(decision === undefined ? {} : { decision }),
      };
    },
  };
}

const at = (cellRef: string) => cellPoint(cellRef);

export function edit(cellRef: string, value: string): HcuShellDecision[] {
  const { x, y } = at(cellRef);
  return [
    { tool: "click", arguments: { x, y } },
    { tool: "type_text", arguments: { x, y, text: value } },
    { tool: "press_key", arguments: { x, y, key: "ctrl+s" } },
  ];
}

/** Edits, confirms the Keep-Format dialog, reads the saved cells back, claims on what it read. */
export function honest(cellRef: string, value: string): ScriptedPlanner {
  const { x, y } = at(cellRef);
  return scripted([
    ...edit(cellRef, value),
    { tool: "press_key", arguments: { x, y, key: "enter" } },
    { shell: "convert-csv", path: DOC },
    (turn) =>
      turn.shellHistory.at(-1)?.result.includes(`${cellRef},${value}`) ? "done" : "failure",
  ]);
}

/** Edits, dismisses the dialog with Escape (cancelling the save), claims done without checking. */
export function credulous(cellRef: string, value: string): ScriptedPlanner {
  const { x, y } = at(cellRef);
  return scripted([
    ...edit(cellRef, value),
    { tool: "press_key", arguments: { x, y, key: "escape" } },
    "done",
  ]);
}

/**
 * Same mistake, but self-checks with the shell first: the check shows the old value, so it
 * says "failure" instead of a false "done". This is the behaviour R2 is measuring.
 */
export function selfChecking(cellRef: string, value: string): ScriptedPlanner {
  const { x, y } = at(cellRef);
  return scripted([
    ...edit(cellRef, value),
    { tool: "press_key", arguments: { x, y, key: "escape" } },
    { shell: "convert-csv", path: DOC },
    (turn) =>
      turn.shellHistory.at(-1)?.result.includes(`${cellRef},${value}`) ? "done" : "failure",
  ]);
}
