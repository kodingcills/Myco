import type { JsonSchema } from "./validate.ts";

/**
 * ADR-0007 result.json (RunRecord) schema: intent, params, steps with
 * pre/postcondition results and state versions, guardFailure?, verdict with
 * per-check weighted partial scores (OSWorld 2.0 partial_scores shape), and
 * unresolvedState?.
 */
export const resultRecordSchema: JsonSchema = {
  $defs: {
    PredicateResult: {
      type: "object",
      additionalProperties: false,
      required: ["predicateName", "passed", "observed"],
      properties: {
        predicateName: { type: "string", minLength: 1 },
        passed: { type: "boolean" },
        observed: { type: "string" },
      },
    },
    ActionRecord: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { type: "string", minLength: 1 },
        ref: { type: ["string", "object"] },
        text: { type: "string" },
        value: { type: "string" },
        keys: { type: "string" },
        timeoutMs: { type: "integer", minimum: 0 },
      },
    },
    GuardFailure: {
      type: "object",
      additionalProperties: false,
      required: ["step", "phase", "predicateName", "observed", "reason"],
      properties: {
        step: { type: "integer" },
        phase: { type: "string", enum: ["precondition", "postcondition"] },
        predicateName: { type: "string", minLength: 1 },
        observed: { type: "string" },
        reason: { type: "string", minLength: 1 },
      },
    },
    PartialScore: {
      type: "object",
      additionalProperties: false,
      required: ["score", "weight"],
      properties: {
        score: { type: "number", minimum: 0, maximum: 1 },
        weight: { type: "number", minimum: 0, maximum: 1 },
        description: { type: "string" },
      },
    },
    CheckVerdict: {
      type: "object",
      additionalProperties: false,
      required: ["name", "passed", "reason", "partial_score"],
      properties: {
        name: { type: "string", minLength: 1 },
        passed: { type: ["boolean", "null"] },
        reason: { type: "string" },
        partial_score: { $ref: "#/$defs/PartialScore" },
      },
    },
    EvidenceStep: {
      type: "object",
      additionalProperties: false,
      required: [
        "step",
        "action",
        "preconditionResults",
        "postconditionResults",
        "stateVersionBefore",
        "stateVersionAfter",
      ],
      properties: {
        step: { type: "integer", minimum: 0 },
        action: { $ref: "#/$defs/ActionRecord" },
        preconditionResults: { type: "array", items: { $ref: "#/$defs/PredicateResult" } },
        postconditionResults: { type: "array", items: { $ref: "#/$defs/PredicateResult" } },
        stateVersionBefore: { type: "integer", minimum: 0 },
        stateVersionAfter: { type: "integer", minimum: 0 },
      },
    },
    Verdict: {
      type: "object",
      additionalProperties: false,
      required: ["status", "checks", "score", "reasons"],
      properties: {
        status: { type: "string", enum: ["verified", "refuted", "uncertain"] },
        checks: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/CheckVerdict" },
        },
        score: { type: "number", minimum: 0, maximum: 1 },
        reasons: { type: "array", items: { type: "string" } },
      },
    },
  },
  type: "object",
  additionalProperties: false,
  required: ["runId", "taskId", "taskParams", "startedAt", "steps", "verdict"],
  properties: {
    runId: { type: "string", minLength: 1 },
    taskId: { type: "string", minLength: 1 },
    taskParams: { type: "object" },
    startedAt: { type: "string", minLength: 1 },
    steps: { type: "array", items: { $ref: "#/$defs/EvidenceStep" } },
    guardFailure: { $ref: "#/$defs/GuardFailure" },
    verdict: { $ref: "#/$defs/Verdict" },
    unresolvedState: { type: "string" },
  },
};
