import type { JsonSchema } from "./validate.ts";

/**
 * Oracle-authoring record (TIF-271 / R5 authoring cost). Closed. Unmeasured fields are null,
 * never 0. Written by `src/oracle-selftest/authoring.ts`.
 */
const nullableCount: JsonSchema = { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] };
const nullableNumber: JsonSchema = { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] };

export const authoringRecordSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "sessionId",
    "family",
    "oracle",
    "author",
    "authorModelId",
    "simulated",
    "wallClockS",
    "modelCalls",
    "tokens",
    "costUsd",
    "selfTest",
  ],
  properties: {
    schema: { const: "myco.oracle-authoring/1" },
    sessionId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
    family: { type: "string", minLength: 1, maxLength: 64 },
    oracle: { type: "string", minLength: 1, maxLength: 128 },
    author: { type: "string", enum: ["hand", "agent"] },
    authorModelId: { anyOf: [{ type: "string", minLength: 1, maxLength: 128 }, { type: "null" }] },
    simulated: { type: "boolean" },
    wallClockS: nullableNumber,
    modelCalls: nullableCount,
    tokens: {
      type: "object",
      additionalProperties: false,
      required: ["input", "output"],
      properties: { input: nullableCount, output: nullableCount },
    },
    costUsd: nullableNumber,
    selfTest: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["pass", "claims", "caughtClaimed", "runsClaimed"],
          properties: {
            pass: { type: "boolean" },
            claims: { type: "array", items: { type: "string", minLength: 1 } },
            caughtClaimed: { type: "integer", minimum: 0 },
            runsClaimed: { type: "integer", minimum: 0 },
          },
        },
      ],
    },
  },
};
