/**
 * TIF-274 prerequisite (#470 follow-up F2): audit the tool surface of the agent the gated
 * harness actually launches, not a list fixed in a test.
 *
 * The harness builds one `AgentLaunchPlan` (the agent's argv and the MCP servers it is
 * given, with each server's environment), audits that plan with `auditAgentLaunch`, and
 * hands the very same frozen object to the transport that starts the agent. The audit:
 *
 * - reads the granted tools from the argv (`--allowedTools` / `--allowed-tools`, comma or
 *   space separated, repeatable) and runs `auditToolSurface` on them: unknown,
 *   host-reaching and network tools fail closed;
 * - refuses argv flags that widen the surface past that list (`--dangerously-skip-permissions`,
 *   a permission mode other than `default` / `dontAsk`, `--add-dir`) and any argv entry it
 *   does not recognise as a value of a known flag (fail closed);
 * - refuses an MCP server it cannot classify, and an `mcp__<server>__…` tool whose server is
 *   not in the plan;
 * - derives `mycoRtSessionPinned` from the `myco-rt` server's real environment
 *   (`MYCO_RT_SESSION_ID` must equal `rtSessionIdFor(runId)`, so an empty or other value
 *   leaves `create` rejected; #470 N3) instead of taking the caller's word.
 *
 * What it does not see: permission rules loaded from Claude Code settings files. The real
 * driver must launch the agent with those sources off (see the PR's follow-ups).
 */

import {
  type AuditOptions,
  auditToolSurface,
  MCP_SERVERS,
  MYCO_RT_SESSION_ENV,
  rtSessionIdFor,
  type SurfaceAudit,
  type SurfaceViolation,
  type ToolClass,
} from "./surface.ts";

export interface McpServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Exactly what the transport starts: nothing else may widen the agent's tools. */
export interface AgentLaunchPlan {
  /** The agent process argv after the executable (e.g. Claude Code's flags). */
  readonly argv: readonly string[];
  /** MCP servers by the name the agent sees them under (`mcp__<name>__<tool>`). */
  readonly mcpServers: Readonly<Record<string, McpServerLaunch>>;
}

export interface LaunchAuditOptions {
  /** The trial's run id; the `myco-rt` pin must be `rtSessionIdFor(runId)`. */
  readonly runId: string;
  /** Extra servers to classify, e.g. the gate: `{ "myco-gate": { myco_gate_check: … } }`. */
  readonly extraServers?: AuditOptions["extraServers"];
}

export interface LaunchAudit extends SurfaceAudit {
  /** The tools read from the argv: the list that was audited. */
  readonly granted: readonly string[];
  /** True when the `myco-rt` server's environment pins the session id to this trial. */
  readonly mycoRtSessionPinned: boolean;
}

const ALLOWED_TOOLS_FLAGS = new Set(["--allowedTools", "--allowed-tools"]);
/** Flags that take one value and do not widen the tool surface. */
const VALUE_FLAGS = new Set([
  "--mcp-config",
  "--model",
  "--output-format",
  "--input-format",
  "--max-turns",
  "--append-system-prompt",
  "--system-prompt",
  "--session-id",
  "--permission-mode",
  "--disallowedTools",
  "--disallowed-tools",
  "--setting-sources",
]);
/** Boolean flags that do not widen the tool surface. */
const BOOL_FLAGS = new Set(["-p", "--print", "--strict-mcp-config", "--verbose"]);
/** Flags that widen the surface past `--allowedTools`. */
const WIDENING_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--add-dir",
]);
const SAFE_PERMISSION_MODES = new Set(["default", "dontAsk"]);

function splitTools(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
}

/**
 * Read the granted tool list from an agent argv. Every argv entry must be a known flag or
 * its value; anything else is a violation, so an unrecognised widening flag fails closed.
 */
export function grantedToolsFromArgv(argv: readonly string[]): {
  granted: string[];
  violations: SurfaceViolation[];
} {
  const granted: string[] = [];
  const violations: SurfaceViolation[] = [];
  const flagViolation = (flag: string, detail: string) =>
    violations.push({ tool: flag, reach: "unknown", detail });
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index] ?? "";
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const takeValue = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) return undefined;
      index += 1;
      return next;
    };
    if (ALLOWED_TOOLS_FLAGS.has(flag)) {
      // Claude Code's flag is variadic: consume every following non-flag entry.
      if (inline !== undefined) granted.push(...splitTools(inline));
      else {
        let any = false;
        while (index + 1 < argv.length && !(argv[index + 1] ?? "").startsWith("-")) {
          granted.push(...splitTools(argv[index + 1] ?? ""));
          index += 1;
          any = true;
        }
        if (!any) flagViolation(flag, "flag without a value");
      }
    } else if (WIDENING_FLAGS.has(flag)) {
      flagViolation(flag, "widens the agent's tools past --allowedTools: fail closed");
      if (flag === "--add-dir") takeValue();
    } else if (VALUE_FLAGS.has(flag)) {
      const value = takeValue();
      if (value === undefined) flagViolation(flag, "flag without a value");
      else if (flag === "--permission-mode" && !SAFE_PERMISSION_MODES.has(value))
        flagViolation(flag, `permission mode ${JSON.stringify(value)} can grant unlisted tools`);
    } else if (BOOL_FLAGS.has(flag) && inline === undefined) {
      // no value
    } else if (flag.startsWith("-")) {
      flagViolation(flag, "unrecognised agent flag: fail closed");
    } else {
      // A positional entry (the prompt) is not a tool grant.
    }
  }
  return { granted, violations };
}

/**
 * Audit a launch plan. `ok` is true only when the argv grants nothing outside guest / gate /
 * agent-local reach, no flag widens it, and every MCP server is classified.
 */
export function auditAgentLaunch(plan: AgentLaunchPlan, opts: LaunchAuditOptions): LaunchAudit {
  const { granted, violations } = grantedToolsFromArgv(plan.argv);
  const servers: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {
    ...MCP_SERVERS,
    ...opts.extraServers,
  };
  const serverNames = Object.keys(plan.mcpServers);
  for (const name of serverNames)
    if (!Object.hasOwn(servers, name))
      violations.push({
        tool: `mcp__${name}`,
        reach: "unknown",
        detail: "unclassified MCP server in the launch plan: fail closed",
      });
  for (const tool of granted) {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
    if (mcp && !serverNames.includes(mcp[1] ?? ""))
      violations.push({
        tool,
        reach: "unknown",
        detail: "granted tool names an MCP server the launch plan does not start",
      });
  }
  const rt = Object.hasOwn(plan.mcpServers, "myco-rt") ? plan.mcpServers["myco-rt"] : undefined;
  const pin = rt && Object.hasOwn(rt.env, MYCO_RT_SESSION_ENV) ? rt.env[MYCO_RT_SESSION_ENV] : "";
  const mycoRtSessionPinned = pin === rtSessionIdFor(opts.runId) && opts.runId.length > 0;
  const surface = auditToolSurface(granted, {
    ...(opts.extraServers ? { extraServers: opts.extraServers } : {}),
    mycoRtSessionPinned,
  });
  const all = [...violations, ...surface.violations];
  const hostRoots = new Set(surface.hostRoots);
  if (violations.length > 0) hostRoots.add("/");
  return {
    ok: all.length === 0,
    violations: all,
    hostRoots: [...hostRoots],
    granted,
    mycoRtSessionPinned,
  };
}
