/**
 * #732: the R1 / A/B live agent gets action tools, at parity with the `hcu+shell` arm, and the
 * gate stays a separate, verify-only tool. Everything runs on fakes: no VM, no SSH, no `claude`.
 *
 *  - the launch plan (argv and MCP config) grants the actuator's four action tools AND the gate
 *    check, keeps built-in tools off, and adds no shell, host-file or API-key path;
 *  - the gate tool is distinct from every action tool, and the actuator takes no trial, run,
 *    claim or path argument;
 *  - the actuator is the `hcu+shell` arm's desktop reach: same HCU guest command, same pixel
 *    vocabulary sent through the arm's own HCU client, same 30-action budget; codes only.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Screenshot } from "../../src/baseline/c1.ts";
import { connectHcuGui } from "../../src/baseline/hcu-shell/hcu-gui.ts";
import type { HcuGui } from "../../src/baseline/hcu-shell/trial.ts";
import { STEP_BUDGET } from "../../src/baseline/hcu-shell/trial.ts";
import { DEFAULT_HCU_GUEST_COMMAND } from "../../src/baseline/hcu-shell-live/live-vm.ts";
import { GATE_SERVER_CLASS } from "../../src/gate/gated-trial.ts";
import { GATE_TOOL, toolDefinitions as gateTools } from "../../src/gate/mcp-server.ts";
import { auditAgentLaunch, mcpConfigJson, parseAgentArgv } from "../../src/integrity/launch.ts";
import {
  CLAUDE_CODE_BUILTINS,
  classifyTool,
  MCP_SERVERS,
  MYCO_HCU_MCP_TOOLS,
} from "../../src/integrity/surface.ts";
import { API_CREDENTIAL_NAMES } from "../../src/pilot/claude-cli.ts";
import {
  ACTUATOR_GRANTS,
  ACTUATOR_SERVER_TEMPLATE,
  ARGV_TEMPLATE,
  CHILD_ENV_ALLOWLIST,
  GATE_GRANT,
  type PilotConfig,
} from "../../src/pilot/config.ts";
import {
  ACTION_BUDGET,
  ACTION_TOOLS,
  ACTUATOR_CODES,
  ACTUATOR_SERVER_NAME,
  ACTUATOR_TOOLS,
  actuatorToolDefinitions,
  createActuator,
  HCU_GUEST_COMMAND,
  serveActuatorStdio,
} from "../../src/pilot/hcu-actuator.ts";
import { trialLaunchPlan } from "../../src/pilot/launch.ts";
import { config, PUBLISHED, ROOT } from "./helpers.ts";

const SHOT: Screenshot = { mimeType: "image/png", data: "iVBORw0KGgo=" };

function fakeGui(outcome = "delivered") {
  const executed: unknown[] = [];
  let shots = 0;
  const gui: HcuGui = {
    async screenshot() {
      shots += 1;
      return SHOT;
    },
    async execute(action) {
      executed.push(action);
      return { outcome: outcome as "delivered", deliveryMode: "foreground", escalated: false };
    },
  };
  return { gui, executed, shots: () => shots };
}

let nextId = 0;
async function call(
  actuator: ReturnType<typeof createActuator>,
  name: string,
  args?: unknown,
): Promise<Record<string, unknown>> {
  const id = ++nextId;
  const line = await actuator.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: args === undefined ? { name } : { name, arguments: args },
    }),
  );
  const parsed = JSON.parse(line ?? "null");
  expect(parsed.id).toBe(id);
  return parsed;
}

const resultBody = (r: Record<string, unknown>) =>
  (r.result as { structuredContent?: Record<string, unknown> }).structuredContent;

function plan(c: PilotConfig = config()) {
  const task = PUBLISHED.find((t) => t.taskId === "fc-v1-001");
  if (task === undefined) throw new Error("fixture");
  const runId = "r1p-fc-v1-001-a1";
  return trialLaunchPlan(c, task, { runId, trialKey: runId }, `/tmp/pilot/${runId}`, ROOT);
}

describe("#732: the launch plan grants action tools and the gate", () => {
  it("argv grants exactly the four actuator tools and the gate check; built-ins stay off", () => {
    const p = plan();
    const parsed = parseAgentArgv(p.argv);
    expect(parsed.violations).toEqual([]);
    expect(parsed.granted).toEqual([
      "mcp__myco-hcu__screenshot",
      "mcp__myco-hcu__click",
      "mcp__myco-hcu__type_text",
      "mcp__myco-hcu__press_key",
      "mcp__myco-gate__myco_gate_check",
    ]);
    expect(parsed.builtins).toEqual([]);
    expect(p.argv[p.argv.indexOf("--tools") + 1]).toBe("");
    expect(p.argv[p.argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(parsed.strictMcpConfig).toBe(true);
  });

  it("the MCP config the transport writes holds the gate server and the actuator server", () => {
    const p = plan();
    const servers = JSON.parse(mcpConfigJson(p)).mcpServers as Record<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    >;
    expect(Object.keys(servers)).toEqual(["myco-gate", ACTUATOR_SERVER_NAME]);
    const act = servers[ACTUATOR_SERVER_NAME];
    expect(act?.command).toBe("node");
    expect(act?.args).toEqual([
      "--import",
      "tsx",
      `${ROOT}/scripts/myco-hcu.ts`,
      "mcp",
      "--hcu-command",
      HCU_GUEST_COMMAND,
    ]);
    expect(act?.env).toEqual({});
    // The gate server is unchanged: bound to this one task and run.
    const gate = servers["myco-gate"]?.args ?? [];
    expect(gate[gate.indexOf("--task") + 1]).toBe("fc-v1-001");
    expect(gate[gate.indexOf("--run") + 1]).toBe("r1p-fc-v1-001-a1");
  });

  it("the plan passes the launch audit, and every granted actuator tool is guest-only", () => {
    const p = plan();
    const audit = auditAgentLaunch(p, {
      runId: "r1p-fc-v1-001-a1",
      extraServers: GATE_SERVER_CLASS,
    });
    expect(audit.ok, JSON.stringify(audit.violations)).toBe(true);
    expect(audit.effective).toEqual([...ACTUATOR_GRANTS, GATE_GRANT]);
    expect(audit.hostRoots).toEqual([]);
    for (const grant of ACTUATOR_GRANTS) expect(classifyTool(grant)?.reach).toBe("guest");
    expect(classifyTool(GATE_GRANT, { extraServers: GATE_SERVER_CLASS })?.reach).toBe("gate");
  });

  it("no shell, host-file, network or API-key path is introduced", () => {
    const p = plan();
    const granted = parseAgentArgv(p.argv).granted;
    for (const builtin of Object.keys(CLAUDE_CODE_BUILTINS)) expect(granted).not.toContain(builtin);
    for (const flag of ["--dangerously-skip-permissions", "--add-dir", "--verbose"])
      expect(p.argv).not.toContain(flag);
    // The agent's environment allowlist is unchanged and names no API-path variable.
    expect(config().childEnvAllowlist).toEqual(CHILD_ENV_ALLOWLIST);
    for (const name of API_CREDENTIAL_NAMES) {
      expect(config().childEnvAllowlist).not.toContain(name);
      expect(JSON.stringify(ACTUATOR_SERVER_TEMPLATE)).not.toContain(name);
    }
    // The actuator's own CLI reads no key and no API variable, and spawns only `ssh`.
    const cli = readFileSync(join(ROOT, "scripts/myco-hcu.ts"), "utf8");
    for (const word of ["ANTHROPIC", "secret-file", "process.env", "readFileSync", "api.anthropic"])
      expect(cli).not.toContain(word);
    expect([...cli.matchAll(/spawn\("([^"]+)"/g)].map((m) => m[1])).toEqual(["ssh"]);
  });

  it("a launch plan reverted to gate-only is caught (mutant: drop the action grants)", () => {
    const gateOnly: PilotConfig = {
      ...config(),
      argvTemplate: ARGV_TEMPLATE.filter((a) => !ACTUATOR_GRANTS.includes(a)),
    };
    const granted = parseAgentArgv(plan(gateOnly).argv).granted;
    expect(granted).toEqual([GATE_GRANT]);
    expect(ACTUATOR_GRANTS.every((g) => granted.includes(g))).toBe(false);
    // The reviewed argv is not that plan.
    expect(ARGV_TEMPLATE.filter((a) => ACTUATOR_GRANTS.includes(a))).toEqual([...ACTUATOR_GRANTS]);
  });
});

describe("#732: the gate stays separate from the actuator", () => {
  it("the gate tool is distinct from every action tool", () => {
    const gateNames = (gateTools() as { name: string }[]).map((t) => t.name);
    expect(gateNames).toEqual([GATE_TOOL]);
    for (const tool of ACTUATOR_TOOLS) expect(gateNames).not.toContain(tool);
    expect(ACTUATOR_TOOLS).not.toContain(GATE_TOOL);
    expect(ACTUATOR_GRANTS).not.toContain(GATE_GRANT);
    expect(ACTUATOR_SERVER_NAME).not.toBe("myco-gate");
    expect(Object.keys(MCP_SERVERS[ACTUATOR_SERVER_NAME] ?? {})).not.toContain(GATE_TOOL);
  });

  it("the actuator takes no trial, run, claim, evidence or path argument", () => {
    for (const tool of actuatorToolDefinitions() as {
      inputSchema: { properties: Record<string, unknown>; additionalProperties: boolean };
    }[]) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const key of Object.keys(tool.inputSchema.properties))
        expect(["x", "y", "text", "key"]).toContain(key);
    }
    expect(JSON.stringify(ACTUATOR_SERVER_TEMPLATE)).not.toMatch(/TASK_ID|RUN_ID|TRIAL_DIR/);
  });

  it("the actuator refuses the gate tool by name", async () => {
    const { gui, executed } = fakeGui();
    const r = await call(
      createActuator(async () => gui),
      GATE_TOOL,
      {},
    );
    expect(r.error).toEqual({ code: -32602, message: ACTUATOR_CODES.unknownTool });
    expect(executed).toEqual([]);
  });
});

describe("#732: actuator parity with the hcu+shell arm", () => {
  it("serves exactly the tools the surface classifies, and the arm's command and budget", async () => {
    const a = createActuator(async () => fakeGui().gui);
    const list = JSON.parse(
      (await a.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))) ?? "",
    );
    const names = (list.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual([...ACTUATOR_TOOLS]);
    expect(Object.keys(MYCO_HCU_MCP_TOOLS)).toEqual(names);
    expect(ACTUATOR_GRANTS).toEqual(names.map((n) => `mcp__myco-hcu__${n}`));
    expect(HCU_GUEST_COMMAND).toBe(DEFAULT_HCU_GUEST_COMMAND);
    expect(ACTION_BUDGET).toBe(STEP_BUDGET);
    expect([...ACTION_TOOLS]).toEqual(["click", "type_text", "press_key"]);
  });

  it("forwards each action unchanged to the arm's HCU client, one action per call", async () => {
    const { gui, executed } = fakeGui();
    const a = createActuator(async () => gui);
    const r1 = await call(a, "click", { x: 10, y: 20 });
    const r2 = await call(a, "type_text", { x: 1, y: 2, text: "REVISED-1" });
    const r3 = await call(a, "press_key", { x: 0, y: 0, key: "ctrl+s" });
    expect(executed).toEqual([
      { tool: "click", arguments: { x: 10, y: 20 } },
      { tool: "type_text", arguments: { x: 1, y: 2, text: "REVISED-1" } },
      { tool: "press_key", arguments: { x: 0, y: 0, key: "ctrl+s" } },
    ]);
    expect(resultBody(r1)).toEqual({ outcome: "delivered", stepsLeft: 29 });
    expect(resultBody(r3)).toEqual({ outcome: "delivered", stepsLeft: 27 });
    expect((r2.result as { isError: boolean }).isError).toBe(false);
    expect(a.spent()).toBe(3);
  });

  it("sends through the real hcu+shell client: one HCU GUI batch per action", async () => {
    const batches: unknown[] = [];
    const mcp = {
      async request(method: string, params?: unknown) {
        if (method === "initialize") return { protocolVersion: "2025-06-18" };
        if (method === "tools/list") return { tools: [{ name: "GUI" }] };
        batches.push((params as { arguments: { actions: unknown } }).arguments.actions);
        return { content: [{ type: "text", text: '{"ok":true}' }] };
      },
      async notify() {},
    };
    const a = createActuator(() => connectHcuGui(mcp as never));
    const r = await call(a, "type_text", { x: 5, y: 6, text: "hi" });
    expect(resultBody(r)).toEqual({ outcome: "delivered", stepsLeft: ACTION_BUDGET - 1 });
    expect(batches).toEqual([
      [
        { type: "click", x: 5, y: 6 },
        { type: "type", text: "hi" },
      ],
    ]);
  });

  it("spends at most ACTION_BUDGET actions, then refuses every action with a code", async () => {
    const { gui, executed } = fakeGui();
    const a = createActuator(async () => gui);
    for (let i = 0; i < ACTION_BUDGET; i++) await call(a, "click", { x: i, y: i });
    const over = await call(a, "click", { x: 1, y: 1 });
    expect(resultBody(over)).toEqual({ code: ACTUATOR_CODES.budget });
    expect((over.result as { isError: boolean }).isError).toBe(true);
    expect(executed).toHaveLength(ACTION_BUDGET);
    // A screenshot spends no action and still works.
    const shot = await call(a, "screenshot");
    expect((shot.result as { content: unknown[] }).content).toEqual([
      { type: "image", data: SHOT.data, mimeType: SHOT.mimeType },
    ]);
    expect(a.spent()).toBe(ACTION_BUDGET);
  });

  it("refuses a malformed action before sending it, without spending the budget", async () => {
    const { gui, executed } = fakeGui();
    const a = createActuator(async () => gui);
    for (const [name, args] of [
      ["click", { x: -1, y: 2 }],
      ["click", { x: 1, y: 2, extra: true }],
      ["type_text", { x: 1, y: 2, text: "x".repeat(257) }],
      ["press_key", { x: 1, y: 2, key: "ctrl s; rm" }],
      ["press_key", { key: "enter" }],
      ["screenshot", { path: "C:\\myco" }],
    ] as const) {
      const r = await call(a, name, args);
      expect(resultBody(r)).toEqual({ code: ACTUATOR_CODES.invalid });
    }
    expect(executed).toEqual([]);
    expect(a.spent()).toBe(0);
  });

  it("codes only: an unreachable HCU or a failed send never leaks HCU text", async () => {
    const down = createActuator(async () => {
      throw new Error("ssh: connect to host myco-win11: secret detail");
    });
    const r = await call(down, "click", { x: 1, y: 1 });
    expect(resultBody(r)).toEqual({ code: ACTUATOR_CODES.unavailable });
    expect(JSON.stringify(r)).not.toContain("secret detail");
    expect(resultBody(await call(down, "screenshot"))).toEqual({
      code: ACTUATOR_CODES.unavailable,
    });
    expect(down.spent()).toBe(0);

    const throwing = createActuator(async () => ({
      screenshot: async () => SHOT,
      execute: async () => {
        throw new Error("HCU internal text");
      },
    }));
    const s = await call(throwing, "click", { x: 1, y: 1 });
    expect(resultBody(s)).toEqual({ outcome: "delivered-stalled", stepsLeft: ACTION_BUDGET - 1 });
    expect(JSON.stringify(s)).not.toContain("HCU internal text");
  });

  it("speaks MCP over stdio: initialize, tools/call and a notification", async () => {
    const { gui } = fakeGui();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (d: Buffer) => {
      text += d.toString("utf8");
    });
    const done = serveActuatorStdio(
      createActuator(async () => gui),
      input,
      output,
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "click", arguments: { x: 1, y: 1 } } })}\n`,
    );
    input.end();
    await done;
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual([1, 2]);
    expect(lines[0].result.serverInfo.name).toBe(ACTUATOR_SERVER_NAME);
    expect(lines[1].result.structuredContent).toEqual({ outcome: "delivered", stepsLeft: 29 });
  });

  it("the CLI refuses to start without the plan's HCU command", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts/myco-hcu.ts")], {
      cwd: ROOT,
      encoding: "utf8",
      input: "",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: myco-hcu mcp --hcu-command/);
  });
});
