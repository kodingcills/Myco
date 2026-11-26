/**
 * TIF-274 prerequisite (#470 follow-up F2): audit the tool surface of the agent the gated
 * harness actually launches, not a list fixed in a test.
 *
 * The harness builds one `AgentLaunchPlan` (the agent's argv and the MCP servers it is
 * given, with each server's environment), audits that plan with `auditAgentLaunch`, and
 * hands the very same frozen object to the transport that starts the agent. The audit:
 *
 * - parses the argv the way Claude Code's parser does: `--allowedTools`, `--disallowedTools`,
 *   `--tools`, `--mcp-config` and `--add-dir` are variadic (several values after one flag,
 *   repeatable, or one `--flag=value`), so no value can pass as a positional entry or a
 *   separate flag; a value that looks like a flag fails closed;
 * - runs `auditToolSurface` on the granted tools (`--allowedTools`, comma or space
 *   separated): unknown, host-reaching and network tools fail closed;
 * - audits the effective surface, not just the grant: Claude Code's built-in tools are set by
 *   `--tools` (absent or `default` = every default built-in, `""` = none), separately from
 *   `--allowedTools`. The effective surface is the built-ins `--tools` enables plus the
 *   granted MCP tools, minus whole-tool `--disallowedTools` rules; a launch where it exceeds
 *   the grant is refused, so `--tools` must be given and name only granted tools;
 * - refuses argv flags that widen the surface past that list (`--dangerously-skip-permissions`,
 *   a permission mode other than `dontAsk`, `--add-dir`), and any argv entry it does not
 *   recognise (fail closed);
 * - pins the MCP servers the agent can load to `plan.mcpServers`: `--strict-mcp-config` must be
 *   given (so Claude Code loads no user, project or local MCP server), and there must be
 *   exactly one `--mcp-config` value, equal to `plan.mcpConfigPath` (an absolute, normalised
 *   path; the transport writes `mcpConfigJson(plan)` there). Inline JSON, any other path
 *   (relative, `..`, a symlink's own path) and a second value are refused. The audit is pure
 *   and does not read the file: the transport owns writing it (see `GatedTrialTransport`);
 * - refuses an MCP server in `plan.mcpServers` it cannot classify, and an
 *   `mcp__<server>__…` tool whose server is not in the plan;
 * - when the plan starts a `myco-state` server (capability track I), checks its binding: its
 *   environment must pin `MYCO_STATE_RUN_ID` to this trial's run id and name a harness-issued
 *   UNO pipe, carry no other keys than `MYCO_STATE_ENV_KEYS`, and its args must end in `mcp`.
 *   The server is classified only when the caller passes `STATE_SERVER_CLASS` (the
 *   capability-arm audit does; the R1 gated harness does not, so it refuses the server);
 * - derives `mycoRtSessionPinned` from the `myco-rt` server's real environment
 *   (`MYCO_RT_SESSION_ID` must equal `rtSessionIdFor(runId)`, so an empty or other value
 *   leaves `create` rejected; #470 N3) instead of taking the caller's word.
 *
 * What it does not see: permission rules loaded from Claude Code settings files (the real
 * driver must launch the agent with those sources off; see the PR's follow-ups), and the bytes
 * at `plan.mcpConfigPath`: the transport must write `mcpConfigJson(plan)` there itself, after
 * the audit and before the launch, replacing whatever is there.
 */

import { isAbsolute, normalize } from "node:path";
import {
  type AuditOptions,
  auditToolSurface,
  classifyTool,
  MCP_SERVERS,
  MYCO_RT_SESSION_ENV,
  MYCO_STATE_ENV_KEYS,
  MYCO_STATE_PIPE_ENV,
  MYCO_STATE_RUN_ENV,
  rtSessionIdFor,
  STATE_SERVER_NAME,
  type SurfaceAudit,
  type SurfaceViolation,
  type ToolClass,
} from "./surface.ts";

export interface McpServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Exactly what the transport starts. `auditAgentLaunch` refuses a plan whose argv could load
 * any MCP server other than `mcpServers` (it requires `--strict-mcp-config` and exactly one
 * `--mcp-config mcpConfigPath`) or enable any tool outside the audited grant.
 */
export interface AgentLaunchPlan {
  /** The agent process argv after the executable (e.g. Claude Code's flags). */
  readonly argv: readonly string[];
  /** MCP servers by the name the agent sees them under (`mcp__<name>__<tool>`). */
  readonly mcpServers: Readonly<Record<string, McpServerLaunch>>;
  /**
   * Absolute, normalised host path of the MCP config the transport writes from `mcpServers`
   * (`mcpConfigJson(plan)`) before starting the agent. The argv's one `--mcp-config` value
   * must equal it exactly.
   */
  readonly mcpConfigPath: string;
}

/**
 * The MCP config file content for `plan`: `plan.mcpServers` and nothing else, in Claude
 * Code's `{"mcpServers": {...}}` shape. The transport writes this to `plan.mcpConfigPath`.
 */
export function mcpConfigJson(plan: AgentLaunchPlan): string {
  const mcpServers: Record<string, McpServerLaunch> = {};
  for (const [name, server] of Object.entries(plan.mcpServers))
    mcpServers[name] = { command: server.command, args: [...server.args], env: { ...server.env } };
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
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
  /**
   * The effective tool surface: built-ins `--tools` enables plus granted MCP tools, minus
   * whole-tool `--disallowedTools` rules. `"unbounded"` when `--tools` is absent or `default`.
   */
  readonly effective: readonly string[] | "unbounded";
  /** True when the `myco-rt` server's environment pins the session id to this trial. */
  readonly mycoRtSessionPinned: boolean;
}

/** What a value-taking flag's values mean to the audit. */
type FlagRole = "allowed" | "disallowed" | "tools" | "mcp-config" | "add-dir" | "other";

/**
 * Claude Code's variadic flags (`<x...>` in `claude --help`): the first value is the next
 * argv entry, then every following entry that does not look like an option, and a repeated
 * flag adds to the earlier values. `--add-dir` is variadic too; it is refused below, but its
 * values are still consumed so none is read as a positional entry.
 */
const VARIADIC_FLAGS: ReadonlyMap<string, FlagRole> = new Map<string, FlagRole>([
  ["--allowedTools", "allowed"],
  ["--allowed-tools", "allowed"],
  ["--disallowedTools", "disallowed"],
  ["--disallowed-tools", "disallowed"],
  ["--tools", "tools"],
  ["--mcp-config", "mcp-config"],
  ["--add-dir", "add-dir"],
]);
/** Flags that take exactly one value and do not widen the tool surface. */
const VALUE_FLAGS = new Set([
  "--model",
  "--output-format",
  "--input-format",
  "--max-turns",
  "--append-system-prompt",
  "--system-prompt",
  "--session-id",
  "--permission-mode",
  "--setting-sources",
]);
/** Boolean flags that do not widen the tool surface. */
const BOOL_FLAGS = new Set(["-p", "--print", "--strict-mcp-config", "--verbose"]);
/** Boolean flags that widen the surface past `--allowedTools`. */
const WIDENING_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
]);
// `default` is not a choice in Claude Code 2.1.332 (#497 verifier nit 1); only `dontAsk`.
const SAFE_PERMISSION_MODES = new Set(["dontAsk"]);

/** Claude Code's (commander's) test for an argv entry that is an option, not a value. */
function looksLikeOption(entry: string): boolean {
  return entry.length > 1 && entry.startsWith("-");
}

function splitTools(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
}

/** Everything the audit reads from an agent argv. */
export interface ParsedAgentArgv {
  /** `--allowedTools` values: the audited allow-list. */
  readonly granted: string[];
  /** `--disallowedTools` values. */
  readonly disallowed: string[];
  /**
   * The built-in tools `--tools` makes available: `"all"` when the flag is absent or names
   * `default` (Claude Code then enables its whole default set), else the named tools
   * (`--tools ""` is none).
   */
  readonly builtins: "all" | string[];
  /** `--mcp-config` values (files or JSON strings). */
  readonly mcpConfigs: string[];
  /** True when the bare `--strict-mcp-config` flag was given. */
  readonly strictMcpConfig: boolean;
  readonly violations: SurfaceViolation[];
}

/**
 * Parse an agent argv the way Claude Code's parser does, failing closed on anything the
 * audit cannot place. Every entry is a known flag, a value of the flag before it, or a
 * positional entry (the prompt); an unrecognised flag is a violation. A value that itself
 * looks like a flag is also a violation: Claude Code would take it as the value, a reader
 * might take it as a flag, and the audit refuses to pick one.
 */
export function parseAgentArgv(argv: readonly string[]): ParsedAgentArgv {
  const granted: string[] = [];
  const disallowed: string[] = [];
  let toolsGiven = false;
  let toolsDefault = false;
  const builtins: string[] = [];
  const mcpConfigs: string[] = [];
  let strictMcpConfig = false;
  const violations: SurfaceViolation[] = [];
  const flagViolation = (flag: string, detail: string) =>
    violations.push({ tool: flag, reach: "unknown", detail });
  const record = (flag: string, role: FlagRole, value: string) => {
    if (looksLikeOption(value))
      flagViolation(flag, `value ${JSON.stringify(value)} looks like a flag: fail closed`);
    if (role === "allowed") granted.push(...splitTools(value));
    else if (role === "disallowed") disallowed.push(...splitTools(value));
    else if (role === "tools") {
      toolsGiven = true;
      for (const tool of splitTools(value)) {
        if (tool === "default") toolsDefault = true;
        else builtins.push(tool);
      }
    } else if (role === "mcp-config") mcpConfigs.push(value);
    else if (flag === "--permission-mode" && !SAFE_PERMISSION_MODES.has(value))
      flagViolation(flag, `permission mode ${JSON.stringify(value)} can grant unlisted tools`);
  };
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index] ?? "";
    if (raw === "--") {
      // Claude Code reads everything after `--` as positional; the audit refuses it outright.
      flagViolation(raw, "end-of-options marker: fail closed");
      break;
    }
    if (!looksLikeOption(raw)) continue; // A positional entry (the prompt) is not a grant.
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const variadic = VARIADIC_FLAGS.get(flag);
    const role: FlagRole | undefined = variadic ?? (VALUE_FLAGS.has(flag) ? "other" : undefined);
    if (flag === "--add-dir")
      flagViolation(flag, "widens the agent's tools past --allowedTools: fail closed");
    if (role !== undefined) {
      if (inline !== undefined) {
        // `--flag=value` carries one value; Claude Code reads no more values after it.
        record(flag, role, inline);
        continue;
      }
      // The first value is the next entry, whatever it looks like (as in Claude Code).
      if (index + 1 >= argv.length) {
        flagViolation(flag, "flag without a value");
        continue;
      }
      index += 1;
      record(flag, role, argv[index] ?? "");
      if (variadic !== undefined)
        while (index + 1 < argv.length && !looksLikeOption(argv[index + 1] ?? "")) {
          index += 1;
          record(flag, role, argv[index] ?? "");
        }
    } else if (WIDENING_FLAGS.has(flag)) {
      flagViolation(flag, "widens the agent's tools past --allowedTools: fail closed");
    } else if (BOOL_FLAGS.has(flag) && inline === undefined) {
      // A boolean flag takes no value; `--flag=x` is refused below (Claude Code rejects it).
      if (flag === "--strict-mcp-config") strictMcpConfig = true;
    } else {
      flagViolation(flag, "unrecognised agent flag: fail closed");
    }
  }
  return {
    granted,
    disallowed,
    builtins: !toolsGiven || toolsDefault ? "all" : builtins,
    mcpConfigs,
    strictMcpConfig,
    violations,
  };
}

/**
 * Read the granted tool list from an agent argv (see `parseAgentArgv`). Every argv entry
 * must be a known flag or its value; anything else is a violation, so an unrecognised
 * widening flag fails closed.
 */
export function grantedToolsFromArgv(argv: readonly string[]): {
  granted: string[];
  violations: SurfaceViolation[];
} {
  const { granted, violations } = parseAgentArgv(argv);
  return { granted, violations };
}

/** True when a `--disallowedTools` rule removes the whole of `tool` (not just some uses). */
function whollyDisallowed(tool: string, disallowed: readonly string[]): boolean {
  if (disallowed.includes(tool)) return true;
  const mcp = /^mcp__(.+?)__/.exec(tool);
  return (
    mcp !== null &&
    (disallowed.includes(`mcp__${mcp[1]}`) || disallowed.includes(`mcp__${mcp[1]}__*`))
  );
}

/**
 * The MCP servers the agent can load must be exactly `plan.mcpServers`: `--strict-mcp-config`
 * (no user / project / local servers) and one `--mcp-config` equal to `plan.mcpConfigPath`.
 * String equality on an absolute, normalised path: inline JSON, a relative path, a path with
 * `..` and a symlink at another path all differ from it and are refused.
 */
function mcpConfigViolations(
  plan: AgentLaunchPlan,
  mcpConfigs: readonly string[],
  strict: boolean,
): SurfaceViolation[] {
  const out: SurfaceViolation[] = [];
  const violation = (tool: string, detail: string) => out.push({ tool, reach: "unknown", detail });
  if (!strict)
    violation(
      "--strict-mcp-config",
      "missing: without it Claude Code also loads user, project and local MCP servers",
    );
  const planPath = typeof plan.mcpConfigPath === "string" ? plan.mcpConfigPath : "";
  const planPathOk =
    planPath.length > 0 && isAbsolute(planPath) && normalize(planPath) === planPath;
  if (!planPathOk)
    violation(
      "--mcp-config",
      "the launch plan's mcpConfigPath is not an absolute, normalised path: fail closed",
    );
  if (mcpConfigs.length !== 1)
    violation(
      "--mcp-config",
      `${mcpConfigs.length} MCP configs: exactly one, the plan's mcpConfigPath, must load`,
    );
  for (const value of mcpConfigs)
    if (value !== planPath)
      violation(
        "--mcp-config",
        value.trimStart().startsWith("{")
          ? "inline JSON MCP config: only the plan's mcpConfigPath may load"
          : "MCP config is not the plan's mcpConfigPath: only that file may load",
      );
  return out;
}

/** Harness-issued UNO pipe names (`UNO_PIPE_NAME` in src/state/linux/uno.ts). */
const STATE_PIPE = /^myco-state-[a-z0-9-]{8,64}$/;

/**
 * A `myco-state` server in the plan must be bound to this trial: run id pinned, a
 * harness-issued pipe, no other env keys, args ending in `mcp`. Fail closed on any other.
 */
function stateBindingViolations(plan: AgentLaunchPlan, runId: string): SurfaceViolation[] {
  if (!Object.hasOwn(plan.mcpServers, STATE_SERVER_NAME)) return [];
  const server = plan.mcpServers[STATE_SERVER_NAME] as McpServerLaunch;
  const out: SurfaceViolation[] = [];
  const violation = (detail: string) =>
    out.push({ tool: `mcp__${STATE_SERVER_NAME}`, reach: "unknown", detail });
  const env = server.env ?? {};
  for (const key of Object.keys(env))
    if (!MYCO_STATE_ENV_KEYS.includes(key))
      violation(`environment key ${JSON.stringify(key)} is not a myco-state binding key`);
  const pinned = Object.hasOwn(env, MYCO_STATE_RUN_ENV) ? env[MYCO_STATE_RUN_ENV] : "";
  if (runId.length === 0 || pinned !== runId)
    violation(`${MYCO_STATE_RUN_ENV} does not pin the server to this trial's run id`);
  const pipe = Object.hasOwn(env, MYCO_STATE_PIPE_ENV) ? (env[MYCO_STATE_PIPE_ENV] ?? "") : "";
  if (!STATE_PIPE.test(pipe))
    violation(`${MYCO_STATE_PIPE_ENV} is not a harness-issued myco-state pipe name`);
  if (server.args.at(-1) !== "mcp" || server.args.some((a) => looksLikeOption(a)))
    violation("server args must end in `mcp` and carry no flags");
  return out;
}

/**
 * Audit a launch plan. `ok` is true only when the argv grants nothing outside guest / gate /
 * agent-local reach, no flag widens it, the agent can load only `plan.mcpServers` (via
 * `--strict-mcp-config` and the one `--mcp-config plan.mcpConfigPath`), and every one of
 * those servers is classified.
 */
export function auditAgentLaunch(plan: AgentLaunchPlan, opts: LaunchAuditOptions): LaunchAudit {
  const { granted, disallowed, builtins, mcpConfigs, strictMcpConfig, violations } = parseAgentArgv(
    plan.argv,
  );
  violations.push(...mcpConfigViolations(plan, mcpConfigs, strictMcpConfig));
  const servers: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {
    ...MCP_SERVERS,
    ...opts.extraServers,
  };
  const serverNames = Object.keys(plan.mcpServers);
  violations.push(...stateBindingViolations(plan, opts.runId));
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
  // The effective surface: the built-ins `--tools` enables plus the granted MCP tools,
  // minus what `--disallowedTools` removes whole. It must not exceed the audited grant.
  const grantedSet = new Set(granted);
  let effectiveBuiltins: string[] = [];
  if (builtins === "all")
    violations.push({
      tool: "--tools",
      reach: "unknown",
      detail:
        'built-in tools not restricted: without --tools (or with "default") Claude Code ' +
        'enables its default built-ins, and read-only ones run without approval; pass --tools "" ' +
        "or name only granted tools",
    });
  else {
    effectiveBuiltins = [...new Set(builtins)].filter((t) => !whollyDisallowed(t, disallowed));
    for (const tool of effectiveBuiltins)
      if (!grantedSet.has(tool))
        violations.push({
          tool,
          reach: classifyTool(tool)?.reach ?? "unknown",
          detail:
            "enabled by --tools but not in --allowedTools: the effective surface exceeds the audited one",
        });
  }
  const effective = [
    ...effectiveBuiltins.filter((t) => !looksLikeOption(t)),
    ...granted.filter(
      (t) =>
        serverNames.includes(/^mcp__(.+?)__/.exec(t)?.[1] ?? "") &&
        !whollyDisallowed(t, disallowed),
    ),
  ];
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
    effective: builtins === "all" ? "unbounded" : effective,
    mycoRtSessionPinned,
  };
}
