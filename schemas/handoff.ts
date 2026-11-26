import {
  AGENT_NOTE_LIMIT,
  ASSISTANCE_LABELS,
  HANDOFF_ID,
  HANDOFF_OUTCOMES,
  HANDOFF_REASONS,
  HUMAN_NOTE_LIMIT,
  MAX_HANDOFF_TIMEOUT_MS,
  MIN_HANDOFF_TIMEOUT_MS,
  OPERATOR_LABEL,
  OPERATOR_VIAS,
  POLICY_ID,
} from "../src/handoff/protocol.ts";
import type { JsonSchema } from "./validate.ts";

/**
 * Human handoff records (capability track N, docs/handoff/protocol.md).
 *
 *  - `handoffEntrySchema`  one handoff, as the run record keeps it;
 *  - `handoffLogSchema`    `myco.handoff.log/1`, the run record's optional `handoffs` field
 *                          (schemas/result-record.ts) and the body of a trial row;
 *  - `handoffTrialSchema`  `myco.handoff.trial/1`, one row per trial in a `handoffs.jsonl`
 *                          beside an arm ledger, keyed by `trialKey`; the evidence guard
 *                          (`src/handoff/evidence.ts`) reads it.
 *
 * Note bounds are enforced here as lengths; the content rules (no control characters, host
 * paths or key shapes) are `noteRejection` in src/handoff/protocol.ts.
 */

const iso: JsonSchema = { type: "string", minLength: 1, maxLength: 40 };

export const handoffEntrySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "handoffId",
    "runId",
    "taskId",
    "source",
    "policyId",
    "reason",
    "note",
    "requestedAt",
    "resolvedAt",
    "durationMs",
    "resolution",
    "resolvedBy",
    "operatorLabel",
    "humanNote",
  ],
  properties: {
    handoffId: { type: "string", pattern: HANDOFF_ID.source },
    runId: { type: "string", minLength: 1, maxLength: 128 },
    taskId: { type: "string", minLength: 1, maxLength: 128 },
    source: { type: "string", enum: ["agent", "policy"] },
    policyId: { anyOf: [{ type: "string", pattern: POLICY_ID.source }, { type: "null" }] },
    reason: { type: "string", enum: [...HANDOFF_REASONS] },
    note: { type: "string", maxLength: AGENT_NOTE_LIMIT },
    requestedAt: iso,
    resolvedAt: iso,
    durationMs: { type: "integer", minimum: 0 },
    resolution: { type: "string", enum: [...HANDOFF_OUTCOMES, "timeout", "cancelled"] },
    resolvedBy: {
      type: "string",
      enum: [...OPERATOR_VIAS.map((v) => `operator:${v}`), "host:timeout", "host:harness"],
    },
    operatorLabel: {
      anyOf: [{ type: "string", pattern: OPERATOR_LABEL.source }, { type: "null" }],
    },
    humanNote: { anyOf: [{ type: "string", maxLength: HUMAN_NOTE_LIMIT }, { type: "null" }] },
  },
};

export const handoffLogSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "assistance", "attemptEnd", "timeoutMs", "entries"],
  properties: {
    schema: { const: "myco.handoff.log/1" },
    assistance: { type: "string", enum: [...ASSISTANCE_LABELS] },
    attemptEnd: { anyOf: [{ const: "handoff-timeout" }, { type: "null" }] },
    timeoutMs: {
      type: "integer",
      minimum: MIN_HANDOFF_TIMEOUT_MS,
      maximum: MAX_HANDOFF_TIMEOUT_MS,
    },
    entries: { type: "array", items: handoffEntrySchema },
  },
};

export const handoffTrialSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "trialKey", "log"],
  properties: {
    schema: { const: "myco.handoff.trial/1" },
    trialKey: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
    log: handoffLogSchema,
  },
};
