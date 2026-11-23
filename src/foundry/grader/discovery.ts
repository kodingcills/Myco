import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { armRegistry, discoveryPlanner } from "../baseline/registry.ts";
import { watchesPersistencePath } from "../guard.ts";
import { scoreTrial, type TrialInput } from "../oracles/blind.ts";
import { oracleForApp } from "../oracles/state.ts";
import { findTask, taskFixture } from "../tasks/bank.ts";
import type { GuardTraceEvent } from "../types.ts";
import { type Attestation, type AttestedBundle, bundleDigest, isAttestation } from "./attest.ts";

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

/**
 * Whether an attestation may make a row decision-eligible.
 *
 * `false` until an independent verifier PASSES the binding. The binding is present and
 * tested here, but a gate that has not been independently verified must not admit anything:
 * the whole point of the workstream is that a self-reported success is not evidence. Flipping
 * this is a separate, deliberate change made only after a PASS.
 */
export const ATTESTATION_BINDING_LANDED = false;

/** Read the binding through its accessor, so a throwing getter cannot escape. */
function readBindingSafely(attestation: Attestation): AttestedBundle | null {
  try {
    return readBinding(attestation.binding);
  } catch {
    return null;
  }
}

/** Digest the scored bytes, or `null` when they are not a file map. */
function digestSafely(files: unknown): string | null {
  try {
    return bundleDigest(files as Readonly<Record<string, Uint8Array>>);
  } catch {
    return null;
  }
}

/** Read a binding defensively: a Proxy trap must not escape as a throw. */
function readBinding(value: unknown): AttestedBundle | null {
  if (value === null || typeof value !== "object") return null;
  try {
    const { armId, taskId, promptHash, bundleDigest: digest } = value as AttestedBundle;
    if (
      typeof armId !== "string" ||
      typeof taskId !== "string" ||
      typeof promptHash !== "string" ||
      typeof digest !== "string"
    )
      return null;
    return { armId, taskId, promptHash, bundleDigest: digest };
  } catch {
    return null;
  }
}

/**
 * Score a discovery trial.
 *
 * `attestation` is the trusted-ingest gate (TIF-95). Without it the row is descriptive, as
 * before. With it, the row is decision-eligible only when the gate admits it — and the gate
 * resolves the fixture from the hidden commitment, so a caller cannot supply a benign one.
 * The gate never changes the verdict; it only decides whether the verdict may count.
 */
export function scoreDiscoveryTrial(
  evidence: DiscoveryTrialEvidence,
  input: Omit<TrialInput, "intent">,
  comparisonSettings: PlannerSettings,
  attestation?: Attestation,
) {
  // TOTAL. A malformed row is refused, never fatal: one bad row must not abort the batch.
  // `scoreTrial` throws on an invalid faultVersion, and a null `fixture`, `actual`, `trace`,
  // `screen` or `selfReport` throws on the way in, so the whole body is guarded rather than
  // each field (R6 round 3, finding 1).
  try {
    return scoreDiscoveryTrialUnsafe(evidence, input, comparisonSettings, attestation);
  } catch {
    return {
      armId: safeField(evidence, "armId"),
      taskId: safeField(evidence, "taskId"),
      promptHash: safeField(evidence, "promptHash"),
      planner: undefined,
      status: "excluded" as const,
      decisionEligible: false,
      reason: "malformed" as const,
    };
  }
}

/** A row for a trial record that could not even be read. */
function malformedRow() {
  return {
    armId: "(unreadable)",
    taskId: "(unreadable)",
    promptHash: "(unreadable)",
    planner: undefined,
    status: "excluded" as const,
    decisionEligible: false,
    reason: "malformed" as const,
  };
}

/** Read an identity field without letting a hostile accessor escape as a throw. */
function safeField(evidence: unknown, key: string): string {
  try {
    const value = (evidence as Record<string, unknown> | null | undefined)?.[key];
    return typeof value === "string" ? value : "(unreadable)";
  } catch {
    return "(unreadable)";
  }
}

function scoreDiscoveryTrialUnsafe(
  evidence: DiscoveryTrialEvidence,
  input: Omit<TrialInput, "intent">,
  comparisonSettings: PlannerSettings,
  attestation?: Attestation,
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
  if (!audit) {
    if (armId !== "hcu+shell")
      return { ...identity, status: "excluded" as const, decisionEligible: false, reason: "audit" };
    const reasons = ["Tool-call audit is incomplete or does not match the trace"];
    return {
      ...identity,
      status: "scored" as const,
      decisionEligible: false,
      reason: "audit",
      attestationBlockers: ["tool-call audit is incomplete or does not match the trace"],
      storeReads: null,
      result: {
        fixtureId: fixture.fixtureId,
        fixtureVersion: fixture.version,
        oracleVersion: oracleForApp(fixture.app).version,
        faultVersion: input.faultVersion,
        verdict: "uncertain" as const,
        falseSuccess: false,
        stateChecks: [],
        screenClaims: [],
        traceGuard: { status: "unknown" as const, reasons },
        reasons,
      },
    };
  }

  const result = scoreTrial({
    ...input,
    fixture,
    intent: task.intent,
    trace: audit.guardTrace,
    requireSavedBytes: armId === "hcu+shell",
  });
  // The gate decides eligibility; it never touches `result`. A refuted verdict stays
  // refuted whether or not the run is eligible, and an eligible run is not thereby verified.
  //
  // The runtime check matters as much as the type: an untyped caller can pass a literal
  // `{ eligible: true }` as `never`, and the brand is the only thing that distinguishes a
  // real attestation from a claim about one.
  //
  // FAIL CLOSED (TIF-125). `attestation.eligible` is the gate's claim about evidence that was
  // handed to it. The scorer holds the row, and it does not yet re-derive that evidence —
  // the gate verified a bundle the caller supplied, and nothing here proves it was THIS
  // bundle. Until TIF-125 lands the binding and the scorer recomputes `bundleDigest` from
  // `input.actual.files`, no row may be decision-eligible on the strength of an attestation.
  // `ATTESTATION_BINDING_LANDED` is the single switch to flip when that work merges.
  // The scorer re-derives the binding itself. It must not take the gate's word for which
  // row the evidence describes: it holds the row, so it recomputes the digest from the
  // bytes it is about to score and compares that to what the attestation claims (R6 1a).
  const attested = isAttestation(attestation);
  // Nothing here may throw: a throw aborts the whole comparison batch, so one malformed row
  // would take down every other row's score (R6 round 2, finding 3). That covers the
  // `binding` accessor itself, not just the value it returns, and the digest of malformed
  // files — `scoreTrial` handles both without throwing, so the scorer must too.
  const binding = attested ? readBindingSafely(attestation) : null;
  const bindsThisRow =
    binding !== null &&
    binding.armId === armId &&
    binding.taskId === taskId &&
    binding.promptHash === promptHash &&
    binding.bundleDigest === digestSafely(input.actual.files);
  if (attested && !bindsThisRow) {
    return {
      ...identity,
      status: "scored" as const,
      decisionEligible: false,
      attestationBlockers: [
        "binding: the attestation does not cover this row (R6 1a: the scorer re-derives the bundle digest)",
      ],
      storeReads: audit.storeReads,
      result,
    };
  }
  const eligible = ATTESTATION_BINDING_LANDED && attested && attestation.eligible;
  return {
    ...identity,
    status: "scored" as const,
    decisionEligible: eligible,
    // Always present, empty when eligible: a uniform shape means a reader cannot mistake
    // "no blockers recorded" for "no blockers existed".
    attestationBlockers: eligible
      ? []
      : !ATTESTATION_BINDING_LANDED && attested
        ? [
            "eligibility withheld: TIF-125 must bind the attestation to the scored row before this can count",
          ]
        : attested
          ? attestation.blockers
          : ["no attestation supplied"],
    ...(eligible
      ? { attestation: { observerId: attestation.observerId, accepted: attestation.accepted } }
      : { decisionBlocker: "trusted-live-artifacts-unavailable" as const }),
    storeReads: audit.storeReads,
    result,
  };
}

/**
 * Reuse the same comparison across batches and quota pauses.
 *
 * `attester` is required, not optional. A comparison that silently skipped the gate would
 * produce rows that look scored but were never admitted, which is the failure this whole
 * workstream exists to prevent (R6 round 2, finding 2). A caller that genuinely wants
 * descriptive rows calls `scoreDiscoveryTrial` directly and gets `decisionEligible: false`.
 */
export function createDiscoveryComparison(
  comparisonSettings: PlannerSettings,
  attester: (evidence: DiscoveryTrialEvidence, input: Omit<TrialInput, "intent">) => Attestation,
) {
  const pinnedSettings = structuredClone(comparisonSettings);
  return (
    trials: Iterable<{
      evidence: DiscoveryTrialEvidence;
      input: Omit<TrialInput, "intent">;
    }>,
  ) => {
    const results: ReturnType<typeof scoreDiscoveryTrial>[] = [];
    // Materialise first, guarded: a broken iterator ends the batch, but rows already
    // collected still score. Destructuring each record is guarded separately below, because
    // a null record or a throwing `evidence` accessor used to abort everything (round 1,
    // finding 2).
    const records: unknown[] = [];
    try {
      for (const record of trials) records.push(record);
    } catch {
      // A throwing iterator is a broken batch; score what we have.
    }
    for (const record of records) {
      let evidence: DiscoveryTrialEvidence;
      let input: Omit<TrialInput, "intent">;
      try {
        ({ evidence, input } = record as {
          evidence: DiscoveryTrialEvidence;
          input: Omit<TrialInput, "intent">;
        });
      } catch {
        results.push(malformedRow());
        continue;
      }
      // The attester is caller-supplied, so it can throw too. A throw there must cost one
      // row, not the batch.
      let attestation: Attestation | undefined;
      try {
        attestation = attester(evidence, input);
      } catch {
        attestation = undefined;
      }
      const trial = scoreDiscoveryTrial(evidence, input, pinnedSettings, attestation);
      results.push(trial);
      if (trial.status === "paused") break;
    }
    return results;
  };
}
