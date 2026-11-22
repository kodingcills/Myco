import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { armRegistry, discoveryPlanner } from "../baseline/registry.ts";
import { watchesPersistencePath } from "../guard.ts";
import { scoreTrial, type TrialInput } from "../oracles/blind.ts";
import { findTask, taskFixture } from "../tasks/bank.ts";
import type { GuardTraceEvent } from "../types.ts";

type Setting =
  | null
  | boolean
  | number
  | string
  | readonly Setting[]
  | {
      readonly [key: string]: Setting;
    };
type PlannerSettings = Readonly<Record<string, Setting>>;

interface PlannerEvidence {
  readonly model: string;
  readonly settings: PlannerSettings;
}

interface RecordedToolCall {
  readonly callId: string;
  readonly via: "gui" | "file-io" | "shell-exec";
}

interface ToolCallAudit extends RecordedToolCall {
  readonly status: "complete" | "incomplete";
  /** Resolved paths from the recorder, including indirect effects of shell calls. */
  readonly accesses: readonly { operation: "read" | "write"; path: string }[];
}

interface DiscoveryTrialEvidence {
  readonly armId: "myco" | (typeof armRegistry)[number]["id"];
  readonly taskId: string;
  readonly promptHash: string;
  readonly status: "finished" | "quota-exhausted";
  readonly planner?: PlannerEvidence;
  /** Invocation IDs from the harness, captured independently of the effect audit. */
  readonly recordedCalls?: readonly RecordedToolCall[];
  /** Final invocation count from the recorder after closing the trial. */
  readonly recordedCallCount?: number;
  readonly toolCallAudits?: readonly ToolCallAudit[];
}

function reconcileAudit(
  evidence: DiscoveryTrialEvidence,
  trace: readonly GuardTraceEvent[],
  watched: ReadonlySet<string>,
) {
  const { recordedCalls, recordedCallCount, toolCallAudits } = evidence;
  if (
    !Array.isArray(recordedCalls) ||
    recordedCalls.length !== recordedCallCount ||
    !Array.isArray(toolCallAudits)
  )
    return null;

  const calls = new Map<string, RecordedToolCall["via"]>();
  for (const call of recordedCalls as readonly RecordedToolCall[]) {
    if (
      !call ||
      typeof call.callId !== "string" ||
      !call.callId.trim() ||
      calls.has(call.callId) ||
      !["gui", "file-io", "shell-exec"].includes(call.via)
    )
      return null;
    calls.set(call.callId, call.via);
  }

  const audits = new Map<string, ToolCallAudit>();
  for (const audit of toolCallAudits as readonly ToolCallAudit[]) {
    if (
      !audit ||
      calls.get(audit.callId) !== audit.via ||
      audits.has(audit.callId) ||
      audit.status !== "complete" ||
      !Array.isArray(audit.accesses)
    )
      return null;
    audits.set(audit.callId, audit);
    for (const access of audit.accesses) {
      if (
        !access ||
        !["read", "write"].includes(access.operation) ||
        typeof access.path !== "string" ||
        !access.path.trim()
      )
        return null;
    }
  }
  if (audits.size !== calls.size) return null;

  const storeReads: (RecordedToolCall & {
    path: string;
    timestamp: string;
    traceIndex: number;
  })[] = [];
  const guardTrace: GuardTraceEvent[] = [];
  const seen = new Set<string>();
  let callIndex = 0;
  for (const [traceIndex, event] of trace.entries()) {
    guardTrace.push(event);
    if (
      event.type === "action" &&
      (!event.callId || !seen.has(event.callId) || calls.get(event.callId) !== "gui")
    )
      return null;
    if (event.type !== "tool-call") continue;

    const expected = recordedCalls[callIndex++];
    const audit = audits.get(event.callId);
    if (
      seen.has(event.callId) ||
      !audit ||
      expected?.callId !== event.callId ||
      expected.via !== event.via
    )
      return null;
    seen.add(event.callId);
    const { callId, via, timestamp } = event;
    for (const { operation, path } of audit.accesses) {
      if (!watchesPersistencePath(watched, path)) continue;
      if (operation === "read") storeReads.push({ callId, via, path, timestamp, traceIndex });
      else if (via !== "gui") guardTrace.push({ type: "file-write", via, path, timestamp });
    }
  }
  return seen.size === calls.size ? { guardTrace, storeReads } : null;
}

/** Score public evidence descriptively. This entry point has no trusted artifact ingress. */
export function scoreDiscoveryTrial(
  evidence: DiscoveryTrialEvidence,
  input: Omit<TrialInput, "intent">,
  comparisonSettings: PlannerSettings,
) {
  const { armId, taskId, promptHash, planner } = evidence;
  const identity = { armId, taskId, promptHash, planner };
  if (evidence.status === "quota-exhausted")
    return { ...identity, status: "paused" as const, decisionEligible: false, reason: "quota" };

  const task = findTask(taskId);
  if (
    evidence.status !== "finished" ||
    (armId !== "myco" && !armRegistry.some((arm) => arm.id === armId)) ||
    !task ||
    task.fixtureId !== input.fixture.fixtureId ||
    promptHash !== createHash("sha256").update(task.prompt).digest("hex")
  )
    return { ...identity, status: "excluded" as const, decisionEligible: false, reason: "task" };

  if (
    planner?.model !== discoveryPlanner ||
    !comparisonSettings ||
    Object.keys(comparisonSettings).length === 0 ||
    !isDeepStrictEqual(planner.settings, comparisonSettings)
  )
    return { ...identity, status: "excluded" as const, decisionEligible: false, reason: "planner" };

  const fixture = taskFixture(task);
  const audit = reconcileAudit(evidence, input.trace, new Set(fixture.persistenceFiles));
  if (!audit)
    return { ...identity, status: "excluded" as const, decisionEligible: false, reason: "audit" };

  const result = scoreTrial({
    ...input,
    fixture,
    intent: task.intent,
    trace: audit.guardTrace,
    requireSavedBytes: armId === "hcu+shell",
  });
  return {
    ...identity,
    status: "scored" as const,
    decisionEligible: false,
    decisionBlocker: "trusted-live-artifacts-unavailable" as const,
    storeReads: audit.storeReads,
    result,
  };
}

/** Reuse the same comparison across batches and quota pauses. */
export function createDiscoveryComparison(comparisonSettings: PlannerSettings) {
  const pinnedSettings = structuredClone(comparisonSettings);
  return (
    trials: Iterable<{
      evidence: DiscoveryTrialEvidence;
      input: Omit<TrialInput, "intent">;
    }>,
  ) => {
    const results: ReturnType<typeof scoreDiscoveryTrial>[] = [];
    for (const { evidence, input } of trials) {
      const trial = scoreDiscoveryTrial(evidence, input, pinnedSettings);
      results.push(trial);
      if (trial.status === "paused") break;
    }
    return results;
  };
}
