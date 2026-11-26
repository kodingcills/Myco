/**
 * The gated harness path for one trial (TIF-274 prerequisite; #470 F2, #471/#478 F2).
 *
 * The order is the contract, and each step fails closed:
 *
 *  1. Audit the launch plan (`auditAgentLaunch`): the agent's real argv and MCP servers. A
 *     failing audit ends the trial before anything is sealed or launched.
 *  2. Seal the trial in the vault: ground truth `gateGroundTruth(task)`, fixtures, oracle
 *     sources. The receipt stays in this function's memory.
 *  3. Build the gate bound to `{ runId, receipt }` (`createSealedGate`), and start the agent
 *     through the transport with the *same frozen plan object* that was audited. The agent
 *     may call the gate; before capture every call is `uncertain`.
 *  4. When the transport reports the agent stopped, `markAgentStopped`, then capture the
 *     host copy of the persisted output (and evidence for audit).
 *  5. The harness's own check on the same gate: the trial's verdict, read only from the
 *     sealed capture.
 *
 * The transport is the only part that differs between the mock path and a live run. It must
 * not resolve `runAgent` until the agent process (and its MCP servers) have exited: the vault
 * records the harness's word that the agent stopped (see verdict-integrity.md §2.3).
 */

import { HANDOFF_SERVER_CLASS } from "../handoff/agent-server.ts";
import { assertNoOperatorReach } from "../handoff/operator-server.ts";
import type { HandoffLog } from "../handoff/protocol.ts";
import type { LaunchAudit } from "../integrity/launch.ts";
import { type AgentLaunchPlan, auditAgentLaunch } from "../integrity/launch.ts";
import type {
  CaptureInput,
  IntegrityViolation,
  SealReceipt,
  VerdictVault,
} from "../integrity/vault.ts";
import type { GateResult } from "./api.ts";
import type { Gate, GateConfig, TaskRegistry } from "./gate.ts";
import { GATE_TOOL, SERVER_NAME } from "./mcp-server.ts";
import { createSealedGate, gateGroundTruth } from "./sealed.ts";

/** The gate's MCP tool, classified for the surface audit. */
export const GATE_SERVER_CLASS = {
  [SERVER_NAME]: {
    [GATE_TOOL]: { reach: "gate", note: "TIF-265 verdict tool: takes a task id and run id only" },
  },
} as const;

export interface GatedTrialTransport {
  /**
   * Start the agent with exactly `plan` (the object that was audited) and give it `gate` as
   * its `myco-gate` server. Write `mcpConfigJson(plan)` to `plan.mcpConfigPath` first (the
   * audit pinned the argv's one `--mcp-config` to that path, but does not read the file).
   * Resolve only after the agent process and its servers exited.
   */
  runAgent(plan: AgentLaunchPlan, gate: Gate): Promise<void>;
  /**
   * After the agent stopped: host copies of what the oracle reads, as
   * `persisted/<task stateFile>`, plus any evidence kept for audit (`result.json`, …).
   */
  captureAfterStop(): Promise<CaptureInput>;
}

export interface GatedTrialOptions {
  readonly vault: VerdictVault;
  readonly runId: string;
  readonly taskId: string;
  readonly tasks: TaskRegistry;
  readonly plan: AgentLaunchPlan;
  readonly transport: GatedTrialTransport;
  readonly fixtures?: Readonly<Record<string, Uint8Array>>;
  /** Absolute host paths of the oracle's source files, hashed at seal time. */
  readonly oracleSources: readonly string[];
  readonly onDecision?: GateConfig["onDecision"];
  readonly onDiagnostic?: GateConfig["onDiagnostic"];
  readonly onIntegrity?: (violations: readonly IntegrityViolation[]) => void;
  /**
   * Agent-safe corrections (M2 scope add B), off when absent. The outcome's `corrections`
   * records the setting so the arm row can (`src/benchmark/gated-rows.ts`), and R1 evidence
   * refuses a row recorded "on" (`correctionsOnError`, `src/benchmark/check.ts`). This
   * function has no notion of an evidence run, so the ledger check is the enforcement point.
   */
  readonly corrections?: GateConfig["corrections"];
  /**
   * Capability track N: the trial's handoff broker. When present, the launch plan may start the
   * `myco-handoff` MCP server (its two tools are classified `agent-local` by
   * `HANDOFF_SERVER_CLASS`); when absent, a plan with the server fails the audit closed. Only
   * that one server class is added: this is not a general way to widen the audit. The broker
   * must be bound to this trial's `{ runId, taskId }`. Once the agent stopped, this function
   * closes the broker (a still-pending handoff is recorded `cancelled`) and puts its log on the
   * `decided` outcome as `handoffs`, so the run record's field comes from the broker, never
   * from a caller remembering to write it. The handoff never reaches the gate, the vault or the
   * verdict (docs/handoff/security.md §4).
   */
  readonly handoff?: GatedTrialHandoff;
}

/** The handoff side of one gated trial (track N). `HandoffBroker` satisfies `broker`. */
export interface GatedTrialHandoff {
  readonly broker: {
    readonly runId: string;
    readonly taskId: string;
    log(): HandoffLog;
    close(): void;
  };
  /**
   * The operator connection (file path and token). When given, the launch plan is refused
   * before anything is sealed if it names the file or carries the token
   * (`assertNoOperatorReach`, docs/handoff/security.md §2).
   */
  readonly operatorConnection?: { readonly path: string; readonly token: string };
}

export type GatedTrialOutcome =
  | { readonly status: "refused"; readonly audit: LaunchAudit }
  | {
      readonly status: "decided";
      readonly audit: LaunchAudit;
      readonly receipt: SealReceipt;
      readonly result: GateResult;
      /** Whether the gate had corrections on for this trial's task. */
      readonly corrections: "on" | "off";
      /** Track N: the broker's log, present exactly when the trial ran with `handoff`. */
      readonly handoffs?: HandoffLog;
    };

function frozenPlan(plan: AgentLaunchPlan): AgentLaunchPlan {
  const servers: Record<string, AgentLaunchPlan["mcpServers"][string]> = {};
  for (const [name, server] of Object.entries(plan.mcpServers))
    servers[name] = Object.freeze({
      command: server.command,
      args: Object.freeze([...server.args]),
      env: Object.freeze({ ...server.env }),
    });
  return Object.freeze({
    argv: Object.freeze([...plan.argv]),
    mcpServers: Object.freeze(servers),
    mcpConfigPath: plan.mcpConfigPath,
  });
}

export async function runGatedTrial(opts: GatedTrialOptions): Promise<GatedTrialOutcome> {
  const task = opts.tasks.get(opts.taskId);
  if (!task)
    throw new Error(
      `invalid gate assignment: task ${JSON.stringify(opts.taskId)} is not in the registry`,
    );
  // One copy, audited and launched: a caller mutating its plan afterwards changes neither.
  const plan = frozenPlan(opts.plan);
  const handoff = opts.handoff;
  if (handoff) {
    if (handoff.broker.runId !== opts.runId || handoff.broker.taskId !== task.id)
      throw new Error("invalid handoff broker: it is bound to a different trial");
    if (handoff.operatorConnection)
      assertNoOperatorReach(
        plan,
        handoff.operatorConnection.path,
        handoff.operatorConnection.token,
      );
  }
  const audit = auditAgentLaunch(plan, {
    runId: opts.runId,
    extraServers:
      handoff !== undefined ? { ...GATE_SERVER_CLASS, ...HANDOFF_SERVER_CLASS } : GATE_SERVER_CLASS,
  });
  if (!audit.ok) return { status: "refused", audit };

  const receipt = opts.vault.seal(opts.runId, {
    groundTruth: gateGroundTruth(task),
    fixtures: opts.fixtures ?? {},
    oracle: { id: `${task.family.id}@${task.family.version}`, sourceFiles: opts.oracleSources },
  });
  const gate = createSealedGate({
    tasks: opts.tasks,
    vault: opts.vault,
    binding: { runId: opts.runId, receipt },
    taskId: task.id,
    ...(opts.onDecision ? { onDecision: opts.onDecision } : {}),
    ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
    ...(opts.onIntegrity ? { onIntegrity: opts.onIntegrity } : {}),
    ...(opts.corrections ? { corrections: opts.corrections } : {}),
  });

  // A transport that rejects has not shown the agent stopped: no stop marker, no capture,
  // so the trial has no verdict (the vault stays at seal, and any later check is uncertain).
  try {
    await opts.transport.runAgent(plan, gate);
  } finally {
    // The agent stopped (or the transport failed): no handoff stays open past the attempt.
    handoff?.broker.close();
  }
  opts.vault.markAgentStopped(opts.runId);
  opts.vault.capture(opts.runId, await opts.transport.captureAfterStop());
  const result = await gate.check({ taskId: task.id, runId: opts.runId });
  const corrections = opts.corrections?.families.includes(task.family.id) ? "on" : "off";
  return {
    status: "decided",
    audit,
    receipt,
    result,
    corrections,
    ...(handoff ? { handoffs: handoff.broker.log() } : {}),
  };
}
