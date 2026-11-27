/**
 * Track R evaluation test helpers: a well-formed r-v1 pack built from the committed prereg
 * and fr-v1 manifest, with per-task outcomes chosen by the test. Every pack here is
 * SIMULATED unless a test asks for the pre-registered model id; none is evidence of anything.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  R_ARM,
  type RArm,
  type RInvocation,
  type RTrialRow,
  rV1Schedule,
} from "../../src/recording-eval/analysis.ts";
import { canonicalSha256, sha256Hex } from "../../src/recording-eval/canonical.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const PREREG_DIR = join(ROOT, "docs/product/capability-prereg/r-v1");
export const readPrereg = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(PREREG_DIR, "prereg.json"), "utf8"));
export const readManifest = (): {
  tasks: {
    taskId: string;
    demonstrationFamily: string;
    fixtureSha256: string;
    instructionSha256: string;
  }[];
} & Record<string, unknown> =>
  JSON.parse(readFileSync(join(PREREG_DIR, "fr-v1-manifest.json"), "utf8"));

export const FAMILIES = [
  "record-edit:name",
  "record-edit:qty",
  "record-edit:joined",
  "record-edit:salary",
];
export const recordingSha = (family: string) => sha256Hex(`recording:${family}`);

export interface Outcome {
  /** Grader status for this arm's trial. */
  readonly grade: "pass" | "fail" | "ungradable";
  readonly claim?: "done" | "not-done" | "no-claim";
  /** R arm only: the replay invocations; default one certified, verified-by-derived replay. */
  readonly invocations?: readonly RInvocation[];
}

export interface BuildOptions {
  readonly planner?: string;
  readonly simulatedDemo?: boolean;
  readonly withC1?: boolean;
  /**
   * Analyse against a copy of the committed prereg with `leadRulingPending` emptied (and the
   * pack's hash recomputed), as the prereg will read once the lead has ruled. Default false:
   * the committed prereg, whose pending rulings block every "shown".
   */
  readonly ruled?: boolean;
  /** Outcome per (task index, arm). Default: everyone fails. */
  readonly outcome?: (taskIndex: number, arm: RArm) => Outcome;
}

export function buildPack(options: BuildOptions = {}) {
  const committed = readPrereg();
  const prereg = options.ruled ? { ...committed, leadRulingPending: [] } : committed;
  const manifest = readManifest();
  const planner = options.planner ?? "simulated:scripted";
  const seeds = prereg.seeds as { assignment: string };
  const schedule = rV1Schedule(
    seeds.assignment,
    manifest.tasks.map((t) => t.taskId),
  );
  const arms: RArm[] = options.withC1 ? [R_ARM, "hcu+shell", "C1"] : [R_ARM, "hcu+shell"];
  const trials: RTrialRow[] = [];
  const grades: Record<string, unknown>[] = [];
  manifest.tasks.forEach((task, i) => {
    for (const arm of arms) {
      const o = options.outcome?.(i, arm) ?? { grade: "fail" };
      const trialKey = `r-v1-${task.taskId}-${arm}`;
      const persistedSha256 = sha256Hex(`doc:${trialKey}`);
      trials.push({
        schema: "myco.capability.r-trial/1",
        trialKey,
        taskId: task.taskId,
        arm,
        ordinal: schedule.get(`${task.taskId}|${arm}`) as number,
        plannerModelId: planner,
        stepBudget: 30,
        instructionSha256: task.instructionSha256,
        fixtureSha256: task.fixtureSha256,
        claim: o.claim ?? "done",
        persistedSha256,
        steps: 10,
        wallClockS: 60,
        costUsdEstimate: 0.01,
        cause: null,
        derived:
          arm === R_ARM
            ? {
                invocations: o.invocations ?? [
                  {
                    workflowId: `wf-${task.demonstrationFamily}`,
                    recordingSha256: recordingSha(task.demonstrationFamily),
                    certified: true,
                    refusal: null,
                    gateVerdict: o.grade === "pass" ? "verified" : "refuted",
                  },
                ],
              }
            : null,
      });
      grades.push({
        schema: "myco.benchmark.grade-row/1",
        trialKey,
        taskId: task.taskId,
        graderVersion: "false-completion-grader/1",
        status: o.grade,
        reasons: [],
        fixtureSha256: task.fixtureSha256,
        persistedSha256,
        target: "B2",
        targetSatisfied: o.grade === "pass",
        mismatchCount: o.grade === "pass" ? 0 : 1,
      });
    }
  });
  const pack = {
    schema: "myco.capability.r-pack/1",
    preregHash: canonicalSha256(prereg),
    preregCommit: "0".repeat(40),
    taskSetVersion: "fr-v1",
    manifestSha256: canonicalSha256(manifest),
    demonstrations: FAMILIES.map((family) => ({
      family,
      recordingSha256: recordingSha(family),
      simulated: options.simulatedDemo ?? planner.startsWith("simulated:"),
    })),
  };
  return { prereg, manifest, pack, trials, grades };
}

/** Outcome table: R verifies tasks [0, rOnly), base verifies [rOnly, rOnly + baseOnly). */
export const discordant =
  (rOnly: number, baseOnly: number, both = 0) =>
  (i: number, arm: RArm): Outcome => {
    if (i < rOnly) return { grade: arm === R_ARM ? "pass" : "fail" };
    if (i < rOnly + baseOnly) return { grade: arm === R_ARM ? "fail" : "pass" };
    if (i < rOnly + baseOnly + both) return { grade: "pass" };
    return { grade: "fail" };
  };
