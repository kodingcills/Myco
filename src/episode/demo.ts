/**
 * Writer hooks for the gate's mock demos (`myco-gate demo --transport mock`): every scenario
 * row becomes a SIMULATED episode in a simulated store. Mock rows are plumbing, never data
 * about an agent: `simulated: true`, source `demo-mock` / `demo-multistep-mock`.
 *
 * This module imports nothing from the grader: the demo families (todo-items,
 * calc-multi-step) have no independent grader, so ground truth is `no-independent-grader`,
 * and the gate CLI that calls these hooks stays out of the grader's import graph.
 */
import type { ReasonCode } from "../gate/api.ts";
import { REASON_CODES } from "../gate/api.ts";
import { type DemoReport, SCENARIOS } from "../gate/demo.ts";
import type { MsReport } from "../gate/multistep-demo.ts";
import { MS_TASK_ID } from "../gate/multistep-demo.ts";
import { NOT_RECORDED } from "./build.ts";
import { HARNESS_REASON_CODES } from "./gated.ts";
import { EpisodeRecorder } from "./recorder.ts";
import type { EpisodeStore, WriteResult } from "./store.ts";
import type { AgentClaim, EpisodeOutcome } from "./types.ts";

const KNOWN_CODES: ReadonlySet<string> = new Set(REASON_CODES);

function codes(raw: readonly string[]): ReasonCode[] {
  return raw.filter((c): c is ReasonCode => KNOWN_CODES.has(c));
}

function labelled(
  verdict: string,
  reasonCodes: readonly ReasonCode[],
): { outcome: EpisodeOutcome; fault: { class: "gate-harness-code"; code: string } | null } {
  const harness = reasonCodes.find((c) => HARNESS_REASON_CODES.has(c));
  if (harness !== undefined)
    return { outcome: "harness-fault", fault: { class: "gate-harness-code", code: harness } };
  if (verdict !== "verified" && verdict !== "refuted" && verdict !== "uncertain")
    throw new Error(`demo row has no gate verdict (${verdict})`);
  return { outcome: verdict, fault: null };
}

/** The demo agent "claims done" in prose; the claim it makes is done. */
const claimOf = (text: string): AgentClaim => (text.trim() === "" ? "no-claim" : "done");

function requireSimulated(store: EpisodeStore): void {
  if (!store.simulated)
    throw new Error("demo episodes are simulated: never written to a real store");
}

export function writeDemoEpisodes(report: DemoReport, store: EpisodeStore): WriteResult[] {
  requireSimulated(store);
  if (report.rows.length !== SCENARIOS.length)
    throw new Error("demo report does not match its scenarios");
  return report.rows.map((row, i) => {
    const scenario = SCENARIOS[i];
    if (scenario === undefined || scenario.name !== row.scenario)
      throw new Error(`demo row ${i} is not scenario ${scenario?.name ?? "?"}`);
    const reasonCodes = codes(row.reasonCodes);
    const { outcome, fault } = labelled(row.verdict, reasonCodes);
    const recorder = new EpisodeRecorder();
    if (row.uiStatus !== "") recorder.uiStatus(row.uiStatus, null);
    const snap = recorder.snapshot();
    return store.record({
      outcome,
      simulated: true,
      task: {
        id: scenario.taskId,
        family: "todo-items",
        taskSetVersion: null,
        faultClass: null,
        instruction: null,
        instructionSha256: null,
        fixtureSha256: null,
      },
      actions: NOT_RECORDED.actions,
      observations: snap.observations,
      agentClaim: claimOf(row.agentClaim),
      gate: {
        verdict: row.verdict as "verified" | "refuted" | "uncertain",
        accepted: row.accepted,
        reasonCodes,
        oracle: null,
      },
      groundTruth:
        outcome === "harness-fault"
          ? { source: "none", reason: "harness-fault" }
          : { source: "none", reason: "no-independent-grader" },
      harness: {
        arm: "myco-gate",
        plannerModelId: "simulated:scripted-demo",
        outputCeiling: null,
        corrections: "off",
        fault,
      },
      provenance: {
        source: "demo-mock",
        runId: scenario.runId,
        // The tamper scenario shares df-s02's run: the scenario index keeps rows distinct.
        trialKey: `demo-${i}-${scenario.taskId}`,
        attemptLedger: null,
      },
    });
  });
}

export function writeMultiStepDemoEpisodes(report: MsReport, store: EpisodeStore): WriteResult[] {
  requireSimulated(store);
  return report.rows.map((row) => {
    const last = row.trial.attempts[row.trial.attempts.length - 1];
    const reasonCodes = codes(last?.reasonCodes ?? []);
    const { outcome, fault } = labelled(row.trial.verdict, reasonCodes);
    return store.record({
      outcome,
      simulated: true,
      task: {
        id: MS_TASK_ID,
        family: "calc-multi-step",
        taskSetVersion: null,
        faultClass: null,
        instruction: null,
        instructionSha256: null,
        fixtureSha256: null,
      },
      ...NOT_RECORDED,
      agentClaim: last === undefined ? "no-claim" : claimOf(last.claim),
      gate: {
        verdict: row.trial.verdict,
        accepted: row.trial.accepted,
        reasonCodes,
        oracle: null,
      },
      groundTruth:
        outcome === "harness-fault"
          ? { source: "none", reason: "harness-fault" }
          : { source: "none", reason: "no-independent-grader" },
      harness: {
        arm: `myco-gate:${row.arm}`,
        plannerModelId: "simulated:scripted-demo",
        outputCeiling: null,
        // The multi-step demo's gate runs without `--corrections` (src/gate/multistep-demo.ts).
        corrections: "off",
        fault,
      },
      provenance: {
        source: "demo-multistep-mock",
        runId: row.runId,
        trialKey: row.runId,
        attemptLedger: null,
      },
    });
  });
}
