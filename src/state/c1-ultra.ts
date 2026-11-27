/**
 * Capability track I: the C1 arm ported onto the Ultra (Claude Code) harness, first piece.
 *
 * Capability spec §1.3 / §5: I's primary comparison, `C1+I` vs `C1`, needs both arms in the
 * same harness and model, and C1 today is a raw Messages-API loop (`src/baseline/c1-trial.ts`).
 * This module defines the two arms as audited headless Claude Code launch plans, built and
 * checked offline; nothing here spawns a process, touches the VM or calls a model.
 *
 *  - **`C1`**: the C1 vocabulary, served by a `myco-c1` MCP server as
 *    `mcp__myco-c1__{screenshot,click,type_text,press_key}`. Every action argument is C1's own
 *    shape and is validated by C1's own `pixelAction` (`src/baseline/c1.ts`), so the Ultra arm
 *    accepts exactly the actions the Messages-API arm did. The screenshot C1 got each turn is
 *    an explicit `screenshot` call here, and it spends a step like any tool call (§1.3).
 *  - **`C1+I`**: exactly `C1`'s tools plus the four `myco-state` tools, and nothing else.
 *
 * Both arms are gate-less (§1.3 default: neither arm calls the gate, the done claim is the
 * arm's claim). The argv uses the same headless flags as the R1 pilot (`ARGV_TEMPLATE`,
 * `src/pilot/config.ts`; the parity test pins them) but is spelled here, because no
 * `src/state/` module may reach `src/gate/` even transitively and the pilot config does.
 *
 * Not here yet (follow-ups): the `myco-c1` MCP server process and its backend, a
 * `PilotDriver` that runs these plans through the src/pilot runner, step counting from the
 * transcript, and the row writer.
 */
import { isAbsolute, join, normalize } from "node:path";
import { pixelAction } from "../baseline/c1.ts";
import {
  type AgentLaunchPlan,
  auditAgentLaunch,
  type LaunchAudit,
  type McpServerLaunch,
} from "../integrity/launch.ts";
import {
  MYCO_STATE_DOC_ENV,
  MYCO_STATE_PIPE_ENV,
  MYCO_STATE_RUN_ENV,
  MYCO_STATE_WITHHELD_ENV,
  STATE_SERVER_CLASS,
  STATE_SERVER_NAME,
  type SurfaceViolation,
  type ToolClass,
} from "../integrity/surface.ts";
import { STATE_TOOL_NAMES } from "./api.ts";
import { withheldCoversTrial } from "./arms.ts";
import { I_ARMS, type IArm } from "./prereg.ts";

export const C1_SERVER_NAME = "myco-c1";
/** The env key that binds a `myco-c1` server to one trial; the only key it may get. */
export const MYCO_C1_RUN_ENV = "MYCO_C1_RUN_ID";
export const C1_TOOL_NAMES = ["screenshot", "click", "type_text", "press_key"] as const;
export type C1ToolName = (typeof C1_TOOL_NAMES)[number];

export const C1_SERVER_CLASS: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {
  [C1_SERVER_NAME]: {
    screenshot: { reach: "guest", note: "C1: a screenshot of the trial's Calc window" },
    click: { reach: "guest", note: "C1: one click at pixel (x, y) in the trial's window" },
    type_text: { reach: "guest", note: "C1: type up to 256 characters at (x, y)" },
    press_key: { reach: "guest", note: "C1: one key or chord at (x, y)" },
  },
};

const coord = { type: "number", minimum: 0 } as const;

/** The MCP input schemas: exactly the argument shapes `pixelAction` accepts. */
export const C1_TOOL_SCHEMAS: Readonly<Record<C1ToolName, object>> = {
  screenshot: { type: "object", properties: {}, additionalProperties: false },
  click: {
    type: "object",
    properties: { x: coord, y: coord },
    required: ["x", "y"],
    additionalProperties: false,
  },
  type_text: {
    type: "object",
    properties: { x: coord, y: coord, text: { type: "string", maxLength: 256 } },
    required: ["x", "y", "text"],
    additionalProperties: false,
  },
  press_key: {
    type: "object",
    properties: { x: coord, y: coord, key: { type: "string", pattern: "^[a-z0-9+_-]{1,32}$" } },
    required: ["x", "y", "key"],
    additionalProperties: false,
  },
};

export type C1ToolCall =
  | { readonly kind: "screenshot" }
  | { readonly kind: "action"; readonly action: ReturnType<typeof pixelAction> };

/**
 * Validate one `myco-c1` tool call. Actions go through C1's own `pixelAction` (which runs
 * C1's purity check), so the Ultra arm's vocabulary is the Messages-API arm's exactly. Throws a
 * code-only error (`C1_TOOL_UNKNOWN`, `C1_ARGS_INVALID`) for anything else.
 */
export function c1ToolCall(name: string, args: unknown): C1ToolCall {
  if (!(C1_TOOL_NAMES as readonly string[]).includes(name)) throw new Error("C1_TOOL_UNKNOWN");
  if (name === "screenshot") {
    const ok =
      args === undefined ||
      (args !== null &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        Object.keys(args).length === 0);
    if (!ok) throw new Error("C1_ARGS_INVALID");
    return { kind: "screenshot" };
  }
  try {
    return { kind: "action", action: pixelAction({ tool: name, arguments: args }) };
  } catch {
    throw new Error("C1_ARGS_INVALID");
  }
}

const c1Grants = C1_TOOL_NAMES.map((t) => `mcp__${C1_SERVER_NAME}__${t}`);

/** Exactly the tools each Ultra arm is granted. */
export const ULTRA_ARM_TOOLS: Readonly<Record<IArm, readonly string[]>> = {
  C1: c1Grants,
  "C1+I": [...c1Grants, ...STATE_TOOL_NAMES.map((t) => `mcp__${STATE_SERVER_NAME}__${t}`)],
};

/** Exactly the MCP servers each Ultra arm starts. No gate server in either (§1.3). */
export const ULTRA_ARM_SERVERS: Readonly<Record<IArm, readonly string[]>> = {
  C1: [C1_SERVER_NAME],
  "C1+I": [C1_SERVER_NAME, STATE_SERVER_NAME],
};

/** The system-prompt addition: how to end. Same ending line as the pilot's, no gate sentence. */
export const ULTRA_SYSTEM_PROMPT =
  "End your final message with one line: DONE if you completed the task, NOT DONE otherwise.";

export interface UltraArmPlanInput {
  readonly arm: IArm;
  readonly runId: string;
  /** The task's exact instruction (identical across arms). */
  readonly instruction: string;
  /** The pre-registered model id (identical across arms). */
  readonly modelId: string;
  /** Absolute, normalised directory the transport writes `mcp.json` into. */
  readonly configDir: string;
  /** How the harness starts the `myco-c1` server; its args must end in `mcp`. */
  readonly c1Server: { readonly command: string; readonly args: readonly string[] };
  /** C1+I only: the `myco-state` launch, exactly as `capabilityArmPlan` takes it. */
  readonly state?: {
    readonly command: string;
    readonly args: readonly string[];
    readonly pipe: string;
    readonly docUid: string;
    readonly withheld: readonly string[];
  };
}

export function ultraArmPlan(input: UltraArmPlanInput): AgentLaunchPlan {
  if (!(I_ARMS as readonly string[]).includes(input.arm))
    throw new Error(`unknown arm ${input.arm}`);
  const mcpConfigPath = normalize(join(input.configDir, "mcp.json"));
  const servers: Record<string, McpServerLaunch> = {
    [C1_SERVER_NAME]: {
      command: input.c1Server.command,
      args: [...input.c1Server.args],
      env: { [MYCO_C1_RUN_ENV]: input.runId },
    },
  };
  if (input.arm === "C1+I") {
    const s = input.state;
    if (!s) throw new Error("the C1+I arm needs the myco-state launch (pipe, document, withheld)");
    servers[STATE_SERVER_NAME] = {
      command: s.command,
      args: [...s.args],
      env: {
        [MYCO_STATE_RUN_ENV]: input.runId,
        [MYCO_STATE_PIPE_ENV]: s.pipe,
        [MYCO_STATE_DOC_ENV]: s.docUid,
        [MYCO_STATE_WITHHELD_ENV]: JSON.stringify(s.withheld),
      },
    };
  } else if (input.state) throw new Error("the C1 arm starts no myco-state server");
  return {
    argv: [
      "-p",
      input.instruction,
      "--model",
      input.modelId,
      "--output-format",
      "json",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigPath,
      "--tools",
      "",
      "--allowedTools",
      ULTRA_ARM_TOOLS[input.arm].join(","),
      "--permission-mode",
      "dontAsk",
      "--append-system-prompt",
      ULTRA_SYSTEM_PROMPT,
    ],
    mcpConfigPath,
    mcpServers: servers,
  };
}

export interface UltraArmAudit {
  readonly ok: boolean;
  readonly arm: IArm;
  readonly launch: LaunchAudit;
  readonly violations: readonly SurfaceViolation[];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && a.length === b.length && [...x].every((v) => y.has(v));
}

const looksLikeOption = (a: string) => a.startsWith("-");

/**
 * The TIF-274 launch audit plus: the arm's exact tool and server allowlist (no gate), the
 * `myco-c1` binding (one env key, the trial's run id; args end in `mcp`, no flags), the
 * pre-registered model, and for C1+I the withheld list covering the trial's own dir.
 */
export function auditUltraArmPlan(
  plan: AgentLaunchPlan,
  opts: {
    readonly arm: IArm;
    readonly runId: string;
    readonly trialDir: string;
    readonly modelId: string;
  },
): UltraArmAudit {
  const extra =
    opts.arm === "C1+I" ? { ...C1_SERVER_CLASS, ...STATE_SERVER_CLASS } : C1_SERVER_CLASS;
  const launch = auditAgentLaunch(plan, { runId: opts.runId, extraServers: extra });
  const violations: SurfaceViolation[] = [...launch.violations];
  const v = (tool: string, detail: string) => violations.push({ tool, reach: "unknown", detail });
  const want = ULTRA_ARM_TOOLS[opts.arm];
  if (!sameSet(launch.granted, want))
    v("--allowedTools", `granted tools are not exactly the ${opts.arm} arm's allowlist`);
  if (launch.effective === "unbounded" || !sameSet(launch.effective, want))
    v("--tools", `effective tool surface is not exactly the ${opts.arm} arm's allowlist`);
  if (!sameSet(Object.keys(plan.mcpServers), ULTRA_ARM_SERVERS[opts.arm]))
    v("mcpServers", `MCP servers are not exactly the ${opts.arm} arm's`);
  const c1 = plan.mcpServers[C1_SERVER_NAME];
  const env = c1?.env ?? {};
  if (
    !c1 ||
    Object.keys(env).length !== 1 ||
    !Object.hasOwn(env, MYCO_C1_RUN_ENV) ||
    env[MYCO_C1_RUN_ENV] !== opts.runId ||
    opts.runId.length === 0
  )
    v(`mcp__${C1_SERVER_NAME}`, `${MYCO_C1_RUN_ENV} must be its only env key and pin this run id`);
  if (c1 && (c1.args.at(-1) !== "mcp" || c1.args.some(looksLikeOption)))
    v(`mcp__${C1_SERVER_NAME}`, "server args must end in `mcp` and carry no flags");
  const models = plan.argv.flatMap((a, i) => (a === "--model" ? [plan.argv[i + 1]] : []));
  if (models.length !== 1 || models[0] !== opts.modelId)
    v("--model", "exactly one --model, the pre-registered model");
  if (
    opts.arm === "C1+I" &&
    !(isAbsolute(opts.trialDir) && withheldCoversTrial(plan, opts.trialDir))
  )
    v(STATE_SERVER_NAME, "the withheld list does not cover this trial's dir");
  return { ok: violations.length === 0, arm: opts.arm, launch, violations };
}
