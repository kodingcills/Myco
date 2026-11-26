/**
 * Capability track I: the agent arms for the structured-state measurement (wiring only;
 * nothing here runs a trial or calls a model).
 *
 * Three arms on the same task, model, budget and gate, differing only in the channel added
 * on top of the shared acting surface (`myco-rt` observe + act, and the gate):
 *
 *  - `screenshot-only`  nothing added (the C1 condition: the agent sees pixels);
 *  - `hcu+shell`        a guest shell (`myco-rt` launch_process). The live hcu+shell arm
 *                       (src/baseline/hcu-shell/) drives HCU with its own bounded shell; this
 *                       is its MCP-surface analogue for a like-for-like launch audit;
 *  - `structured-state` the `myco-state` server (read-only app state, `./server.ts`).
 *
 * `capabilityArmPlan` builds the exact `AgentLaunchPlan` for an arm and
 * `auditCapabilityArmLaunch` audits it: the TIF-274 launch audit (strict MCP config, one
 * pinned `--mcp-config`, `--tools ""`, `dontAsk`, every granted tool classified, the
 * `myco-state` binding pinned to the trial) plus an exact allowlist per arm: the granted
 * tools and the MCP servers must be exactly the arm's, no more and no fewer.
 *
 * Rows from these arms are capability measurements, never R1 evidence: their schema is
 * `myco.capability.arm-row/1`, not the benchmark ledger's, they carry `r1Evidence: false`,
 * and the benchmark check refuses them (test/state/arms.test.ts).
 */
import { join } from "node:path";
import {
  type AgentLaunchPlan,
  auditAgentLaunch,
  type LaunchAudit,
  type McpServerLaunch,
} from "../integrity/launch.ts";
import {
  MYCO_RT_SESSION_ENV,
  MYCO_STATE_PIPE_ENV,
  MYCO_STATE_RUN_ENV,
  rtSessionIdFor,
  STATE_SERVER_CLASS,
  STATE_SERVER_NAME,
  type SurfaceViolation,
  type ToolClass,
} from "../integrity/surface.ts";
import { STATE_TOOL_NAMES } from "./api.ts";

/**
 * The gate's server and tool names, as the agent sees them. Spelled here, not imported:
 * no state module imports gate code, even transitively (capability spec §1.2 rule 4;
 * test/state/state-independence.test.ts). test/state/state-arms.test.ts pins them to
 * `SERVER_NAME`, `GATE_TOOL` and `GATE_SERVER_CLASS` in src/gate/.
 */
export const GATE_SERVER_NAME = "myco-gate";
export const GATE_TOOL = "myco_gate_check";
export const GATE_CLASS: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {
  [GATE_SERVER_NAME]: {
    [GATE_TOOL]: { reach: "gate", note: "TIF-265 verdict tool: takes a task id and run id only" },
  },
};

export const CAPABILITY_ARMS = ["screenshot-only", "hcu+shell", "structured-state"] as const;
export type CapabilityArm = (typeof CAPABILITY_ARMS)[number];

const RT = "myco-rt";
const BASE_TOOLS = [
  `mcp__${RT}__observe`,
  `mcp__${RT}__act`,
  `mcp__${GATE_SERVER_NAME}__${GATE_TOOL}`,
];

/** Exactly the tools each arm is granted. */
export const CAPABILITY_ARM_TOOLS: Readonly<Record<CapabilityArm, readonly string[]>> = {
  "screenshot-only": BASE_TOOLS,
  "hcu+shell": [...BASE_TOOLS, `mcp__${RT}__launch_process`],
  "structured-state": [
    ...BASE_TOOLS,
    ...STATE_TOOL_NAMES.map((t) => `mcp__${STATE_SERVER_NAME}__${t}`),
  ],
};

/** Exactly the MCP servers each arm starts. */
export const CAPABILITY_ARM_SERVERS: Readonly<Record<CapabilityArm, readonly string[]>> = {
  "screenshot-only": [RT, GATE_SERVER_NAME],
  "hcu+shell": [RT, GATE_SERVER_NAME],
  "structured-state": [RT, GATE_SERVER_NAME, STATE_SERVER_NAME],
};

export interface CapabilityArmPlanInput {
  readonly arm: CapabilityArm;
  readonly runId: string;
  /** The task instruction the agent is given (identical across arms). */
  readonly instruction: string;
  /** Absolute, normalised directory the transport writes `mcp.json` into. */
  readonly configDir: string;
  /** How the harness starts `myco-state mcp` (e.g. `npx`, [`tsx`, `<repo>/scripts/myco-state.ts`, `mcp`]). */
  readonly stateServer?: { readonly command: string; readonly args: readonly string[] };
  /** The trial's live soffice pipe (`statePipeFor(runId)`); structured-state only. */
  readonly statePipe?: string;
  /** Host strings no state reply may contain (trial dir, vault, fixture, oracle config). */
  readonly withheld?: readonly string[];
}

export function capabilityArmPlan(input: CapabilityArmPlanInput): AgentLaunchPlan {
  const mcpConfigPath = join(input.configDir, "mcp.json");
  const servers: Record<string, McpServerLaunch> = {
    [RT]: {
      command: "myco-rt-mcp",
      args: [],
      env: { [MYCO_RT_SESSION_ENV]: rtSessionIdFor(input.runId) },
    },
    [GATE_SERVER_NAME]: { command: "myco-gate", args: ["mcp"], env: {} },
  };
  if (input.arm === "structured-state") {
    if (!input.stateServer || !input.statePipe)
      throw new Error("structured-state arm needs the state server command and the trial's pipe");
    servers[STATE_SERVER_NAME] = {
      command: input.stateServer.command,
      args: [...input.stateServer.args],
      env: {
        [MYCO_STATE_RUN_ENV]: input.runId,
        [MYCO_STATE_PIPE_ENV]: input.statePipe,
        ...(input.withheld && input.withheld.length > 0
          ? { MYCO_STATE_WITHHELD: JSON.stringify(input.withheld) }
          : {}),
      },
    };
  }
  return {
    argv: [
      "-p",
      input.instruction,
      "--strict-mcp-config",
      "--tools",
      "",
      "--mcp-config",
      mcpConfigPath,
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      CAPABILITY_ARM_TOOLS[input.arm].join(","),
    ],
    mcpServers: servers,
    mcpConfigPath,
  };
}

export interface CapabilityArmAudit {
  readonly ok: boolean;
  readonly arm: CapabilityArm;
  readonly launch: LaunchAudit;
  /** Launch-audit violations plus the arm's exact-allowlist violations. */
  readonly violations: readonly SurfaceViolation[];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

/** The TIF-274 launch audit plus the arm's exact tool and server allowlist. */
export function auditCapabilityArmLaunch(
  plan: AgentLaunchPlan,
  opts: { readonly arm: CapabilityArm; readonly runId: string },
): CapabilityArmAudit {
  const extraServers =
    opts.arm === "structured-state" ? { ...GATE_CLASS, ...STATE_SERVER_CLASS } : { ...GATE_CLASS };
  const launch = auditAgentLaunch(plan, { runId: opts.runId, extraServers });
  const violations: SurfaceViolation[] = [...launch.violations];
  const expectedTools = CAPABILITY_ARM_TOOLS[opts.arm];
  if (!sameSet(launch.granted, expectedTools) || launch.granted.length !== expectedTools.length)
    violations.push({
      tool: "--allowedTools",
      reach: "unknown",
      detail: `granted tools are not exactly the ${opts.arm} arm's allowlist`,
    });
  if (launch.effective === "unbounded" || !sameSet(launch.effective, expectedTools))
    violations.push({
      tool: "--tools",
      reach: "unknown",
      detail: `effective tool surface is not exactly the ${opts.arm} arm's allowlist`,
    });
  if (!sameSet(Object.keys(plan.mcpServers), CAPABILITY_ARM_SERVERS[opts.arm]))
    violations.push({
      tool: "mcpServers",
      reach: "unknown",
      detail: `MCP servers are not exactly the ${opts.arm} arm's`,
    });
  return { ok: violations.length === 0, arm: opts.arm, launch, violations };
}

/** The cost basis string the benchmark uses (`COST_BASIS`, src/benchmark/check.ts). */
export const CAPABILITY_COST_BASIS =
  "token-derived estimate at frozen rates; not billed USD" as const;

/**
 * One capability-measurement row. Never R1 evidence: a different schema from the benchmark
 * ledger (`myco.benchmark.arm-row/1`), an arm name the ledger does not accept, and
 * `r1Evidence: false` as a literal type.
 */
export interface CapabilityArmRow {
  readonly schema: "myco.capability.arm-row/1";
  readonly capabilityTrack: "I";
  readonly arm: CapabilityArm;
  readonly evidenceClass: "capability-measurement";
  readonly r1Evidence: false;
  /** True for a scripted / mock agent (no model). A simulated row is never evidence of anything. */
  readonly simulated: boolean;
  readonly taskId: string;
  readonly trialKey: string;
  readonly runId: string;
  readonly plannerModelId: string;
  /** The gate's verdict on the captured persisted bytes (null: the gate was not reached). */
  readonly gateVerdict: "verified" | "refuted" | "uncertain" | null;
  /** The independent grader's grade, filled in by grading (null until graded). */
  readonly grade: "pass" | "fail" | "ungradable" | null;
  /** Agent decisions that acted or read (each tool call counts one step). */
  readonly steps: number | null;
  readonly stateToolCalls: number;
  readonly cost: {
    readonly basis: typeof CAPABILITY_COST_BASIS;
    /** Token-derived ESTIMATE; null when unmeasured (never 0 for unmeasured). */
    readonly estimatedModelUsd: number | null;
  };
}

export function capabilityArmRow(
  input: Omit<
    CapabilityArmRow,
    "schema" | "capabilityTrack" | "evidenceClass" | "r1Evidence" | "cost"
  > & {
    readonly estimatedModelUsd: number | null;
  },
): CapabilityArmRow {
  const { estimatedModelUsd, ...rest } = input;
  return {
    schema: "myco.capability.arm-row/1",
    capabilityTrack: "I",
    evidenceClass: "capability-measurement",
    r1Evidence: false,
    ...rest,
    cost: { basis: CAPABILITY_COST_BASIS, estimatedModelUsd },
  };
}
