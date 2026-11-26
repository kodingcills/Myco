/**
 * The gate on TIF-266's verdict vault (TIF-274 prerequisite; #470 follow-up F2, #471/#478
 * follow-up F2).
 *
 * A gated run's gate reads persisted state from exactly one place: the sealed host capture
 * of the one trial it is bound to. `createSealedGate` builds a TIF-265 gate whose
 * assignment run id IS the binding's run id and whose reader is `sealedEvidenceReader`, so:
 *
 * - The agent's request is checked against the assignment first (ASSIGNMENT_MISMATCH, nothing
 *   read). The reader then opens the vault only through `openForTrial`, for `binding.runId`
 *   with `binding.receipt`, and refuses any other run id itself (defence in depth). No value
 *   the agent sends selects another trial's sealed bytes.
 * - The bytes the family oracle sees are `captured/persisted/<stateFile>` from the vault,
 *   copied on the host after the agent stopped and hash-checked in the same read.
 * - The task spec the gate holds must be the one sealed for this trial (the ground truth is
 *   `gateGroundTruth(task)`): a registry spec that differs from the sealed one is refused.
 * - Before capture (the agent calling the gate mid-run) the answer is `uncertain`
 *   STATE_UNREADABLE: the gate decides only from the capture taken after the agent stops.
 *
 * Agent-facing details carry `integrity:<code>` only (#478/#480): a violation's path can be
 * an absolute host path. The full violations go to the operator through `onIntegrity`.
 *
 * `fileEvidenceReader` (`./gate.ts`) stays as the mock-path stand-in only.
 */

import { integrityCodes, openForTrial, type TrialBinding } from "../integrity/gate.ts";
import type { IntegrityViolation, VerdictVault } from "../integrity/vault.ts";
import {
  createGate,
  type EvidenceReader,
  type Gate,
  type GateConfig,
  type GateTask,
  STATE_FILE_LIMIT,
  specDigest,
} from "./gate.ts";

export const GATE_GROUND_TRUTH_KIND = "myco.gate.trial/v1";

/** What a gated trial seals as its ground truth: the task the gate will decide, in full. */
export interface GateGroundTruth {
  readonly kind: typeof GATE_GROUND_TRUTH_KIND;
  readonly taskId: string;
  readonly family: string;
  readonly familyVersion: string;
  readonly stateFile: string;
  readonly spec: unknown;
}

export function gateGroundTruth(task: GateTask): GateGroundTruth {
  return {
    kind: GATE_GROUND_TRUTH_KIND,
    taskId: task.id,
    family: task.family.id,
    familyVersion: task.family.version,
    stateFile: task.stateFile,
    spec: structuredClone(task.spec),
  };
}

/** Why the sealed ground truth does not describe `task`, or undefined when it does. */
function groundTruthProblem(sealed: unknown, task: GateTask): string | undefined {
  if (typeof sealed !== "object" || sealed === null) return "sealed ground truth is not an object";
  const gt = sealed as Partial<Record<keyof GateGroundTruth, unknown>>;
  if (gt.kind !== GATE_GROUND_TRUTH_KIND) return "sealed ground truth is not a gate trial";
  if (gt.taskId !== task.id) return "sealed task differs from the gate's task";
  if (gt.family !== task.family.id || gt.familyVersion !== task.family.version)
    return "sealed oracle family differs from the gate's";
  if (gt.stateFile !== task.stateFile) return "sealed state file differs from the gate's";
  if (specDigest(gt.spec) !== task.specSha256) return "sealed spec differs from the gate's";
  return undefined;
}

export interface SealedReaderOptions {
  readonly vault: VerdictVault;
  readonly binding: TrialBinding;
  readonly task: GateTask;
  /** Operator-only: the full violations (with paths) when an integrity check fails. */
  readonly onIntegrity?: (violations: readonly IntegrityViolation[]) => void;
}

const BEFORE_CAPTURE = new Set(["integrity:agent-not-stopped", "integrity:capture-missing"]);

/**
 * The gated run's evidence reader: the bound trial's sealed capture and nothing else. The
 * `runId` the gate passes is compared with the binding and never used to open the vault.
 */
export function sealedEvidenceReader(opts: SealedReaderOptions): EvidenceReader {
  const { vault, binding, task } = opts;
  const report = (violations: readonly IntegrityViolation[]) => {
    try {
      opts.onIntegrity?.(violations);
    } catch {
      // Diagnostics never change a verdict.
    }
  };
  return {
    describe: `sealed vault capture for the bound trial (task ${task.id})`,
    async read(runId, stateFile) {
      if (stateFile !== task.stateFile)
        return { ok: false, cause: "unreadable", detail: "not the bound task's state file" };
      const opened = openForTrial(vault, binding, runId);
      if (!opened.ok) {
        report(opened.violations);
        const codes = integrityCodes(opened.violations);
        const early = codes.length > 0 && codes.every((code) => BEFORE_CAPTURE.has(code));
        return {
          ok: false,
          cause: "unreadable",
          detail: early
            ? `no sealed capture yet: the gate decides from the host capture taken after the agent stops (${codes.join(", ")})`
            : `integrity check failed (${codes.join(", ")})`,
        };
      }
      const problem = groundTruthProblem(opened.inputs.groundTruth, task);
      if (problem) return { ok: false, cause: "unreadable", detail: `integrity: ${problem}` };
      const { persisted } = opened.inputs;
      if (!Object.hasOwn(persisted, stateFile))
        return {
          ok: false,
          cause: "missing",
          detail: `${stateFile} was not in the sealed capture`,
        };
      const bytes = persisted[stateFile] as Uint8Array;
      // The mock reader's limit, on the sealed path too (track H, H-06): an oversized capture
      // never reaches the oracle, and the two readers agree on the same bytes.
      if (bytes.length > STATE_FILE_LIMIT)
        return {
          ok: false,
          cause: "unreadable",
          detail: `persisted state is larger than ${STATE_FILE_LIMIT} bytes`,
        };
      return { ok: true, bytes };
    },
  };
}

export interface SealedGateConfig extends Omit<GateConfig, "reader" | "assignment"> {
  readonly vault: VerdictVault;
  /** The operator's binding: the trial's run id and the receipt `vault.seal` returned. */
  readonly binding: TrialBinding;
  /** The task this trial runs. The gate's assignment is `{ taskId, runId: binding.runId }`. */
  readonly taskId: string;
  readonly onIntegrity?: SealedReaderOptions["onIntegrity"];
}

/** A gate bound to one sealed trial. Throws when the task is not in the registry. */
export function createSealedGate(config: SealedGateConfig): Gate {
  const { vault, binding, taskId, onIntegrity, ...rest } = config;
  const task = config.tasks.get(taskId);
  if (!task)
    throw new Error(
      `invalid gate assignment: task ${JSON.stringify(taskId)} is not in the registry`,
    );
  return createGate({
    ...rest,
    assignment: { taskId, runId: binding.runId },
    reader: sealedEvidenceReader({
      vault,
      binding,
      task,
      ...(onIntegrity ? { onIntegrity } : {}),
    }),
  });
}
