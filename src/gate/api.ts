/**
 * Myco gate API, version 1 (TIF-265 / M2-02): the public, agent-facing contract.
 *
 * The gate answers one question: "is this task done, according to persisted state?"
 * It returns the three-valued verdict (`verified` / `refuted` / `uncertain`) with stable
 * reason codes and refs to the evidence it read. A caller accepts "done" only when
 * `accepted` is true, and `accepted` is true only when `verdict` is `verified`, which in
 * turn only happens when the oracle ran on the persisted state and passed.
 *
 * Trust split (the shape TIF-266's isolation builds on):
 *  - `GateRequest` is everything the agent may say: which task, which run, and an
 *    optional claim that is recorded and never read by the oracle. Any other field is
 *    rejected, so the agent has no way to hand the oracle an expected value, a store,
 *    a path or a verdict.
 *  - `GateConfig` (see `gate.ts`) is operator-only: the task registry (task specs and
 *    the oracle family for each) and the evidence reader (where persisted state is read
 *    from). The agent never constructs it; the MCP server builds it from CLI flags.
 *
 * Changing any exported type or reason code in a breaking way requires a new
 * `GATE_API_VERSION`; adding a reason code is additive and keeps `v1`.
 */

export const GATE_API_VERSION = "myco.gate/v1";

export type GateVerdict = "verified" | "refuted" | "uncertain";

/**
 * Stable reason codes. Exactly one of the `ORACLE_*` or input/state codes explains the
 * verdict; `CLAIM_RECORDED` may accompany any of them, and the detail codes
 * `TARGET_MISMATCH` / `DOCUMENT_COLLATERAL` may accompany `ORACLE_FAIL` only.
 */
export const REASON_CODES = [
  /** The oracle ran on persisted state and passed. The only code that goes with `verified`. */
  "ORACLE_PASS",
  /** The oracle ran on persisted state and found the effect provably absent. */
  "ORACLE_FAIL",
  /** The oracle ran but could not decide (for example a target cell absent). */
  "ORACLE_UNCERTAIN",
  /** The oracle threw. Never read as a pass. */
  "ORACLE_ERROR",
  /** The oracle returned something that is not a well-formed verdict. Never read as a pass. */
  "ORACLE_INVALID_OUTPUT",
  /** The persisted state file does not exist in the run's evidence location. */
  "STATE_MISSING",
  /** The persisted state exists but could not be read (permissions, escapes the root). */
  "STATE_UNREADABLE",
  /** The persisted state was read but does not parse as the family's format. */
  "STATE_CORRUPT",
  /**
   * The task's spec names a sealed fixture (the exact document the guest was given, TIF-270
   * round 3) and the gate could not read it from the operator's evidence location.
   */
  "FIXTURE_UNREADABLE",
  /**
   * The sealed fixture the gate read does not match the digest in the operator's spec: the
   * fixture was altered or swapped after the operator registered it. Nothing is decided.
   */
  "FIXTURE_MISMATCH",
  /** The request is not an object, lacks a field, or a field has the wrong form. */
  "INVALID_REQUEST",
  /** The request named an API version this gate does not serve. */
  "UNSUPPORTED_API_VERSION",
  /** The request carried a field the API does not define. */
  "UNKNOWN_FIELD",
  /**
   * The request tried to supply an oracle input (expected values, store contents, a
   * path, a verdict). Recorded separately from UNKNOWN_FIELD so a tamper attempt is
   * countable (M2-10's tamper class).
   */
  "ORACLE_INPUT_REJECTED",
  /**
   * The request named a task or run other than the one this gate was assigned by the
   * operator. Nothing is read. Counted like ORACLE_INPUT_REJECTED: a substitution attempt.
   */
  "ASSIGNMENT_MISMATCH",
  /** `taskId` is not in the operator's registry. */
  "UNKNOWN_TASK",
  /**
   * The operator's decision log could not be written. The gate fails closed: the verdict
   * becomes `uncertain`, because an unlogged acceptance could not be audited (R1).
   */
  "AUDIT_FAILED",
  /** The agent's claim was recorded. Informational; it never changes the verdict. */
  "CLAIM_RECORDED",
  /**
   * Detail for ORACLE_FAIL (TIF-270): a cell the task targets does not hold the value the
   * task asked for. Accompanies ORACLE_FAIL only, never another verdict.
   */
  "TARGET_MISMATCH",
  /**
   * Detail for ORACLE_FAIL (TIF-270): a cell the task does not target differs from the
   * pristine fixture (changed, cleared or added): collateral damage. The whole document
   * must equal pristine + intent, so a correct target with collateral damage is refuted.
   */
  "DOCUMENT_COLLATERAL",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Reason codes an oracle may attach to a `refuted` output to say why (TIF-270). The gate
 * refuses any other code, and any of these on a non-refuted output, as malformed.
 */
export const ORACLE_DETAIL_CODES = ["TARGET_MISMATCH", "DOCUMENT_COLLATERAL"] as const;
export type OracleDetailCode = (typeof ORACLE_DETAIL_CODES)[number];

/** One checkpoint's verdict in a multi-step task (TIF-270). Checkpoints are numbered from 1. */
export interface CheckpointVerdict {
  readonly checkpoint: number;
  readonly verdict: "verified" | "refuted";
}

/**
 * Per-checkpoint verdicts for a multi-step task (TIF-270), computed by the oracle from the
 * persisted document and the operator's spec alone. `lastVerified` is computed by the
 * gate: the number of leading verified checkpoints (0 = none; the retry then starts from
 * the pristine fixture). The final checkpoint's verdict is the task's verdict.
 */
export interface CheckpointSummary {
  readonly total: number;
  readonly lastVerified: number;
  readonly verdicts: readonly CheckpointVerdict[];
}

/** What the agent sends. Every field except these is rejected. */
export interface GateRequest {
  /** Optional; when present it must equal `GATE_API_VERSION`. */
  readonly apiVersion?: string;
  /** A task id from the operator's registry. */
  readonly taskId: string;
  /** The run whose persisted state the gate reads, resolved inside the operator's root. */
  readonly runId: string;
  /** The agent's completion claim, recorded for the ledger, never read by the oracle. */
  readonly claim?: string;
}

/** A pointer to something the gate read, with a digest so a ledger can pin it. */
export interface EvidenceRef {
  /**
   * `persisted-state`: the saved document the oracle decided on. `sealed-fixture`: the
   * operator's sealed fixture the expected document was built from (TIF-270 round 3).
   */
  readonly kind: "persisted-state" | "sealed-fixture";
  readonly runId: string;
  /** Path relative to the run's evidence location. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface GateResult {
  readonly apiVersion: typeof GATE_API_VERSION;
  readonly verdict: GateVerdict;
  /** True exactly when `verdict` is `verified`. The only field a harness needs to gate on. */
  readonly accepted: boolean;
  readonly reasonCodes: readonly ReasonCode[];
  /** Human-readable reasons, from the oracle or from the gate. Not a stable contract. */
  readonly reasons: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  /** The request fields as the gate understood them (absent when the request was unusable). */
  readonly request: {
    readonly taskId?: string;
    readonly runId?: string;
    readonly claim?: string;
  };
  /** Which oracle decided, present only when an oracle ran. */
  readonly oracle?: {
    readonly family: string;
    readonly version: string;
    /** sha256 of the canonical JSON of the operator's task spec. */
    readonly specSha256: string;
  };
  /**
   * Per-checkpoint verdicts, present only when a multi-step family's oracle decided
   * (TIF-270). Verdicts only: no expected value is ever exposed or accepted.
   */
  readonly checkpoints?: CheckpointSummary;
  /**
   * Agent-safe corrections (TIF-265 follow-up, M2 scope add B): present only when the
   * operator enabled corrections for the task's family (`GateConfig.corrections`, off by
   * default), the verdict is `refuted` (ORACLE_FAIL) or `uncertain` (STATE_MISSING), and the
   * case is a supported one. A closed schema the gate builds from its own comparison, never
   * oracle text. It reveals only what the task instruction gave the agent (the target's
   * record, column and requested value) and what the agent can observe in its own saved
   * document (what a target cell holds, which cells it changed). It never changes the
   * verdict, the reason codes, the reasons or the retry budget. See docs/gate/api.md,
   * "Corrections".
   */
  readonly corrections?: readonly Correction[];
  readonly checkedAt: string;
}

/** The closed set of correction kinds (docs/gate/api.md, "Corrections"). */
export const CORRECTION_KINDS = [
  "target_value_mismatch",
  "target_unchanged",
  "document_not_saved",
  "collateral_change",
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

/** Fields every target correction carries: the cell and what the instruction asked for. */
interface TargetCorrectionFields {
  /** Multi-step tasks only: the step (1-based) whose target this is. */
  readonly step?: number;
  /** The target cell's A1 address in the saved document. */
  readonly cell: string;
  /** The record and column the instruction named. */
  readonly record: string;
  readonly column: string;
  /** The value the instruction told the agent to write. */
  readonly expected: string;
}

/**
 * A target cell holds a value other than the requested one, and other than what it held
 * when the agent was given the document. `observed` is what the agent's saved document
 * holds there (null: the cell is empty), at most `CORRECTION_VALUE_LIMIT` characters;
 * `observedTruncated` is true when it was cut.
 */
export interface TargetValueMismatch extends TargetCorrectionFields {
  readonly kind: "target_value_mismatch";
  readonly observed: string | null;
  readonly observedTruncated?: true;
}

/**
 * A target cell still holds what it held when the agent was given the document. The value
 * is deliberately absent: it is the pristine fixture's.
 */
export interface TargetUnchanged extends TargetCorrectionFields {
  readonly kind: "target_unchanged";
}

/**
 * The saved document does not show the work: `no_saved_file` (the persisted state was not
 * found after the agent stopped) or `saved_file_unchanged` (the saved document is,
 * cell for cell, the document the agent was given).
 */
export interface DocumentNotSaved {
  readonly kind: "document_not_saved";
  readonly evidence: "no_saved_file" | "saved_file_unchanged";
}

/**
 * Cells the task does not target differ from the document the agent was given (changed,
 * cleared or added). Addresses only, at most `CORRECTION_CELL_LIMIT` of them, and how many
 * more there are: never a value, neither the pristine one nor the agent's.
 */
export interface CollateralChange {
  readonly kind: "collateral_change";
  readonly cells: readonly string[];
  readonly more: number;
}

export type Correction =
  | TargetValueMismatch
  | TargetUnchanged
  | DocumentNotSaved
  | CollateralChange;

/** Longest `observed` value a correction carries. */
export const CORRECTION_VALUE_LIMIT = 200;
/** Most collateral addresses a correction lists (the rest are counted in `more`). */
export const CORRECTION_CELL_LIMIT = 10;

/** The request fields the API defines. */
const ALLOWED_FIELDS = new Set(["apiVersion", "taskId", "runId", "claim"]);

/**
 * Names that would be oracle inputs if the gate accepted them. Rejected with
 * ORACLE_INPUT_REJECTED rather than UNKNOWN_FIELD, so a tamper attempt is visible as one.
 */
export const ORACLE_INPUT_FIELDS: readonly string[] = [
  "items",
  "expected",
  "expectedValue",
  "spec",
  "params",
  "intent",
  "store",
  "state",
  "persisted",
  "cells",
  "storePath",
  "stateFile",
  "path",
  "evidenceRoot",
  "evidenceDir",
  "evidence",
  "oracle",
  "family",
  "groundTruth",
  "fixture",
  "verdict",
  "status",
  "accepted",
  // Multi-step Calc (TIF-270): the steps, their expected values and the checkpoint
  // verdicts are the operator's and the oracle's, never the agent's.
  "steps",
  "edits",
  "newValue",
  "checkpoint",
  "checkpoints",
  "lastVerified",
  // Sealed fixture (TIF-270 round 3): the fixture and its digest are the operator's.
  "fixtureSeed",
  "fixtureFile",
  "fixtureSha256",
  "fixtureCsv",
];

/** Ids are path segments, so they are restricted to a safe alphabet and never `.`/`..`. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const CLAIM_LIMIT = 4000;

export function isSafeId(value: string): boolean {
  return ID.test(value) && !value.includes("..");
}

export type ParsedRequest =
  | { readonly ok: true; readonly request: GateRequest }
  | {
      readonly ok: false;
      readonly code: ReasonCode;
      readonly reason: string;
      /** Whatever usable identifiers the request did carry, for the audit record. */
      readonly partial: GateResult["request"];
    };

function partialOf(raw: Record<string, unknown>): GateResult["request"] {
  const out: { taskId?: string; runId?: string; claim?: string } = {};
  if (typeof raw.taskId === "string" && isSafeId(raw.taskId)) out.taskId = raw.taskId;
  if (typeof raw.runId === "string" && isSafeId(raw.runId)) out.runId = raw.runId;
  if (typeof raw.claim === "string" && raw.claim.length <= CLAIM_LIMIT) out.claim = raw.claim;
  return out;
}

/** Narrow an untrusted value to a `GateRequest`, or say exactly why not. Never throws. */
export function parseGateRequest(raw: unknown): ParsedRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, code: "INVALID_REQUEST", reason: "request is not an object", partial: {} };
  }
  const record = raw as Record<string, unknown>;
  const partial = partialOf(record);
  const keys = Object.keys(record);
  const oracleInputs = keys.filter((key) => ORACLE_INPUT_FIELDS.includes(key));
  if (oracleInputs.length > 0) {
    return {
      ok: false,
      code: "ORACLE_INPUT_REJECTED",
      reason: `the gate reads oracle inputs itself; the request may not carry: ${oracleInputs.join(", ")}`,
      partial,
    };
  }
  const unknown = keys.filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      code: "UNKNOWN_FIELD",
      reason: `unknown request field(s): ${unknown.join(", ")}; allowed: ${[...ALLOWED_FIELDS].join(", ")}`,
      partial,
    };
  }
  if (record.apiVersion !== undefined && record.apiVersion !== GATE_API_VERSION) {
    return {
      ok: false,
      code: "UNSUPPORTED_API_VERSION",
      reason: `this gate serves ${GATE_API_VERSION}`,
      partial,
    };
  }
  for (const field of ["taskId", "runId"] as const) {
    const value = record[field];
    if (typeof value !== "string" || !isSafeId(value)) {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        reason: `${field} must be a string of 1-128 characters from [A-Za-z0-9._-], starting with a letter or digit, without ".."`,
        partial,
      };
    }
  }
  if (record.claim !== undefined && typeof record.claim !== "string") {
    return { ok: false, code: "INVALID_REQUEST", reason: "claim must be a string", partial };
  }
  if (typeof record.claim === "string" && record.claim.length > CLAIM_LIMIT) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      reason: `claim is longer than ${CLAIM_LIMIT} characters`,
      partial,
    };
  }
  const request: GateRequest = {
    ...(record.apiVersion === undefined ? {} : { apiVersion: GATE_API_VERSION }),
    taskId: record.taskId as string,
    runId: record.runId as string,
    ...(typeof record.claim === "string" ? { claim: record.claim } : {}),
  };
  return { ok: true, request };
}

/** JSON Schema of `GateRequest`, used as the MCP tool's `inputSchema`. */
export const GATE_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    apiVersion: { type: "string", const: GATE_API_VERSION },
    taskId: {
      type: "string",
      pattern: ID.source,
      description: "The task id you were given (from the operator's registry).",
    },
    runId: {
      type: "string",
      pattern: ID.source,
      description: "The run id you were given; the gate reads that run's persisted state itself.",
    },
    claim: {
      type: "string",
      maxLength: CLAIM_LIMIT,
      description:
        "Optional: your completion claim, recorded for audit. It never affects the verdict.",
    },
  },
  required: ["taskId", "runId"],
  additionalProperties: false,
} as const;
