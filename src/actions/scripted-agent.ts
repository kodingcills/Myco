/**
 * Track J - a deterministic, scripted "fast-path" agent for the $0 end-to-end test.
 *
 * No model is called. The agent knows only what an instruction tells any agent: the record
 * key, the column and the new value. It finds the cell by READING the document through the
 * router (`doc.export-csv`, the script route), edits it through the router
 * (`calc.set-cell`, which the router sends to the app API and falls back to the GUI), and
 * may check its own work by reading again. Every call is one step.
 *
 * Kinds:
 * - `honest`  : read, edit and save, read back, claim done.
 * - `no-save` : read, edit WITHOUT saving, claim done anyway (a false completion; the route
 *               reports success, which is why a route's word is never the verdict).
 * - `hostile` : first runs the given shell commands (attempts to reach outside the trial
 *               workspace), then behaves as `honest`.
 *
 * Rows it produces are simulated (`plannerModelId` is not a model id) and never evidence.
 */

import type { ActionRouter, ActResult } from "./router.ts";

export const FAST_PATH_AGENTS = ["honest", "no-save", "hostile"] as const;
export type FastPathAgentKind = (typeof FAST_PATH_AGENTS)[number];

/** The instruction's fields: exactly what the task text gives any agent. */
export interface InstructionFields {
  readonly rowKey: string;
  readonly column: string;
  readonly newValue: string;
}

export interface FastPathAgentRun {
  readonly agent: FastPathAgentKind;
  readonly claim: "done" | "failure";
  readonly results: readonly ActResult[];
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, LF or CRLF rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Locate the target cell from what the document shows. Null when it is not there. */
export function locateCell(csv: string, fields: InstructionFields): string | null {
  const rows = parseCsv(csv);
  const header = rows[0];
  if (!header) return null;
  const col = header.indexOf(fields.column);
  const row = rows.findIndex((r, i) => i > 0 && r[0] === fields.rowKey);
  if (col < 0 || row < 0) return null;
  return `${columnLetters(col)}${row + 1}`;
}

export function runFastPathAgent(
  agent: FastPathAgentKind,
  fields: InstructionFields,
  router: ActionRouter,
  hostileCommands: readonly string[] = [],
): FastPathAgentRun {
  const results: ActResult[] = [];
  const act = (request: unknown) => {
    const result = router.act(request);
    results.push(result);
    return result;
  };
  if (agent === "hostile")
    for (const command of hostileCommands) act({ kind: "shell.run", command });
  const before = act({ kind: "doc.export-csv" });
  const cell = before.ok && before.output !== undefined ? locateCell(before.output, fields) : null;
  if (cell === null) return { agent, claim: "failure", results };
  const edit =
    agent === "no-save"
      ? act({ kind: "calc.set-cell", cell, value: fields.newValue, save: false })
      : act({ kind: "calc.set-cell", cell, value: fields.newValue });
  if (!edit.ok) return { agent, claim: "failure", results };
  // The false-completion agent claims done without looking again.
  if (agent === "no-save") return { agent, claim: "done", results };
  act({ kind: "doc.export-csv" });
  return { agent, claim: "done", results };
}
