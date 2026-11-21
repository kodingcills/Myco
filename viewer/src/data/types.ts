import type { SchemaIssue } from "../../../schemas/validate.ts";
import type { CheckVerdict, LedgerRow, RunRecord, TraceEvent } from "../../../src/core/evidence.ts";
import type { DisplayVerdict } from "./verdict.ts";

export type ResultRecord =
  | (RunRecord & { recordKind?: "run" })
  | (Pick<RunRecord, "runId" | "startedAt" | "steps" | "guardFailure" | "unresolvedState"> &
      Partial<Pick<RunRecord, "taskId" | "taskParams">> & {
        recordKind: "session";
        checks?: CheckVerdict[];
      });

export type SourceRef = { file: string; line: number } | { file: string; path: string };

export interface Sourced<T> {
  value: T;
  source: SourceRef;
}

export interface ParseError {
  source: SourceRef;
  issues: SchemaIssue[];
}

export interface ExtendedEvent {
  type: string;
  [key: string]: unknown;
}

export type ViewTraceEvent = (
  | { kind: "standard"; event: TraceEvent }
  | { kind: "extended"; event: ExtendedEvent }
) & {
  source: SourceRef;
  step?: number;
  raw?: string;
};

export interface RunManifest {
  format: "mycotrace/1";
  runId: string;
  files: Record<string, unknown>;
}

export type EvidenceValidation =
  | { kind: "pending" }
  | { kind: "complete"; manifestChecked: boolean }
  | { kind: "invalid"; reason: Sourced<string> };

export interface RunData {
  validation: EvidenceValidation;
  result?: ResultRecord;
  events: ViewTraceEvent[];
  /** Proof evidence available while the full trace is being indexed. */
  proofEvents?: ViewTraceEvent[];
  byStep: Map<number, ViewTraceEvent[]>;
  ledger: Sourced<LedgerRow>[];
  manifest?: RunManifest;
  artifactPaths: string[];
  screenshots?: Map<number, Sourced<string>>;
  parseErrors: ParseError[];
}

export type RunUpdate =
  | { type: "result"; result?: ResultRecord; parseErrors: ParseError[] }
  | { type: "trace"; events: ViewTraceEvent[] }
  | {
      type: "validated";
      verdict: DisplayVerdict;
      evidence: Pick<RunData, "validation" | "parseErrors" | "proofEvents" | "ledger" | "manifest">;
    };
