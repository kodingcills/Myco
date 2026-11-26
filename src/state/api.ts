/**
 * `myco.state/v1` — read-only structured state of the agent's own live app (capability
 * track I; docs/state/tools.md, docs/state/security.md).
 *
 * The agent asks for app state (sheets, cells with values and formulas as the app holds
 * them, the document's save state, a bounded UI/accessibility tree) instead of guessing from
 * pixels. This module is the contract: the tool names, the input schemas, the caps, the
 * coded refusals and the strict request parser. It is pure (no I/O, no imports outside this
 * directory) and shares nothing with the gate (`src/gate/`) or the grader
 * (`src/benchmark/grade/`).
 *
 * What the state is NOT: proof of completion. It is the app's live, in-memory state; it can
 * differ from what was persisted, and only the gate (persisted bytes it captures itself) and
 * the independent grader decide whether a task is done. Every successful reply carries
 * `LIVE_STATE_NOTICE` so the agent sees that in the tool output itself.
 */

export const STATE_API_VERSION = "myco.state/v1";

export const STATE_TOOLS = {
  listSheets: "state_list_sheets",
  readRange: "state_read_range",
  documentStatus: "state_document_status",
  uiTree: "state_ui_tree",
} as const;
export type StateToolName = (typeof STATE_TOOLS)[keyof typeof STATE_TOOLS];
export const STATE_TOOL_NAMES: readonly StateToolName[] = Object.values(STATE_TOOLS);

/** Shown in every successful reply. */
export const LIVE_STATE_NOTICE =
  "Live app state, read-only. Not proof of completion: only the completion gate, which reads " +
  "the saved file, decides whether the task is done.";

/**
 * Output bounds. A request beyond a cap is refused with a code (fail closed), never
 * silently widened; the server re-checks the backend's reply against the same caps.
 */
export const STATE_CAPS = {
  /** Cells in one `state_read_range` call. */
  maxCells: 400,
  /** Rows or columns in one range. */
  maxRangeSide: 200,
  /** Characters of one cell's display text or formula; longer text is cut and flagged. */
  maxCellTextChars: 512,
  /** Characters of a sheet or UI node name. */
  maxNameChars: 128,
  /** Sheets listed by `state_list_sheets`. */
  maxSheets: 64,
  /** UI tree: deepest level returned, and the default. */
  maxTreeDepth: 8,
  defaultTreeDepth: 4,
  /** UI tree: most nodes returned, and the default. */
  maxTreeNodes: 200,
  defaultTreeNodes: 60,
  /** UI tree: children listed per node (a spreadsheet table has millions). */
  maxChildrenPerNode: 25,
  /** Serialized reply (structuredContent) bytes. */
  maxReplyBytes: 64 * 1024,
  /** Largest row/column the A1 parser accepts (Calc's own limits are lower or equal). */
  maxRow: 1_048_576,
  maxColumn: 16_384,
} as const;

/** Every refusal code a state tool can return. Codes only: never raw errors or paths. */
export const STATE_CODES = [
  "INVALID_REQUEST",
  "UNKNOWN_FIELD",
  "UNKNOWN_TOOL",
  "INVALID_RANGE",
  "RANGE_TOO_LARGE",
  "UNKNOWN_SHEET",
  "LIMIT_OUT_OF_RANGE",
  "OUTPUT_TOO_LARGE",
  "OUTPUT_WITHHELD",
  "UI_TREE_UNAVAILABLE",
  "DOCUMENT_UNAVAILABLE",
  "BACKEND_ERROR",
] as const;
export type StateCode = (typeof STATE_CODES)[number];

export function isStateCode(value: unknown): value is StateCode {
  return typeof value === "string" && (STATE_CODES as readonly string[]).includes(value);
}

/** A sheet by 0-based index or by exact name. Absent: the first sheet. */
export type SheetRef = number | string;

/** A parsed A1 range, 0-based inclusive: [col0, row0, col1, row1]. */
export type GridRange = readonly [number, number, number, number];

export type StateRequest =
  | { readonly tool: "state_list_sheets" }
  | { readonly tool: "state_document_status" }
  | {
      readonly tool: "state_read_range";
      readonly sheet: SheetRef | null;
      readonly range: GridRange;
    }
  | { readonly tool: "state_ui_tree"; readonly maxDepth: number; readonly maxNodes: number };

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: StateCode };

const SHEET_SCHEMA = {
  description:
    "Sheet by 0-based index or exact name (from state_list_sheets). Omit for the first sheet.",
  oneOf: [
    { type: "integer", minimum: 0, maximum: STATE_CAPS.maxSheets - 1 },
    { type: "string", minLength: 1, maxLength: STATE_CAPS.maxNameChars },
  ],
};

/** The MCP input schemas. `additionalProperties: false` everywhere: unknown fields are refused. */
export const STATE_INPUT_SCHEMAS: Readonly<Record<StateToolName, object>> = {
  state_list_sheets: { type: "object", properties: {}, additionalProperties: false },
  state_document_status: { type: "object", properties: {}, additionalProperties: false },
  state_read_range: {
    type: "object",
    properties: {
      sheet: SHEET_SCHEMA,
      range: {
        type: "string",
        description: `A1 cell or range, e.g. "B8" or "A1:F21". At most ${STATE_CAPS.maxCells} cells and ${STATE_CAPS.maxRangeSide} rows or columns.`,
        pattern: "^\\$?[A-Za-z]{1,3}\\$?[0-9]{1,7}(:\\$?[A-Za-z]{1,3}\\$?[0-9]{1,7})?$",
        maxLength: 24,
      },
    },
    required: ["range"],
    additionalProperties: false,
  },
  state_ui_tree: {
    type: "object",
    properties: {
      maxDepth: { type: "integer", minimum: 1, maximum: STATE_CAPS.maxTreeDepth },
      maxNodes: { type: "integer", minimum: 1, maximum: STATE_CAPS.maxTreeNodes },
    },
    additionalProperties: false,
  },
};

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Parse an A1 cell or range into a 0-based inclusive grid range, or a code. */
export function parseA1Range(text: string): Parsed<GridRange> {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})(?::\$?([A-Za-z]{1,3})\$?([0-9]{1,7}))?$/.exec(text);
  if (!m) return { ok: false, code: "INVALID_RANGE" };
  const a = [columnIndex(m[1] ?? ""), Number(m[2]) - 1] as const;
  const b = m[3] === undefined ? a : ([columnIndex(m[3]), Number(m[4]) - 1] as const);
  const [c0, c1] = a[0] <= b[0] ? [a[0], b[0]] : [b[0], a[0]];
  const [r0, r1] = a[1] <= b[1] ? [a[1], b[1]] : [b[1], a[1]];
  if (r0 < 0 || c1 >= STATE_CAPS.maxColumn || r1 >= STATE_CAPS.maxRow)
    return { ok: false, code: "INVALID_RANGE" };
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  if (cols > STATE_CAPS.maxRangeSide || rows > STATE_CAPS.maxRangeSide)
    return { ok: false, code: "RANGE_TOO_LARGE" };
  if (cols * rows > STATE_CAPS.maxCells) return { ok: false, code: "RANGE_TOO_LARGE" };
  return { ok: true, value: [c0, r0, c1, r1] };
}

/** 0-based column index to letters. */
export function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function onlyFields(args: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(args).every((key) => allowed.includes(key));
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): Parsed<number> {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== "number" || !Number.isInteger(value))
    return { ok: false, code: "INVALID_REQUEST" };
  if (value < min || value > max) return { ok: false, code: "LIMIT_OUT_OF_RANGE" };
  return { ok: true, value };
}

function parseSheet(value: unknown): Parsed<SheetRef | null> {
  if (value === undefined) return { ok: true, value: null };
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value >= STATE_CAPS.maxSheets)
      return { ok: false, code: "UNKNOWN_SHEET" };
    return { ok: true, value };
  }
  if (typeof value === "string") {
    if (value.length === 0 || value.length > STATE_CAPS.maxNameChars)
      return { ok: false, code: "UNKNOWN_SHEET" };
    return { ok: true, value };
  }
  return { ok: false, code: "INVALID_REQUEST" };
}

/**
 * Parse one tool call. The arguments must be a plain object with only the tool's declared
 * fields; anything else is refused with a code. Nothing in the arguments can name a file,
 * a trial, a run or a host path: there is no such field.
 */
export function parseStateRequest(tool: unknown, args: unknown): Parsed<StateRequest> {
  if (typeof tool !== "string" || !(STATE_TOOL_NAMES as readonly string[]).includes(tool))
    return { ok: false, code: "UNKNOWN_TOOL" };
  const a = args === undefined ? {} : args;
  if (!plainObject(a)) return { ok: false, code: "INVALID_REQUEST" };
  switch (tool as StateToolName) {
    case "state_list_sheets":
    case "state_document_status":
      if (!onlyFields(a, [])) return { ok: false, code: "UNKNOWN_FIELD" };
      return { ok: true, value: { tool: tool as "state_list_sheets" | "state_document_status" } };
    case "state_read_range": {
      if (!onlyFields(a, ["sheet", "range"])) return { ok: false, code: "UNKNOWN_FIELD" };
      if (typeof a.range !== "string" || a.range.length > 24)
        return { ok: false, code: "INVALID_RANGE" };
      const sheet = parseSheet(a.sheet);
      if (!sheet.ok) return sheet;
      const range = parseA1Range(a.range);
      if (!range.ok) return range;
      return {
        ok: true,
        value: { tool: "state_read_range", sheet: sheet.value, range: range.value },
      };
    }
    case "state_ui_tree": {
      if (!onlyFields(a, ["maxDepth", "maxNodes"])) return { ok: false, code: "UNKNOWN_FIELD" };
      const depth = boundedInt(a.maxDepth, 1, STATE_CAPS.maxTreeDepth, STATE_CAPS.defaultTreeDepth);
      if (!depth.ok) return depth;
      const nodes = boundedInt(a.maxNodes, 1, STATE_CAPS.maxTreeNodes, STATE_CAPS.defaultTreeNodes);
      if (!nodes.ok) return nodes;
      return {
        ok: true,
        value: { tool: "state_ui_tree", maxDepth: depth.value, maxNodes: nodes.value },
      };
    }
  }
}

/**
 * The harness's withheld list (`MYCO_STATE_WITHHELD`): a JSON array of 1 to 64 absolute host
 * paths (POSIX `/…`, a drive `C:\…`, or UNC `\\…`), each at least 4 characters with no line
 * break. Returns the list, or null when it is missing or unusable: the server refuses to
 * start without one (docs/state/security.md, "Host paths"). Same rule as the launch audit's
 * `stateWithheldListValid` (src/integrity/surface.ts), spelled here so no state module
 * imports integrity code; test/state/state-arms.test.ts holds both to one case table.
 */
export function withheldListFrom(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 64) return null;
  for (const p of parsed)
    if (
      typeof p !== "string" ||
      p.length < 4 ||
      /[\r\n]/.test(p) ||
      !(p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\"))
    )
      return null;
  return parsed as string[];
}
