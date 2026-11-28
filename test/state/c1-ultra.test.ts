/**
 * Track I: the C1 arm on the Ultra (Claude Code) harness, first piece (capability spec §1.3,
 * §5). Offline only: plans are built and audited, nothing is spawned.
 *
 * Pins: C1+I's surface is exactly C1's plus the four state tools; neither arm has the gate
 * (§1.3 gate-less default); both use the pilot's headless flags and the pre-registered model;
 * the `myco-c1` tools accept exactly the actions C1's own `pixelAction` accepts.
 */
import { describe, expect, it } from "vitest";
import { pixelAction } from "../../src/baseline/c1.ts";
import type { AgentLaunchPlan } from "../../src/integrity/launch.ts";
import { MCP_SERVERS } from "../../src/integrity/surface.ts";
import { ARGV_TEMPLATE } from "../../src/pilot/config.ts";
import { STATE_TOOL_NAMES } from "../../src/state/api.ts";
import {
  auditUltraArmPlan,
  C1_SERVER_CLASS,
  C1_SERVER_NAME,
  C1_TOOL_NAMES,
  C1_TOOL_SCHEMAS,
  c1ToolCall,
  MYCO_C1_RUN_ENV,
  ULTRA_ARM_SERVERS,
  ULTRA_ARM_TOOLS,
  ultraArmPlan,
} from "../../src/state/c1-ultra.ts";
import { type IArm, loadIPrereg } from "../../src/state/prereg.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const MODEL = loadIPrereg(ROOT).prereg.modelId;
const RUN = "run-i-c1-001";
const TRIAL = "/srv/myco/trials/run-i-c1-001";
const STATE = {
  command: "npx",
  args: ["tsx", "/opt/myco/scripts/myco-state.ts", "mcp"],
  pipe: "myco-state-0123456789abcdef-a1b2c3d4e5f6",
  docUid: "1",
  withheld: ["/srv/myco/vault", TRIAL],
};

function plan(arm: IArm): AgentLaunchPlan {
  return ultraArmPlan({
    arm,
    runId: RUN,
    instruction: "Set the cell at record EMP-0011, column name, to REVISED and save the file.",
    modelId: MODEL,
    configDir: TRIAL,
    c1Server: { command: "npx", args: ["tsx", "/opt/myco/scripts/myco-c1.ts", "mcp"] },
    ...(arm === "C1+I" ? { state: STATE } : {}),
  });
}
const audit = (p: AgentLaunchPlan, arm: IArm, over: { modelId?: string; trialDir?: string } = {}) =>
  auditUltraArmPlan(p, { arm, runId: RUN, trialDir: TRIAL, modelId: MODEL, ...over });

// biome-ignore lint/suspicious/noExplicitAny: tests mutate plans loosely
function mutate(p: AgentLaunchPlan, f: (m: { argv: string[]; mcpServers: any }) => void) {
  const m = structuredClone(p) as unknown as {
    argv: string[];
    mcpServers: Record<string, unknown>;
  };
  f(m);
  return m as unknown as AgentLaunchPlan;
}
const allowedOf = (p: AgentLaunchPlan) => p.argv[p.argv.indexOf("--allowedTools") + 1] as string;

describe("both Ultra arms pass the launch audit as built", () => {
  for (const arm of ["C1", "C1+I"] as IArm[])
    it(arm, () => {
      const a = audit(plan(arm), arm);
      expect(a.violations).toEqual([]);
      expect(a.ok).toBe(true);
    });
});

describe("parity (§1.3): C1+I is C1 plus exactly the four state tools", () => {
  it("tool and server sets", () => {
    const extra = ULTRA_ARM_TOOLS["C1+I"].filter((t) => !ULTRA_ARM_TOOLS.C1.includes(t));
    expect(extra.sort()).toEqual(STATE_TOOL_NAMES.map((t) => `mcp__myco-state__${t}`).sort());
    expect(ULTRA_ARM_TOOLS.C1.every((t) => ULTRA_ARM_TOOLS["C1+I"].includes(t))).toBe(true);
    expect(ULTRA_ARM_TOOLS.C1).toEqual(C1_TOOL_NAMES.map((t) => `mcp__myco-c1__${t}`));
    expect(Object.keys(plan("C1").mcpServers)).toEqual([...ULTRA_ARM_SERVERS.C1]);
    expect(Object.keys(plan("C1+I").mcpServers).sort()).toEqual(
      [...ULTRA_ARM_SERVERS["C1+I"]].sort(),
    );
  });

  it("argv differs only in the grant: same instruction, model, flags and system prompt", () => {
    const a = plan("C1").argv;
    const b = plan("C1+I").argv;
    expect(a.length).toBe(b.length);
    const diff = a.flatMap((x, i) => (x === b[i] ? [] : [a[i - 1]]));
    expect(diff).toEqual(["--allowedTools"]);
  });

  it("neither arm has the gate (gate-less, §1.3)", () => {
    for (const arm of ["C1", "C1+I"] as IArm[]) {
      expect(Object.keys(plan(arm).mcpServers)).not.toContain("myco-gate");
      expect(plan(arm).argv.join(" ")).not.toMatch(/myco-gate|myco_gate_check/);
    }
  });

  it("uses the R1 pilot's headless flags, and the pre-registered model", () => {
    const flags = (argv: readonly string[]) => argv.filter((x) => x.startsWith("-")).sort();
    expect(flags(plan("C1").argv)).toEqual(flags(ARGV_TEMPLATE));
    const p = plan("C1").argv;
    expect(p[p.indexOf("--model") + 1]).toBe(MODEL);
    expect(p[p.indexOf("--tools") + 1]).toBe("");
    expect(p[p.indexOf("--setting-sources") + 1]).toBe("");
    expect(p[p.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });
});

describe("the audit refuses", () => {
  const cases: [string, IArm, (p: AgentLaunchPlan) => AgentLaunchPlan, RegExp][] = [
    [
      "an extra tool (the gate) in C1",
      "C1",
      (p) =>
        mutate(p, (m) => {
          m.argv[m.argv.indexOf("--allowedTools") + 1] =
            `${allowedOf(p)},mcp__myco-gate__myco_gate_check`;
        }),
      /allowlist|does not start/,
    ],
    [
      "a missing tool in C1+I",
      "C1+I",
      (p) =>
        mutate(p, (m) => {
          m.argv[m.argv.indexOf("--allowedTools") + 1] = allowedOf(p).split(",").slice(1).join(",");
        }),
      /allowlist/,
    ],
    ["C1 granted the state tools", "C1", () => mutate(plan("C1+I"), () => {}), /allowlist|servers/],
    [
      "an extra myco-c1 env key",
      "C1",
      (p) => mutate(p, (m) => (m.mcpServers[C1_SERVER_NAME].env.EXTRA = "1")),
      /only env key/,
    ],
    [
      "another trial's run id on myco-c1",
      "C1",
      (p) => mutate(p, (m) => (m.mcpServers[C1_SERVER_NAME].env[MYCO_C1_RUN_ENV] = "run-other")),
      /pin this run id/,
    ],
    [
      "a flag in the myco-c1 args",
      "C1",
      (p) => mutate(p, (m) => m.mcpServers[C1_SERVER_NAME].args.unshift("--inspect")),
      /no flags/,
    ],
    [
      "a withheld list that does not cover the trial",
      "C1+I",
      (p) =>
        mutate(p, (m) => {
          m.mcpServers["myco-state"].env.MYCO_STATE_WITHHELD = JSON.stringify(["/srv/myco/vault"]);
        }),
      /withheld/,
    ],
  ];
  for (const [name, arm, change, want] of cases)
    it(name, () => {
      const a = audit(change(plan(arm)), arm);
      expect(a.ok).toBe(false);
      expect(a.violations.map((v) => v.detail).join("; ")).toMatch(want);
    });

  it("a grant wider than the arm's allowlist, named by the grant check itself", () => {
    // The gate tool is granted but its server is not started, so the effective surface still
    // equals C1's; only the grant check (not the effective-surface check) can name this.
    const a = audit(
      mutate(plan("C1"), (m) => {
        m.argv[m.argv.indexOf("--allowedTools") + 1] =
          `${allowedOf(plan("C1"))},mcp__myco-gate__myco_gate_check`;
      }),
      "C1",
    );
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.detail)).toContain(
      "granted tools are not exactly the C1 arm's allowlist",
    );
  });

  it("an extra MCP server (the state server on C1), named by the server-set check itself", () => {
    const a = audit(
      mutate(plan("C1"), (m) => {
        m.mcpServers["myco-state"] = structuredClone(plan("C1+I").mcpServers["myco-state"]);
      }),
      "C1",
    );
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.detail)).toContain("MCP servers are not exactly the C1 arm's");
  });

  it("a model other than the pre-registered one", () => {
    const a = audit(plan("C1"), "C1", { modelId: "claude-other-1" });
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.tool)).toContain("--model");
  });

  it("building C1 with a state server, or C1+I without one", () => {
    expect(() =>
      ultraArmPlan({
        arm: "C1",
        runId: RUN,
        instruction: "x",
        modelId: MODEL,
        configDir: TRIAL,
        c1Server: { command: "c", args: ["mcp"] },
        state: STATE,
      }),
    ).toThrow(/no myco-state/);
    expect(() =>
      ultraArmPlan({
        arm: "C1+I",
        runId: RUN,
        instruction: "x",
        modelId: MODEL,
        configDir: TRIAL,
        c1Server: { command: "c", args: ["mcp"] },
      }),
    ).toThrow(/needs the myco-state/);
  });
});

describe("myco-c1 is classified guest-only and is not a default MCP server", () => {
  it("every tool reaches the guest, and the R1 audit's server table does not know it", () => {
    for (const t of Object.values(C1_SERVER_CLASS[C1_SERVER_NAME] ?? {}))
      expect(t.reach).toBe("guest");
    expect(Object.keys(C1_SERVER_CLASS[C1_SERVER_NAME] ?? {})).toEqual([...C1_TOOL_NAMES]);
    expect(Object.hasOwn(MCP_SERVERS, C1_SERVER_NAME)).toBe(false);
  });
});

describe("c1ToolCall accepts exactly C1's own vocabulary", () => {
  const corpus: [string, unknown][] = [
    ["click", { x: 10, y: 20 }],
    ["click", { x: 0, y: 0 }],
    ["click", { x: -1, y: 20 }],
    ["click", { x: 10 }],
    ["click", { x: 10, y: 20, z: 1 }],
    ["click", { x: Number.NaN, y: 1 }],
    ["type_text", { x: 1, y: 2, text: "REVISED-1" }],
    ["type_text", { x: 1, y: 2, text: "a".repeat(256) }],
    ["type_text", { x: 1, y: 2, text: "a".repeat(257) }],
    ["type_text", { x: 1, y: 2 }],
    ["press_key", { x: 1, y: 2, key: "ctrl+s" }],
    ["press_key", { x: 1, y: 2, key: "ctrl s" }],
    ["press_key", { x: 1, y: 2, key: "k".repeat(33) }],
    ["press_key", { x: "1", y: 2, key: "enter" }],
  ];
  const pixelOk = (tool: string, args: unknown) => {
    try {
      pixelAction({ tool, arguments: args });
      return true;
    } catch {
      return false;
    }
  };
  const ultraOk = (tool: string, args: unknown) => {
    try {
      c1ToolCall(tool, args);
      return true;
    } catch {
      return false;
    }
  };
  for (const [tool, args] of corpus)
    it(`${tool} ${JSON.stringify(args)}`, () => {
      expect(ultraOk(tool, args)).toBe(pixelOk(tool, args));
    });

  it("screenshot takes no arguments; anything else is C1_TOOL_UNKNOWN; errors are codes", () => {
    expect(c1ToolCall("screenshot", {})).toEqual({ kind: "screenshot" });
    expect(c1ToolCall("screenshot", undefined)).toEqual({ kind: "screenshot" });
    expect(() => c1ToolCall("screenshot", { x: 1 })).toThrow(/^C1_ARGS_INVALID$/);
    expect(() => c1ToolCall("launch_process", {})).toThrow(/^C1_TOOL_UNKNOWN$/);
    expect(() => c1ToolCall("click", { x: -1, y: 0 })).toThrow(/^C1_ARGS_INVALID$/);
  });

  it("the advertised schemas name exactly the keys pixelAction requires", () => {
    const keys = (t: keyof typeof C1_TOOL_SCHEMAS) =>
      ((C1_TOOL_SCHEMAS[t] as { required?: string[] }).required ?? []).sort();
    expect(keys("click")).toEqual(["x", "y"]);
    expect(keys("type_text")).toEqual(["text", "x", "y"]);
    expect(keys("press_key")).toEqual(["key", "x", "y"]);
    expect(keys("screenshot")).toEqual([]);
  });
});
