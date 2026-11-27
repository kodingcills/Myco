/**
 * Track J, pre-registration j-v1: the harness side (non-VM).
 *
 * Three pieces the J arm needs to produce analysable rows on the Ultra `hcu+shell` harness,
 * none of which runs a model or touches the VM:
 *
 * - `loadJV1Prereg` reads the committed pre-registration, refuses it unless the analysis
 *   script's bytes still hash to the SHA-256 it names, and returns the pre-registration hash
 *   every pack must record (capability spec §3 items 1-2);
 * - `jV1Schedule` (from the frozen analysis script) is the seeded order the harness runs the
 *   (task, arm) trials in; the analysis refuses a pack that ran in any other order;
 * - `jTrialFromFastPathRow` turns a `myco.capability.fast-path-row/1` row plus the harness's
 *   own counts into the analysis row (`myco.capability.j-v1.trial/1`). A trial whose number
 *   of `myco-cap` calls differs from its route records is a harness fault (`UNRECORDED_ROUTE`),
 *   counted, never verified (spec §2 J guardrail).
 *
 * The baseline arm's rows come from the Ultra `hcu+shell` harness; their adapter is a
 * follow-up, because that harness (and the per-trial step count it must record) is not on
 * `main` yet.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FastPathArmRow, fastPathRowProblems } from "./arm.ts";
import {
  J_CAPABILITY_ARM,
  J_V1_TRIAL_SCHEMA,
  type JTrialRow,
  type JV1Prereg,
  jV1Schedule,
  preregHash,
  preregProblems,
} from "./j-v1-analysis.ts";

export { jV1Schedule };

export const J_V1_PREREG_PATH = "docs/product/capability-prereg/j-v1/prereg.json";
export const J_V1_ANALYSIS_PATH = "src/actions/j-v1-analysis.ts";

export interface LoadedJV1Prereg {
  readonly prereg: JV1Prereg;
  /** SHA-256 over the canonical JSON of prereg.json: what every pack records. */
  readonly hash: string;
}

/** Read and check the committed j-v1 pre-registration. Throws on any mismatch. */
export function loadJV1Prereg(repoRoot: string): LoadedJV1Prereg {
  const raw: unknown = JSON.parse(readFileSync(join(repoRoot, J_V1_PREREG_PATH), "utf8"));
  const problems = preregProblems(raw);
  if (problems.length > 0) throw new Error(`j-v1 pre-registration: ${problems.join(", ")}`);
  const analysis = (raw as { analysis?: { script?: unknown; sha256?: unknown } }).analysis;
  if (analysis?.script !== J_V1_ANALYSIS_PATH)
    throw new Error("j-v1 pre-registration: analysis script path is not the frozen script");
  const actual = createHash("sha256")
    .update(readFileSync(join(repoRoot, J_V1_ANALYSIS_PATH)))
    .digest("hex");
  if (analysis.sha256 !== actual)
    throw new Error("j-v1 pre-registration: the analysis script does not match its SHA-256");
  return { prereg: raw as JV1Prereg, hash: preregHash(raw) };
}

/** What the harness itself counted for one J trial, outside the router's log. */
export interface JHarnessCounts {
  /** The trial's position in `jV1Schedule`. */
  readonly seq: number;
  /** Agent tool calls of every kind (GUI action, shell call, act, act_script). */
  readonly toolCalls: number;
  /** Agent calls to `mcp__myco-cap__act` and `mcp__myco-cap__act_script`. */
  readonly capToolCalls: number;
  /** A route or shell access that resolved outside the boundary. */
  readonly boundaryBreach: boolean;
  /** Any other harness fault code for this trial. */
  readonly harnessFault?: string;
}

/** The analysis row for one J trial. Throws on a row or count the harness should never produce. */
export function jTrialFromFastPathRow(row: FastPathArmRow, counts: JHarnessCounts): JTrialRow {
  const problems = fastPathRowProblems(row);
  if (problems.length > 0) throw new Error(`fast-path row refused: ${problems.join(", ")}`);
  for (const [name, v] of [
    ["seq", counts.seq],
    ["toolCalls", counts.toolCalls],
    ["capToolCalls", counts.capToolCalls],
  ] as const)
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`bad harness count ${name}`);
  if (counts.capToolCalls > counts.toolCalls)
    throw new Error("more myco-cap calls than tool calls");
  const unrecorded = counts.capToolCalls !== row.routeLog.length;
  return {
    schema: J_V1_TRIAL_SCHEMA,
    taskId: row.taskId,
    arm: J_CAPABILITY_ARM,
    seq: counts.seq,
    plannerModelId: row.plannerModelId,
    simulated: row.simulated,
    claim: row.claim === "done" ? "done" : "not-done",
    grade: row.grade,
    steps: counts.toolCalls,
    wallMs: row.wallMs,
    harnessFault: counts.harnessFault ?? (unrecorded ? "UNRECORDED_ROUTE" : null),
    boundaryBreach: counts.boundaryBreach,
  };
}
