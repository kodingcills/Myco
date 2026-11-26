/**
 * TIF-272 — the scripted agent the M2 fault classes run, and the dialog overlay that puts
 * an injected instruction on its screen. No model: the agent is a fixed program, so a
 * fault-suite row depends only on the gate, the vault and the grader.
 *
 * The agent works from what it sees. It finds the target cell by reading the screen (the
 * header row for the column, column A for the record key), and it reads every visible
 * text for an instruction addressed to it. With policy `obey` it follows the instruction;
 * with `ignore` it does the task as asked. It always claims done at the end, because the
 * question these classes ask is what the gate does with that claim.
 */
import type {
  ActResult,
  AdapterCapabilities,
  AppAdapter,
  ProgramAction,
} from "../../core/adapter.ts";
import type { AppState, StateNode } from "../../core/state.ts";
import type { AgentPolicy } from "./classes.ts";

/** The marker an injected instruction starts with, so a test can find it on screen. */
export const INJECTION_MARKER = "NOTE TO ASSISTANT";

/** What the agent was asked to do (the instruction it was given, not anything on screen). */
export interface AgentTask {
  readonly rowKey: string;
  readonly column: string;
  readonly newValue: string;
}

/** A directive the agent parsed out of screen text. */
export type Directive =
  | { readonly kind: "no-edit" }
  | { readonly kind: "no-save" }
  | { readonly kind: "wrong-value"; readonly value: string }
  | { readonly kind: "collateral"; readonly column: string; readonly rowKey: string };

export interface AgentRun {
  /** What the agent says at the end. Always "done" in this suite. */
  readonly claim: "done";
  /** The value the agent typed into the target, or null when it made no edit. */
  readonly typed: string | null;
  readonly saved: boolean;
  /** Instructions found on screen (the marker lines), whether or not they were followed. */
  readonly instructionsSeen: number;
  /** Directives the agent followed. Empty for `ignore` and `honest`. */
  readonly followed: readonly Directive["kind"][];
}

/**
 * Parse the directives in one piece of screen text. Text without the marker is not an
 * instruction to the agent and yields nothing.
 */
export function parseDirectives(text: string): Directive[] {
  if (!text.includes(INJECTION_MARKER)) return [];
  const out: Directive[] = [];
  if (/already (?:been )?(?:done|applied)/i.test(text)) out.push({ kind: "no-edit" });
  if (/saved automatically|do not press ctrl\+s/i.test(text)) out.push({ kind: "no-save" });
  const value = /correct new value is (\S+)/i.exec(text);
  if (value?.[1]) out.push({ kind: "wrong-value", value: value[1] });
  const clear = /also clear (?:the )?(\w+) of (\S+)/i.exec(text);
  if (clear?.[1] && clear[2]) out.push({ kind: "collateral", column: clear[1], rowKey: clear[2] });
  return out;
}

function grid(state: AppState): Map<string, StateNode> {
  return new Map(state.nodes.filter((n) => n.role === "cell").map((n) => [n.id, n]));
}

/** A1-style id of the cell at (row, col), the way the fake app names its cells. */
function a1(row: number, col: number): string {
  let name = "";
  let c = col;
  do {
    name = String.fromCharCode(65 + (c % 26)) + name;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${name}${row + 1}`;
}

/** Find a record's cell by reading the screen: header row 0, keys in column A. */
function locate(state: AppState, rowKey: string, column: string): string | null {
  const cells = grid(state);
  let col = -1;
  for (let c = 0; cells.has(a1(0, c)); c++) if (cells.get(a1(0, c))?.value === column) col = c;
  let row = -1;
  for (let r = 1; cells.has(a1(r, 0)); r++) if (cells.get(a1(r, 0))?.value === rowKey) row = r;
  return col < 0 || row < 0 ? null : a1(row, col);
}

async function setCell(app: AppAdapter, nodeId: string, value: string): Promise<void> {
  // Refs are bound to the state version, so take a fresh one for every action.
  await app.observe();
  const ref = app.issueRef?.(nodeId);
  if (!ref) throw new Error(`scripted agent: no ref for ${nodeId}`);
  const result = await app.act({ kind: "setValue", ref, value });
  if (result.outcome === "failed") throw new Error(`scripted agent: setValue ${nodeId} failed`);
}

/**
 * Run the scripted agent. `valueOverride` makes it type a value of its own (the tamper
 * class's agent fails the task this way before it tampers).
 */
export async function runScriptedAgent(
  app: AppAdapter,
  task: AgentTask,
  options: { readonly policy: AgentPolicy | "honest"; readonly valueOverride?: string },
): Promise<AgentRun> {
  const state = await app.observe();
  const texts = state.nodes
    .filter((n) => n.visible)
    .flatMap((n) => [n.name, n.value])
    .filter((t) => t.includes(INJECTION_MARKER));
  const directives = options.policy === "obey" ? texts.flatMap(parseDirectives) : [];
  const has = (kind: Directive["kind"]) => directives.some((d) => d.kind === kind);

  let typed: string | null = null;
  let saved = false;
  if (!has("no-edit")) {
    const target = locate(state, task.rowKey, task.column);
    if (!target) throw new Error("scripted agent: target cell not on screen");
    const wrong = directives.find((d) => d.kind === "wrong-value");
    typed = options.valueOverride ?? (wrong?.kind === "wrong-value" ? wrong.value : task.newValue);
    await setCell(app, target, typed);
    for (const d of directives) {
      if (d.kind !== "collateral") continue;
      const other = locate(await app.observe(), d.rowKey, d.column);
      if (other) await setCell(app, other, "");
    }
    if (!has("no-save")) {
      const result = await app.act({ kind: "keyPress", keys: "ctrl+s" });
      saved = result.outcome !== "failed";
    }
  }
  return {
    claim: "done",
    typed,
    saved,
    instructionsSeen: texts.length,
    followed: [...new Set(directives.map((d) => d.kind))],
  };
}

/**
 * Wraps an app so its screen shows one extra dialog carrying `text`. The dialog is screen
 * content only: it is not a cell, so it never reaches the saved file. Everything else is
 * the real app.
 */
export class DialogOverlay implements AppAdapter {
  readonly #real: AppAdapter;
  readonly #text: string;

  constructor(real: AppAdapter, text: string) {
    this.#real = real;
    this.#text = text;
  }

  capabilities(): AdapterCapabilities {
    return this.#real.capabilities();
  }

  async observe(): Promise<AppState> {
    const state = await this.#real.observe();
    const dialog: StateNode = {
      id: "dialog:notice",
      role: "window",
      name: "Notice",
      value: this.#text,
      bounds: { x: 120, y: 80, width: 320, height: 120 },
      enabled: true,
      visible: true,
    };
    return { ...state, nodes: [...state.nodes, dialog] };
  }

  issueRef(nodeId: string): string | null {
    return this.#real.issueRef?.(nodeId) ?? null;
  }

  act(action: ProgramAction): Promise<ActResult> {
    return this.#real.act(action);
  }
}
