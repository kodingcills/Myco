/** Track S s-v1 test fixtures: synthetic conformance results built from trg-v1's expectations. */
import type {
  MutationReport,
  Observed,
  ResultsFile,
  SV1Frozen,
} from "../../../src/schedule/conformance/analysis.ts";
import {
  buildTrgManifest,
  buildTrgV1,
  manifestSha256,
  type TrgCase,
} from "../../../src/schedule/conformance/trg-v1.ts";

export const CORPUS = buildTrgV1();
export const MANIFEST_SHA = manifestSha256(buildTrgManifest(CORPUS));
export const SCRIPT_SHA = "ab".repeat(32);

export const FROZEN: SV1Frozen = {
  preregSha256: "cd".repeat(32),
  corpusVersion: "trg-v1",
  manifestSha256: MANIFEST_SHA,
  mutationScriptSha256: SCRIPT_SHA,
  mutantCount: 3,
};

/** What a conforming run observes for case `c`. */
export function perfectObserved(c: TrgCase): Observed {
  const e = c.expected;
  const runs = Array.from({ length: e.executorCalls }, (_, i) => ({
    runId: `sched-x-${c.id}-${i}`,
    policiesAllowedBeforeStart: true,
    gateTrialBindings: 1,
    budgetAdmitted: true,
    ledgerRowsForRun: e.unwrittenRows.length > 0 ? 0 : 1,
    startedWhilePaused: false,
  }));
  return {
    startup: e.startup,
    startupRefusal: e.startupRefusal,
    executorCalls: e.executorCalls,
    ledgerRows: e.ledgerRows.map((r, i) => ({
      ...r,
      runId: runs[i]?.runId ?? null,
      reasonCodes: r.status === "verified" ? ["ORACLE_PASS"] : [],
      evidence: false,
    })),
    unwrittenRows: e.unwrittenRows,
    responses: e.responses,
    notifications: e.notifications,
    ledgerChainVerifies: true,
    runs,
    maxConcurrent: Math.min(1, e.executorCalls),
    concurrencyBudget: 1,
    markerLeaks: 0,
  };
}

export function perfectResults(
  edit: (id: string, o: Observed) => Observed = (_, o) => o,
): ResultsFile {
  return {
    schema: "myco.schedule.conformance-results/1",
    corpusVersion: "trg-v1",
    manifestSha256: MANIFEST_SHA,
    preregSha256: FROZEN.preregSha256,
    simulated: true,
    evidence: false,
    cases: CORPUS.map((c) => ({ caseId: c.id, observed: edit(c.id, perfectObserved(c)) })),
  };
}

export function mutation(
  rows = [
    { label: "a", status: "killed" },
    { label: "b", status: "killed" },
    { label: "c", status: "killed" },
  ],
): MutationReport {
  return { schema: "myco.schedule.mutation-report/1", scriptSha256: SCRIPT_SHA, rows };
}
