/**
 * TIF-266 — the agent's tool surface, classified by what each tool can reach.
 *
 * Every tool an M2 agent can be granted is listed here with its reach. `auditToolSurface`
 * fails closed: a tool it does not know is a violation, so adding a tool to the MCP server
 * or the guest agent without classifying it breaks CI (test/integrity/surface.test.ts reads
 * the tool names straight from `runtime/crates/myco-rt-mcp/src/main.rs` and
 * `agent/myco_agent/ops.py`).
 *
 * Reach classes:
 * - `guest`        acts inside the disposable guest only. The guest is agent-controlled
 *                  in full (act:launch and launch_process run any command), so nothing in
 *                  the guest may be ground truth or an oracle input the harness has not
 *                  copied to the host after the agent stopped.
 * - `gate`         the TIF-265 verdict tool. Takes a run id; never an intent or an expected value.
 * - `agent-local`  touches only the agent's own context (e.g. a todo list).
 * - `host-dir-agent-named` makes a host directory whose name the agent chooses
 *                  (myco-rt-mcp `create` makes `<workspace>/runs/<session_id>/`, and the
 *                  agent supplies `session_id`). Allowed only when the server is started with
 *                  `MYCO_RT_SESSION_ID` (the harness pins the id and `create` refuses any
 *                  other); pass `mycoRtSessionPinned: true` to the audit to say so.
 * - `host-write-fixed` writes host files under a run dir named by the session id, with
 *                  content the agent does not supply (myco-rt-mcp `evidence`). The agent
 *                  chooses when, and, unpinned, the dir name. Denied in a gated run: the
 *                  harness exports evidence itself after the agent stops.
 * - `host-fs`      reads or writes host paths the agent chooses.
 * - `host-shell`   runs host commands (or spawns an agent that can).
 * - `network`      host-side network fetches (not a write path; denied to keep the surface
 *                  closed and auditable).
 * - `app-state`    reads the agent's OWN live app/document for its own trial, read-only,
 *                  through a server the harness bound to that trial (capability track I,
 *                  `myco-state`, `src/state/`). Takes no path, trial or run argument. Not in
 *                  the default `MCP_SERVERS`: only a capability-arm audit classifies it
 *                  (`STATE_SERVER_CLASS`), so the R1 gated harness keeps refusing it.
 */

export type Reach =
  | "guest"
  | "gate"
  | "agent-local"
  | "host-dir-agent-named"
  | "host-write-fixed"
  | "host-fs"
  | "host-shell"
  | "network"
  | "app-state";

export interface ToolClass {
  readonly reach: Reach;
  readonly note: string;
}

/** The Linux runtime MCP server (`myco-rt-mcp`), served to Claude Code as `mcp__myco-rt__<tool>`. */
export const MYCO_RT_MCP_TOOLS: Readonly<Record<string, ToolClass>> = {
  create: {
    reach: "host-dir-agent-named",
    note: "boots a guest and makes host <workspace>/runs/<session_id>/; session_id is agent-supplied unless MYCO_RT_SESSION_ID pins it",
  },
  observe: {
    reach: "guest",
    note: "a11y tree, windows, processes; screenshot path is a guest path",
  },
  act: { reach: "guest", note: "launch/click/type in the guest; launch runs any guest command" },
  evidence: {
    reach: "host-write-fixed",
    note: "writes the session's trace.jsonl/result.json into host <workspace>/runs/<session_id>/, at a time the agent picks",
  },
  read_file: { reach: "guest", note: "confined beneath the session's guest read_root" },
  write_file: { reach: "guest", note: "confined beneath the guest read_root, opt-in allow_write" },
  launch_process: { reach: "guest", note: "any guest command" },
  kill_process: { reach: "guest", note: "guest process by handle" },
  relaunch_process: { reach: "guest", note: "guest process by handle" },
  reset: { reach: "guest", note: "restores the guest to its clean base" },
  destroy: {
    reach: "guest",
    note: "deletes the guest overlay and releases the lock; leaves the host run dir in place",
  },
};

/**
 * The Windows guest agent's NDJSON ops (`agent/myco_agent/ops.py`). Today only the host
 * harness speaks this protocol; if an M2 actuator exposes these ops to the agent they are
 * `guest`-only, but note read_file/write_file are unconfined within the guest.
 */
export const MYCO_AGENT_OPS: Readonly<Record<string, ToolClass>> = {
  ping: { reach: "guest", note: "liveness" },
  session_info: { reach: "guest", note: "guest session facts" },
  launch: { reach: "guest", note: "any guest argv" },
  uia_tree: { reach: "guest", note: "UIA read" },
  uia_invoke: { reach: "guest", note: "UIA action" },
  screenshot: { reach: "guest", note: "guest screen" },
  read_file: { reach: "guest", note: "ANY guest path (unconfined)" },
  write_file: { reach: "guest", note: "ANY guest path (unconfined)" },
  kill: { reach: "guest", note: "guest process" },
  uno_eval: { reach: "guest", note: "read-only UNO calls" },
};

/** Claude Code built-in tools. A gated M2 run grants none of the host-reaching ones. */
export const CLAUDE_CODE_BUILTINS: Readonly<Record<string, ToolClass>> = {
  Bash: { reach: "host-shell", note: "any host command" },
  BashOutput: { reach: "host-shell", note: "reads background shell output" },
  KillShell: { reach: "host-shell", note: "controls host shells" },
  Read: { reach: "host-fs", note: "any host path" },
  Write: { reach: "host-fs", note: "any host path" },
  Edit: { reach: "host-fs", note: "any host path" },
  MultiEdit: { reach: "host-fs", note: "any host path" },
  NotebookEdit: { reach: "host-fs", note: "any host path" },
  Glob: { reach: "host-fs", note: "lists host paths" },
  Grep: { reach: "host-fs", note: "reads host files" },
  LS: { reach: "host-fs", note: "lists host paths" },
  Task: { reach: "host-shell", note: "spawns a subagent with its own tools" },
  Agent: { reach: "host-shell", note: "spawns a subagent with its own tools" },
  WebFetch: { reach: "network", note: "host network" },
  WebSearch: { reach: "network", note: "host network" },
  TodoWrite: { reach: "agent-local", note: "the agent's own todo list" },
};

/**
 * The structured-state server (`myco-state`, capability track I), served as
 * `mcp__myco-state__<tool>`. NOT in `MCP_SERVERS`: pass `STATE_SERVER_CLASS` as an extra
 * server, which only the capability-arm audit does (`src/state/arms.ts`).
 * test/state/state-arms.test.ts pins these names to the server's own tool list.
 */
export const MYCO_STATE_MCP_TOOLS: Readonly<Record<string, ToolClass>> = {
  state_list_sheets: {
    reach: "app-state",
    note: "sheet names and used ranges of the trial's open document",
  },
  state_read_range: { reach: "app-state", note: "bounded cell read of the trial's open document" },
  state_document_status: { reach: "app-state", note: "the trial's open document's save state" },
  state_ui_tree: { reach: "app-state", note: "bounded a11y tree of the trial's app window" },
};

export const STATE_SERVER_NAME = "myco-state";
export const STATE_SERVER_CLASS: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {
  [STATE_SERVER_NAME]: MYCO_STATE_MCP_TOOLS,
};

/** The env var that binds a `myco-state` server to one trial (`STATE_ENV.runId` in src/state/cli.ts). */
export const MYCO_STATE_RUN_ENV = "MYCO_STATE_RUN_ID";
/** The env var naming the trial's live soffice UNO pipe (`STATE_ENV.pipe`). */
export const MYCO_STATE_PIPE_ENV = "MYCO_STATE_UNO_PIPE";
/** The env var naming the trial document's RuntimeUID in that soffice (`STATE_ENV.docUid`). */
export const MYCO_STATE_DOC_ENV = "MYCO_STATE_DOC_UID";
/** The env var listing the host paths no state reply may contain (`STATE_ENV.withheld`). */
export const MYCO_STATE_WITHHELD_ENV = "MYCO_STATE_WITHHELD";
/** The only env keys a `myco-state` server may be launched with. */
export const MYCO_STATE_ENV_KEYS: readonly string[] = [
  MYCO_STATE_RUN_ENV,
  MYCO_STATE_PIPE_ENV,
  MYCO_STATE_DOC_ENV,
  MYCO_STATE_WITHHELD_ENV,
  "MYCO_PYTHON",
];

/**
 * A usable withheld list: a JSON array of 1 to 64 absolute host paths (POSIX `/…`, a drive
 * `C:\…`, or UNC `\\…`), each at least 4 characters with no line break. Mandatory for a
 * `myco-state` server: it is the layer that keeps the trial, vault and fixture dirs out of
 * every reply. The server's own check (`withheldListFrom` in src/state/api.ts) is the same
 * rule, spelled there because no state module imports integrity code;
 * test/state/state-arms.test.ts holds both to one case table.
 */
export function stateWithheldListValid(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return (
    Array.isArray(parsed) &&
    parsed.length >= 1 &&
    parsed.length <= 64 &&
    parsed.every(
      (p) =>
        typeof p === "string" &&
        p.length >= 4 &&
        !/[\r\n]/.test(p) &&
        (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")),
    )
  );
}

/**
 * The R1 / A/B live agent's actuator (#732), served as `mcp__myco-hcu__<tool>` by
 * `scripts/myco-hcu.ts` (`src/pilot/hcu-actuator.ts`). Each tool is one C1 pixel action (or a
 * screenshot) sent to Microsoft HCU's `GUI` tool in the trial guest through the `hcu+shell`
 * arm's own client (`connectHcuGui`), so both R2 arms act through one code path. Guest reach
 * only: no path, no host file, no command; the server is separate from the gate.
 * `test/pilot/hcu-actuator.test.ts` pins these names to the server's own tool list.
 */
export const MYCO_HCU_MCP_TOOLS: Readonly<Record<string, ToolClass>> = {
  screenshot: {
    reach: "guest",
    note: "one screenshot of the guest desktop through HCU's GUI tool",
  },
  click: { reach: "guest", note: "one pixel click in the guest through HCU's GUI tool" },
  type_text: {
    reach: "guest",
    note: "click a guest pixel, then type at most 256 characters through HCU's GUI tool",
  },
  press_key: { reach: "guest", note: "one key chord in the guest through HCU's GUI tool" },
};

export const HCU_ACTUATOR_SERVER_NAME = "myco-hcu";

/** MCP servers by the name a harness registers them under. */
export const MCP_SERVERS: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {
  "myco-rt": MYCO_RT_MCP_TOOLS,
  [HCU_ACTUATOR_SERVER_NAME]: MYCO_HCU_MCP_TOOLS,
};

const ALLOWED: ReadonlySet<Reach> = new Set<Reach>(["guest", "gate", "agent-local", "app-state"]);

export interface SurfaceViolation {
  readonly tool: string;
  readonly reach: Reach | "unknown";
  readonly detail: string;
}

export interface SurfaceAudit {
  readonly ok: boolean;
  readonly violations: SurfaceViolation[];
  /** Host paths the granted tools can reach. Empty for a passing audit. */
  readonly hostRoots: string[];
}

export interface AuditOptions {
  /**
   * Extra MCP servers to classify, e.g. TIF-265's gate server:
   * `{ "myco-gate": { verdict: { reach: "gate", note: "..." } } }`.
   */
  readonly extraServers?: Readonly<Record<string, Readonly<Record<string, ToolClass>>>>;
  /**
   * True only when the harness starts `myco-rt-mcp` with `MYCO_RT_SESSION_ID` set (see
   * `rtSessionIdFor`). Then `create` cannot name a host dir and counts as `guest`.
   */
  readonly mycoRtSessionPinned?: boolean;
}

/** The env var that pins `myco-rt-mcp`'s session id (`SESSION_ID_ENV` in its main.rs). */
export const MYCO_RT_SESSION_ENV = "MYCO_RT_SESSION_ID";

/**
 * The pinned runtime session id for a harness run. Suffixed so the runtime's
 * `runs/<session>/` can never be the harness's own `runs/<runId>/`.
 */
export function rtSessionIdFor(runId: string): string {
  return `${runId}.rt`;
}

/** Classify a tool name in Claude Code's form: a built-in name, or `mcp__<server>__<tool>`. */
export function classifyTool(name: string, opts: AuditOptions = {}): ToolClass | undefined {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp)
    return Object.hasOwn(CLAUDE_CODE_BUILTINS, name) ? CLAUDE_CODE_BUILTINS[name] : undefined;
  const [, server = "", tool = ""] = mcp;
  const servers = { ...MCP_SERVERS, ...opts.extraServers };
  const tools = Object.hasOwn(servers, server) ? servers[server] : undefined;
  const cls = tools && Object.hasOwn(tools, tool) ? tools[tool] : undefined;
  if (cls?.reach === "host-dir-agent-named" && opts.mycoRtSessionPinned)
    return { reach: "guest", note: `${cls.note} (pinned: ${MYCO_RT_SESSION_ENV} set)` };
  return cls;
}

/**
 * Audit the exact list of tools a gated run grants the agent. Fails closed on unknown
 * tools and on any reach outside guest / gate / agent-local / app-state.
 */
export function auditToolSurface(
  granted: readonly string[],
  opts: AuditOptions = {},
): SurfaceAudit {
  const violations: SurfaceViolation[] = [];
  const hostRoots = new Set<string>();
  for (const tool of granted) {
    const cls = classifyTool(tool, opts);
    if (!cls) {
      violations.push({ tool, reach: "unknown", detail: "unclassified tool: fail closed" });
      hostRoots.add("/");
      continue;
    }
    if (!ALLOWED.has(cls.reach)) {
      violations.push({ tool, reach: cls.reach, detail: cls.note });
      if (cls.reach === "host-fs" || cls.reach === "host-shell") hostRoots.add("/");
    }
  }
  return { ok: violations.length === 0, violations, hostRoots: [...hostRoots] };
}
