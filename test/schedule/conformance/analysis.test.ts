/** Track S s-v1: the property-bar analysis over trg-v1 results (pure; synthetic results, $0). */
import { describe, expect, it } from "vitest";
import {
  analyzeSV1,
  type Observed,
  SV1RefusalError,
} from "../../../src/schedule/conformance/analysis.ts";
import { CORPUS, FROZEN, mutation, perfectResults } from "./fixtures.ts";

const ID = "trg-v1-webhook-verified";
const OOS = "trg-v1-cron-ledger-write-fails";

function run(edit?: (id: string, o: Observed) => Observed, mut = mutation()) {
  return analyzeSV1(FROZEN, CORPUS, perfectResults(edit), mut);
}

/** Edit only case `id`. */
const only = (id: string, f: (o: Observed) => Observed) => (cid: string, o: Observed) =>
  cid === id ? f(o) : o;

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SV1RefusalError) return e.code;
    throw e;
  }
  return "NOT_REFUSED";
}

describe("s-v1 analysis: the bar holds only at 100%", () => {
  it("a fully conforming run reads 'property holds' with the case count and 0 bypasses", () => {
    const r = run();
    expect(r.verdict).toBe("property holds");
    expect(r.reasons).toEqual([]);
    expect(r.inScope).toEqual({ total: 88, passed: 88, failed: [] });
    expect(r.outOfScope).toEqual({ total: 4, matched: 4, mismatched: [] });
    expect(r.primary.bypasses).toBe(0);
    expect(r.primary.runs).toBeGreaterThan(0);
    expect(r.simulated).toBe(true);
    expect(r.evidence).toBe(false);
  });

  it("one in-scope counterexample fails the bar", () => {
    const r = run(only(ID, (o) => ({ ...o, notifications: o.notifications + 1 })));
    expect(r.verdict).toBe("not shown");
    expect(r.reasons).toEqual(["IN_SCOPE_CASE_FAILED"]);
    expect(r.inScope.failed).toEqual([ID]);
    expect(r.cases.find((c) => c.caseId === ID)?.failures).toEqual(["NOTIFICATIONS"]);
  });

  it.each([
    [
      "status",
      (o: Observed) => ({
        ...o,
        ledgerRows: o.ledgerRows.map((x) => ({ ...x, status: "refuted" as const })),
      }),
      "LEDGER_ROWS",
    ],
    ["executor calls", (o: Observed) => ({ ...o, executorCalls: 2 }), "EXECUTOR_CALLS"],
    [
      "responses",
      (o: Observed) => ({ ...o, responses: [{ status: 200, code: "ACCEPTED" }] }),
      "RESPONSES",
    ],
    ["startup", (o: Observed) => ({ ...o, startup: "refused" as const }), "STARTUP"],
  ])("a mismatch in %s is a counterexample", (_, f, code) => {
    const r = run(only(ID, f));
    expect(r.verdict).toBe("not shown");
    expect(r.cases.find((c) => c.caseId === ID)?.failures).toContain(code);
  });

  it("a row with the right status but the wrong codes is a counterexample", () => {
    const id = "trg-v1-manual-policy-denies";
    const r = run(
      only(id, (o) => ({
        ...o,
        ledgerRows: o.ledgerRows.map((x) => ({ ...x, codes: ["POLICY_DENIED"] })),
      })),
    );
    expect(r.verdict).toBe("not shown");
    expect(r.cases.find((c) => c.caseId === id)?.failures).toEqual(["LEDGER_ROWS"]);
  });

  it("an out-of-scope case that does not match its stated outcome fails the bar", () => {
    const r = run(only(OOS, (o) => ({ ...o, unwrittenRows: [] })));
    expect(r.verdict).toBe("not shown");
    expect(r.reasons).toEqual(["OUT_OF_SCOPE_MISMATCH"]);
    expect(r.outOfScope.mismatched).toEqual([OOS]);
  });

  it("the out-of-scope ledger-failure run is not counted as an in-scope bypass", () => {
    const r = run();
    expect(r.outOfScopeBypasses).toBe(4);
    expect(r.primary.bypasses).toBe(0);
  });

  it("a malformed observation fails its case", () => {
    const r = run(only(ID, () => ({ startup: "ok" }) as unknown as Observed));
    expect(r.cases.find((c) => c.caseId === ID)?.failures).toEqual(["MALFORMED_RESULT"]);
    expect(r.verdict).toBe("not shown");
  });

  it("a refused start with the wrong refusal code is a counterexample (N1)", () => {
    const id = "trg-v1-service-state-dir-locked";
    const r = run(only(id, (o) => ({ ...o, startupRefusal: "CONFIG_INVALID" })));
    expect(r.verdict).toBe("not shown");
    expect(r.cases.find((c) => c.caseId === id)?.failures).toEqual(["STARTUP_REFUSAL"]);
  });

  it.each([
    ["missing", undefined],
    ["negative", -1],
    ["fractional", 0.5],
    ["a string", "0"],
  ])("an observation with markerLeaks %s is malformed, never read as 0 leaks (N2)", (_, v) => {
    const r = run(only(ID, (o) => ({ ...o, markerLeaks: v as unknown as number })));
    expect(r.cases.find((c) => c.caseId === ID)?.failures).toEqual(["MALFORMED_RESULT"]);
    expect(r.verdict).toBe("not shown");
  });

  it("a run id reused in another case is a double run (N4)", () => {
    const a = "trg-v1-webhook-verified";
    const b = "trg-v1-manual-concurrency";
    const r = run((cid, o) =>
      cid === a || cid === b
        ? { ...o, runs: o.runs.map((x, i) => (i === 0 ? { ...x, runId: "shared-run" } : x)) }
        : o,
    );
    expect(r.invariants.doubleRuns).toBe(1);
    expect(r.reasons).toContain("DOUBLE_RUN");
  });

  it("a runs list that disagrees with the executor-call count fails its case", () => {
    const r = run(only(ID, (o) => ({ ...o, runs: [] })));
    expect(r.cases.find((c) => c.caseId === ID)?.failures).toContain("RUNS_INCONSISTENT");
  });
});

describe("s-v1 analysis: bypasses (primary) and invariants", () => {
  const firstRun = (f: (x: Observed["runs"][number]) => Observed["runs"][number]) =>
    only(ID, (o) => ({ ...o, runs: o.runs.map((x, i) => (i === 0 ? f(x) : x)) }));

  it.each([
    ["no allow from every policy", firstRun((x) => ({ ...x, policiesAllowedBeforeStart: false }))],
    ["gate bound to two trials", firstRun((x) => ({ ...x, gateTrialBindings: 2 }))],
    ["gate not bound", firstRun((x) => ({ ...x, gateTrialBindings: 0 }))],
    ["budget not admitted", firstRun((x) => ({ ...x, budgetAdmitted: false }))],
    ["no ledger row", firstRun((x) => ({ ...x, ledgerRowsForRun: 0 }))],
    ["two ledger rows", firstRun((x) => ({ ...x, ledgerRowsForRun: 2 }))],
  ])("%s is a bypass", (_, edit) => {
    const r = run(edit);
    expect(r.primary.bypasses).toBe(1);
    expect(r.reasons).toEqual(["BYPASS", "IN_SCOPE_CASE_FAILED"]);
  });

  it.each([
    [
      "a double run",
      only("trg-v1-manual-concurrency", (o) => ({
        ...o,
        runs: o.runs.map((x) => ({ ...x, runId: "same" })),
      })),
      "DOUBLE_RUN",
    ],
    [
      "a run started while paused",
      only(ID, (o) => ({ ...o, runs: o.runs.map((x) => ({ ...x, startedWhilePaused: true })) })),
      "RUN_WHILE_PAUSED",
    ],
    [
      "an accepted row without ORACLE_PASS",
      only(ID, (o) => ({ ...o, ledgerRows: o.ledgerRows.map((x) => ({ ...x, reasonCodes: [] })) })),
      "ACCEPTED_NOT_VERIFIED",
    ],
    [
      "a row claiming evidence",
      only(ID, (o) => ({ ...o, ledgerRows: o.ledgerRows.map((x) => ({ ...x, evidence: true })) })),
      "EVIDENCE_ROW",
    ],
    [
      "a concurrency overrun",
      only("trg-v1-inbox-concurrency", (o) => ({ ...o, maxConcurrent: 2 })),
      "CONCURRENCY_OVERRUN",
    ],
    [
      "a broken ledger chain",
      only(ID, (o) => ({ ...o, ledgerChainVerifies: false })),
      "CHAIN_FAILURE",
    ],
    ["a planted-marker leak", only(ID, (o) => ({ ...o, markerLeaks: 1 })), "MARKER_LEAK"],
  ])("%s fails the bar", (_, edit, code) => {
    const r = run(edit);
    expect(r.verdict).toBe("not shown");
    expect(r.reasons).toContain(code);
  });

  it("a marker leak in an out-of-scope case still fails the bar", () => {
    const r = run(only(OOS, (o) => ({ ...o, markerLeaks: 1 })));
    expect(r.reasons).toContain("MARKER_LEAK");
  });
});

describe("s-v1 analysis: the mutation table", () => {
  it("a surviving mutant fails the bar", () => {
    const r = run(
      undefined,
      mutation([
        { label: "a", status: "killed" },
        { label: "b", status: "SURVIVED" },
        { label: "c", status: "killed" },
      ]),
    );
    expect(r.reasons).toEqual(["MUTANT_SURVIVED"]);
    expect(r.mutation.notKilled).toEqual(["b"]);
  });

  it("a bad anchor is not a kill", () => {
    const r = run(
      undefined,
      mutation([
        { label: "a", status: "killed" },
        { label: "b", status: "BAD-ANCHOR(0)" },
        { label: "c", status: "killed" },
      ]),
    );
    expect(r.reasons).toEqual(["MUTANT_SURVIVED"]);
  });

  it("fewer mutants than pre-registered fails the bar", () => {
    const r = run(
      undefined,
      mutation([
        { label: "a", status: "killed" },
        { label: "b", status: "killed" },
      ]),
    );
    expect(r.reasons).toEqual(["MUTANT_COUNT", "MUTANT_MISSING"]);
    expect(r.mutation.missing).toEqual(["c | src/schedule/c.ts"]);
  });

  it("a duplicated label cannot stand in for a missing mutant", () => {
    const r = run(
      undefined,
      mutation([
        { label: "a", status: "killed" },
        { label: "a", status: "killed" },
        { label: "c", status: "killed" },
      ]),
    );
    expect(r.reasons).toEqual(["MUTANT_LABEL_DUPLICATE", "MUTANT_MISSING"]);
  });

  it("made-up labels (the right count, all killed) fail the bar (B2)", () => {
    const r = run(
      undefined,
      mutation([
        { label: "fake1", status: "killed" },
        { label: "fake2", status: "killed" },
        { label: "fake3", status: "killed" },
      ]),
    );
    expect(r.verdict).toBe("not shown");
    expect(r.reasons).toEqual(["MUTANT_MISSING", "MUTANT_UNKNOWN"]);
    expect(r.mutation.unknown).toHaveLength(3);
    expect(r.mutation.missing).toHaveLength(3);
  });

  it("one made-up label in place of a real one fails the bar", () => {
    const r = run(
      undefined,
      mutation([
        { label: "a", status: "killed" },
        { label: "b", status: "killed" },
        { label: "z", status: "killed" },
      ]),
    );
    expect(r.reasons).toEqual(["MUTANT_MISSING", "MUTANT_UNKNOWN"]);
    expect(r.mutation.unknown).toEqual(["z | src/schedule/z.ts"]);
    expect(r.mutation.missing).toEqual(["c | src/schedule/c.ts"]);
  });

  it("a real label reported against another file is not that mutant", () => {
    const r = run(
      undefined,
      mutation([
        { label: "a", status: "killed" },
        { label: "b", status: "killed" },
        { label: "c", status: "killed", file: "src/schedule/other.ts" },
      ]),
    );
    expect(r.reasons).toEqual(["MUTANT_MISSING", "MUTANT_UNKNOWN"]);
  });
});

describe("s-v1 analysis: pending lead rulings (B1)", () => {
  it("a conforming run reads 'not shown' with LEAD_RULING_PENDING while any ruling is pending", () => {
    const frozen = { ...FROZEN, leadRulingPending: ["Ratification of S's property bar itself."] };
    const r = analyzeSV1(frozen, CORPUS, perfectResults(), mutation());
    expect(r.verdict).toBe("not shown");
    expect(r.reasons).toEqual(["LEAD_RULING_PENDING"]);
    expect(r.leadRulingPending).toEqual(frozen.leadRulingPending);
  });

  it("with no ruling pending the same run reads 'property holds'", () => {
    const r = analyzeSV1(FROZEN, CORPUS, perfectResults(), mutation());
    expect(r.verdict).toBe("property holds");
    expect(r.leadRulingPending).toEqual([]);
  });

  it.each([
    ["no pending list", { ...FROZEN, leadRulingPending: undefined }],
    ["a pending list that is not strings", { ...FROZEN, leadRulingPending: [1] }],
    ["no mutant set", { ...FROZEN, mutants: undefined }],
    ["an empty mutant set", { ...FROZEN, mutants: [] }],
  ])("a frozen record with %s is refused, never read as 'nothing pending'", (_, frozen) => {
    expect(
      refusal(() =>
        analyzeSV1(frozen as unknown as typeof FROZEN, CORPUS, perfectResults(), mutation()),
      ),
    ).toBe("PREREG_SCHEMA");
  });
});

describe("s-v1 analysis: input that cannot be analysed is refused", () => {
  const base = () => perfectResults();
  it.each([
    ["a results file claiming evidence", { ...base(), evidence: true }, "EVIDENCE_CLAIM_REFUSED"],
    ["a results file not simulated", { ...base(), simulated: false }, "NOT_SIMULATED"],
    ["another corpus version", { ...base(), corpusVersion: "trg-v2" }, "CORPUS_VERSION_MISMATCH"],
    ["another manifest", { ...base(), manifestSha256: "00".repeat(32) }, "MANIFEST_MISMATCH"],
    ["another pre-registration", { ...base(), preregSha256: "00".repeat(32) }, "PREREG_MISMATCH"],
    ["the wrong schema", { ...base(), schema: "x" }, "RESULTS_SCHEMA"],
    ["a missing case", { ...base(), cases: base().cases.slice(1) }, "MISSING_CASE"],
    [
      "an unknown case",
      { ...base(), cases: [...base().cases, { caseId: "trg-v1-x", observed: {} }] },
      "UNKNOWN_CASE",
    ],
    [
      "a duplicate case",
      { ...base(), cases: [...base().cases, base().cases[0]] },
      "DUPLICATE_CASE",
    ],
  ])("%s", (_, results, code) => {
    expect(refusal(() => analyzeSV1(FROZEN, CORPUS, results, mutation()))).toBe(code);
  });

  it("a mutation report from another script is refused", () => {
    const m = { ...mutation(), scriptSha256: "00".repeat(32) };
    expect(refusal(() => analyzeSV1(FROZEN, CORPUS, perfectResults(), m))).toBe(
      "MUTATION_SCRIPT_MISMATCH",
    );
  });

  it("a mutation row without its file is refused", () => {
    const m = mutation();
    const rows = m.rows.map(({ label, status }) => ({ label, status }));
    expect(refusal(() => analyzeSV1(FROZEN, CORPUS, perfectResults(), { ...m, rows }))).toBe(
      "MUTATION_SCHEMA",
    );
  });
});
