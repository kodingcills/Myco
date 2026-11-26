/**
 * `myco-state` MCP server (capability track I): read-only structured app state over stdio
 * (newline-delimited JSON-RPC 2.0). docs/state/tools.md is the tool reference and
 * docs/state/security.md the security model.
 *
 * A separate server from the gate (`myco-gate`, `myco.gate/v1`, one tool) and from the
 * actuator (`myco-rt`). Nothing here is added to the gate's surface, and the gate never
 * calls this server: its verdict comes only from the persisted bytes it captures itself.
 *
 * Every reply is checked here, whatever the backend returned (defense in depth):
 *  - the request parser is strict (`parseStateRequest`): unknown tools and fields, bad
 *    ranges and out-of-range limits get a code;
 *  - the backend's data is re-checked against the caps (cell count and shape, string
 *    lengths, tree depth, node count and width); a reply over a cap is refused
 *    (BACKEND_ERROR), never passed through;
 *  - host paths, four layers (docs/state/security.md, "Host paths"):
 *     1. path functions: while ANY formula in the document (formula cells on every sheet,
 *        document- and sheet-scoped named expressions, validation formulas) calls `CELL`
 *        or `INFO` (the built-in functions that return the document's location) or any
 *        function that is not built in (a Basic macro, an extension add-in), every cell
 *        read and UI tree is withheld (OUTPUT_WITHHELD). The backend reports this document-wide
 *        (`documentPathFunctions`); a reply without the flag is refused (BACKEND_ERROR),
 *        and the server also checks every returned formula itself. This is what stops a
 *        transformed spelling (`MID(CELL("filename");10)`, `SUBSTITUTE(…;"/";"|")`): it
 *        cuts the source, not the spelling;
 *     2. the backend's raw cell, sheet and status strings must not contain any of the
 *        harness's `withheld` strings (as written, JSON-escaped, file-URL-encoded),
 *        checked BEFORE scrubbing so a partial scrub cannot hide one (OUTPUT_WITHHELD);
 *        UI-tree names and roles have withheld strings redacted instead;
 *     3. separator-insensitive: no string may contain 16 consecutive letters/digits of a
 *        withheld entry once both are NFKC-folded, lowercased and stripped of everything
 *        but letters and digits (OUTPUT_WITHHELD), so a path whose separators were
 *        swapped or whose prefix was cut, then pasted as plain text, is still caught;
 *     4. every string the agent sees (cell display, value and formula, sheet names, UI
 *        names and roles) has path-like text replaced by `[path]`, so a host path the list
 *        does not name is not shown verbatim; a cell changed this way carries
 *        `pathScrubbed: true`.
 *    What no layer can stop: an agent that deliberately re-encodes its own document's path
 *    (reverses it, spells it as character codes) and pastes the result as plain values
 *    after removing the formula. The security model says so;
 *  - the serialized reply must fit `maxReplyBytes` (OUTPUT_TOO_LARGE) and must not contain
 *    a withheld string in any form (OUTPUT_WITHHELD);
 *  - a backend that throws gives BACKEND_ERROR; the error text goes to the operator's
 *    `onDiagnostic` only, never to the agent.
 *
 * JSON-RPC rules mirror the gate's `handleLine`: parse error -32700 and keep serving; batch
 * -32600; unknown method -32601; a notification gets no reply.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  LIVE_STATE_NOTICE,
  parseStateRequest,
  STATE_API_VERSION,
  STATE_CAPS,
  STATE_INPUT_SCHEMAS,
  STATE_TOOLS,
  type StateCode,
  type StateRequest,
  type StateToolName,
} from "./api.ts";
import type { BackendResult, StateBackend, UiNode } from "./backend.ts";

export const STATE_SERVER_NAME = "myco-state";
export const STATE_SERVER_VERSION = "0.1.0";
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const STATE_INSTRUCTIONS =
  "Read-only structured state of the app you are working in: sheets, cells (values and " +
  "formulas as the app holds them), the document's save state, and a bounded UI tree. Use it " +
  "to check what the app actually holds instead of guessing from the screen. It reads only " +
  "your own open document and cannot change anything. It is live state, not proof: an edit " +
  "you see here is not saved until the document status says modified=false after you save, " +
  "and only the completion gate decides whether the task is done.";

const DESCRIPTIONS: Readonly<Record<StateToolName, string>> = {
  state_list_sheets:
    "List the open document's sheets with each sheet's used range (A1). Read-only live state.",
  state_read_range: `Read a cell or range (A1, at most ${STATE_CAPS.maxCells} cells): each cell's kind, value, displayed text and formula as the app holds them now. Withheld while any formula in the document (cells, named expressions, validation) calls CELL, INFO or a non-built-in function such as a macro. Read-only live state; not proof the document was saved.`,
  state_document_status:
    "The open document's save state: modified (unsaved edits present), read-only, sheet count, active sheet. Read-only.",
  state_ui_tree: `A bounded summary of the app window's accessibility tree (depth <= ${STATE_CAPS.maxTreeDepth}, nodes <= ${STATE_CAPS.maxTreeNodes}, ${STATE_CAPS.maxChildrenPerNode} children per node). Read-only.`,
};

export function stateToolDefinitions(): object[] {
  return Object.values(STATE_TOOLS).map((name) => ({
    name,
    title: name.replace(/_/g, " "),
    description: DESCRIPTIONS[name],
    inputSchema: STATE_INPUT_SCHEMAS[name],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }));
}

export type StateReply =
  | {
      readonly api: typeof STATE_API_VERSION;
      readonly ok: true;
      readonly tool: StateToolName;
      readonly backend: StateBackend["kind"];
      readonly notice: typeof LIVE_STATE_NOTICE;
      readonly data: unknown;
    }
  | {
      readonly api: typeof STATE_API_VERSION;
      readonly ok: false;
      readonly tool: StateToolName | null;
      readonly code: StateCode;
    };

export interface StateServiceOptions {
  /** The backend bound to this trial's live document. */
  readonly backend: StateBackend;
  /**
   * Strings that must never appear in a reply (host paths of the trial dir, vault, fixture,
   * oracle config, other trials). A reply containing one is replaced by OUTPUT_WITHHELD.
   */
  readonly withheld?: readonly string[];
  /** Operator-side diagnostics (never shown to the agent). */
  readonly onDiagnostic?: (event: { tool: string; detail: string }) => void;
}

export interface StateService {
  call(tool: unknown, args: unknown): Promise<StateReply>;
}

/**
 * Path-like text. A file URL runs to the next quote or line end (Calc's `CELL("filename")`
 * gives `'file:///dir with spaces/x.xlsx'#$Sheet1`, and a file URL can carry spaces once
 * decoded). An absolute POSIX path must not follow a word character, `.`, `)`, `]` or `/`,
 * so dates (`2024/06/21`), formula division (`=(A1)/(B1)/2`) and web URLs are left alone.
 * A redacted withheld prefix followed by more path (`[path]/saved.xlsx`) is one path.
 */
const PATHLIKE =
  /\[path\][\\/][^\s'"]*|\bfile:\/\/[^'"\r\n]*|(?<![A-Za-z])[A-Za-z]:[\\/]\S*|\\\\[^\s\\]+\\\S*|~\/\S*|(?<![\w.)\]/])\/(?:[^\s/'"]+\/)+[^\s/'"]*/gi;

/** Replace path-like substrings (absolute POSIX/Windows paths, file URLs, UNC, ~/) with `[path]`. */
export function scrubPaths(text: string): string {
  return text.replace(PATHLIKE, "[path]");
}

/** `text` cut to `limit` UTF-16 units without splitting a surrogate pair. */
function cutTo(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(limit - 1)) ? limit - 1 : limit;
  return text.slice(0, end);
}

/**
 * Functions that return the document's own location. Matched anywhere in a formula (no word
 * boundary), so a false positive such as a literal "INFO(" withholds: fail closed.
 */
export const PATH_FUNCTION = /(?:CELL|INFO)\s*\(/i;

/** Letters and digits only, NFKC-folded and lowercased: the separator-insensitive form. */
export function foldForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** The window of consecutive letters/digits of a withheld entry that may not appear. */
export const FOLDED_WINDOW = 16;
/** Folded entries shorter than this are too generic to match without false positives. */
const FOLDED_MIN = 8;

interface FoldedForms {
  readonly windows: ReadonlySet<string>;
  readonly short: readonly string[];
}

function foldedForms(values: readonly string[]): FoldedForms {
  const windows = new Set<string>();
  const short: string[] = [];
  for (const v of values) {
    const f = foldForMatch(v);
    if (f.length < FOLDED_MIN) continue;
    if (f.length < FOLDED_WINDOW) short.push(f);
    else
      for (let i = 0; i + FOLDED_WINDOW <= f.length; i++)
        windows.add(f.slice(i, i + FOLDED_WINDOW));
  }
  return { windows, short };
}

/** Some string in `value` carries a withheld entry in its separator-insensitive form. */
function containsFolded(value: unknown, folded: FoldedForms): boolean {
  if (typeof value === "string") {
    const f = foldForMatch(value);
    if (folded.short.some((s) => f.includes(s))) return true;
    for (let i = 0; i + FOLDED_WINDOW <= f.length; i++)
      if (folded.windows.has(f.slice(i, i + FOLDED_WINDOW))) return true;
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => containsFolded(v, folded));
  if (typeof value === "object" && value !== null)
    return Object.values(value).some((v) => containsFolded(v, folded));
  return false;
}

/** Every form of a withheld string that could appear in a reply. */
function withheldForms(values: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const v of values) {
    if (v.length < 4) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(encodeURI(v.replace(/\\/g, "/")));
  }
  return [...forms];
}

function containsAny(value: unknown, forms: readonly string[]): boolean {
  if (typeof value === "string") return forms.some((f) => value.includes(f));
  if (Array.isArray(value)) return value.some((v) => containsAny(v, forms));
  if (typeof value === "object" && value !== null)
    return Object.values(value).some((v) => containsAny(v, forms));
  return false;
}

function redact(text: string, forms: readonly string[]): string {
  let out = text;
  for (const f of forms) out = out.split(f).join("[path]");
  return out;
}

/** Scrub every string in `value` (cut back to `limit` if `[path]` made one longer). */
function scrubDeep(value: unknown, limit: number): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const scrubbed = scrubPaths(value);
    return scrubbed === value
      ? { value, changed: false }
      : { value: cutTo(scrubbed, limit), changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = scrubDeep(v, limit);
      changed ||= r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = scrubDeep(v, limit);
      changed ||= r.changed;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/** Scrub one cell; a cell whose text changed says so (`pathScrubbed: true`). */
function scrubCell(cell: unknown): unknown {
  const { value, changed } = scrubDeep(cell, STATE_CAPS.maxCellTextChars);
  return changed && typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...value, pathScrubbed: true }
    : value;
}

function refuse(tool: StateToolName | null, code: StateCode): StateReply {
  return { api: STATE_API_VERSION, ok: false, tool, code };
}

/** Every string in `value` is at most `limit` characters. */
function stringsWithin(value: unknown, limit: number): boolean {
  if (typeof value === "string") return value.length <= limit;
  if (Array.isArray(value)) return value.every((v) => stringsWithin(v, limit));
  if (typeof value === "object" && value !== null)
    return Object.values(value).every((v) => stringsWithin(v, limit));
  return true;
}

function checkTree(
  node: UiNode,
  depth: number,
  limits: { maxDepth: number; maxNodes: number },
  count: { n: number },
  forms: readonly string[],
): UiNode | null {
  count.n += 1;
  if (count.n > limits.maxNodes || depth > limits.maxDepth) return null;
  if (typeof node.role !== "string" || typeof node.name !== "string") return null;
  const children = node.children ?? [];
  if (!Array.isArray(children) || children.length > STATE_CAPS.maxChildrenPerNode) return null;
  const out: UiNode[] = [];
  for (const child of children) {
    const checked = checkTree(child, depth + 1, limits, count, forms);
    if (checked === null) return null;
    out.push(checked);
  }
  return {
    role: cutTo(scrubPaths(redact(node.role, forms)), STATE_CAPS.maxNameChars),
    name: cutTo(scrubPaths(redact(node.name, forms)), STATE_CAPS.maxNameChars),
    childCount: Number.isInteger(node.childCount) ? node.childCount : 0,
    ...(node.childrenOmitted ? { childrenOmitted: node.childrenOmitted } : {}),
    ...(node.children ? { children: out } : {}),
  };
}

type Checked =
  | { ok: true; data: unknown }
  | { ok: false; code: "BACKEND_ERROR" | "OUTPUT_WITHHELD" };

/**
 * Check the backend's data for `request` against the caps and the withheld list, then scrub
 * path-like text. BACKEND_ERROR when the backend broke a bound (fail closed),
 * OUTPUT_WITHHELD when its raw strings carry a withheld string.
 */
function checkData(
  request: StateRequest,
  data: unknown,
  forms: readonly string[],
  folded: FoldedForms,
): Checked {
  const broken = { ok: false, code: "BACKEND_ERROR" } as const;
  const withheld = { ok: false, code: "OUTPUT_WITHHELD" } as const;
  if (typeof data !== "object" || data === null) return broken;
  if (!stringsWithin(data, STATE_CAPS.maxCellTextChars)) return broken;
  if (request.tool === "state_read_range" || request.tool === "state_ui_tree") {
    // Layer 1: the document-wide path-function flag is mandatory (fail closed).
    const flag = (data as { documentPathFunctions?: unknown }).documentPathFunctions;
    if (typeof flag !== "boolean") return broken;
    if (flag) return withheld;
  }
  if (request.tool !== "state_ui_tree") {
    if (containsAny(data, forms)) return withheld;
    if (containsFolded(data, folded)) return withheld;
  }
  switch (request.tool) {
    case "state_read_range": {
      const rows = (data as { rows?: unknown }).rows;
      const [c0, r0, c1, r1] = request.range;
      if (!Array.isArray(rows) || rows.length !== r1 - r0 + 1) return broken;
      if (!rows.every((row) => Array.isArray(row) && row.length === c1 - c0 + 1)) return broken;
      // Layer 1, server side: a returned formula that calls a path function, whatever the
      // backend's flag said.
      if (
        rows.some((row: unknown[]) =>
          row.some((cell) => {
            const formula = (cell as { formula?: unknown } | null)?.formula;
            return typeof formula === "string" && PATH_FUNCTION.test(formula);
          }),
        )
      )
        return withheld;
      const {
        rows: _rows,
        documentPathFunctions: _flag,
        ...rest
      } = data as Record<string, unknown>;
      return {
        ok: true,
        data: {
          ...(scrubDeep(rest, STATE_CAPS.maxNameChars).value as object),
          rows: rows.map((row: unknown[]) => row.map(scrubCell)),
        },
      };
    }
    case "state_list_sheets": {
      const sheets = (data as { sheets?: unknown }).sheets;
      if (!Array.isArray(sheets) || sheets.length > STATE_CAPS.maxSheets) return broken;
      if (!stringsWithin(sheets, STATE_CAPS.maxNameChars)) return broken;
      return { ok: true, data: scrubDeep(data, STATE_CAPS.maxNameChars).value };
    }
    case "state_document_status":
      return { ok: true, data: scrubDeep(data, STATE_CAPS.maxNameChars).value };
    case "state_ui_tree": {
      const tree = (data as { tree?: unknown }).tree;
      if (typeof tree !== "object" || tree === null) return broken;
      const count = { n: 0 };
      const checked = checkTree(tree as UiNode, 0, request, count, forms);
      if (checked === null) return broken;
      // Layer 3 on the tree, after exact withheld strings were redacted.
      if (containsFolded(checked, folded)) return withheld;
      return {
        ok: true,
        data: {
          tree: checked,
          nodes: count.n,
          truncated: (data as { truncated?: unknown }).truncated === true,
        },
      };
    }
  }
}

async function dispatch(
  backend: StateBackend,
  request: StateRequest,
): Promise<BackendResult<unknown>> {
  switch (request.tool) {
    case "state_list_sheets":
      return backend.listSheets();
    case "state_document_status":
      return backend.documentStatus();
    case "state_read_range":
      return backend.readRange(request.sheet, request.range);
    case "state_ui_tree":
      return backend.uiTree({ maxDepth: request.maxDepth, maxNodes: request.maxNodes });
  }
}

export function createStateService(options: StateServiceOptions): StateService {
  const forms = withheldForms(options.withheld ?? []);
  const folded = foldedForms(options.withheld ?? []);
  const diag = (tool: string, detail: string) => options.onDiagnostic?.({ tool, detail });
  return {
    async call(tool, args) {
      const parsed = parseStateRequest(tool, args);
      const name =
        typeof tool === "string" && !parsed.ok && parsed.code === "UNKNOWN_TOOL"
          ? null
          : (tool as StateToolName);
      if (!parsed.ok) return refuse(name, parsed.code);
      const request = parsed.value;
      let result: BackendResult<unknown>;
      try {
        result = await dispatch(options.backend, request);
      } catch (error) {
        diag(request.tool, error instanceof Error ? error.message : String(error));
        return refuse(request.tool, "BACKEND_ERROR");
      }
      if (!result.ok) return refuse(request.tool, result.code);
      const checked = checkData(request, result.data, forms, folded);
      if (!checked.ok) {
        diag(
          request.tool,
          checked.code === "OUTPUT_WITHHELD"
            ? "reply contained a withheld string"
            : "backend reply broke a cap or shape check",
        );
        return refuse(request.tool, checked.code);
      }
      const data = checked.data;
      const reply: StateReply = {
        api: STATE_API_VERSION,
        ok: true,
        tool: request.tool,
        backend: options.backend.kind,
        notice: LIVE_STATE_NOTICE,
        data,
      };
      const text = JSON.stringify(reply);
      if (Buffer.byteLength(text, "utf8") > STATE_CAPS.maxReplyBytes)
        return refuse(request.tool, "OUTPUT_TOO_LARGE");
      // Defense in depth, believed unreachable: every string was already checked raw
      // (layer 2) or had withheld strings redacted (UI tree) before it got here. Kept so a
      // future field added without those checks still fails closed.
      if (forms.some((f) => text.includes(f))) {
        diag(request.tool, "reply contained a withheld string");
        return refuse(request.tool, "OUTPUT_WITHHELD");
      }
      return reply;
    },
  };
}

type RpcResult = { ok: true; result: unknown } | { ok: false; code: number; message: string };

function rpc(id: unknown, outcome: RpcResult): string {
  return JSON.stringify(
    outcome.ok
      ? { jsonrpc: "2.0", id, result: outcome.result }
      : { jsonrpc: "2.0", id, error: { code: outcome.code, message: outcome.message } },
  );
}

async function callTool(
  service: StateService,
  params: Record<string, unknown>,
): Promise<RpcResult> {
  if (typeof params.name !== "string")
    return { ok: false, code: -32602, message: "missing tool name" };
  const reply = await service.call(params.name, params.arguments);
  if (!reply.ok && reply.code === "UNKNOWN_TOOL")
    return { ok: false, code: -32602, message: "unknown tool" };
  return {
    ok: true,
    result: {
      content: [{ type: "text", text: JSON.stringify(reply) }],
      structuredContent: reply,
      isError: !reply.ok,
    },
  };
}

/** Handle one wire line. Returns the reply line, or undefined for notifications. */
export async function handleStateLine(
  service: StateService,
  line: string,
): Promise<string | undefined> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return rpc(null, { ok: false, code: -32700, message: "parse error" });
  }
  if (Array.isArray(message))
    return rpc(null, { ok: false, code: -32600, message: "batch requests are not supported" });
  if (typeof message !== "object" || message === null)
    return rpc(null, { ok: false, code: -32600, message: "invalid request" });
  const request = message as Record<string, unknown>;
  const hasId = Object.hasOwn(request, "id");
  const id = hasId ? request.id : null;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string")
    return hasId ? rpc(id, { ok: false, code: -32600, message: "invalid request" }) : undefined;
  const params =
    typeof request.params === "object" && request.params !== null && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};
  let outcome: RpcResult;
  switch (request.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" &&
        (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : PROTOCOL_VERSIONS[0];
      outcome = {
        ok: true,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: STATE_SERVER_NAME, version: STATE_SERVER_VERSION },
          instructions: STATE_INSTRUCTIONS,
        },
      };
      break;
    }
    case "notifications/initialized":
      return undefined;
    case "ping":
      outcome = { ok: true, result: {} };
      break;
    case "tools/list":
      outcome = { ok: true, result: { tools: stateToolDefinitions() } };
      break;
    case "tools/call":
      outcome = await callTool(service, params);
      break;
    default:
      outcome = { ok: false, code: -32601, message: "method not found" };
  }
  return hasId ? rpc(id, outcome) : undefined;
}

/** Serve until `input` ends; one request at a time, replies in request order. */
export function serveStateStdio(
  service: StateService,
  input: Readable,
  output: Writable,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let chain = Promise.resolve();
  return new Promise((resolveDone) => {
    lines.on("line", (line) => {
      if (line.trim().length === 0) return;
      chain = chain.then(async () => {
        let out: string | undefined;
        try {
          out = await handleStateLine(service, line);
        } catch {
          out = rpc(null, { ok: false, code: -32603, message: "internal error" });
        }
        if (out !== undefined) output.write(`${out}\n`);
      });
    });
    lines.on("close", () => {
      void chain.then(() => resolveDone());
    });
  });
}
