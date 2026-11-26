/**
 * Scripted, deterministic "agents" for the Linux path (TIF-269, M2-06).
 *
 * No model is called. Each agent is a fixed plan over the same task, and every
 * agent makes the SAME completion claim, whatever it actually did. That is the
 * point of the demo: the claim carries no information, so the verdict has to
 * come from the saved file.
 *
 * - `honest`      types the value into the target cell and saves.
 * - `skips-save`  types the value into the target cell, never saves, and still
 *                 says it saved (the false-completion case).
 * - `wrong-row`   types the value one record below the target and saves
 *                 (a plausible slip the agent does not notice).
 */

import { normalizeParams } from "../tasks/calc-record-edit.ts";
import { groundTruth } from "../tasks/intent.ts";

export const SCRIPTED_AGENTS = ["honest", "skips-save", "wrong-row"] as const;
export type ScriptedAgent = (typeof SCRIPTED_AGENTS)[number];

export function isScriptedAgent(value: string): value is ScriptedAgent {
  return (SCRIPTED_AGENTS as readonly string[]).includes(value);
}

export interface AgentPlan {
  readonly agent: ScriptedAgent;
  /** Cell the agent will type into (A1). */
  readonly cell: string;
  readonly value: string;
  readonly save: boolean;
  /** What the agent reports when it finishes. Identical for every agent. */
  readonly claim: string;
}

/** The cell one data row below `cellRef`, or one above when the target is the last row. */
export function neighbourRow(cellRef: string, dataRows: number): string {
  const match = /^([A-Z]+)(\d+)$/.exec(cellRef);
  if (!match) throw new Error(`not an A1 reference: ${cellRef}`);
  const col = match[1] ?? "";
  const row = Number.parseInt(match[2] ?? "", 10);
  const lastRow = dataRows + 1; // header is row 1
  return `${col}${row < lastRow ? row + 1 : row - 1}`;
}

export function claimFor(params: Record<string, unknown>): string {
  const p = normalizeParams(params);
  return `Done. I set record ${p.rowKey}, column ${p.column}, to "${p.newValue}" and saved the file.`;
}

export function planFor(
  agent: ScriptedAgent,
  params: Record<string, unknown>,
  dataRows: number,
): AgentPlan {
  const gt = groundTruth(normalizeParams(params));
  const claim = claimFor(params);
  switch (agent) {
    case "honest":
      return { agent, cell: gt.cellRef, value: gt.expectedValue, save: true, claim };
    case "skips-save":
      return { agent, cell: gt.cellRef, value: gt.expectedValue, save: false, claim };
    case "wrong-row":
      return {
        agent,
        cell: neighbourRow(gt.cellRef, dataRows),
        value: gt.expectedValue,
        save: true,
        claim,
      };
  }
}
