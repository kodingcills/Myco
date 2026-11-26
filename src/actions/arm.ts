/**
 * Track J - the `fast-path` agent arm, wired for later measurement.
 *
 * It sits next to the two baseline arms the capability spec pairs it with
 * (`docs/product/capability-spec.md`, track J; the spec calls it `hcu+shell+J`):
 * `screenshot-only` (C1) and `hcu+shell`. Nothing here runs a model or a measurement;
 * measurement waits for the integrity fixes and the lead's GO, on Claude Ultra only.
 *
 * ## Launch audit, extended
 *
 * The agent reaches the router through one MCP server, `myco-cap` (the spec's proposed
 * capability server), with two tools: `act` (a typed action, routed) and `act_script` (a
 * shell command, parsed by the policy, default deny). The integrity launch audit
 * (`auditAgentLaunch`, `src/integrity/launch.ts`) fails closed on any server it cannot
 * classify. `auditFastPathLaunch` classifies `myco-cap` for it, the way the audit treats
 * `myco-rt`'s session pin:
 *
 * - **pinned** (the server's environment is EXACTLY `MYCO_CAP_RUN_ID = runId` and
 *   `MYCO_CAP_WORKSPACE = <the trial's absolute, normalised workspace>`, and that workspace
 *   is not a filesystem root): both tools are classified as confined to the trial
 *   sandbox (`guest` reach: the trial workspace is the disposable sandbox on the Linux
 *   path), and the audit can pass;
 * - **anything else** (missing or extra variables, another run id, a relative or `..`
 *   workspace, another trial's workspace): both tools are classified `host-fs`, so the
 *   integrity audit refuses the launch.
 *
 * `src/integrity/*` is not modified: the classification is passed through the audit's
 * existing `extraServers` option.
 *
 * ## Rows are never R1 evidence
 *
 * A fast-path row has its own schema id and `evidence: false` as a literal. Its `arm` is
 * not `myco-gate`, and `myco.benchmark.arm-row/1` admits only `myco-gate` and `hcu+shell`,
 * so the benchmark check (`checkBenchmark`) refuses it outright; R1 evidence rules
 * (`src/benchmark/taskset-binding.ts`) are untouched. Admitting the arm to a ledger is a
 * reviewed schema change (TO FILE), and even then the spec keeps capability rows out of R1.
 */

import { isAbsolute, normalize, parse } from "node:path";
import { type AgentLaunchPlan, auditAgentLaunch, type LaunchAudit } from "../integrity/launch.ts";
import type { ToolClass } from "../integrity/surface.ts";
import {
  type ActionRouter,
  type RouteDecision,
  type RouteName,
  type RoutingSummary,
  summarizeRouting,
} from "./router.ts";

export const FAST_PATH_ARM = "fast-path" as const;
/** The capability spec's name for this arm. */
export const FAST_PATH_SPEC_ARM = "hcu+shell+J" as const;
export const CAP_SERVER = "myco-cap" as const;
export const CAP_RUN_ENV = "MYCO_CAP_RUN_ID";
export const CAP_WORKSPACE_ENV = "MYCO_CAP_WORKSPACE";
export const FAST_PATH_TOOLS = ["act", "act_script"] as const;

/** The fast-path arm beside the baselines it is measured against. */
export const FAST_PATH_ARM_SPEC = {
  id: FAST_PATH_ARM,
  specName: FAST_PATH_SPEC_ARM,
  channel: "api+script+gui",
  pairsWith: ["hcu+shell", "screenshot-only"] as const,
  status: "not-run" as const,
  blocker:
    "built offline on the Linux path (track J); measurement needs the integrity fixes " +
    "(#518, the xlsx gate replacement, the #494 follow-up), the lead's GO, Claude Ultra, " +
    "and, for the Windows Calc tasks, a guest-side router under the VM lock",
  evidence: false as const,
} as const;

const PINNED: ToolClass = {
  reach: "guest",
  note: "track J router: confined to the pinned trial workspace by the action policy",
};
const UNPINNED: ToolClass = {
  reach: "host-fs",
  note: "track J router without a pinned trial workspace: could reach any host path",
};

export interface FastPathPin {
  readonly runId: string;
  /** The trial's workspace: absolute, normalised. */
  readonly workspace: string;
}

/** True only when `env` pins the server to exactly this trial's run and workspace. */
export function capServerPinned(env: Readonly<Record<string, string>>, pin: FastPathPin): boolean {
  const keys = Object.keys(env).sort();
  if (keys.length !== 2 || keys[0] !== CAP_RUN_ENV || keys[1] !== CAP_WORKSPACE_ENV) return false;
  const ws = pin.workspace;
  const wsOk =
    typeof ws === "string" &&
    ws.length > 1 &&
    isAbsolute(ws) &&
    normalize(ws) === ws &&
    !ws.endsWith("/") &&
    parse(ws).root !== ws;
  return (
    wsOk &&
    typeof pin.runId === "string" &&
    pin.runId.length > 0 &&
    env[CAP_RUN_ENV] === pin.runId &&
    env[CAP_WORKSPACE_ENV] === ws
  );
}

export interface FastPathPlanOptions extends FastPathPin {
  readonly mcpConfigPath: string;
  readonly prompt: string;
  /** How the harness starts the `myco-cap` server. */
  readonly capCommand: string;
  readonly capArgs?: readonly string[];
}

/** The fast-path agent's launch plan: no built-ins, `myco-cap`'s two tools only. */
export function fastPathLaunchPlan(options: FastPathPlanOptions): AgentLaunchPlan {
  return {
    mcpConfigPath: options.mcpConfigPath,
    argv: [
      "-p",
      options.prompt,
      "--strict-mcp-config",
      "--tools",
      "",
      "--mcp-config",
      options.mcpConfigPath,
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      ...FAST_PATH_TOOLS.map((tool) => `mcp__${CAP_SERVER}__${tool}`),
    ],
    mcpServers: {
      [CAP_SERVER]: {
        command: options.capCommand,
        args: [...(options.capArgs ?? [])],
        env: { [CAP_RUN_ENV]: options.runId, [CAP_WORKSPACE_ENV]: options.workspace },
      },
    },
  };
}

export interface FastPathLaunchAudit extends LaunchAudit {
  readonly capPinned: boolean;
}

/** `auditAgentLaunch` with `myco-cap` classified by its pin (see the module doc). */
export function auditFastPathLaunch(
  plan: AgentLaunchPlan,
  pin: FastPathPin,
  extraServers: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {},
): FastPathLaunchAudit {
  const server = Object.hasOwn(plan.mcpServers, CAP_SERVER)
    ? plan.mcpServers[CAP_SERVER]
    : undefined;
  const capPinned = server !== undefined && capServerPinned(server.env, pin);
  const cls = capPinned ? PINNED : UNPINNED;
  const capTools: Record<string, ToolClass> = {};
  for (const tool of FAST_PATH_TOOLS) capTools[tool] = cls;
  if (Object.hasOwn(extraServers, CAP_SERVER))
    throw new Error("auditFastPathLaunch: myco-cap is classified here, not by the caller");
  const audit = auditAgentLaunch(plan, {
    runId: pin.runId,
    extraServers: { ...extraServers, [CAP_SERVER]: capTools },
  });
  // A plan without a pinned `myco-cap` is not a fast-path launch, even if it is otherwise clean.
  return { ...audit, ok: audit.ok && capPinned, capPinned };
}

// ---------------------------------------------------------------------------------------
// Run record and experiment row.

export interface FastPathRunRecord {
  readonly schema: "myco.fast-path-run/1";
  readonly arm: typeof FAST_PATH_ARM;
  readonly runId: string;
  readonly taskId: string;
  readonly policyId: string;
  readonly availability: Readonly<Record<RouteName, boolean>>;
  /** Every routing decision: route, reason, fallback, attempts. */
  readonly routing: readonly RouteDecision[];
  readonly summary: RoutingSummary;
  readonly claim: "done" | "failure";
  readonly plannerModelId: string;
  readonly wallMs: number;
  readonly evidence: false;
}

/** The harness's record of one fast-path trial, from the router's own log. */
export function fastPathRunRecord(input: {
  readonly router: Pick<ActionRouter, "log" | "availability" | "policyId">;
  readonly runId: string;
  readonly taskId: string;
  readonly claim: "done" | "failure";
  readonly plannerModelId: string;
  readonly wallMs: number;
}): FastPathRunRecord {
  const routing = input.router.log();
  return {
    schema: "myco.fast-path-run/1",
    arm: FAST_PATH_ARM,
    runId: input.runId,
    taskId: input.taskId,
    policyId: input.router.policyId,
    availability: { ...input.router.availability },
    routing,
    summary: summarizeRouting(routing),
    claim: input.claim,
    plannerModelId: input.plannerModelId,
    wallMs: input.wallMs,
    evidence: false,
  };
}

/** One row per trial for a later paired analysis. Never R1 evidence. */
export interface FastPathArmRow {
  readonly schema: "myco.capability.fast-path-row/1";
  readonly arm: typeof FAST_PATH_ARM;
  readonly specArm: typeof FAST_PATH_SPEC_ARM;
  readonly pairsWith: readonly string[];
  readonly taskId: string;
  readonly trialKey: string;
  readonly plannerModelId: string;
  /** True when the planner is not a model id (scripted, dry run): never evidence. */
  readonly simulated: boolean;
  readonly claim: "done" | "failure";
  readonly steps: number;
  readonly wallMs: number;
  readonly routes: Readonly<Record<RouteName | "none", number>>;
  readonly fallbacks: number;
  readonly denials: number;
  /** Route log without action payloads (no agent text, no paths). */
  readonly routeLog: readonly {
    readonly kind: string;
    readonly route: RouteName | null;
    readonly reason: RouteDecision["reason"];
    readonly fallbackFrom: RouteName | null;
    readonly code: string;
  }[];
  /** The gate's verdict from the persisted bytes, if the harness ran it. */
  readonly gateVerdict: "verified" | "refuted" | "uncertain" | null;
  /** The independent grader's status on the persisted bytes. */
  readonly grade: "pass" | "fail" | "ungradable" | null;
  /** Verified = claimed done AND graded pass (capability spec §1.1). */
  readonly verified: boolean;
  readonly evidence: false;
}

const MODEL_ID = /^claude-[a-z0-9.-]+$/;

export function fastPathArmRow(input: {
  readonly record: FastPathRunRecord;
  readonly trialKey: string;
  readonly gateVerdict: FastPathArmRow["gateVerdict"];
  readonly grade: FastPathArmRow["grade"];
}): FastPathArmRow {
  const { record } = input;
  return {
    schema: "myco.capability.fast-path-row/1",
    arm: FAST_PATH_ARM,
    specArm: FAST_PATH_SPEC_ARM,
    pairsWith: [...FAST_PATH_ARM_SPEC.pairsWith],
    taskId: record.taskId,
    trialKey: input.trialKey,
    plannerModelId: record.plannerModelId,
    simulated: !MODEL_ID.test(record.plannerModelId),
    claim: record.claim,
    steps: record.summary.steps,
    wallMs: record.wallMs,
    routes: record.summary.byRoute,
    fallbacks: record.summary.fallbacks,
    denials: record.summary.denials,
    routeLog: record.routing.map((d) => ({
      kind: d.kind,
      route: d.route,
      reason: d.reason,
      fallbackFrom: d.fallbackFrom,
      code: d.code,
    })),
    gateVerdict: input.gateVerdict,
    grade: input.grade,
    // The grader decides; a claim alone, or a gate verdict alone, is never "verified".
    verified: record.claim === "done" && input.grade === "pass",
    evidence: false,
  };
}

/**
 * Problems that make a row unusable as a fast-path experiment row. Any row claiming to be
 * evidence is refused: capability rows are never R1 evidence.
 */
export function fastPathRowProblems(row: unknown): string[] {
  const problems: string[] = [];
  if (typeof row !== "object" || row === null) return ["not an object"];
  const r = row as Record<string, unknown>;
  if (r.schema !== "myco.capability.fast-path-row/1") problems.push("wrong schema");
  if (r.arm !== FAST_PATH_ARM) problems.push("arm is not fast-path");
  if (r.evidence !== false) problems.push("a fast-path row is never evidence");
  if (r.verified === true && !(r.claim === "done" && r.grade === "pass"))
    problems.push("verified without a done claim graded pass");
  if (typeof r.plannerModelId !== "string") problems.push("no planner id");
  else if (r.simulated !== !MODEL_ID.test(r.plannerModelId))
    problems.push("simulated flag disagrees with the planner id");
  return problems;
}
