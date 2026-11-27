/**
 * Track S: the s-v1 analysis. It checks S's property bar (capability-spec-2 §2 S) over a
 * conformance results file for `trg-v1` and a mutation report.
 *
 * Pure: no file system, no clock, no network. `scripts/s-v1-analysis.ts` reads the files,
 * verifies the pre-registration and calls `analyzeSV1`.
 *
 * The bar passes ("property holds") only when all of these are true:
 *  - every in-scope case's observed outcome matches its expected outcome, at 100%, with the
 *    case count stated. One counterexample fails it (spec-2 §1.1 item 2);
 *  - every out-of-scope case matches its stated outcome, so the limit is tested, not hidden
 *    (§1.1 item 4). A mismatch there also fails the bar;
 *  - the primary metric, bypasses, is 0 over the in-scope runs. A run is a bypass when it
 *    started without an allow from every policy, without a gate bound to exactly one trial,
 *    without passing its budget checks, or without exactly one chained ledger row (bar item 1);
 *  - there are 0 double runs, 0 runs started while paused, 0 accepted rows that are not verified
 *    with ORACLE_PASS, 0 rows claiming evidence, 0 concurrency overruns, 0 ledger chain failures
 *    and 0 marker leaks, in every case (bar items 1-5);
 *  - the mutation report covers exactly the pre-registered mutant count, with unique labels,
 *    its rows are exactly the frozen proof script's mutants (label and file; a made-up or
 *    missing mutant fails it), and every mutant is killed (bar item 6);
 *  - no lead ruling is pending in the pre-registration. While any is, the verdict is "not
 *    shown" with LEAD_RULING_PENDING, whatever the data says (the bar is not yet ratified).
 *
 * Run ids must be unique across the whole results file: a run id reused in another case
 * counts as a double run.
 *
 * Anything else reads "not shown", with codes saying why. Input that cannot be analysed at all
 * (the wrong corpus, prereg or manifest; missing, duplicate or unknown case ids; a file that
 * claims evidence) is refused with `SV1RefusalError`, never analysed. Property-bar rows come
 * from scripted runs: they prove the mechanism, never agent capability, and are never evidence.
 */

import type { ExpectedResponse, ExpectedRow, TrgCase } from "./trg-v1.ts";

export const RESULTS_SCHEMA = "myco.schedule.conformance-results/1" as const;
export const MUTATION_SCHEMA = "myco.schedule.mutation-report/1" as const;
export const REPORT_SCHEMA = "myco.schedule.s-v1-report/1" as const;

export class SV1RefusalError extends Error {
  override name = "SV1RefusalError";
  constructor(readonly code: string) {
    super(code);
  }
}

export interface ObservedRow extends ExpectedRow {
  readonly runId: string | null;
  readonly reasonCodes: readonly string[];
  readonly evidence: boolean;
}

export interface ObservedRun {
  readonly runId: string;
  /** Every configured policy returned allow before the executor started. */
  readonly policiesAllowedBeforeStart: boolean;
  /** Trials the gate was bound to for this run (exactly 1 is required). */
  readonly gateTrialBindings: number;
  /** Runs/day and concurrency admitted this run before it started. */
  readonly budgetAdmitted: boolean;
  /** Chained ledger rows carrying this run id. */
  readonly ledgerRowsForRun: number;
  readonly startedWhilePaused: boolean;
}

export interface Observed {
  readonly startup: "ok" | "refused";
  readonly startupRefusal: string | null;
  readonly executorCalls: number;
  readonly ledgerRows: readonly ObservedRow[];
  readonly unwrittenRows: readonly ExpectedRow[];
  readonly responses: readonly ExpectedResponse[];
  readonly notifications: number;
  readonly ledgerChainVerifies: boolean;
  readonly runs: readonly ObservedRun[];
  readonly maxConcurrent: number;
  readonly concurrencyBudget: number;
  /** Planted markers found in any response, row, claim, notification, diagnostic, CLI output or state file. */
  readonly markerLeaks: number;
}

export interface CaseResult {
  readonly caseId: string;
  readonly observed: unknown;
}

export interface ResultsFile {
  readonly schema: typeof RESULTS_SCHEMA;
  readonly corpusVersion: string;
  readonly manifestSha256: string;
  readonly preregSha256: string;
  readonly simulated: true;
  readonly evidence: false;
  readonly cases: readonly CaseResult[];
}

export interface MutantRef {
  readonly label: string;
  readonly file: string;
}

export interface MutationReport {
  readonly schema: typeof MUTATION_SCHEMA;
  readonly scriptSha256: string;
  readonly rows: readonly (MutantRef & { readonly status: string })[];
}

export interface SV1Frozen {
  readonly preregSha256: string;
  readonly corpusVersion: string;
  readonly manifestSha256: string;
  readonly mutationScriptSha256: string;
  readonly mutantCount: number;
  /**
   * The mutants (label and file) of the frozen mutation proof script, parsed from that script
   * after its SHA-256 is checked. The report's rows must be exactly this set.
   */
  readonly mutants: readonly MutantRef[];
  /** The pre-registration's `leadRulingPending`. While non-empty, the bar never reads "property holds". */
  readonly leadRulingPending: readonly string[];
}

export interface CaseVerdict {
  readonly caseId: string;
  readonly inScope: boolean;
  readonly pass: boolean;
  /** Codes, sorted: which expectation or invariant failed. Empty when it passed. */
  readonly failures: readonly string[];
}

export interface SV1Report {
  readonly schema: typeof REPORT_SCHEMA;
  readonly preregSha256: string;
  readonly corpusVersion: string;
  readonly manifestSha256: string;
  readonly verdict: "property holds" | "not shown";
  readonly reasons: readonly string[];
  readonly inScope: {
    readonly total: number;
    readonly passed: number;
    readonly failed: readonly string[];
  };
  readonly outOfScope: {
    readonly total: number;
    readonly matched: number;
    readonly mismatched: readonly string[];
  };
  readonly primary: { readonly bypasses: number; readonly runs: number };
  readonly outOfScopeBypasses: number;
  readonly invariants: {
    readonly doubleRuns: number;
    readonly runsWhilePaused: number;
    readonly acceptedNotVerified: number;
    readonly evidenceRows: number;
    readonly concurrencyOverruns: number;
    readonly chainFailures: number;
    readonly markerLeaks: number;
  };
  readonly mutation: {
    readonly expected: number;
    readonly reported: number;
    readonly killed: number;
    readonly notKilled: readonly string[];
    /** Reported rows that are not a mutant of the frozen script (label and file). */
    readonly unknown: readonly string[];
    /** Mutants of the frozen script with no reported row. */
    readonly missing: readonly string[];
  };
  /** The pre-registration's pending lead rulings; any one keeps the verdict at "not shown". */
  readonly leadRulingPending: readonly string[];
  readonly cases: readonly CaseVerdict[];
  readonly simulated: true;
  readonly evidence: false;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNat = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function isRow(v: unknown): v is ExpectedRow {
  return (
    isObj(v) && typeof v.status === "string" && isStrArr(v.codes) && typeof v.accepted === "boolean"
  );
}

function isObservedRow(v: unknown): v is ObservedRow {
  return (
    isRow(v) &&
    isObj(v) &&
    (v.runId === null || typeof v.runId === "string") &&
    isStrArr(v.reasonCodes) &&
    typeof v.evidence === "boolean"
  );
}

function isRun(v: unknown): v is ObservedRun {
  return (
    isObj(v) &&
    typeof v.runId === "string" &&
    typeof v.policiesAllowedBeforeStart === "boolean" &&
    isNat(v.gateTrialBindings) &&
    typeof v.budgetAdmitted === "boolean" &&
    isNat(v.ledgerRowsForRun) &&
    typeof v.startedWhilePaused === "boolean"
  );
}

/** Strict shape check of one case's observation; `undefined` means malformed. */
export function parseObserved(v: unknown): Observed | undefined {
  if (!isObj(v)) return undefined;
  const ok =
    (v.startup === "ok" || v.startup === "refused") &&
    (v.startupRefusal === null || typeof v.startupRefusal === "string") &&
    isNat(v.executorCalls) &&
    Array.isArray(v.ledgerRows) &&
    v.ledgerRows.every(isObservedRow) &&
    Array.isArray(v.unwrittenRows) &&
    v.unwrittenRows.every(isRow) &&
    Array.isArray(v.responses) &&
    v.responses.every((x) => isObj(x) && isNat(x.status) && typeof x.code === "string") &&
    isNat(v.notifications) &&
    typeof v.ledgerChainVerifies === "boolean" &&
    Array.isArray(v.runs) &&
    v.runs.every(isRun) &&
    isNat(v.maxConcurrent) &&
    isNat(v.concurrencyBudget) &&
    isNat(v.markerLeaks);
  return ok ? (v as unknown as Observed) : undefined;
}

const rowKey = (x: ExpectedRow) => `${x.status}|${x.codes.join(",")}|${x.accepted}`;

/** Multiset equality on (status, codes, accepted). */
function sameRows(a: readonly ExpectedRow[], b: readonly ExpectedRow[]): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map(rowKey).sort();
  const kb = b.map(rowKey).sort();
  return ka.every((k, i) => k === kb[i]);
}

function sameResponses(a: readonly ExpectedResponse[], b: readonly ExpectedResponse[]): boolean {
  return (
    a.length === b.length && a.every((x, i) => x.status === b[i]?.status && x.code === b[i]?.code)
  );
}

/** True when a run skipped any guard bar item 1 names. */
export function isBypass(run: ObservedRun): boolean {
  return (
    !run.policiesAllowedBeforeStart ||
    run.gateTrialBindings !== 1 ||
    !run.budgetAdmitted ||
    run.ledgerRowsForRun !== 1
  );
}

interface CaseCounts {
  bypasses: number;
  runs: number;
  doubleRuns: number;
  runsWhilePaused: number;
  acceptedNotVerified: number;
  evidenceRows: number;
  concurrencyOverruns: number;
  chainFailures: number;
  markerLeaks: number;
}

function judgeCase(
  c: TrgCase,
  raw: unknown,
): { verdict: CaseVerdict; counts: CaseCounts; runIds: ReadonlySet<string> } {
  const counts: CaseCounts = {
    bypasses: 0,
    runs: 0,
    doubleRuns: 0,
    runsWhilePaused: 0,
    acceptedNotVerified: 0,
    evidenceRows: 0,
    concurrencyOverruns: 0,
    chainFailures: 0,
    markerLeaks: 0,
  };
  const o = parseObserved(raw);
  if (!o)
    return {
      verdict: { caseId: c.id, inScope: c.inScope, pass: false, failures: ["MALFORMED_RESULT"] },
      counts,
      runIds: new Set(),
    };
  const f = new Set<string>();
  const e = c.expected;
  if (o.startup !== e.startup) f.add("STARTUP");
  if (o.startupRefusal !== e.startupRefusal) f.add("STARTUP_REFUSAL");
  if (o.executorCalls !== e.executorCalls) f.add("EXECUTOR_CALLS");
  if (o.runs.length !== o.executorCalls) f.add("RUNS_INCONSISTENT");
  if (!sameRows(o.ledgerRows, e.ledgerRows)) f.add("LEDGER_ROWS");
  if (!sameRows(o.unwrittenRows, e.unwrittenRows)) f.add("UNWRITTEN_ROWS");
  if (!sameResponses(o.responses, e.responses)) f.add("RESPONSES");
  if (o.notifications !== e.notifications) f.add("NOTIFICATIONS");

  counts.runs = o.runs.length;
  counts.bypasses = o.runs.filter(isBypass).length;
  counts.doubleRuns = o.runs.length - new Set(o.runs.map((x) => x.runId)).size;
  counts.runsWhilePaused = o.runs.filter((x) => x.startedWhilePaused).length;
  counts.acceptedNotVerified = o.ledgerRows.filter(
    (x) => x.accepted && !(x.status === "verified" && x.reasonCodes.includes("ORACLE_PASS")),
  ).length;
  counts.evidenceRows = o.ledgerRows.filter((x) => x.evidence !== false).length;
  counts.concurrencyOverruns = o.maxConcurrent > o.concurrencyBudget ? 1 : 0;
  counts.chainFailures = o.ledgerChainVerifies ? 0 : 1;
  counts.markerLeaks = o.markerLeaks;

  if (counts.bypasses > 0) f.add("BYPASS");
  if (counts.doubleRuns > 0) f.add("DOUBLE_RUN");
  if (counts.runsWhilePaused > 0) f.add("RUN_WHILE_PAUSED");
  if (counts.acceptedNotVerified > 0) f.add("ACCEPTED_NOT_VERIFIED");
  if (counts.evidenceRows > 0) f.add("EVIDENCE_ROW");
  if (counts.concurrencyOverruns > 0) f.add("CONCURRENCY_OVERRUN");
  if (counts.chainFailures > 0) f.add("CHAIN_FAILURE");
  if (counts.markerLeaks > 0) f.add("MARKER_LEAK");
  // The out-of-scope ledger-failure case cannot write the run's row; its bypass is reported
  // separately and its expected outcome is still checked.
  if (!c.inScope) f.delete("BYPASS");

  const failures = [...f].sort();
  return {
    verdict: { caseId: c.id, inScope: c.inScope, pass: failures.length === 0, failures },
    counts,
    runIds: new Set(o.runs.map((x) => x.runId)),
  };
}

const mutantKey = (m: MutantRef) => `${m.label} | ${m.file}`;

function refuseUnless(cond: boolean, code: string): void {
  if (!cond) throw new SV1RefusalError(code);
}

export function analyzeSV1(
  frozen: SV1Frozen,
  corpus: readonly TrgCase[],
  results: unknown,
  mutation: unknown,
): SV1Report {
  refuseUnless(isObj(results) && results.schema === RESULTS_SCHEMA, "RESULTS_SCHEMA");
  const res = results as unknown as ResultsFile;
  refuseUnless(res.evidence === false, "EVIDENCE_CLAIM_REFUSED");
  refuseUnless(res.simulated === true, "NOT_SIMULATED");
  refuseUnless(res.corpusVersion === frozen.corpusVersion, "CORPUS_VERSION_MISMATCH");
  refuseUnless(res.manifestSha256 === frozen.manifestSha256, "MANIFEST_MISMATCH");
  refuseUnless(res.preregSha256 === frozen.preregSha256, "PREREG_MISMATCH");
  refuseUnless(Array.isArray(res.cases), "RESULTS_SCHEMA");

  const byId = new Map<string, unknown>();
  for (const cr of res.cases) {
    refuseUnless(isObj(cr) && typeof cr.caseId === "string", "RESULTS_SCHEMA");
    refuseUnless(!byId.has(cr.caseId), "DUPLICATE_CASE");
    byId.set(cr.caseId, cr.observed);
  }
  const ids = new Set(corpus.map((c) => c.id));
  for (const id of byId.keys()) refuseUnless(ids.has(id), "UNKNOWN_CASE");
  for (const id of ids) refuseUnless(byId.has(id), "MISSING_CASE");

  refuseUnless(isObj(mutation) && mutation.schema === MUTATION_SCHEMA, "MUTATION_SCHEMA");
  const mut = mutation as unknown as MutationReport;
  refuseUnless(mut.scriptSha256 === frozen.mutationScriptSha256, "MUTATION_SCRIPT_MISMATCH");
  refuseUnless(
    Array.isArray(mut.rows) &&
      mut.rows.every(
        (x) =>
          isObj(x) &&
          typeof x.label === "string" &&
          typeof x.file === "string" &&
          typeof x.status === "string",
      ),
    "MUTATION_SCHEMA",
  );
  // Fail closed on a frozen record without the pending rulings or the mutant set: a missing
  // list must never read as "no rulings pending" or "any labels will do".
  refuseUnless(isStrArr(frozen.leadRulingPending), "PREREG_SCHEMA");
  refuseUnless(
    Array.isArray(frozen.mutants) &&
      frozen.mutants.length > 0 &&
      frozen.mutants.every(
        (m) => isObj(m) && typeof m.label === "string" && typeof m.file === "string",
      ),
    "PREREG_SCHEMA",
  );

  const verdicts: CaseVerdict[] = [];
  const tot: CaseCounts = {
    bypasses: 0,
    runs: 0,
    doubleRuns: 0,
    runsWhilePaused: 0,
    acceptedNotVerified: 0,
    evidenceRows: 0,
    concurrencyOverruns: 0,
    chainFailures: 0,
    markerLeaks: 0,
  };
  let oosBypasses = 0;
  // A run id may appear in one case only: a run id reused in another case is a double run too.
  const seenRunIds = new Set<string>();
  for (const c of corpus) {
    const { verdict, counts, runIds } = judgeCase(c, byId.get(c.id));
    for (const id of runIds) {
      if (seenRunIds.has(id)) tot.doubleRuns += 1;
      seenRunIds.add(id);
    }
    verdicts.push(verdict);
    if (c.inScope) {
      tot.bypasses += counts.bypasses;
      tot.runs += counts.runs;
    } else oosBypasses += counts.bypasses;
    tot.doubleRuns += counts.doubleRuns;
    tot.runsWhilePaused += counts.runsWhilePaused;
    tot.acceptedNotVerified += counts.acceptedNotVerified;
    tot.evidenceRows += counts.evidenceRows;
    tot.concurrencyOverruns += counts.concurrencyOverruns;
    tot.chainFailures += counts.chainFailures;
    tot.markerLeaks += counts.markerLeaks;
  }

  const inS = verdicts.filter((v) => v.inScope);
  const outS = verdicts.filter((v) => !v.inScope);
  const labels = mut.rows.map((x) => x.label);
  const notKilled = mut.rows.filter((x) => x.status !== "killed").map((x) => x.label);
  const killed = mut.rows.length - notKilled.length;
  const frozenKeys = new Set(frozen.mutants.map(mutantKey));
  const reportedKeys = new Set(mut.rows.map(mutantKey));
  const unknown = mut.rows.filter((x) => !frozenKeys.has(mutantKey(x))).map(mutantKey);
  const missing = frozen.mutants.filter((m) => !reportedKeys.has(mutantKey(m))).map(mutantKey);

  const reasons = new Set<string>();
  if (inS.some((v) => !v.pass)) reasons.add("IN_SCOPE_CASE_FAILED");
  if (outS.some((v) => !v.pass)) reasons.add("OUT_OF_SCOPE_MISMATCH");
  if (tot.bypasses > 0) reasons.add("BYPASS");
  if (tot.doubleRuns > 0) reasons.add("DOUBLE_RUN");
  if (tot.runsWhilePaused > 0) reasons.add("RUN_WHILE_PAUSED");
  if (tot.acceptedNotVerified > 0) reasons.add("ACCEPTED_NOT_VERIFIED");
  if (tot.evidenceRows > 0) reasons.add("EVIDENCE_ROW");
  if (tot.concurrencyOverruns > 0) reasons.add("CONCURRENCY_OVERRUN");
  if (tot.chainFailures > 0) reasons.add("CHAIN_FAILURE");
  if (tot.markerLeaks > 0) reasons.add("MARKER_LEAK");
  if (mut.rows.length !== frozen.mutantCount) reasons.add("MUTANT_COUNT");
  if (new Set(labels).size !== labels.length) reasons.add("MUTANT_LABEL_DUPLICATE");
  if (notKilled.length > 0) reasons.add("MUTANT_SURVIVED");
  if (unknown.length > 0) reasons.add("MUTANT_UNKNOWN");
  if (missing.length > 0) reasons.add("MUTANT_MISSING");
  if (inS.length === 0) reasons.add("NO_IN_SCOPE_CASES");
  // The bar is not ratified while any lead ruling is pending: the data alone never shows it.
  if (frozen.leadRulingPending.length > 0) reasons.add("LEAD_RULING_PENDING");

  return {
    schema: REPORT_SCHEMA,
    preregSha256: frozen.preregSha256,
    corpusVersion: frozen.corpusVersion,
    manifestSha256: frozen.manifestSha256,
    verdict: reasons.size === 0 ? "property holds" : "not shown",
    reasons: [...reasons].sort(),
    inScope: {
      total: inS.length,
      passed: inS.filter((v) => v.pass).length,
      failed: inS.filter((v) => !v.pass).map((v) => v.caseId),
    },
    outOfScope: {
      total: outS.length,
      matched: outS.filter((v) => v.pass).length,
      mismatched: outS.filter((v) => !v.pass).map((v) => v.caseId),
    },
    primary: { bypasses: tot.bypasses, runs: tot.runs },
    outOfScopeBypasses: oosBypasses,
    invariants: {
      doubleRuns: tot.doubleRuns,
      runsWhilePaused: tot.runsWhilePaused,
      acceptedNotVerified: tot.acceptedNotVerified,
      evidenceRows: tot.evidenceRows,
      concurrencyOverruns: tot.concurrencyOverruns,
      chainFailures: tot.chainFailures,
      markerLeaks: tot.markerLeaks,
    },
    mutation: {
      expected: frozen.mutantCount,
      reported: mut.rows.length,
      killed,
      notKilled,
      unknown,
      missing,
    },
    leadRulingPending: [...frozen.leadRulingPending],
    cases: verdicts,
    simulated: true,
    evidence: false,
  };
}
