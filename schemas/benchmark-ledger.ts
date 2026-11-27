import type { JsonSchema } from "./validate.ts";

/**
 * False-completion benchmark ledgers (TIF-267 / M2-04). Two closed row shapes, written by
 * two different parties and joined only by the check (`src/benchmark/check.ts`):
 *
 *  - an ARM row, written by the arm's harness (Myco's gate arm, `hcu+shell`, or a capability
 *    arm, `CAPABILITY_ARMS`, which is never R1 or evidence): what the
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

/** The arms the R1 and A/B evidence paths read. Unchanged by the capability arms. */
export const R1_PATH_ARMS = ["myco-gate", "hcu+shell"] as const;

/**
 * Capability-arm values (tracks I-V; capability-spec.md §3.4, capability-spec-2.md §1.5),
 * added as ONE reviewed schema change. Each is a tool surface written `<base>+<capability>`,
 * with Part 2's base surface `B` resolved to `C1` (capability-spec-2.md §1.3: "Until any
 * Part 1 bar is shown, `B` = `C1`"); a later base (e.g. `C1+I+N`) is a new reviewed change.
 * `C1` is the screenshot-only baseline on the capability (Ultra) harness, gate-less by
 * default and gated for K's and P's baseline. `hcu+shell` is a baseline too, but it is an
 * R1-path arm and stays in `R1_PATH_ARMS`, unchanged. Q and S have no arms (property bars).
 *
 * Capability rows are experiment rows: `checkBenchmark` refuses every one of these values
 * under `evidence` and under the task-set binding (`--require-r1`, `--evidence`), and the M2
 * pack manifest's `expectTrials` admits only `R1_PATH_ARMS`, so no R1 or A/B pack holds one.
 */
export const CAPABILITY_ARMS = [
  "C1",
  "C1+I",
  "hcu+shell+I",
  "hcu+shell+J",
  "C1+K",
  "C1+L",
  "C1+M",
  "C1+M-cold",
  "C1+N",
  "C1+O",
  "C1+P",
  "hcu+shell+R",
  "C1+T",
  "hcu+shell+T",
  "C1+U",
  "hcu+shell+U",
  "hcu+shell+V",
] as const;

/**
 * Which track each capability arm belongs to and the same-harness baseline arm it pairs with
 * (the bar's comparison, or a reported secondary). `C1` is every C1-based track's baseline.
 */
export const CAPABILITY_ARM_PAIRS: Readonly<
  Record<
    Exclude<(typeof CAPABILITY_ARMS)[number], "C1" | "C1+M-cold">,
    {
      readonly track: string;
      readonly baseline: "C1" | "hcu+shell" | "C1+M-cold";
      readonly role: "primary" | "secondary";
    }
  >
> = {
  "C1+I": { track: "I", baseline: "C1", role: "primary" },
  "hcu+shell+I": { track: "I", baseline: "hcu+shell", role: "secondary" },
  "hcu+shell+J": { track: "J", baseline: "hcu+shell", role: "primary" },
  "C1+K": { track: "K", baseline: "C1", role: "primary" },
  "C1+L": { track: "L", baseline: "C1", role: "primary" },
  "C1+M": { track: "M", baseline: "C1+M-cold", role: "primary" },
  "C1+N": { track: "N", baseline: "C1", role: "primary" },
  "C1+O": { track: "O", baseline: "C1", role: "primary" },
  "C1+P": { track: "P", baseline: "C1", role: "primary" },
  "hcu+shell+R": { track: "R", baseline: "hcu+shell", role: "primary" },
  "C1+T": { track: "T", baseline: "C1", role: "primary" },
  "hcu+shell+T": { track: "T", baseline: "hcu+shell", role: "secondary" },
  "C1+U": { track: "U", baseline: "C1", role: "primary" },
  "hcu+shell+U": { track: "U", baseline: "hcu+shell", role: "primary" },
  "hcu+shell+V": { track: "V", baseline: "hcu+shell", role: "primary" },
};

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
    arm: { type: "string", enum: [...R1_PATH_ARMS, ...CAPABILITY_ARMS] },
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
    /**
     * Myco arm: the gate call. `hcu+shell`: null (that arm has no gate). A capability arm:
     * null on a gate-less row, the gate call on a gated row (capability-spec.md §1.1).
     */
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
    /**
     * Present only on rows from an experiment run, never on evidence rows (TIF-274 / track B;
     * #547). Today the one experiment is the corrections ON/OFF A/B: its stage, its arm, and
     * the run's fresh seed (the identity a reused trial cannot shed by changing its key). The
     * evidence check and the M2 pack check refuse every row that carries it.
     */
    experiment: {
      type: "object",
      additionalProperties: false,
      required: ["id", "stage", "arm", "seed"],
      properties: {
        id: { const: "corrections-ab" },
        stage: { type: "integer", enum: [0, 1] },
        arm: { type: "string", enum: ["on", "off"] },
        seed: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
      },
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
