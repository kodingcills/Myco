/**
 * Track O, #605 item 1: the `myco-rt` MCP surface is kept out of policed trials.
 *
 * `mcp__myco-rt__act` (launch with any arguments, click, type), `launch_process` and
 * `write_file` reach the guest with no policed wrapper in between: Claude Code calls them
 * directly. `startPolicy` must refuse a trial that grants any of them (or any tool off the closed
 * `POLICED_GRANTABLE_TOOLS`), before it reads anything. If that check is removed, the
 * "bypass" cases below start a policed trial whose agent holds an unpoliced acting tool, and
 * fail.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_TOOL, SERVER_NAME } from "../../src/gate/mcp-server.ts";
import {
  classifyTool,
  MYCO_RT_MCP_TOOLS,
  STATE_SERVER_CLASS,
  STATE_SERVER_NAME,
} from "../../src/integrity/surface.ts";
import { startPolicy } from "../../src/policy/guard.ts";
import {
  MAX_GRANTED_TOOLS,
  POLICED_GRANTABLE_TOOLS,
  POLICED_RT_READ_TOOLS,
} from "../../src/policy/surface.ts";
import { STATE_TOOL_NAMES } from "../../src/state/api.ts";
import {
  auditCapabilityArmLaunch,
  CAPABILITY_ARM_TOOLS,
  CAPABILITY_ARMS,
  capabilityArmPlan,
  GATE_CLASS,
} from "../../src/state/arms.ts";
import { ALL_RULES, fixture, POLICED_ARM_TOOLS, writeConfig } from "./helpers.ts";

const RT_TOOLS = Object.keys(MYCO_RT_MCP_TOOLS).map((t) => `mcp__myco-rt__${t}`);
const RT_ACTING = RT_TOOLS.filter((t) => !(POLICED_RT_READ_TOOLS as readonly string[]).includes(t));

function start(grantedTools: unknown, configPath?: string) {
  const f = fixture();
  return startPolicy({
    configPath: configPath ?? writeConfig(f, ALL_RULES),
    scope: { originalDocument: f.original, documentDir: f.docDir },
    screenSensor: () => false,
    grantedTools: grantedTools as readonly string[],
  });
}

describe("policed trials grant no unpoliced acting tool (#605 item 1)", () => {
  it("the grantable list is closed and pinned", () => {
    expect([...POLICED_GRANTABLE_TOOLS]).toEqual([
      "mcp__myco-rt__observe",
      "mcp__myco-rt__read_file",
      "mcp__myco-gate__myco_gate_check",
      "mcp__myco-state__state_list_sheets",
      "mcp__myco-state__state_read_range",
      "mcp__myco-state__state_document_status",
      "mcp__myco-state__state_ui_tree",
      "TodoWrite",
    ]);
    expect(Object.isFrozen(POLICED_GRANTABLE_TOOLS)).toBe(true);
  });

  it("the names spelled in src/policy match the real tables (no policy import of them)", () => {
    for (const t of POLICED_RT_READ_TOOLS) expect(RT_TOOLS).toContain(t);
    expect(POLICED_GRANTABLE_TOOLS).toContain(`mcp__${SERVER_NAME}__${GATE_TOOL}`);
    for (const t of STATE_TOOL_NAMES)
      expect(POLICED_GRANTABLE_TOOLS).toContain(`mcp__${STATE_SERVER_NAME}__${t}`);
  });

  it("every grantable tool is classified, and none reaches the host", () => {
    const extraServers = { ...GATE_CLASS, ...STATE_SERVER_CLASS };
    for (const t of POLICED_GRANTABLE_TOOLS) {
      const cls = classifyTool(t, { extraServers, mycoRtSessionPinned: true });
      expect(cls, t).toBeDefined();
      expect(["guest", "gate", "app-state", "agent-local"], t).toContain(cls?.reach);
    }
  });

  it("the only myco-rt tools granted are the two reads: act, launch_process, write_file and the rest are not", () => {
    expect(RT_ACTING).toEqual(
      expect.arrayContaining([
        "mcp__myco-rt__act",
        "mcp__myco-rt__launch_process",
        "mcp__myco-rt__write_file",
        "mcp__myco-rt__relaunch_process",
      ]),
    );
    expect(RT_ACTING).toHaveLength(RT_TOOLS.length - 2);
    for (const t of RT_ACTING) expect(POLICED_GRANTABLE_TOOLS, t).not.toContain(t);
  });

  it("bypass: a policed trial whose agent also holds a raw myco-rt acting tool refuses to start", () => {
    // The same trial starts without the acting tool, so the refusal is caused by it alone.
    expect(start(POLICED_ARM_TOOLS).ok).toBe(true);
    for (const t of RT_ACTING)
      expect(start([...POLICED_ARM_TOOLS, t]), t).toEqual({
        ok: false,
        code: "POLICY_UNPOLICED_SURFACE",
      });
  });

  it("bypass: no capability arm as defined today can be a policed arm (each grants raw act)", () => {
    for (const arm of CAPABILITY_ARMS) {
      expect(CAPABILITY_ARM_TOOLS[arm]).toContain("mcp__myco-rt__act");
      expect(start(CAPABILITY_ARM_TOOLS[arm]), arm).toEqual({
        ok: false,
        code: "POLICY_UNPOLICED_SURFACE",
      });
    }
  });

  it("bypass: a real capability arm launch plan's audited effective surface is refused", () => {
    const runId = "run-cap-o-605";
    const trialDir = `/srv/myco/trials/${runId}`;
    for (const arm of CAPABILITY_ARMS) {
      const plan = capabilityArmPlan({
        arm,
        runId,
        instruction: "Set record EMP-0007, column name, to REVISED and save.",
        configDir: trialDir,
        stateServer: { command: "npx", args: ["tsx", "/opt/myco/scripts/myco-state.ts", "mcp"] },
        statePipe: "myco-state-0123456789abcdef-a1b2c3d4e5f6",
        stateDocUid: "1",
        withheld: ["/srv/myco/vault", trialDir],
      });
      const audit = auditCapabilityArmLaunch(plan, { arm, runId, trialDir });
      expect(audit.violations, arm).toEqual([]);
      const effective = audit.launch.effective;
      expect(Array.isArray(effective), arm).toBe(true);
      expect(start(effective), arm).toEqual({
        ok: false,
        code: "POLICY_UNPOLICED_SURFACE",
      });
    }
    // An unbounded surface (no `--tools`) is not a list: refused.
    expect(start("unbounded")).toEqual({ ok: false, code: "POLICY_UNPOLICED_SURFACE" });
  });

  it("fails closed: missing, malformed, unknown, host-reaching or oversized grants are refused", () => {
    const refused = { ok: false, code: "POLICY_UNPOLICED_SURFACE" };
    expect(start(undefined)).toEqual(refused);
    expect(start(null)).toEqual(refused);
    expect(start("mcp__myco-rt__observe")).toEqual(refused);
    expect(start([1])).toEqual(refused);
    expect(start(["mcp__myco-rt__observe", "Bash"])).toEqual(refused);
    expect(start(["mcp__myco-rt__observe", "mcp__other__act"])).toEqual(refused);
    expect(start(["mcp__myco-rt__OBSERVE"])).toEqual(refused);
    expect(start(Array(MAX_GRANTED_TOOLS + 1).fill("TodoWrite"))).toEqual(refused);
    expect(start(Array(MAX_GRANTED_TOOLS).fill("TodoWrite")).ok).toBe(true);
    expect(start([]).ok).toBe(true);
  });

  it("is checked before the config is read: an acting grant with no config is still this refusal", () => {
    const f = fixture();
    expect(start(["mcp__myco-rt__act"], join(f.host, "absent.json"))).toEqual({
      ok: false,
      code: "POLICY_UNPOLICED_SURFACE",
    });
    expect(start(POLICED_ARM_TOOLS, join(f.host, "absent.json"))).toEqual({
      ok: false,
      code: "POLICY_CONFIG_MISSING",
    });
  });
});
