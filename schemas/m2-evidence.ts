import type { JsonSchema } from "./validate.ts";

/**
 * M2 evidence pack (TIF-273 / M2-11). A pack is one directory under
 * `docs/research/experiments/m2-<name>/` holding:
 *
 *  - `pack.json`   this manifest: which scorecard rows the pack is evidence for, and the
 *                  counts the check must find (lesson L3: a check takes an expected count);
 *  - `arm.jsonl`   arm rows, `myco.benchmark.arm-row/1` (schemas/benchmark-ledger.ts);
 *  - `grades.jsonl` grade rows, `myco.benchmark.grade-row/1`, from the independent grader;
 *  - `ops.jsonl`   one trial-ops row per arm row (below): the process record the M2 plan
 *                  §2.2 keeps as a CI gate instead of a scorecard row.
 *
 * The check is `src/m2/evidence.ts`; the scorecard check `scripts/m2-scorecard-check.py`
 * quotes what it recomputes.
 */

const positiveInt: JsonSchema = { type: "integer", minimum: 1 };

export const M2_PACK_ROWS = ["R1", "R2", "R3", "R7"] as const;

export const m2PackManifestSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "rows", "expectTrials", "expectPairs", "runs"],
  properties: {
    schema: { const: "myco.m2.pack/1" },
    /** Scorecard rows this pack is evidence for. */
    rows: {
      type: "array",
      minItems: 1,
      maxItems: M2_PACK_ROWS.length,
      items: { type: "string", enum: [...M2_PACK_ROWS] },
    },
    /** Expected arm-row count per arm; an arm present in arm.jsonl must be listed. */
    expectTrials: {
      type: "object",
      additionalProperties: false,
      properties: { "myco-gate": positiveInt, "hcu+shell": positiveInt },
    },
    /** R2: the expected number of task pairs across the two arms; null otherwise. */
    expectPairs: { anyOf: [positiveInt, { type: "null" }] },
    /**
     * Committed run directories (trace.jsonl + result.json), validated with
     * `src/integration/validate-live.ts --expect`; null when the arm emits none.
     */
    runs: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["path", "expect"],
          properties: {
            path: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" },
            expect: positiveInt,
          },
        },
      ],
    },
  },
};

/** Harness classes from the M2 plan §2.2 (the TIF-216/219/220 lessons). */
export const HARNESS_CLASSES = [
  "convert-deadline",
  "deploy-copy",
  "sshd",
  "timeout",
  "load",
] as const;

/**
 * Per-trial process record. `hostLoad1mStart` is the host's 1-minute load when the trial
 * started (the guest load gate: no trial starts at load >= 10, eval-runbook §7.3).
 * `harnessClass` is set exactly when the arm row's `cause.kind` is `harness`.
 * `faultLanded` says whether the injected fault took effect; it is null exactly on an
 * unfaulted trial (`faultClass: "none"`). A fault that never landed makes the trial
 * ineligible for R1 and R3 (eval-runbook, M1 corrupt suite: "a fault that never landed is
 * also ineligible").
 */
export const m2TrialOpsSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "trialKey", "hostLoad1mStart", "harnessClass", "faultLanded"],
  properties: {
    schema: { const: "myco.m2.trial-ops/1" },
    trialKey: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
    hostLoad1mStart: { type: "number", minimum: 0 },
    harnessClass: {
      anyOf: [{ type: "string", enum: [...HARNESS_CLASSES] }, { type: "null" }],
    },
    faultLanded: { anyOf: [{ type: "boolean" }, { type: "null" }] },
  },
};
