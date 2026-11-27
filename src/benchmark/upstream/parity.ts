/**
 * Fleet parity assessment for the public R1 (lead rulings 2026-11-27 14:05Z, 14:37Z, 15:21Z;
 * #741). The pre-declared sample (docs/benchmark/upstream/r1-parity-sample.json) lists OSWorld
 * LibreOffice tasks, each with a scripted known-good and known-bad action sequence. The parity
 * harness (src/benchmark/upstream/fleet/osworld_parity.py) runs each sequence through upstream
 * `DesktopEnv` and `DesktopEnv.evaluate()` on one environment and writes one record per (task,
 * sequence). This module only reads those records.
 *
 * Per task:
 *  - INCOMPLETE: a record for one of the four (env, sequence) runs is missing;
 *  - SEQUENCE_INVALID: on the reference the known-good sequence is not a pass (exactly 1.0) or
 *    the known-bad one is not a gradable fail; the sample, not the fleet, is wrong;
 *  - MATCH: the fleet gives the reference's status for both sequences (pass, fail);
 *  - GAP: it does not, including an ungradable fleet run (a stated gap).
 * Parity passes only when the sample's shape is sound, every record is admissible and every
 * task matches. A record is admissible when it is LIVE-SCRIPTED (never MOCK or simulated:
 * `simulated` must be absent or exactly false), graded by the upstream evaluate path at the pin,
 * for this exact sample (its SHA-256), from that environment's provider, with a harness stamp
 * that passes `harnessStampProblems`, and unique per (env, task, sequence). Reasons are codes.
 */
import { MYCO_FLEET } from "./pins.ts";
import { PARITY_RULE_PHRASE, preregSha256 } from "./prereg.ts";
import type { HarnessStamp } from "./r1-grade.ts";
import { harnessStampProblems, OSWORLD_EVALUATE_GRADER, R1_PASS_SCORE } from "./r1-grade.ts";

export const PARITY_ENVS = { fleet: MYCO_FLEET.provider, reference: MYCO_FLEET.referenceProvider };
export type ParityEnv = keyof typeof PARITY_ENVS;
export const PARITY_SEQUENCES = ["known-good", "known-bad"] as const;

export interface ParityTask {
  readonly taskId: string;
  readonly knownGood: readonly unknown[];
  readonly knownBad: readonly unknown[];
  readonly [k: string]: unknown;
}
export interface ParitySample {
  readonly schema: string;
  readonly taskSet: string;
  readonly rule: string;
  readonly envs: Readonly<Record<string, { readonly provider: string }>>;
  readonly tasks: readonly ParityTask[];
  readonly [k: string]: unknown;
}
export interface ParityRecord {
  readonly label: string;
  readonly env: string;
  readonly provider: string;
  readonly taskId: string;
  readonly sequence: string;
  readonly score: number | null;
  readonly graderVersion: string;
  readonly sampleSha256: string;
  readonly hostLabel: string;
  readonly stamp: HarnessStamp;
  readonly simulated?: unknown;
}
export type ParityStatus = "pass" | "fail" | "ungradable" | "missing";
export interface ParityTaskResult {
  readonly taskId: string;
  readonly verdict: "MATCH" | "GAP" | "SEQUENCE_INVALID" | "INCOMPLETE";
  readonly fleet: Readonly<Record<(typeof PARITY_SEQUENCES)[number], ParityStatus>>;
  readonly reference: Readonly<Record<(typeof PARITY_SEQUENCES)[number], ParityStatus>>;
}
export interface ParityAssessment {
  readonly passed: boolean;
  readonly sampleSha256: string;
  readonly reasons: readonly string[];
  readonly tasks: readonly ParityTaskResult[];
}

const ACTION = (a: unknown): boolean => {
  if (!a || typeof a !== "object") return false;
  const t = (a as { action_type?: unknown }).action_type;
  if (t === "DONE" || t === "FAIL" || t === "WAIT") return true;
  return t === "tool_use" && typeof (a as { command?: unknown }).command === "string";
};

/** Codes for every way the sample misses what the parity ruling requires. */
export function paritySampleProblems(sample: ParitySample, subset: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (sample.schema !== "myco.parity.sample/1") out.push("PARITY_SCHEMA");
  if (typeof sample.rule !== "string" || !sample.rule.includes(PARITY_RULE_PHRASE))
    out.push("PARITY_RULE_MISSING");
  if (
    sample.envs?.fleet?.provider !== PARITY_ENVS.fleet ||
    sample.envs?.reference?.provider !== PARITY_ENVS.reference
  )
    out.push("PARITY_ENVS_WRONG");
  const tasks = Array.isArray(sample.tasks) ? sample.tasks : [];
  if (tasks.length === 0) out.push("PARITY_SAMPLE_EMPTY");
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!subset.has(t.taskId)) out.push(`PARITY_TASK_OUTSIDE_SUBSET:${t.taskId}`);
    if (ids.has(t.taskId)) out.push(`PARITY_TASK_DUPLICATE:${t.taskId}`);
    ids.add(t.taskId);
    for (const key of ["knownGood", "knownBad"] as const) {
      const seq = t[key];
      if (!Array.isArray(seq) || seq.length === 0 || !seq.every(ACTION))
        out.push(`PARITY_SEQUENCE_MALFORMED:${t.taskId}:${key}`);
    }
  }
  return out;
}

const statusOf = (r: ParityRecord | undefined): ParityStatus => {
  if (r === undefined) return "missing";
  if (typeof r.score !== "number" || !Number.isFinite(r.score)) return "ungradable";
  return r.score === R1_PASS_SCORE ? "pass" : "fail";
};

export function assessParity(
  sample: ParitySample,
  subset: ReadonlySet<string>,
  records: readonly ParityRecord[],
): ParityAssessment {
  const sampleSha256 = preregSha256(sample);
  const reasons = paritySampleProblems(sample, subset).map((p) => `SAMPLE_INVALID:${p}`);
  const tasks = Array.isArray(sample.tasks) ? sample.tasks : [];
  const declared = new Set(tasks.map((t) => t.taskId));
  const byKey = new Map<string, ParityRecord>();
  for (const r of records) {
    const env = r.env as ParityEnv;
    const where = `${r.env}:${r.taskId}:${r.sequence}`;
    if (r.label !== "LIVE-SCRIPTED") reasons.push(`RECORD_NOT_LIVE:${where}`);
    if (r.simulated !== undefined && r.simulated !== false)
      reasons.push(`RECORD_SIMULATED:${where}`);
    if (r.graderVersion !== OSWORLD_EVALUATE_GRADER) reasons.push(`RECORD_NOT_UPSTREAM:${where}`);
    if (r.sampleSha256 !== sampleSha256) reasons.push(`RECORD_OTHER_SAMPLE:${where}`);
    if (!(env in PARITY_ENVS) || r.provider !== PARITY_ENVS[env])
      reasons.push(`RECORD_PROVIDER_WRONG:${where}`);
    else if (harnessStampProblems(r.stamp, PARITY_ENVS[env]).length > 0)
      reasons.push(`RECORD_HARNESS_NOT_PINNED:${where}`);
    if (typeof r.hostLabel !== "string" || r.hostLabel.trim() === "")
      reasons.push(`RECORD_HOST_UNLABELLED:${where}`);
    if (!declared.has(r.taskId) || !(PARITY_SEQUENCES as readonly string[]).includes(r.sequence))
      reasons.push(`RECORD_NOT_DECLARED:${where}`);
    if (byKey.has(where)) reasons.push(`RECORD_DUPLICATE:${where}`);
    byKey.set(where, r);
  }
  const results: ParityTaskResult[] = tasks.map((t) => {
    const side = (env: ParityEnv) => ({
      "known-good": statusOf(byKey.get(`${env}:${t.taskId}:known-good`)),
      "known-bad": statusOf(byKey.get(`${env}:${t.taskId}:known-bad`)),
    });
    const fleet = side("fleet");
    const reference = side("reference");
    const all = [...Object.values(fleet), ...Object.values(reference)];
    let verdict: ParityTaskResult["verdict"];
    if (all.includes("missing")) verdict = "INCOMPLETE";
    else if (reference["known-good"] !== "pass" || reference["known-bad"] !== "fail")
      verdict = "SEQUENCE_INVALID";
    else if (fleet["known-good"] === "pass" && fleet["known-bad"] === "fail") verdict = "MATCH";
    else verdict = "GAP";
    return { taskId: t.taskId, verdict, fleet, reference };
  });
  for (const r of results) if (r.verdict !== "MATCH") reasons.push(`TASK_${r.verdict}:${r.taskId}`);
  return { passed: reasons.length === 0, sampleSha256, reasons, tasks: results };
}
