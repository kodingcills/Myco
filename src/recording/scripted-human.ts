/**
 * Track R: a scripted "human" and a hermetic stand-in for Calc, for $0 end-to-end tests and
 * the demo. No model, no GUI, no LibreOffice: a deterministic script acts on an in-memory
 * sheet and the stand-in emits the event stream the Linux recorder's UNO listeners emit
 * (`scripts/linux/calc_recorder.py`), plus the noisy raw GUI fields a real desktop event
 * carries (window titles with the document's host path, key text, clipboard contents), so
 * the recorder's allowlist and scrubbing are exercised on every run.
 */
import { a1, parseA1, parseCsvRows, serializeCsvRows } from "./csv.ts";
import type { SourceEvent } from "./types.ts";

export type HumanStep =
  /** Click a cell. */
  | { readonly do: "select"; readonly cell: string }
  /** Type into a cell and press Enter: Calc reports a cell change (app-level). */
  | { readonly do: "type"; readonly cell: string; readonly text: string }
  /** Change a cell in a way only GUI events show (no app-level event): the fallback path. */
  | { readonly do: "type-gui-only"; readonly cell: string; readonly text: string }
  /** Copy text to the clipboard (never recorded). */
  | { readonly do: "copy"; readonly text: string }
  /** Save (ctrl+s). */
  | { readonly do: "save" };

export interface DemonstrationSource {
  /** Run the demonstration, pushing raw events; resolve with the saved document's bytes. */
  demonstrate(push: (event: SourceEvent) => void): Promise<Uint8Array>;
}

export interface ScriptedHumanOptions {
  /** The document as opened. */
  readonly document: Uint8Array;
  readonly steps: readonly HumanStep[];
  /**
   * What a real desktop would put in window titles: the document's host path. The recorder
   * must drop it. Tests plant a marker here.
   */
  readonly windowTitle?: string;
}

/** A scripted human acting on a hermetic in-memory Calc stand-in. */
export function scriptedHuman(options: ScriptedHumanOptions): DemonstrationSource {
  return {
    async demonstrate(push) {
      const sheet = parseCsvRows(options.document).map((r) => [...r]);
      let saved = options.document;
      const title = options.windowTitle ?? "document.csv - LibreOffice Calc";
      const set = (cell: string, text: string) => {
        const at = parseA1(cell);
        if (!at) throw new Error(`scripted human: bad cell ${cell}`);
        while (sheet.length <= at.row) sheet.push([]);
        const row = sheet[at.row] as string[];
        while (row.length <= at.col) row.push("");
        row[at.col] = text;
      };
      for (const step of options.steps) {
        switch (step.do) {
          case "select":
            push({
              type: "gui",
              event: "click",
              cell: step.cell,
              windowTitle: title,
              x: 120,
              y: 48,
            });
            break;
          case "type":
          case "type-gui-only":
            for (const ch of step.text) {
              push({ type: "gui", event: "key", cell: step.cell, keyText: ch, windowTitle: title });
            }
            push({ type: "gui", event: "key", cell: step.cell, keyText: "Enter" });
            set(step.cell, step.text);
            if (step.do === "type")
              push({ type: "cell-changed", cell: step.cell, value: step.text });
            break;
          case "copy":
            push({
              type: "gui",
              event: "key",
              cell: null,
              keyText: "ctrl+c",
              clipboard: step.text,
            });
            break;
          case "save":
            push({ type: "gui", event: "key", cell: null, keyText: "ctrl+s", windowTitle: title });
            saved = new TextEncoder().encode(serializeCsvRows(sheet));
            push({ type: "saved", via: "app", path: title });
            break;
        }
      }
      return saved;
    },
  };
}

/** The A1 ref of a keyed cell in a CSV document, for writing scripted steps. */
export function cellFor(document: Uint8Array, rowKey: string, column: string): string {
  const rows = parseCsvRows(document);
  const col = (rows[0] ?? []).indexOf(column);
  const row = rows.findIndex((r, i) => i > 0 && r[0] === rowKey);
  if (col < 1 || row < 1) throw new Error(`no ${rowKey}/${column} in the document`);
  return a1(row, col);
}
