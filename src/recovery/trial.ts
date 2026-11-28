/**
 * Capability track K: one recovery trial (docs/product/capability-spec.md, "K. Recovery";
 * docs/recovery/recovery.md). The harness loop of #514 (`src/gate/multistep.ts`), extended
 * with the agent's recovery tools and ONE step budget shared across attempts.
 *
 * Arms (fixed here, not per call): `K` = recovery tools on, gate corrections on, retryBudget 1;
 * `no-recovery` = no tools, corrections off, retryBudget 0. Both arms call the gate at the end
 * of every attempt.
 *
 * Per attempt:
 *  1. the harness writes the host-generated document for the attempt into the guest (attempt
 *     1: checkpoint 0, the pristine fixture; the retry: the gate's last verified checkpoint,
 *     `retryCheckpoint`, harness-driven as in #514, never agent-picked);
 *  2. the agent runs with that document as its handed snapshot, the shared meter, and (K only)
 *     a fresh `RecoveryTools` instance, closed when the agent stops;
 *  3. the harness captures the saved document on the host (`capture` returns the sha256 of its
 *     own copy) and asks the gate bound to this trial;
 *  4. the harness checks the gate's result before believing it, and fails closed (`uncertain`,
 *     with a harness code, no retry) when: the result names another task or run
 *     (`GATE_BINDING_MISMATCH`); `accepted` disagrees with `verdict` (`GATE_RESULT_INCONSISTENT`);
 *     the document the gate read is not this attempt's fresh capture (`EVIDENCE_NOT_FRESH`); the
 *     no-recovery arm received corrections (`ARM_CORRECTIONS_MISMATCH`); or a harness step threw
 *     (`RESTORE_FAILED`, `AGENT_RUN_FAILED`, `CAPTURE_FAILED`, `GATE_CALL_FAILED`).
 *
 * The verdict is the gate's result for the last attempt, after those checks. The agent's only
 * input to it is its claim string; nothing a recovery tool returns or records reaches it.
 * Every attempt, failed, rolled back or harness-faulted, is kept in `attempts`, appended to the
 * attempt log as it runs, and counted in steps, time and cost; nothing is overwritten.
 */
import type { Correction, GateResult } from "../gate/api.ts";
import { retryCheckpoint } from "../gate/multistep.ts";
import { type GuestDocument, type RecoveryEvent, RecoveryTools, StepMeter } from "./tools.ts";

export const RECOVERY_ARMS = ["K", "no-recovery"] as const;
export type RecoveryArm = (typeof RECOVERY_ARMS)[number];

export interface RecoveryArmConfig {
  readonly recoveryTools: boolean;
  readonly corrections: "on" | "off";
  readonly retryBudget: 0 | 1;
}

/** The two arms, as the spec fixes them. */
export const ARM_CONFIG: Readonly<Record<RecoveryArm, RecoveryArmConfig>> = Object.freeze({
  K: Object.freeze({ recoveryTools: true, corrections: "on", retryBudget: 1 }),
  "no-recovery": Object.freeze({ recoveryTools: false, corrections: "off", retryBudget: 0 }),
});

/** The proposed shared step budget for long tasks (both arms). */
export const DEFAULT_STEP_BUDGET = 80;

export const HARNESS_CODES = [
  "RESTORE_FAILED",
  "AGENT_RUN_FAILED",
  "CAPTURE_FAILED",
  "GATE_CALL_FAILED",
  "GATE_BINDING_MISMATCH",
  "GATE_RESULT_INCONSISTENT",
  "EVIDENCE_NOT_FRESH",
  "ARM_CORRECTIONS_MISMATCH",
] as const;
export type HarnessCode = (typeof HARNESS_CODES)[number];

export interface RecoveryAttemptContext {
  readonly attempt: 1 | 2;
  readonly fromCheckpoint: number;
  /** The gate's corrections from the previous attempt (K only; empty otherwise). */
  readonly corrections: readonly Correction[];
  /** The trial's shared meter: the agent takes one step per action. */
  readonly meter: StepMeter;
  /** K only: this attempt's recovery tools. */
  readonly tools: RecoveryTools | null;
}

export interface AttemptLog {
  start(attempt: 1 | 2): void;
  end(
    attempt: 1 | 2,
    result: { outcome: "completed" } | { outcome: "harness-fault"; harnessClass: string },
  ): void;
}

export interface RecoveryHarness {
  /** The trial the gate is bound to. */
  readonly taskId: string;
  readonly runId: string;
  /** The host-generated document for a checkpoint (0 = pristine fixture). */
  handedDocument(checkpoint: number): Promise<Uint8Array>;
  /** The trial's guest document. */
  readonly guest: GuestDocument;
  /** Run the agent until it stops (process and servers exited). */
  runAgent(
    context: RecoveryAttemptContext,
  ): Promise<{ readonly claim: string; readonly costUsd?: number | null }>;
  /** After the agent stopped: copy the saved document to the evidence root; its sha256. */
  capture(attempt: 1 | 2): Promise<{ readonly sha256: string }>;
  /** Ask the gate bound to this trial. */
  checkGate(claim: string): Promise<GateResult>;
  readonly log?: AttemptLog;
  readonly now?: () => number;
}

export interface RecoveryAttemptRecord {
  readonly attempt: 1 | 2;
  readonly fromCheckpoint: number;
  readonly claim: string | null;
  /** The gate's own verdict (null when the gate was not reached). */
  readonly gateVerdict: GateResult["verdict"] | null;
  /** The verdict after the harness's checks: `uncertain` whenever `harnessCodes` is not empty. */
  readonly verdict: GateResult["verdict"];
  readonly accepted: boolean;
  readonly reasonCodes: readonly string[];
  readonly harnessCodes: readonly HarnessCode[];
  readonly checkpoints: GateResult["checkpoints"] | null;
  /** The harness's capture of this attempt (null when capture did not happen). */
  readonly capturedSha256: string | null;
  readonly correctionKinds: readonly Correction["kind"][];
  readonly steps: number;
  readonly elapsedMs: number;
  /** Agent-reported cost estimate; null when unknown (never read as 0). */
  readonly costUsd: number | null;
  readonly recoveryEvents: readonly RecoveryEvent[];
}

export interface RecoveryTrialRecord {
  readonly arm: RecoveryArm;
  readonly config: RecoveryArmConfig;
  readonly stepBudget: number;
  readonly attempts: readonly RecoveryAttemptRecord[];
  readonly verdict: GateResult["verdict"];
  readonly accepted: boolean;
  readonly steps: number;
  readonly elapsedMs: number;
  readonly costUsd: number | null;
}

/** The harness's checks on one gate result. Exported for tests. */
export function harnessChecks(
  result: GateResult,
  binding: { taskId: string; runId: string; capturedSha256: string; arm: RecoveryArm },
): HarnessCode[] {
  const codes: HarnessCode[] = [];
  if (result.request?.taskId !== binding.taskId || result.request?.runId !== binding.runId)
    codes.push("GATE_BINDING_MISMATCH");
  if (result.accepted !== (result.verdict === "verified")) codes.push("GATE_RESULT_INCONSISTENT");
  const read = (result.evidenceRefs ?? []).filter((r) => r.kind === "persisted-state");
  const fresh =
    read.length > 0 &&
    read.every((r) => r.runId === binding.runId && r.sha256 === binding.capturedSha256);
  // A gate that read a document must have read this attempt's capture; an accepted result
  // must rest on one.
  if ((read.length > 0 || result.accepted) && !fresh) codes.push("EVIDENCE_NOT_FRESH");
  if (ARM_CONFIG[binding.arm].corrections === "off" && (result.corrections?.length ?? 0) > 0)
    codes.push("ARM_CORRECTIONS_MISMATCH");
  return codes;
}

export async function runRecoveryTrial(
  harness: RecoveryHarness,
  options: { readonly arm: RecoveryArm; readonly stepBudget?: number },
): Promise<RecoveryTrialRecord> {
  if (!Object.hasOwn(ARM_CONFIG, options.arm))
    throw new Error(`unknown recovery arm ${JSON.stringify(options.arm)}`);
  const arm = options.arm;
  const config = ARM_CONFIG[arm];
  const meter = new StepMeter(options.stepBudget ?? DEFAULT_STEP_BUDGET);
  const now = harness.now ?? Date.now;
  const attempts: RecoveryAttemptRecord[] = [];

  let attempt: 1 | 2 = 1;
  let from = 0;
  let corrections: readonly Correction[] = [];
  for (;;) {
    const started = now();
    const stepsBefore = meter.used;
    harness.log?.start(attempt);
    const harnessCodes: HarnessCode[] = [];
    let tools: RecoveryTools | null = null;
    let claim: string | null = null;
    let costUsd: number | null = null;
    let capturedSha256: string | null = null;
    let result: GateResult | null = null;

    try {
      const handed = await harness.handedDocument(from);
      await harness.guest.write(handed);
      tools = config.recoveryTools
        ? new RecoveryTools({ document: harness.guest, handed, meter })
        : null;
    } catch {
      harnessCodes.push("RESTORE_FAILED");
    }
    if (harnessCodes.length === 0) {
      try {
        const out = await harness.runAgent({
          attempt,
          fromCheckpoint: from,
          corrections: config.corrections === "on" ? [...corrections] : [],
          meter,
          tools,
        });
        claim = typeof out.claim === "string" ? out.claim : "";
        costUsd =
          typeof out.costUsd === "number" && Number.isFinite(out.costUsd) && out.costUsd >= 0
            ? out.costUsd
            : null;
      } catch {
        harnessCodes.push("AGENT_RUN_FAILED");
      }
    }
    // The agent stopped: its tools end here, before anything is captured.
    tools?.close();
    if (harnessCodes.length === 0) {
      try {
        const cap = await harness.capture(attempt);
        capturedSha256 = typeof cap?.sha256 === "string" ? cap.sha256 : null;
        if (capturedSha256 === null) harnessCodes.push("CAPTURE_FAILED");
      } catch {
        harnessCodes.push("CAPTURE_FAILED");
      }
    }
    if (harnessCodes.length === 0) {
      try {
        result = await harness.checkGate(claim ?? "");
      } catch {
        harnessCodes.push("GATE_CALL_FAILED");
      }
    }
    if (result !== null)
      harnessCodes.push(
        ...harnessChecks(result, {
          taskId: harness.taskId,
          runId: harness.runId,
          capturedSha256: capturedSha256 ?? "",
          arm,
        }),
      );
    const faulted = harnessCodes.length > 0;
    const thrown = harnessCodes.find((c) => c.endsWith("_FAILED"));
    harness.log?.end(
      attempt,
      thrown === undefined
        ? { outcome: "completed" }
        : { outcome: "harness-fault", harnessClass: thrown },
    );
    const accepted = !faulted && result?.accepted === true;
    attempts.push({
      attempt,
      fromCheckpoint: from,
      claim,
      gateVerdict: result?.verdict ?? null,
      verdict: faulted ? "uncertain" : (result?.verdict ?? "uncertain"),
      accepted,
      reasonCodes: [...(result?.reasonCodes ?? [])],
      harnessCodes,
      checkpoints: result?.checkpoints ?? null,
      capturedSha256,
      correctionKinds: (result?.corrections ?? []).map((c) => c.kind),
      steps: meter.used - stepsBefore,
      elapsedMs: Math.max(0, now() - started),
      costUsd,
      recoveryEvents: tools?.events() ?? [],
    });

    const retry =
      !accepted &&
      !faulted &&
      result !== null &&
      attempt === 1 &&
      config.retryBudget === 1 &&
      meter.remaining > 0;
    if (!retry) break;
    from = retryCheckpoint(result as GateResult);
    corrections = (result as GateResult).corrections ?? [];
    attempt = 2;
  }

  const last = attempts[attempts.length - 1] as RecoveryAttemptRecord;
  const costs = attempts.map((a) => a.costUsd);
  return {
    arm,
    config,
    stepBudget: meter.budget,
    attempts,
    verdict: last.verdict,
    accepted: last.accepted,
    steps: meter.used,
    elapsedMs: attempts.reduce((s, a) => s + a.elapsedMs, 0),
    costUsd: costs.some((c) => c === null)
      ? null
      : costs.reduce<number>((s, c) => s + (c as number), 0),
  };
}
