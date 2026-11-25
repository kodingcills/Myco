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
 * - `host-write-fixed` writes host files at a path the agent does not choose, with content
 *                  the agent does not supply (myco-rt-mcp `evidence`). Denied in a gated run:
 *                  the harness exports evidence itself after the agent stops.
 * - `host-fs`      reads or writes host paths the agent chooses.
 * - `host-shell`   runs host commands (or spawns an agent that can).
 * - `network`      host-side network fetches (not a write path; denied to keep the surface
 *                  closed and auditable).
 */

export type Reach =
  | "guest"
  | "gate"
  | "agent-local"
  | "host-write-fixed"
  | "host-fs"
  | "host-shell"
  | "network";

export interface ToolClass {
  readonly reach: Reach;
  readonly note: string;
}

/** The Linux runtime MCP server (`myco-rt-mcp`), served to Claude Code as `mcp__myco-rt__<tool>`. */
export const MYCO_RT_MCP_TOOLS: Readonly<Record<string, ToolClass>> = {
  create: { reach: "guest", note: "boots a guest; read_root/allow_write are guest paths" },
  observe: {
    reach: "guest",
    note: "a11y tree, windows, processes; screenshot path is a guest path",
  },
  act: { reach: "guest", note: "launch/click/type in the guest; launch runs any guest command" },
  evidence: {
    reach: "host-write-fixed",
    note: "exports the session's trace.jsonl/result.json into the host runs/<session>/ dir",
  },
  read_file: { reach: "guest", note: "confined beneath the session's guest read_root" },
  write_file: { reach: "guest", note: "confined beneath the guest read_root, opt-in allow_write" },
  launch_process: { reach: "guest", note: "any guest command" },
  kill_process: { reach: "guest", note: "guest process by handle" },
  relaunch_process: { reach: "guest", note: "guest process by handle" },
  reset: { reach: "guest", note: "restores the guest to its clean base" },
  destroy: { reach: "guest", note: "tears down the guest; deletes the host run dir" },
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

/** MCP servers by the name a harness registers them under. */
export const MCP_SERVERS: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {
  "myco-rt": MYCO_RT_MCP_TOOLS,
};

const ALLOWED: ReadonlySet<Reach> = new Set<Reach>(["guest", "gate", "agent-local"]);

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
}

/** Classify a tool name in Claude Code's form: a built-in name, or `mcp__<server>__<tool>`. */
export function classifyTool(name: string, opts: AuditOptions = {}): ToolClass | undefined {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp)
    return Object.hasOwn(CLAUDE_CODE_BUILTINS, name) ? CLAUDE_CODE_BUILTINS[name] : undefined;
  const [, server = "", tool = ""] = mcp;
  const servers = { ...MCP_SERVERS, ...opts.extraServers };
  const tools = Object.hasOwn(servers, server) ? servers[server] : undefined;
  return tools && Object.hasOwn(tools, tool) ? tools[tool] : undefined;
}

/**
 * Audit the exact list of tools a gated run grants the agent. Fails closed on unknown
 * tools and on any reach outside guest / gate / agent-local.
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
