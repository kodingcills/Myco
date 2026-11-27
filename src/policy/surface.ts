/**
 * Track O: what the agent of a policed trial may be granted (#605 item 1).
 *
 * The policed wrappers (`./actuators.ts`) sit on the HOST's actuator interfaces. The `myco-rt`
 * MCP server (`runtime/crates/myco-rt-mcp`) is a different path: Claude Code calls its tools
 * directly, so `mcp__myco-rt__act` (launch with any arguments, click, type),
 * `launch_process` and `write_file` reach the guest's `Command::new` and file system without
 * passing any wrapper. O does not police that surface; it keeps it out of policed trials.
 *
 * `startPolicy` therefore requires the exact list of tools the trial grants the agent and
 * refuses the trial (`POLICY_UNPOLICED_SURFACE`) unless every one is on
 * `POLICED_GRANTABLE_TOOLS`: a closed list of tools that act on nothing. Everything else is
 * refused, including a tool this list has never heard of, so a new acting tool on any server
 * fails closed until it is reviewed here. A policed agent acts only through a wrapped host
 * interface (for example `DesktopTransport.act`, which the host's `RuntimeTransport`
 * implements over `myco-rt`'s `act`).
 *
 * Limit: the check is only as good as the list the host passes. The runner that wires a policed
 * arm must pass the `effective` surface of the audited launch plan it starts the agent with
 * (`auditAgentLaunch(plan).effective`, `src/integrity/launch.ts`); an `"unbounded"` surface is
 * not an array, so it is refused. No `src/` runner wires a policed arm yet.
 *
 * The names are spelled here, not imported: the policy module reaches no gate, state or
 * integrity code (`test/policy/boundary.test.ts`). `test/policy/surface.test.ts` pins them to
 * the `myco-rt` tool table, the gate's tool and the state server's tools.
 */

/** Read-only `myco-rt` tools: an a11y/screen read, and a confined guest read. */
export const POLICED_RT_READ_TOOLS = ["mcp__myco-rt__observe", "mcp__myco-rt__read_file"] as const;

/** The only tools a policed trial may grant its agent. Closed; adding one is a reviewed change. */
export const POLICED_GRANTABLE_TOOLS: readonly string[] = Object.freeze([
  ...POLICED_RT_READ_TOOLS,
  // The completion gate's verdict tool: takes a task id, run id and claim; acts on nothing.
  "mcp__myco-gate__myco_gate_check",
  // Track I's read-only app-state server.
  "mcp__myco-state__state_list_sheets",
  "mcp__myco-state__state_read_range",
  "mcp__myco-state__state_document_status",
  "mcp__myco-state__state_ui_tree",
  // The agent's own todo list.
  "TodoWrite",
]);

const GRANTABLE: ReadonlySet<string> = new Set(POLICED_GRANTABLE_TOOLS);

/** At most this many granted tools are read (a larger list is refused, not truncated). */
export const MAX_GRANTED_TOOLS = 256;

/**
 * True only when `granted` is an array of at most `MAX_GRANTED_TOOLS` strings, each on
 * `POLICED_GRANTABLE_TOOLS`. Anything else (missing, not an array, a non-string, an unknown or
 * acting tool) is false: the trial is refused.
 */
export function policedGrantOk(granted: unknown): boolean {
  if (!Array.isArray(granted) || granted.length > MAX_GRANTED_TOOLS) return false;
  return granted.every((t: unknown) => typeof t === "string" && GRANTABLE.has(t));
}
