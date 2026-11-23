import type { JsonSchema } from "./validate.ts";

/**
 * ADR-0007 / ADR-0012 result.json (RunRecord) schema: intent, params, steps with
 * pre/postcondition results and state versions, guardFailure?, verdict with
 * per-check weighted partial scores (OSWorld 2.0 partial_scores shape), and
 * unresolvedState?.
 *
 * ADR-0012 `recordKind` discriminator: `"run"` (default when absent — verdict
 * required, M1 behavior unchanged) vs `"session"` (runtime-layer session record —
 * verdict forbidden; optional top-level `checks` for host-side scoring later).
 */
const resultRecordDefs = {
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
} as const satisfies Record<string, JsonSchema>;

export const resultRecordSchema: JsonSchema = {
  $defs: {
    ...resultRecordDefs,
    /**
     * MVD-001 acceptance 5: per-run economics. The number cannot travel alone: a
     * mock wall-clock relabelled as live would read as run latency it never had,
     * so `provenance` is *fixed* per branch and `wallClockBasis` must agree with it
     * (`anyOf` over the two permitted pairings — the subset has no
     * `if/then`, and a pairing is exactly what the pairing check expresses).
     * `modelCost` is an object rather than a number so "not measured" cannot be
     * read as 0.
     */
    Economics: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["provenance", "wallClockMs", "wallClockBasis", "modelCost"],
          properties: {
            provenance: { type: "string", const: "mock" },
            wallClockMs: { type: "integer", minimum: 0 },
            wallClockBasis: { type: "string", const: "mock-contract-double" },
            modelCost: { $ref: "#/$defs/ModelCost" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["provenance", "wallClockMs", "wallClockBasis", "modelCost"],
          properties: {
            provenance: { type: "string", const: "live" },
            wallClockMs: { type: "integer", minimum: 0 },
            wallClockBasis: { type: "string", const: "live-guest" },
            modelCost: { $ref: "#/$defs/ModelCost" },
          },
        },
      ],
    },
    /** A cost is never a bare number: "not-measured" must carry its reason. */
    ModelCost: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reason"],
      properties: {
        status: { type: "string", enum: ["not-measured", "measured"] },
        reason: { type: "string" },
        usd: { type: "number", minimum: 0 },
      },
    },
    // M1 run record: verdict required. recordKind optional; absent or "run".
    RunRecord: {
      type: "object",
      additionalProperties: false,
      required: ["runId", "taskId", "taskParams", "startedAt", "steps", "verdict"],
      properties: {
        recordKind: { type: "string", enum: ["run"] },
        runId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        taskParams: { type: "object" },
        instruction: { type: "string" },
        startedAt: { type: "string", minLength: 1 },
        steps: { type: "array", items: { $ref: "#/$defs/EvidenceStep" } },
        guardFailure: { $ref: "#/$defs/GuardFailure" },
        verdict: { $ref: "#/$defs/Verdict" },
        unresolvedState: { type: "string" },
        simulated: { type: "boolean" },
        dryRun: { type: "boolean" },
        economics: { $ref: "#/$defs/Economics" },
      },
    },
    // ADR-0012 session record: runtime-layer summary, no verdict. `verdict` is
    // not declared, so additionalProperties:false rejects a session record that
    // carries one. `checks` optional: host-side verification may attach
    // per-check results without a scored verdict.
    SessionRecord: {
      type: "object",
      additionalProperties: false,
      required: ["recordKind", "runId", "startedAt", "steps"],
      properties: {
        recordKind: { type: "string", const: "session" },
        runId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        taskParams: { type: "object" },
        startedAt: { type: "string", minLength: 1 },
        steps: { type: "array", items: { $ref: "#/$defs/EvidenceStep" } },
        guardFailure: { $ref: "#/$defs/GuardFailure" },
        checks: { type: "array", items: { $ref: "#/$defs/CheckVerdict" } },
        unresolvedState: { type: "string" },
        economics: { $ref: "#/$defs/Economics" },
      },
    },
  },
  anyOf: [{ $ref: "#/$defs/RunRecord" }, { $ref: "#/$defs/SessionRecord" }],
};
