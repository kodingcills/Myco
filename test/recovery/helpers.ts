/**
 * Test harness for track K: a REAL in-process gate (myco.gate/v1, calc-multi-step, bound to
 * one trial), a host-side evidence root, a guest document outside it, and a scripted agent.
 * No VM, no model, no network.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GateResult } from "../../src/gate/api.ts";
import { type CellEdit, documentCsv } from "../../src/gate/calc-document.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { MS_SPEC } from "../../src/gate/multistep-demo.ts";
import type {
  RecoveryArm,
  RecoveryAttemptContext,
  RecoveryHarness,
  RecoveryTrialRecord,
} from "../../src/recovery/trial.ts";
import { runRecoveryTrial } from "../../src/recovery/trial.ts";

export const TASK = "calc-ms-k";
export const STATE = "sheet.csv";
export const SEED = MS_SPEC.fixtureSeed;
export const STEPS = MS_SPEC.steps;
/** A cell no step targets: writing it is collateral damage. */
export const COLLATERAL: CellEdit = { rowKey: "EMP-0001", column: "name", newValue: "Scratch" };

export const doc = (edits: readonly CellEdit[]) => documentCsv(SEED, edits);
export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export interface World {
  readonly root: string;
  readonly evidence: string;
  readonly guestFile: string;
  readonly capturedFile: string;
  readonly runId: string;
  readonly log: string[];
  readonly results: GateResult[];
  readonly harness: RecoveryHarness;
  /** Write a whole document into the guest (what the agent's edits amount to). */
  setGuest(edits: readonly CellEdit[]): void;
  guestText(): string;
}

export type Agent = (
  ctx: RecoveryAttemptContext,
  w: World,
) => Promise<{ claim: string; costUsd?: number | null }>;

export function world(
  agent: Agent,
  opts: {
    corrections?: boolean;
    runId?: string;
    overrides?: Partial<RecoveryHarness>;
  } = {},
): World {
  const root = mkdtempSync(join(tmpdir(), "myco-recovery-test-"));
  const runId = opts.runId ?? "k-run-1";
  const evidence = join(root, "evidence");
  const guestFile = join(root, "guest", runId, STATE);
  const capturedFile = join(evidence, runId, STATE);
  mkdirSync(dirname(guestFile), { recursive: true });
  mkdirSync(evidence, { recursive: true });
  const gate = createGate({
    tasks: buildRegistry([
      { id: TASK, family: "calc-multi-step", stateFile: STATE, spec: MS_SPEC },
    ]),
    reader: fileEvidenceReader(evidence),
    assignment: { taskId: TASK, runId },
    ...(opts.corrections ? { corrections: { families: ["calc-multi-step"] } } : {}),
  });
  const log: string[] = [];
  const results: GateResult[] = [];
  const w: World = {
    root,
    evidence,
    guestFile,
    capturedFile,
    runId,
    log,
    results,
    setGuest: (edits) => writeFileSync(guestFile, doc(edits)),
    guestText: () => readFileSync(guestFile, "utf8"),
    harness: {
      taskId: TASK,
      runId,
      handedDocument: async (k) => new TextEncoder().encode(doc(STEPS.slice(0, k))),
      guest: {
        read: async () => new Uint8Array(readFileSync(guestFile)),
        write: async (bytes) => writeFileSync(guestFile, bytes),
      },
      runAgent: (ctx) => agent(ctx, w),
      capture: async () => {
        mkdirSync(dirname(capturedFile), { recursive: true });
        copyFileSync(guestFile, capturedFile);
        return { sha256: sha(readFileSync(capturedFile)) };
      },
      checkGate: async (claim) => {
        const r = await gate.check({ taskId: TASK, runId, claim });
        results.push(r);
        return r;
      },
      log: {
        start: (a) => log.push(`start ${a}`),
        end: (a, r) =>
          log.push(
            `end ${a} ${r.outcome}${r.outcome === "harness-fault" ? ` ${r.harnessClass}` : ""}`,
          ),
      },
      ...opts.overrides,
    },
  };
  return w;
}

export async function run(
  agent: Agent,
  arm: RecoveryArm,
  opts: Parameters<typeof world>[1] & { stepBudget?: number } = {},
): Promise<{ record: RecoveryTrialRecord; w: World }> {
  const w = world(agent, { corrections: arm === "K", ...opts });
  const record = await runRecoveryTrial(w.harness, {
    arm,
    ...(opts.stepBudget === undefined ? {} : { stepBudget: opts.stepBudget }),
  });
  return { record, w };
}

/** Take `n` steps from the meter (an agent's actions); false when the budget ran out. */
export function steps(ctx: RecoveryAttemptContext, n: number): boolean {
  for (let i = 0; i < n; i++) if (!ctx.meter.take()) return false;
  return true;
}
