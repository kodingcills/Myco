/**
 * Track M (learning from verified outcomes): the skill record and its content rules.
 *
 * A skill is a short, reusable procedure taken from a run that the gate VERIFIED and the
 * independent grader PASSED (see `admission.ts`). This module owns what a record may hold
 * and how it is digested; it decides nothing about verdicts.
 *
 * A record never holds secrets, host paths, oracle internals, expected values or fixture
 * contents. The content check below REFUSES such text (it never redacts and keeps the
 * rest): a refused procedure is not stored at all. Every text field is printable ASCII
 * and bounded, so a record cannot smuggle control characters or look-alike Unicode.
 *
 * Provenance carries references and digests only: the run id, the attempt-ledger entry it
 * came from, a digest of the gate's verdict fields and a digest of the grader's result.
 * Not the evidence paths, not the oracle spec digest, not the persisted bytes.
 *
 * This module imports nothing from the gate or the grader at runtime (`import type` only;
 * `test/skills/isolation.test.ts`), and nothing under `src/gate/` or `src/benchmark/`
 * imports it: retrieved skills can never become gate or grader input.
 */
import { createHash } from "node:crypto";

export const SKILL_RECORD_SCHEMA = "myco.skills.record/1";

/** Bounds on a procedure. Above them the candidate is refused, not truncated. */
export const MAX_STEPS = 12;
export const MAX_PRECONDITIONS = 6;
export const MAX_TEXT = 160;
export const MAX_FEATURES = 16;

/** Printable ASCII only: no control characters, no Unicode look-alikes. */
const PRINTABLE = /^[\x20-\x7E]+$/;
/** Task family ids and similarity features: short lowercase tokens. */
export const TOKEN = /^[a-z0-9][a-z0-9:_.-]{0,47}$/;
/** Run ids and ledger names: plain names, never paths. */
export const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface SkillProvenance {
  /** The run the procedure was taken from. */
  readonly runId: string;
  /** The published task that run executed. */
  readonly taskId: string;
  /**
   * The attempt-ledger entry this outcome was recorded in: the ledger's plain name and the
   * SHA-256 of the entry's canonical bytes. The ledger itself lands with #518 (append-only
   * attempt ledger); the store checks the reference's shape, the ledger check its content.
   */
  readonly ledgerRef: { readonly ledger: string; readonly entrySha256: string };
  /** Always "verified": the only gate verdict a skill can come from. */
  readonly gateVerdict: "verified";
  /** SHA-256 of the canonical JSON of the gate verdict fields (`verdictDigest`). */
  readonly verdictSha256: string;
  /** Always "pass": the only grader status a skill can come from. */
  readonly gradeStatus: "pass";
  readonly graderVersion: string;
  /** SHA-256 of the canonical JSON of the grader result fields (`gradeDigest`). */
  readonly gradeSha256: string;
  /** SHA-256 of the persisted document both the gate and the grader decided on. */
  readonly persistedSha256: string;
  /** The planner that produced the run. `simulated:...` planners are plumbing, never evidence. */
  readonly plannerModelId: string;
  readonly simulated: boolean;
  /** Always false: assisted runs (track N) are never stored. */
  readonly assisted: false;
  /** Always "off": runs with gate corrections on are never stored. */
  readonly corrections: "off";
}

export interface SkillRecord {
  readonly schema: typeof SKILL_RECORD_SCHEMA;
  /** `sk-` + the first 16 hex characters of `recordSha256`. */
  readonly skillId: string;
  /** The gate family the task belongs to (e.g. `calc-record-edit`). */
  readonly taskFamily: string;
  /** Abstract similarity features (`app:calc`, `column-type:date`, ...), sorted, unique. */
  readonly features: readonly string[];
  /** What must hold before the procedure applies. Bounded, checked like steps. */
  readonly preconditions: readonly string[];
  /** The procedure, in order. Bounded, checked. */
  readonly steps: readonly string[];
  readonly provenance: SkillProvenance;
  /** SHA-256 of the canonical JSON of every field above (this field and skillId excluded). */
  readonly recordSha256: string;
}

/**
 * Whether a planner is a stand-in (a scripted agent, a fake, a dry run). Only a Claude model
 * id is not; the R1 evidence check (`EVIDENCE_PLANNERS`, `src/benchmark/check.ts`) is stricter
 * still, and skills-arm rows are never R1 evidence whatever their planner.
 */
export function isSimulatedPlanner(plannerModelId: string): boolean {
  return !/^claude-[a-z0-9.-]+$/.test(plannerModelId);
}

/** Canonical JSON: object keys sorted, no whitespace. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The digest a record is sealed with: everything but `recordSha256` and `skillId`. */
export function recordDigest(record: Omit<SkillRecord, "recordSha256" | "skillId">): string {
  const { schema, taskFamily, features, preconditions, steps, provenance } = record;
  return sha256(canonicalJson({ schema, taskFamily, features, preconditions, steps, provenance }));
}

export function skillIdFor(recordSha256: string): string {
  return `sk-${recordSha256.slice(0, 16)}`;
}

/** Content-rule failure codes (stable; agent-facing replies carry codes only). */
export const CONTENT_CODES = [
  "TEXT_NOT_PRINTABLE",
  "TEXT_TOO_LONG",
  "TEXT_EMPTY",
  "PROCEDURE_EMPTY",
  "PROCEDURE_TOO_LONG",
  "PRECONDITIONS_TOO_LONG",
  "FEATURES_INVALID",
  "FORBIDDEN_SECRET",
  "FORBIDDEN_HOST_PATH",
  "FORBIDDEN_ORACLE_INTERNAL",
  "FORBIDDEN_TASK_VALUE",
  "FORBIDDEN_INJECTION",
] as const;
export type ContentCode = (typeof CONTENT_CODES)[number];

/** Secret-shaped text. A match refuses the record; the matched text is never echoed. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{6,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /\b(api[_-]?key|secret|token|password|passwd|credential)s?\s*[:=]/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /[A-Za-z0-9+/_-]{40,}/,
];

/** Host paths: POSIX roots, home shorthands, Windows drives and shares, file URLs. */
const HOST_PATH_PATTERNS: readonly RegExp[] = [
  /(^|[^A-Za-z0-9])\/(Users|home|root|tmp|private|var|etc|opt|Volumes|mnt|srv|proc|dev|Library|Applications)(\/|\b)/,
  /(^|[\s"'`(=:])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]/,
  /(^|[^A-Za-z0-9])~[A-Za-z0-9_-]*\//,
  /\b[A-Za-z]:[\\/]/,
  /\\\\[A-Za-z0-9.$_-]+\\/,
  /\bfile:\/\//i,
  /\$(HOME|USERPROFILE|TMPDIR|APPDATA)\b|%(USERPROFILE|APPDATA|TEMP)%/i,
];

/**
 * Oracle internals: how the gate or the grader decides, what they compare against, and
 * their machinery. A procedure says what to do in the app, never how the check works.
 */
const ORACLE_PATTERNS: readonly RegExp[] = [
  /\boracles?\b/i,
  /\bverifiers?\b/i,
  /\bgraders?\b/i,
  /\bspec[_ ]?sha256\b/i,
  /\bground[ _-]?truth\b/i,
  /\bvault\b/i,
  /\breceipts?\b/i,
  /\bseal(ed|ing)?\b/i,
  /\bexpected[ _-]?(values?|state|document|cells?|output)\b/i,
  /\bfixtures?\b/i,
  /\bpristine\b/i,
  /\bevidence[ _-]?refs?\b/i,
  /\b(ORACLE|STATE|FIXTURE)_[A-Z_]+\b/,
  /\b(TARGET_MISMATCH|DOCUMENT_COLLATERAL|CLAIM_RECORDED|ASSIGNMENT_MISMATCH)\b/,
  /\bpersisted\//i,
  /\b(soffice|uno)\b/i,
];

/** Instructions aimed at the agent's controls rather than the app. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|override)\b.{0,40}\b(instructions?|prompt|rules|policy)\b/i,
  /\bsystem prompt\b/i,
  /\b(claim|report|say)\b.{0,30}\b(verified|done|accepted)\b.{0,30}\b(without|regardless|anyway)\b/i,
  /\bmcp__/i,
];

/** Whole-token, case-insensitive containment of `needle` in `text`. */
function containsToken(text: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, "i").test(text);
}

/**
 * The task values a procedure may not contain: the operator lists the task's expected
 * values and every fixture cell. Short values (under 3 characters: single digits, "id")
 * are skipped, because whole-token matching on them would refuse every procedure.
 */
export interface ForbiddenValues {
  readonly values: readonly string[];
}

export function forbiddenValuesFor(input: {
  readonly intent: { readonly rowKey: string; readonly column: string; readonly newValue: string };
  readonly fixtureRows: readonly (readonly string[])[];
}): ForbiddenValues {
  const set = new Set<string>([input.intent.rowKey, input.intent.newValue]);
  for (const row of input.fixtureRows) for (const cell of row) set.add(cell);
  return { values: [...set].filter((v) => v.trim().length >= 3) };
}

/** Check one text field. Returns the first failing code, or null. */
export function checkText(text: unknown, forbidden: ForbiddenValues | null): ContentCode | null {
  if (typeof text !== "string") return "TEXT_NOT_PRINTABLE";
  if (text.trim().length === 0) return "TEXT_EMPTY";
  if (text.length > MAX_TEXT) return "TEXT_TOO_LONG";
  if (!PRINTABLE.test(text)) return "TEXT_NOT_PRINTABLE";
  if (SECRET_PATTERNS.some((p) => p.test(text))) return "FORBIDDEN_SECRET";
  if (HOST_PATH_PATTERNS.some((p) => p.test(text))) return "FORBIDDEN_HOST_PATH";
  if (ORACLE_PATTERNS.some((p) => p.test(text))) return "FORBIDDEN_ORACLE_INTERNAL";
  if (INJECTION_PATTERNS.some((p) => p.test(text))) return "FORBIDDEN_INJECTION";
  if (forbidden?.values.some((v) => containsToken(text, v.trim()))) return "FORBIDDEN_TASK_VALUE";
  return null;
}

/** Check a procedure: bounds, then every precondition and step. First failing code, or null. */
export function checkProcedure(
  p: { readonly preconditions: unknown; readonly steps: unknown; readonly features: unknown },
  forbidden: ForbiddenValues | null,
): ContentCode | null {
  if (!Array.isArray(p.steps) || p.steps.length === 0) return "PROCEDURE_EMPTY";
  if (p.steps.length > MAX_STEPS) return "PROCEDURE_TOO_LONG";
  if (!Array.isArray(p.preconditions)) return "TEXT_NOT_PRINTABLE";
  if (p.preconditions.length > MAX_PRECONDITIONS) return "PRECONDITIONS_TOO_LONG";
  if (
    !Array.isArray(p.features) ||
    p.features.length === 0 ||
    p.features.length > MAX_FEATURES ||
    !p.features.every((f) => typeof f === "string" && TOKEN.test(f))
  )
    return "FEATURES_INVALID";
  for (const text of [...p.preconditions, ...p.steps]) {
    const code = checkText(text, forbidden);
    if (code !== null) return code;
  }
  return null;
}

/**
 * Structural check of a whole record as read back from disk: every invariant admission
 * guarantees that does not need the task, re-checked so a hand-written line with
 * recomputed digests still cannot plant secrets, host paths, oracle internals, injection
 * or a non-verified provenance. The task's own values (expected value, record key, fixture
 * cells) are NOT re-checked here: the store does not know the task. The operator's head
 * pin closes that (`test/skills/store.test.ts`). Returns a list of problems.
 */
export function checkRecordShape(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) return ["record is not an object"];
  const r = value as Record<string, unknown>;
  const allowed = new Set([
    "schema",
    "skillId",
    "taskFamily",
    "features",
    "preconditions",
    "steps",
    "provenance",
    "recordSha256",
  ]);
  for (const k of Object.keys(r)) if (!allowed.has(k)) problems.push(`unknown field ${k}`);
  if (r.schema !== SKILL_RECORD_SCHEMA) problems.push("wrong schema");
  if (typeof r.taskFamily !== "string" || !TOKEN.test(r.taskFamily))
    problems.push("taskFamily invalid");
  const content = checkProcedure(
    { preconditions: r.preconditions, steps: r.steps, features: r.features },
    null,
  );
  if (content !== null) problems.push(`content ${content}`);
  const p = r.provenance as Record<string, unknown> | null | undefined;
  if (typeof p !== "object" || p === null) {
    problems.push("provenance missing");
  } else {
    const pAllowed = new Set([
      "runId",
      "taskId",
      "ledgerRef",
      "gateVerdict",
      "verdictSha256",
      "gradeStatus",
      "graderVersion",
      "gradeSha256",
      "persistedSha256",
      "plannerModelId",
      "simulated",
      "assisted",
      "corrections",
    ]);
    for (const k of Object.keys(p)) if (!pAllowed.has(k)) problems.push(`unknown provenance ${k}`);
    if (typeof p.runId !== "string" || !PLAIN_ID.test(p.runId)) problems.push("runId invalid");
    if (typeof p.taskId !== "string" || !PLAIN_ID.test(p.taskId)) problems.push("taskId invalid");
    const lr = p.ledgerRef as Record<string, unknown> | null | undefined;
    if (
      typeof lr !== "object" ||
      lr === null ||
      Object.keys(lr).length !== 2 ||
      typeof lr.ledger !== "string" ||
      !PLAIN_ID.test(lr.ledger) ||
      typeof lr.entrySha256 !== "string" ||
      !HEX64.test(lr.entrySha256)
    )
      problems.push("ledgerRef invalid");
    if (p.gateVerdict !== "verified") problems.push("gateVerdict is not verified");
    if (p.gradeStatus !== "pass") problems.push("gradeStatus is not pass");
    if (p.assisted !== false) problems.push("assisted is not false");
    if (p.corrections !== "off") problems.push("corrections is not off");
    for (const k of ["verdictSha256", "gradeSha256", "persistedSha256"])
      if (typeof p[k] !== "string" || !HEX64.test(p[k] as string)) problems.push(`${k} invalid`);
    if (typeof p.graderVersion !== "string" || !PRINTABLE.test(p.graderVersion))
      problems.push("graderVersion invalid");
    if (
      typeof p.plannerModelId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(p.plannerModelId)
    )
      problems.push("plannerModelId invalid");
    if (p.simulated !== isSimulatedPlanner(String(p.plannerModelId)))
      problems.push("simulated flag contradicts planner");
  }
  if (typeof r.recordSha256 !== "string" || !HEX64.test(r.recordSha256))
    problems.push("recordSha256 invalid");
  else {
    const digest = recordDigest(r as unknown as SkillRecord);
    if (digest !== r.recordSha256) problems.push("recordSha256 does not match content");
    if (r.skillId !== skillIdFor(r.recordSha256 as string))
      problems.push("skillId does not match digest");
  }
  // Last line of defence over the whole serialized record (provenance included).
  const whole = JSON.stringify(r);
  if (SECRET_PATTERNS.slice(0, -1).some((pat) => pat.test(whole)))
    problems.push("secret-shaped text");
  if (HOST_PATH_PATTERNS.some((pat) => pat.test(whole))) problems.push("host path");
  return problems;
}
