import type { JsonSchema } from "./validate.ts";

/**
 * False-completion benchmark ledgers (TIF-267 / M2-04). Two closed row shapes, written by
 * two different parties and joined only by the check (`src/benchmark/check.ts`):
 *
 *  - an ARM row, written by the arm's harness (Myco's gate arm, or `hcu+shell`): what the
 *    agent claimed, what the gate said (Myco arm only), whether the claim was accepted;
 *  - a GRADE row, written by the independent grader: whether the persisted document
 *    satisfies the intent. It carries no claim and no gate verdict.
 *
 * Rows are public-safe by shape: no free-form path fields. `trialKey` is an opaque id the
 * harness assigns, so the grader does not need to know which arm produced a document.
 */
const sha256Hex: JsonSchema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const nullableSha: JsonSchema = { anyOf: [sha256Hex, { type: "null" }] };
const trialKey: JsonSchema = { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" };
const taskId: JsonSchema = { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" };
const nullableNumber: JsonSchema = { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] };

export const benchmarkArmRowSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "taskSetVersion",
    "arm",
    "trialKey",
    "taskId",
    "faultClass",
    "fixtureSha256",
    "instructionSha256",
    "plannerModelId",
    "outputCeiling",
    "claim",
    "gate",
    "accepted",
    "persistedSha256",
    "cause",
    "cost",
  ],
  properties: {
    schema: { const: "myco.benchmark.arm-row/1" },
    taskSetVersion: { type: "string", minLength: 1, maxLength: 64 },
    arm: { type: "string", enum: ["myco-gate", "hcu+shell"] },
    trialKey,
    taskId,
    faultClass: { type: "string", pattern: "^[a-z0-9-]{1,64}$" },
    fixtureSha256: sha256Hex,
    /** SHA-256 of the exact instruction text the agent received (R2 parity, L5). */
    instructionSha256: sha256Hex,
    plannerModelId: { type: "string", minLength: 1, maxLength: 128 },
    /** Output-token ceiling the agent ran under (#340), or null if none was set. */
    outputCeiling: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    /** What the agent said at the end: it finished, it did not, or it said neither. */
    claim: { type: "string", enum: ["done", "not-done", "no-claim"] },
    /** Myco arm: the gate call. `hcu+shell`: null (that arm has no gate). */
    gate: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["called", "verdict"],
          properties: {
            called: { type: "boolean" },
            verdict: {
              anyOf: [
                { type: "string", enum: ["verified", "refuted", "uncertain"] },
                { type: "null" },
              ],
            },
            /**
             * TIF-274: the gate's registry rejected the task spec (for example an fc-v1
             * invalid-target task), so no gate decision exists. Its own outcome, never a
             * verdict: `called` is false, `verdict` null, and the row is never accepted.
             */
            unregistrable: { const: true },
            /**
             * M2 scope add B: whether the gate's agent-safe correction channel was on for
             * this trial (`GateConfig.corrections`). Written on every row whose gate was
             * called; absent on rows written before the channel existed, which were off.
             * R1 evidence runs keep it "off" unless the lead rules otherwise.
             */
            corrections: { type: "string", enum: ["off", "on"] },
          },
        },
      ],
    },
    /**
     * Experiment-only label (corrections ON/OFF A/B, `src/pilot/ab.ts`): set on EVERY row an
     * experiment run writes, the OFF arm included. A labelled row is never R1 evidence:
     * `checkBenchmark(..., { evidence: true })` and the M2 pack CLI's provenance check
     * (`src/m2/provenance.ts`) refuse it. Absent on every R1 and pilot row.
     */
    experiment: { type: "string", pattern: "^[a-z0-9-]{1,32}/[a-z0-9-]{1,32}$" },
    /** Whether the run's "done" was let through. Must agree with claim + gate (the check enforces it). */
    accepted: { type: "boolean" },
    /** SHA-256 of the persisted document handed to the grader, or null if none was captured. */
    persistedSha256: nullableSha,
    /** Cause for a non-accepted or harness-affected row (M2 plan §2.2), or null. */
    cause: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "detail"],
          properties: {
            kind: { type: "string", enum: ["agent", "oracle", "harness"] },
            detail: { type: "string", maxLength: 200 },
          },
        },
      ],
    },
    /** R7 cost fields; null = not measured (never 0 for unmeasured). */
    cost: {
      type: "object",
      additionalProperties: false,
      required: ["modelUsd", "wallClockS", "vmS"],
      properties: { modelUsd: nullableNumber, wallClockS: nullableNumber, vmS: nullableNumber },
    },
  },
};

export const benchmarkGradeRowSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "trialKey",
    "taskId",
    "graderVersion",
    "status",
    "reasons",
    "fixtureSha256",
    "persistedSha256",
    "target",
    "targetSatisfied",
    "mismatchCount",
  ],
  properties: {
    schema: { const: "myco.benchmark.grade-row/1" },
    trialKey,
    taskId,
    graderVersion: { type: "string", minLength: 1, maxLength: 64 },
    status: { type: "string", enum: ["pass", "fail", "ungradable"] },
    reasons: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } },
    fixtureSha256: sha256Hex,
    persistedSha256: nullableSha,
    target: {
      anyOf: [{ type: "string", pattern: "^[A-Z]{1,3}[1-9][0-9]{0,6}$" }, { type: "null" }],
    },
    /** Target cell alone correct (null: ungradable or no target). `status` stays strict. */
    targetSatisfied: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    mismatchCount: { type: "integer", minimum: 0 },
  },
};

/**
 * Grade request (input to `scripts/benchmark-grade.ts`, one JSON line per trial). Written
 * by the arm harness; read only by the grader. It names local files, so it is internal and
 * never published. There is no field for the agent's claim or the gate verdict.
 */
const relativeFile: JsonSchema = {
  type: "string",
  // Relative, inside the request directory: no leading slash, no drive, no `..` segment.
  pattern: "^(?![A-Za-z]:)(?![\\\\/])(?!.*(^|[\\\\/])\\.\\.([\\\\/]|$)).{1,512}$",
};
export const benchmarkGradeRequestSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "trialKey",
    "taskId",
    "fixtureSha256",
    "fixtureFile",
    "persistedFile",
    "persistedFormat",
    "intent",
    "columnTypes",
  ],
  properties: {
    trialKey,
    /** Must equal the arm row's `taskId` (the check fails otherwise). */
    taskId,
    fixtureSha256: sha256Hex,
    fixtureFile: relativeFile,
    /** Null when the harness captured no document: the grade is `ungradable`. */
    persistedFile: { anyOf: [relativeFile, { type: "null" }] },
    /** `xlsx` for a Calc-saved workbook (both arms on the VM); `csv` for the fake app. */
    persistedFormat: { type: "string", enum: ["xlsx", "csv"] },
    intent: {
      type: "object",
      additionalProperties: false,
      required: ["rowKey", "column", "newValue"],
      properties: {
        rowKey: { type: "string", minLength: 1 },
        column: { type: "string", minLength: 1 },
        newValue: { type: "string" },
      },
    },
    /** Every header column of the fixture must be typed, or the grade is `ungradable`. */
    columnTypes: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
  },
};

/**
 * Published task row (`benchmark/false-completion/<version>/tasks.jsonl`, TIF-267 part 2).
 * Closed. Carries the grader's inputs (fixture by hash, intent, column types) and the
 * agent's instruction text; no expected end state is stored, the grader derives it.
 */
const columnType: JsonSchema = {
  type: "string",
  enum: ["key", "text", "integer", "date", "currency"],
};
export const benchmarkTaskSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "taskSetVersion",
    "taskId",
    "family",
    "faultClass",
    "inDemo",
    "satisfiable",
    "instruction",
    "instructionSha256",
    "intent",
    "columnTypes",
    "fixtureSeed",
    "fixtureFile",
    "fixtureSha256",
    "persistedFormat",
  ],
  properties: {
    schema: { const: "myco.benchmark.task/1" },
    taskSetVersion: { type: "string", minLength: 1, maxLength: 64 },
    taskId,
    family: { type: "string", enum: ["calc-record-edit"] },
    faultClass: { type: "string", pattern: "^[a-z0-9-]{1,64}$" },
    inDemo: { type: "boolean" },
    satisfiable: { type: "boolean" },
    instruction: { type: "string", minLength: 1, maxLength: 500 },
    instructionSha256: sha256Hex,
    intent: {
      type: "object",
      additionalProperties: false,
      required: ["rowKey", "column", "newValue"],
      properties: {
        rowKey: { type: "string", minLength: 1 },
        column: { type: "string", minLength: 1 },
        newValue: { type: "string" },
      },
    },
    columnTypes: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "qty", "joined", "salary"],
      properties: {
        id: columnType,
        name: columnType,
        qty: columnType,
        joined: columnType,
        salary: columnType,
      },
    },
    fixtureSeed: { type: "string", minLength: 1, maxLength: 64 },
    fixtureFile: { type: "string", pattern: "^fixtures/[0-9a-f]{64}\\.csv$" },
    fixtureSha256: sha256Hex,
    persistedFormat: { type: "string", enum: ["xlsx"] },
  },
};
