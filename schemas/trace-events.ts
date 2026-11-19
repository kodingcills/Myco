import type { JsonSchema } from "./validate.ts";

/**
 * ADR-0007 trace.jsonl event schema: one line per observation, action,
 * guard evaluation, fault injection, and recovery event. Lines are
 * self-describing via `type` and closed under `additionalProperties: false`
 * so a tampered or drifting writer fails validation.
 */
export const traceEventSchema: JsonSchema = {
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
  },
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "runId", "taskId", "startedAt"],
      properties: {
        type: { type: "string", const: "run-start" },
        runId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        startedAt: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "timestamp", "stateVersion", "nodeCount"],
      properties: {
        type: { type: "string", const: "observation" },
        timestamp: { type: "string", minLength: 1 },
        stateVersion: { type: "integer", minimum: 0 },
        nodeCount: { type: "integer", minimum: 0 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "timestamp", "step", "action"],
      properties: {
        type: { type: "string", const: "action" },
        timestamp: { type: "string", minLength: 1 },
        step: { type: "integer", minimum: 0 },
        action: { $ref: "#/$defs/ActionRecord" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "timestamp",
        "step",
        "phase",
        "results",
        "stateVersionBefore",
        "stateVersionAfter",
      ],
      properties: {
        type: { type: "string", const: "guard-evaluation" },
        timestamp: { type: "string", minLength: 1 },
        step: { type: "integer", minimum: 0 },
        phase: { type: "string", enum: ["pre", "post"] },
        results: { type: "array", items: { $ref: "#/$defs/PredicateResult" } },
        stateVersionBefore: { type: "integer", minimum: 0 },
        stateVersionAfter: { type: "integer", minimum: 0 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "timestamp", "step", "phase", "guard"],
      properties: {
        type: { type: "string", const: "guard-failure" },
        timestamp: { type: "string", minLength: 1 },
        step: { type: "integer" },
        phase: { type: "string", enum: ["precondition", "postcondition"] },
        guard: { $ref: "#/$defs/GuardFailure" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "timestamp", "fault", "detail"],
      properties: {
        type: { type: "string", const: "fault-injection" },
        timestamp: { type: "string", minLength: 1 },
        fault: { type: "string", minLength: 1 },
        detail: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "timestamp", "event", "stateVersion"],
      properties: {
        type: { type: "string", const: "recovery" },
        timestamp: { type: "string", minLength: 1 },
        event: { type: "string", minLength: 1 },
        stateVersion: { type: "integer", minimum: 0 },
      },
    },
  ],
};
