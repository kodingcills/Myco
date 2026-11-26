/**
 * TIF-274 prerequisite (#470 F2): the launch audit reads the agent's real argv and MCP
 * server environment, and fails closed on anything it cannot classify.
 */
import { describe, expect, it } from "vitest";
import {
  type AgentLaunchPlan,
  auditAgentLaunch,
  grantedToolsFromArgv,
} from "../../src/integrity/launch.ts";
import { rtSessionIdFor, type ToolClass } from "../../src/integrity/surface.ts";

const GATE: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {
  "myco-gate": { myco_gate_check: { reach: "gate", note: "gate" } },
};
const RUN = "trial-7";
const SERVERS: AgentLaunchPlan["mcpServers"] = {
  "myco-rt": { command: "myco-rt-mcp", args: [], env: { MYCO_RT_SESSION_ID: rtSessionIdFor(RUN) } },
  "myco-gate": { command: "myco-gate", args: ["mcp"], env: {} },
};
const TOOLS = "mcp__myco-rt__create,mcp__myco-rt__act,mcp__myco-gate__myco_gate_check,TodoWrite";

function audit(argv: string[], servers: AgentLaunchPlan["mcpServers"] = SERVERS) {
  return auditAgentLaunch({ argv, mcpServers: servers }, { runId: RUN, extraServers: GATE });
}

describe("grantedToolsFromArgv", () => {
  it.each([
    [["--allowedTools", TOOLS]],
    [["--allowed-tools", TOOLS]],
    [[`--allowedTools=${TOOLS}`]],
    [["--allowedTools", ...TOOLS.split(",")]],
    [["--allowedTools", TOOLS.replaceAll(",", " ")]],
  ])("reads every spelling of the allowed-tools flag: %j", (argv) => {
    const { granted, violations } = grantedToolsFromArgv(["-p", "prompt", ...argv]);
    expect(violations).toEqual([]);
    expect(granted).toEqual(TOOLS.split(","));
  });

  it("collects repeated flags", () => {
    const { granted } = grantedToolsFromArgv(["--allowedTools", "Bash", "--allowedTools", "Read"]);
    expect(granted).toEqual(["Bash", "Read"]);
  });
});

describe("auditAgentLaunch", () => {
  it("passes the gated plan, pinned from the server's real env", () => {
    const a = audit([
      "-p",
      "do it",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      TOOLS,
    ]);
    expect(a.violations).toEqual([]);
    expect(a.ok).toBe(true);
    expect(a.mycoRtSessionPinned).toBe(true);
    expect(a.hostRoots).toEqual([]);
  });

  it.each([["Bash"], ["Read"], ["WebFetch"], ["mcp__myco-rt__evidence"], ["mcp__myco-rt__nope"]])(
    "a granted %s fails",
    (tool) => {
      const a = audit(["--allowedTools", `${TOOLS},${tool}`]);
      expect(a.ok).toBe(false);
      expect(a.violations.map((v) => v.tool)).toEqual([tool]);
    },
  );

  it.each([
    [["--dangerously-skip-permissions"]],
    [["--allow-dangerously-skip-permissions"]],
    [["--permission-mode", "bypassPermissions"]],
    [["--permission-mode", "acceptEdits"]],
    [["--permission-mode=bypassPermissions"]],
    [["--add-dir", "/"]],
    [["--some-future-flag"]],
    [["--model"]],
  ])("a widening or unknown flag fails closed: %j", (flags) => {
    const a = audit(["--allowedTools", TOOLS, ...flags]);
    expect(a.ok).toBe(false);
    expect(a.hostRoots).toEqual(["/"]);
  });

  it("an MCP server the audit cannot classify fails", () => {
    const a = audit(["--allowedTools", TOOLS], {
      ...SERVERS,
      "host-files": { command: "x", args: [], env: {} },
    });
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.tool)).toEqual(["mcp__host-files"]);
  });

  it("a granted tool on a server the plan does not start fails", () => {
    const { "myco-gate": _gate, ...noGate } = SERVERS;
    const a = audit(["--allowedTools", TOOLS], noGate);
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.tool)).toEqual(["mcp__myco-gate__myco_gate_check"]);
  });

  it.each([
    ["missing", {}],
    ["empty (#470 N3)", { MYCO_RT_SESSION_ID: "" }],
    ["another trial's", { MYCO_RT_SESSION_ID: rtSessionIdFor("trial-6") }],
    ["the bare run id", { MYCO_RT_SESSION_ID: RUN }],
  ])("a %s pin leaves create rejected", (_, env) => {
    const a = audit(["--allowedTools", TOOLS], {
      ...SERVERS,
      "myco-rt": { command: "myco-rt-mcp", args: [], env },
    });
    expect(a.mycoRtSessionPinned).toBe(false);
    expect(a.violations.map((v) => v.tool)).toEqual(["mcp__myco-rt__create"]);
  });
});
