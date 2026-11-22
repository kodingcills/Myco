import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerRowSchema } from "../../schemas/ledger-row.ts";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { type JsonSchema, type SchemaIssue, validateSchema } from "../../schemas/validate.ts";
import type { GuardFailure, PredicateResult, StepRecord } from "./program.ts";
import type { Verdict } from "./verify.ts";

/** ADR-0007: verdict with per-check weighted partial scores. */
export interface CheckVerdict {
  name: string;
  passed: boolean | null;
  reason: string;
  /** OSWorld 2.0 partial_scores shape; weights across checks sum to 1.0. */
  partial_score: { score: number; weight: number; description?: string };
}

export interface ScoredVerdict {
  status: Verdict["status"];
  /** Per-check verdicts; non-empty once scored by the evidence layer. */
  checks: CheckVerdict[];
  /** Weighted partial score; 1.0 iff verified with every check passing. */
  score: number;
  reasons: string[];
}

export interface RunRecord {
  runId: string;
  taskId: string;
  taskParams: Record<string, unknown>;
  startedAt: string;
  steps: EvidenceStep[];
  guardFailure?: GuardFailure;
  verdict: ScoredVerdict;
  unresolvedState?: string;
  simulated?: boolean;
  dryRun?: boolean;
}

export interface EvidenceStep {
  step: number;
  action: Record<string, unknown>;
  preconditionResults: PredicateResult[];
  postconditionResults: PredicateResult[];
  stateVersionBefore: number;
  stateVersionAfter: number;
}

export interface RunResult {
  runId: string;
  outcome: "completed" | "guardFailure";
  verdict?: ScoredVerdict;
  finalSummary: string;
}

/** Self-describing trace.jsonl line vocabulary (ADR-0007). */
export type TraceEvent =
  | { type: "run-start"; runId: string; taskId: string; startedAt: string }
  | { type: "observation"; timestamp: string; stateVersion: number; nodeCount: number }
  | { type: "action"; timestamp: string; step: number; action: Record<string, unknown> }
  | {
      type: "guard-evaluation";
      timestamp: string;
      step: number;
      phase: "pre" | "post";
      results: PredicateResult[];
      stateVersionBefore: number;
      stateVersionAfter: number;
    }
  | {
      type: "guard-failure";
      timestamp: string;
      step: number;
      phase: GuardFailure["phase"];
      guard: GuardFailure;
    }
  | { type: "fault-injection"; timestamp: string; fault: string; detail: string }
  | { type: "recovery"; timestamp: string; event: string; stateVersion: number }
  | {
      type: "claim";
      timestamp: string;
      step: number;
      source: "agent" | "app-ui";
      field: string;
      value: string;
    };

/** ADR-0007 conformance ledger row (Cua action-support ledger format). */
export interface LedgerRow {
  evalId: string;
  runId: string;
  trialIndex: number;
  corruptionClass: string;
  actionKind: string;
  state: "pass" | "refusal" | "failure" | "gap" | "uncertain";
  /** How the row outcome was decided; e.g. "verifier:refuted" or "ground-truth:false". */
  oracle: string;
  /** Explicit refusal code when the runner declined the action, else null. */
  refusalCode: string | null;
  detail?: string;
}

/** Ledger accounting invariant: every row accounted; `gap` never counts as pass. */
export interface LedgerAccounting {
  rows: number;
  pass: number;
  refusal: number;
  failure: number;
  gap: number;
  uncertain: number;
  unaccounted: number;
}

export class InvalidEvidenceError extends Error {
  readonly issues: SchemaIssue[];

  constructor(what: string, issues: SchemaIssue[]) {
    super(`invalid ${what}: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    this.name = "InvalidEvidenceError";
    this.issues = issues;
  }
}

export function stepFromRecord(record: StepRecord): EvidenceStep {
  return {
    step: record.step,
    action: record.action as Record<string, unknown>,
    preconditionResults: record.preconditionResults,
    postconditionResults: record.postconditionResults,
    stateVersionBefore: record.stateVersionBefore,
    stateVersionAfter: record.stateVersionAfter,
  };
}

/**
 * Convert the runner's per-step records into the ADR-0007 event vocabulary:
 * one observation, one action, and one guard-evaluation line per guard phase
 * per step. The runner (owned by M1-001) records observation results only per
 * step, so each step's pre-observation is reconstructed from
 * `stateVersionBefore`; full per-observation event fidelity lands with the
 * real adapter in M1-006.
 */
export function traceEventsForSteps(steps: EvidenceStep[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const step of steps) {
    const timestamp = new Date().toISOString();
    events.push({
      type: "observation",
      timestamp,
      stateVersion: step.stateVersionBefore,
      nodeCount: 0,
    });
    events.push({ type: "action", timestamp, step: step.step, action: step.action });
    events.push({
      type: "guard-evaluation",
      timestamp,
      step: step.step,
      phase: "pre",
      results: step.preconditionResults,
      stateVersionBefore: step.stateVersionBefore,
      stateVersionAfter: step.stateVersionBefore,
    });
    events.push({
      type: "guard-evaluation",
      timestamp,
      step: step.step,
      phase: "post",
      results: step.postconditionResults,
      stateVersionBefore: step.stateVersionBefore,
      stateVersionAfter: step.stateVersionAfter,
    });
  }
  return events;
}

/** Assert a value satisfies a schema; throws InvalidEvidenceError otherwise. */
export function assertSchema(value: unknown, schema: JsonSchema, what: string): void {
  const issues = validateSchema(value, schema);
  if (issues.length > 0) {
    throw new InvalidEvidenceError(what, issues);
  }
}

/**
 * Enforce the ADR-0007 partial_scores invariant that the schema subset
 * validator cannot express: the weights across a verdict's checks must sum
 * to 1.0 (M1-012). Throws InvalidEvidenceError on drift.
 */
export function assertWeightsSumToOne(verdict: ScoredVerdict): void {
  const sum = verdict.checks.reduce((acc, check) => acc + check.partial_score.weight, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new InvalidEvidenceError("result.json", [
      {
        path: "$.verdict.checks[*].partial_score.weight",
        keyword: "sum",
        message: `partial_score weights must sum to 1.0, got ${sum}`,
      },
    ]);
  }
}

/**
 * Write a run's trace.jsonl and result.json. Every artifact is schema-checked
 * before being persisted; a tampered or drifting writer fails the run loudly
 * with InvalidEvidenceError (M1-012: invalid artifacts fail the run).
 */
export function writeRunEvidence(
  runsDir: string,
  record: RunRecord,
  extraTrace: TraceEvent[],
): string {
  assertWeightsSumToOne(record.verdict);

  const runDir = join(runsDir, record.runId);
  mkdirSync(runDir, { recursive: true });

  const events: TraceEvent[] = [
    { type: "run-start", runId: record.runId, taskId: record.taskId, startedAt: record.startedAt },
    ...extraTrace,
    ...traceEventsForSteps(record.steps),
  ];
  if (record.guardFailure) {
    events.push({
      type: "guard-failure",
      timestamp: new Date().toISOString(),
      step: record.guardFailure.step,
      phase: record.guardFailure.phase,
      guard: record.guardFailure,
    });
  }
  if (record.unresolvedState) {
    events.push({
      type: "recovery",
      timestamp: new Date().toISOString(),
      event: "aborted-uncertain",
      stateVersion: 0,
    });
  }

  const tracePath = join(runDir, "trace.jsonl");
  let traceText = "";
  for (const event of events) {
    assertSchema(event, traceEventSchema, "trace event");
    traceText += `${JSON.stringify(event)}\n`;
  }
  writeFileSync(tracePath, traceText);

  assertSchema(record, resultRecordSchema, "result.json");
  writeFileSync(join(runDir, "result.json"), `${JSON.stringify(record, null, 2)}\n`);

  return runDir;
}

/**
 * Append conformance ledger rows to `runs/<evalId>/ledger.jsonl`. Rows are
 * schema-checked first; a violation throws InvalidEvidenceError and the
 * ledger file is left untouched.
 */
export function writeLedgerRows(runsDir: string, evalId: string, rows: LedgerRow[]): void {
  let text = "";
  for (const row of rows) {
    assertSchema(row, ledgerRowSchema, "ledger row");
    text += `${JSON.stringify(row)}\n`;
  }
  const evalDir = join(runsDir, evalId);
  mkdirSync(evalDir, { recursive: true });
  appendFileSync(join(evalDir, "ledger.jsonl"), text);
}

/** Check ledger invariants: no unaccounted rows; `gap` never counts as pass. */
export function auditLedgerRows(rows: LedgerRow[]): LedgerAccounting {
  let pass = 0;
  let refusal = 0;
  let failure = 0;
  let gap = 0;
  let uncertain = 0;
  for (const row of rows) {
    switch (row.state) {
      case "pass":
        pass++;
        break;
      case "refusal":
        refusal++;
        break;
      case "failure":
        failure++;
        break;
      case "gap":
        gap++;
        break;
      case "uncertain":
        uncertain++;
        break;
    }
  }
  return {
    rows: rows.length,
    pass,
    refusal,
    failure,
    gap,
    uncertain,
    unaccounted: rows.length - (pass + refusal + failure + gap + uncertain),
  };
}
