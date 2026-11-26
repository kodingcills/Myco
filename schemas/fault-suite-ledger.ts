import type { JsonSchema } from "./validate.ts";

/**
 * TIF-272 (M2-10, R3) — one row of the M2 fault-class ledger (`ledger.jsonl`), written by
 * `src/faults/security/record.ts` from the raw trial records. Closed shape, no free-form
 * path field, so a row is publishable as is; `summary.json` is recomputed from these rows.
 */
const sha256Hex: JsonSchema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const nullableSha: JsonSchema = { anyOf: [sha256Hex, { type: "null" }] };
const verdict: JsonSchema = { type: "string", enum: ["verified", "refuted", "uncertain"] };
const code: JsonSchema = { type: "string", pattern: "^[A-Za-z0-9_:.-]{1,64}$" };

export const faultSuiteRowSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "suiteVersion",
    "index",
    "trialKey",
    "faultClass",
    "variant",
    "target",
    "effect",
    "policy",
    "role",
    "fixtureSha256",
    "persistedSha256",
    "claim",
    "gateVerdict",
    "accepted",
    "reasonCodes",
    "integrityCodes",
    "ledgerCheck",
    "donorVerdict",
    "followed",
    "grade",
    "eligible",
    "falseSuccess",
    "expectedCode",
    "asExpected",
    "cause",
  ],
  properties: {
    schema: { const: "myco.faults.m2-row/1" },
    suiteVersion: { type: "string", minLength: 1, maxLength: 64 },
    index: { type: "integer", minimum: 0 },
    trialKey: { type: "string", pattern: "^[A-Za-z0-9._-]{1,128}$" },
    faultClass: { type: "string", enum: ["tamper-oracle-inputs", "injected-instruction"] },
    variant: { type: "string", pattern: "^[a-z0-9-]{1,64}$" },
    /** Tamper: the oracle input attacked. Injection: the site (cell or dialog). */
    target: { type: "string", pattern: "^[a-z0-9-]{1,64}$" },
    /** Injection: what an obeying agent does. Null for tamper rows. */
    effect: { anyOf: [{ type: "string", pattern: "^[a-z-]{1,32}$" }, { type: "null" }] },
    policy: { anyOf: [{ type: "string", enum: ["obey", "ignore"] }, { type: "null" }] },
    /** `fault`: a faulted trial counted toward R3. `control`: an injection the agent ignored. */
    role: { type: "string", enum: ["fault", "control"] },
    fixtureSha256: sha256Hex,
    persistedSha256: nullableSha,
    claim: { anyOf: [{ const: "done" }, { type: "null" }] },
    gateVerdict: { anyOf: [verdict, { type: "null" }] },
    accepted: { type: "boolean" },
    reasonCodes: { type: "array", items: code },
    integrityCodes: { type: "array", items: code },
    ledgerCheck: { anyOf: [{ type: "string", enum: ["ok", "chain-broken"] }, { type: "null" }] },
    donorVerdict: { anyOf: [verdict, { type: "null" }] },
    followed: { type: "array", items: { type: "string", pattern: "^[a-z-]{1,32}$" } },
    grade: {
      anyOf: [{ type: "string", enum: ["pass", "fail", "ungradable"] }, { type: "null" }],
    },
    eligible: { type: "boolean" },
    falseSuccess: { type: "boolean" },
    /** Tamper: the code the route must end with. Null for injection rows. */
    expectedCode: { anyOf: [code, { type: "null" }] },
    /** Tamper: whether the route ended as `classes.ts` says it must. Null for injection rows. */
    asExpected: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    cause: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "detail"],
          properties: {
            kind: { type: "string", enum: ["agent", "oracle", "harness"] },
            detail: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      ],
    },
  },
};
