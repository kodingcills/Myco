import type { JsonSchema } from "./validate.ts";

/**
 * ADR-0007 conformance ledger row schema (Cua action-support ledger format):
 * one row per (trial, corruption-class, action-kind) with an explicit oracle,
 * an explicit refusal code, and a `gap` state that is never counted as a pass.
 */
export const ledgerRowSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "evalId",
    "runId",
    "trialIndex",
    "corruptionClass",
    "actionKind",
    "state",
    "oracle",
    "refusalCode",
  ],
  properties: {
    evalId: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
    trialIndex: { type: "integer", minimum: 0 },
    corruptionClass: { type: "string", minLength: 1 },
    actionKind: { type: "string", minLength: 1 },
    state: { type: "string", enum: ["pass", "refusal", "failure", "gap", "uncertain"] },
    oracle: { type: "string", minLength: 1 },
    refusalCode: { type: ["string", "null"] },
    detail: { type: "string" },
  },
};
