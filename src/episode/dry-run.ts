/**
 * Writer hook for the M2 R1 dry run (`runDryRun`, `src/benchmark/r1-dryrun.ts`; SIMULATED).
 * Called by `scripts/m2-r1-dryrun.ts` right after the run, so every dry-run trial gets an
 * episode without touching the dry run itself (#518 is changing that file).
 *
 * The source is what the dry run already wrote: its arm rows and `docs/<trialKey>.csv`. Every
 * episode is `simulated: true` and goes to a simulated store. The dry run's arm rows carry the
 * gate's verdict but not its reason codes, so `gate.reasonCodes` is null (not recorded), and
 * the scripted agent's actions are not seen (`not-recorded`). Ground truth is the independent
 * grader on the captured document against the published fixture; a document withheld as
 * unclean is not graded (`document-withheld`), since the grade could not be bound to it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkArmRow } from "../benchmark/check.ts";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import type { ReasonCode } from "../gate/api.ts";
import { NOT_RECORDED } from "./build.ts";
import { HARNESS_REASON_CODES } from "./gated.ts";
import { gradeCalcRecordEdit } from "./ground-truth.ts";
import { EpisodeRecorder } from "./recorder.ts";
import type { EpisodeStore, WriteResult } from "./store.ts";
import type { EpisodeGate, EpisodeOutcome } from "./types.ts";

export interface DryRunEpisodesInput {
  readonly tasks: readonly BenchmarkTask[];
  readonly armRows: readonly BenchmarkArmRow[];
  /** The dry run's output directory (holds `docs/<trialKey>.csv`). */
  readonly dryRunDir: string;
  /** The published bundle (holds `fixtures/<sha>.csv`). */
  readonly bundleDir: string;
  readonly store: EpisodeStore;
}

export function writeDryRunEpisodes(input: DryRunEpisodesInput): WriteResult[] {
  if (!input.store.simulated)
    throw new Error("dry-run episodes are simulated: they are never written to a real store");
  const results: WriteResult[] = [];
  for (const row of input.armRows) {
    const task = input.tasks.find((t) => t.taskId === row.taskId);
    if (task === undefined)
      throw new Error(`${row.trialKey}: task ${row.taskId} is not in the task set`);
    const doc = new Uint8Array(readFileSync(join(input.dryRunDir, "docs", `${row.trialKey}.csv`)));
    const recorder = new EpisodeRecorder();
    const kept = recorder.state("persisted", "text/csv", doc, null);
    const snap = recorder.snapshot();

    let outcome: EpisodeOutcome;
    let gate: EpisodeGate | null = null;
    let fault: { class: "gate-harness-code"; code: string | null } | null = null;
    const harnessDetail = row.cause?.kind === "harness" ? row.cause.detail : null;
    if (row.gate?.unregistrable === true) outcome = "unregistrable";
    else if (row.gate === null || !row.gate.called || row.gate.verdict === null)
      outcome = "launch-refused";
    else {
      gate = {
        verdict: row.gate.verdict,
        accepted: row.gate.verdict === "verified",
        reasonCodes: null,
        oracle: null,
      };
      const code = harnessDetail?.replace(/^gate: /, "") as ReasonCode | undefined;
      if (harnessDetail !== null) {
        outcome = "harness-fault";
        fault = {
          class: "gate-harness-code",
          code: code !== undefined && HARNESS_REASON_CODES.has(code) ? code : null,
        };
      } else outcome = row.gate.verdict;
    }
    const groundTruth =
      outcome === "harness-fault"
        ? ({ source: "none", reason: "harness-fault" } as const)
        : outcome === "launch-refused"
          ? ({ source: "none", reason: "agent-never-ran" } as const)
          : !kept
            ? ({ source: "none", reason: "document-withheld" } as const)
            : gradeCalcRecordEdit({
                fixtureCsv: new Uint8Array(readFileSync(join(input.bundleDir, task.fixtureFile))),
                fixtureSha256: task.fixtureSha256,
                intent: task.intent,
                columnTypes: task.columnTypes,
                persistedFormat: "csv",
              })(doc);
    const observations =
      outcome === "launch-refused" ? NOT_RECORDED.observations : snap.observations;
    results.push(
      input.store.record(
        {
          outcome,
          simulated: true,
          task: {
            id: task.taskId,
            family: task.family,
            taskSetVersion: task.taskSetVersion,
            faultClass: task.faultClass,
            instruction: task.instruction,
            instructionSha256: task.instructionSha256,
            fixtureSha256: task.fixtureSha256,
          },
          actions: NOT_RECORDED.actions,
          observations,
          agentClaim: row.claim,
          gate,
          groundTruth,
          harness: {
            arm: row.arm,
            plannerModelId: row.plannerModelId,
            outputCeiling: row.outputCeiling,
            corrections: row.gate?.corrections ?? "off",
            fault,
            timing: { wallClockS: row.cost.wallClockS, vmS: row.cost.vmS },
          },
          provenance: {
            source: "m2-dry-run",
            runId: `run-${task.taskId}`,
            trialKey: row.trialKey,
            attemptLedger: null,
          },
        },
        outcome === "launch-refused" ? new Map() : snap.blobs,
      ),
    );
  }
  return results;
}
