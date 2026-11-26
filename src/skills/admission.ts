/**
 * Track M admission: the one door into the skill store.
 *
 * A procedure becomes a skill only when ALL of these hold, each checked here and each
 * failing closed with a stable code (a candidate that meets none of the rules and one that
 * misses only one are refused the same way):
 *
 *  - the gate VERIFIED this run: `verdict === "verified"`, `accepted === true`, and the
 *    reason codes contain `ORACLE_PASS` (the only code that goes with verified);
 *  - the gate result is this run's and this task's (`request.runId`, `request.taskId`), and
 *    names an oracle whose family is the candidate's task family;
 *  - the independent grader graded it and it PASSED (`status === "pass"`; a missing grade,
 *    `fail` or `ungradable` is refused);
 *  - the grader and the gate looked at the same bytes: the grade's `persistedSha256` equals
 *    the gate's `persisted-state` evidence ref digest;
 *  - the grader graded against this task's published fixture: the grade's `fixtureSha256`
 *    equals the task's (`candidate.fixtureSha256`);
 *  - the planner is real: a simulated planner (`isSimulatedPlanner`) is refused unless the
 *    caller explicitly scopes the admission as simulated (`{ simulated: true }`, the $0
 *    tests). A simulated skill is then marked `simulated` and only served to simulated
 *    trials (`retrieve.ts`);
 *  - the run was not assisted (track N): `assisted` must be explicitly `false`; absent or
 *    true is refused;
 *  - gate corrections were off for the run and the gate delivered none: a run that only
 *    got there through corrections (#514 loop) is refused;
 *  - the procedure passes the content rules (`record.ts`): bounded, printable, and free of
 *    secrets, host paths, oracle internals, expected values and fixture contents;
 *  - the operator supplied the task's forbidden values (an empty list is refused: without
 *    it the expected-value check could not run);
 *  - the ledger reference is well formed (the ledger itself lands with #518).
 *
 * Both outcomes are recorded in the skill's provenance as digests (`verdictDigest`,
 * `gradeDigest`), never as the raw results.
 */

import type { GradeResult } from "../benchmark/grade/grade.ts";
import type { GateResult } from "../gate/api.ts";
import {
  type ContentCode,
  canonicalJson,
  checkProcedure,
  type ForbiddenValues,
  isSimulatedPlanner,
  PLAIN_ID,
  recordDigest,
  SKILL_RECORD_SCHEMA,
  type SkillRecord,
  sha256,
  skillIdFor,
  TOKEN,
} from "./record.ts";

/** The gate fields admission reads. */
export type AdmissionGate = Pick<
  GateResult,
  "verdict" | "accepted" | "reasonCodes" | "request" | "evidenceRefs" | "oracle"
> &
  Partial<Pick<GateResult, "corrections">>;

/** The grader fields admission reads. */
export type AdmissionGrade = Pick<
  GradeResult,
  "graderVersion" | "status" | "fixtureSha256" | "persistedSha256" | "mismatchCount"
>;

export interface AdmissionCandidate {
  readonly runId: string;
  readonly taskId: string;
  readonly taskFamily: string;
  /** The published task's fixture digest (`BenchmarkTask.fixtureSha256`). */
  readonly fixtureSha256: string;
  readonly features: readonly string[];
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly ledgerRef: { readonly ledger: string; readonly entrySha256: string };
  /** The harness's own post-stop gate check for this run (`runGatedTrial`'s `result`). */
  readonly gate: AdmissionGate | null;
  /** The independent grader's result for the same run, or null when ungraded. */
  readonly grade: AdmissionGrade | null;
  /** Track N: whether a human or assistant helped the run. Must be explicitly false. */
  readonly assisted?: boolean;
  /** Whether gate corrections were on for the run (`runGatedTrial`'s outcome). */
  readonly corrections?: "on" | "off";
  readonly plannerModelId: string;
}

export const ADMISSION_CODES = [
  "INVALID_CANDIDATE",
  "NO_GATE_RESULT",
  "GATE_NOT_VERIFIED",
  "GATE_NOT_ACCEPTED",
  "GATE_NO_ORACLE_PASS",
  "GATE_RUN_MISMATCH",
  "GATE_TASK_MISMATCH",
  "GATE_FAMILY_MISMATCH",
  "UNGRADED",
  "GRADE_NOT_PASS",
  "GRADE_BYTES_MISMATCH",
  "GRADE_FIXTURE_MISMATCH",
  "SIMULATED_PLANNER",
  "ASSISTED_OR_UNKNOWN",
  "CORRECTIONS_ON",
  "CORRECTIONS_DELIVERED",
  "LEDGER_REF_INVALID",
  "NO_FORBIDDEN_VALUES",
] as const;
export type AdmissionCode = (typeof ADMISSION_CODES)[number] | ContentCode;

export type AdmissionResult =
  | { readonly ok: true; readonly record: SkillRecord }
  | { readonly ok: false; readonly code: AdmissionCode };

/** Digest of the gate verdict fields (the agent's free-text claim is left out). */
export function verdictDigest(gate: AdmissionGate): string {
  return sha256(
    canonicalJson({
      verdict: gate.verdict,
      accepted: gate.accepted,
      reasonCodes: [...gate.reasonCodes],
      taskId: gate.request.taskId ?? null,
      runId: gate.request.runId ?? null,
      oracle: gate.oracle ?? null,
      evidenceRefs: gate.evidenceRefs.map((r) => ({
        kind: r.kind,
        sha256: r.sha256,
        bytes: r.bytes,
      })),
    }),
  );
}

/** Digest of the grader result fields. */
export function gradeDigest(grade: AdmissionGrade): string {
  return sha256(
    canonicalJson({
      graderVersion: grade.graderVersion,
      status: grade.status,
      fixtureSha256: grade.fixtureSha256,
      persistedSha256: grade.persistedSha256,
      mismatchCount: grade.mismatchCount,
    }),
  );
}

const fail = (code: AdmissionCode): AdmissionResult => ({ ok: false, code });

/** Admission scope. `simulated: true` admits simulated planners ($0 tests only). */
export interface AdmissionScope {
  readonly simulated?: boolean;
}

/** Decide whether `c` may become a skill. Never throws on malformed input; refuses it. */
export function admit(
  c: AdmissionCandidate,
  forbidden: ForbiddenValues,
  scope: AdmissionScope = {},
): AdmissionResult {
  if (typeof c !== "object" || c === null) return fail("INVALID_CANDIDATE");
  if (
    typeof c.runId !== "string" ||
    !PLAIN_ID.test(c.runId) ||
    typeof c.taskId !== "string" ||
    !PLAIN_ID.test(c.taskId) ||
    typeof c.taskFamily !== "string" ||
    !TOKEN.test(c.taskFamily) ||
    typeof c.plannerModelId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(c.plannerModelId)
  )
    return fail("INVALID_CANDIDATE");
  if (isSimulatedPlanner(c.plannerModelId) && scope.simulated !== true)
    return fail("SIMULATED_PLANNER");

  // Gate: verified, accepted, ORACLE_PASS, this run, this task, this family.
  const g = c.gate;
  if (g === null || typeof g !== "object") return fail("NO_GATE_RESULT");
  if (g.verdict !== "verified") return fail("GATE_NOT_VERIFIED");
  if (g.accepted !== true) return fail("GATE_NOT_ACCEPTED");
  if (!Array.isArray(g.reasonCodes) || !g.reasonCodes.includes("ORACLE_PASS"))
    return fail("GATE_NO_ORACLE_PASS");
  if (g.request?.runId !== c.runId) return fail("GATE_RUN_MISMATCH");
  if (g.request?.taskId !== c.taskId) return fail("GATE_TASK_MISMATCH");
  if (g.oracle?.family !== c.taskFamily) return fail("GATE_FAMILY_MISMATCH");

  // Grader: graded, passed, on the bytes the gate decided on.
  const gr = c.grade;
  if (gr === null || typeof gr !== "object") return fail("UNGRADED");
  if (gr.status !== "pass") return fail("GRADE_NOT_PASS");
  const persistedRefs = (g.evidenceRefs ?? []).filter((r) => r.kind === "persisted-state");
  if (
    persistedRefs.length !== 1 ||
    typeof gr.persistedSha256 !== "string" ||
    persistedRefs[0]?.sha256 !== gr.persistedSha256
  )
    return fail("GRADE_BYTES_MISMATCH");
  if (typeof c.fixtureSha256 !== "string" || gr.fixtureSha256 !== c.fixtureSha256)
    return fail("GRADE_FIXTURE_MISMATCH");

  // Not assisted, no corrections.
  if (c.assisted !== false) return fail("ASSISTED_OR_UNKNOWN");
  if (c.corrections !== "off") return fail("CORRECTIONS_ON");
  if ((g.corrections?.length ?? 0) > 0) return fail("CORRECTIONS_DELIVERED");

  const lr = c.ledgerRef;
  if (
    typeof lr !== "object" ||
    lr === null ||
    typeof lr.ledger !== "string" ||
    !PLAIN_ID.test(lr.ledger) ||
    typeof lr.entrySha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(lr.entrySha256)
  )
    return fail("LEDGER_REF_INVALID");

  if (
    typeof forbidden !== "object" ||
    forbidden === null ||
    !Array.isArray(forbidden.values) ||
    forbidden.values.length === 0
  )
    return fail("NO_FORBIDDEN_VALUES");
  const content = checkProcedure(
    { preconditions: c.preconditions, steps: c.steps, features: c.features },
    forbidden,
  );
  if (content !== null) return fail(content);

  const body = {
    schema: SKILL_RECORD_SCHEMA as typeof SKILL_RECORD_SCHEMA,
    taskFamily: c.taskFamily,
    features: [...new Set(c.features)].sort(),
    preconditions: [...c.preconditions],
    steps: [...c.steps],
    provenance: {
      runId: c.runId,
      taskId: c.taskId,
      ledgerRef: { ledger: lr.ledger, entrySha256: lr.entrySha256 },
      gateVerdict: "verified" as const,
      verdictSha256: verdictDigest(g),
      gradeStatus: "pass" as const,
      graderVersion: gr.graderVersion,
      gradeSha256: gradeDigest(gr),
      persistedSha256: gr.persistedSha256,
      plannerModelId: c.plannerModelId,
      simulated: isSimulatedPlanner(c.plannerModelId),
      assisted: false as const,
      corrections: "off" as const,
    },
  };
  const recordSha256 = recordDigest(body);
  return { ok: true, record: { ...body, skillId: skillIdFor(recordSha256), recordSha256 } };
}
