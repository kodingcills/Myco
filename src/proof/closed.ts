/**
 * Track Q (replayable proof): the ALLOWLIST. A proof bundle carries only closed-type values.
 *
 * Lead decision (#553): #533 and #548 spent all their rounds on one leak class. A pattern
 * scanner that rewrote host paths and usernames out of free text kept missing new path forms
 * (spaced folders, `Documents and Settings`, UNC, 8.3, mixed separators, encoded forms). So
 * the exporter no longer redacts text by pattern. It never writes text at all:
 *
 *  - A value of a CLOSED type is written as is: an enum member, a boolean, an integer, a
 *    sha256 digest (`HEX64`), a gate reason code, or an id that matches `CLOSED_ID`.
 *  - Every other value (free text, a path, a filename, a command line, an error message, a
 *    note, a URL, any string from the agent, the host or the harness) is replaced
 *    STRUCTURALLY before it is written, by what it is, never by what it looks like:
 *      - a text field (summary, path) becomes a `TextRef`: the sha256 of the raw value (so
 *        equality stays checkable) and its length in UTF-16 code units;
 *      - an id field whose value fails `CLOSED_ID` becomes `h-<sha256 of the raw value>`,
 *        which itself matches `CLOSED_ID`, so equality (a verdict's runId against the run's)
 *        is still checked;
 *      - a field of an enum, boolean, integer or digest type that holds anything else is not
 *        guessed at: the exporter refuses the run (`PROOF_INPUT`, naming the field, never the
 *        value).
 *  - A whole artifact (evidence) is never inlined: only its sha256 and byte count.
 *
 * No string reaches a bundle unless it passed one of the closed grammars below or was
 * produced here (a digest or the `h-` form of one). The leak scanner (`backstop.ts`) is a
 * BACKSTOP only: it runs over every output and fails the export, verify or report closed if
 * it ever fires. It is no longer what keeps a path out.
 *
 * Hashes are plain sha256 with a domain tag, unsalted. A digest does not reveal its input,
 * but a party who GUESSES the exact input (a likely path with a likely username) can confirm
 * the guess. That is the price of keeping equality checkable; it is stated in the doc.
 */
import { createHash } from "node:crypto";
import { REASON_CODES } from "../gate/api.ts";
import type { IdentityGuard } from "./identity.ts";
import { closedApp, closedSubject, closedTool, isClosedKeys } from "./vocab.ts";

/** A closed id: starts alphanumeric, then letters, digits, `.`, `_`, `-`; at most 128. */
export const CLOSED_ID_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
export const CLOSED_ID = new RegExp(CLOSED_ID_SOURCE);
export const HEX64_SOURCE = "^[0-9a-f]{64}$";
export const HEX64 = new RegExp(HEX64_SOURCE);
/**
 * The policy reason codes a policy record may carry AS IS: a CLOSED ENUM, never a grammar
 * (#553 r3, N1: the earlier `[A-Z][A-Z0-9_]*` grammar wrote any upper-case token verbatim,
 * `ZQGPTRR` or an account name in capitals). The members are the gate's `REASON_CODES` and
 * the policy and handoff codes the repo's own policy paths emit (`src/schedule/scheduler.ts`,
 * `src/schedule/runtime.ts`, `src/handoff/policy.ts`). Any other value, however code-like, is
 * replaced by its hashed form. Adding a member is a reviewed change (`allowlist.test.ts` pins
 * this list). Track O's own enum replaces the policy half when it lands.
 */
export const POLICY_REASON_CODES = [
  ...REASON_CODES,
  "POLICY_ALLOW",
  "POLICY_DENIED",
  "POLICY_ERROR",
  "POLICY_INVALID",
  "TASK_NOT_ALLOWED",
  "HUMAN_REJECTED",
  "STILL_PAUSED",
  "HANDOFF_TIMEOUT",
  "HANDOFF_CANCELLED",
  "ATTEMPT_ENDED",
] as const;
/**
 * The media types an evidence record may carry AS IS: a CLOSED ENUM, never a grammar.
 * (#553 r1 D1: the earlier `type/subtype` grammar admitted any lower-case two-segment
 * relative path, `srv/<user>`, so a path could be written verbatim.) These are the types the
 * harness's evidence and the episode's observations use (`text/csv`, `application/json`,
 * `image/png`), plus `image/jpeg` and `text/plain`. Every other value, however
 * media-type-like, is replaced by its hashed form. Adding a member is a reviewed change
 * (`test/proof/allowlist.test.ts` pins this list).
 */
export const MEDIA_TYPES = [
  "application/json",
  "image/jpeg",
  "image/png",
  "text/csv",
  "text/plain",
] as const;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** A member of `MEDIA_TYPES`, or the hashed form. */
export const MEDIA_TYPE_SOURCE = `^(?:${MEDIA_TYPES.map(escapeRe).join("|")}|h-[0-9a-f]{64})$`;
/** A member of `POLICY_REASON_CODES`, or the hashed form. */
export const POLICY_CODE_SOURCE = `^(?:${[...new Set(POLICY_REASON_CODES)].map(escapeRe).join("|")}|h-[0-9a-f]{64})$`;
/**
 * The attempt ledger's own id grammar (#518, `schemas/m2-evidence.ts`): ledger events are
 * carried verbatim, so their trial keys and task ids keep #518's grammar. It is closed too:
 * no separator, no whitespace, no escape character.
 */
export const LEDGER_ID_SOURCE = "^[A-Za-z0-9._:-]{1,128}$";

/** The domain tag every text digest is computed under (versioned: a change is reviewed). */
export const TEXT_DIGEST_TAG = "myco.proof.text/1";

/** sha256 of a raw value under the text tag. Equal inputs give equal digests. */
export function textDigest(raw: string): string {
  return createHash("sha256").update(`${TEXT_DIGEST_TAG}\u0000${raw}`, "utf8").digest("hex");
}

/** What a free-text or path field becomes. Never the text itself. */
export interface TextRef {
  /** `textDigest` of the raw value. */
  readonly sha256: string;
  /** The raw value's length in UTF-16 code units (an integer, nothing more). */
  readonly chars: number;
}

export function textRef(raw: string): TextRef {
  return { sha256: textDigest(raw), chars: raw.length };
}

/** The hashed form of a value that is not a closed id. Matches `CLOSED_ID` itself. */
export function hashedId(raw: string): string {
  return `h-${textDigest(raw)}`;
}

/**
 * The closers the EXPORTER uses, bound to an identity guard (`identity.ts`, #553 r3): an id
 * is written as is only when it matches `CLOSED_ID` AND carries no configured identity string
 * or generic identity shape; otherwise it is replaced by its hashed form. Enum members
 * (`MEDIA_TYPES`, `POLICY_REASON_CODES`, `KNOWN_ARMS`) are constants of this code, not host
 * values, so they are written as is.
 *
 * Agent-produced names (#562, F1) are not ids: they are written as is only when they are in a
 * CLOSED VOCABULARY (`vocab.ts`), else hashed. `tool` (`TOOL_NAMES`), `app`
 * (`REGISTERED_APPS`) and `subject` (both) are single constants; `keys` is a sequence spelled
 * from `KEY_NAMES` and `KEY_MODIFIERS`, and is also put to the identity guard.
 */
export interface Allowlist {
  readonly id: (raw: string) => string;
  readonly arm: (raw: string) => string;
  readonly policyCode: (raw: string) => string;
  readonly mediaType: (raw: string) => string;
  readonly tool: (raw: string) => string;
  readonly app: (raw: string) => string;
  readonly keys: (raw: string) => string;
  readonly subject: (raw: string) => string;
}

export function allowlist(guard: IdentityGuard): Allowlist {
  const id = (raw: string) =>
    CLOSED_ID.test(raw) && guard.hit(raw) === null ? raw : hashedId(raw);
  return {
    id,
    arm: (raw) => ((KNOWN_ARMS as readonly string[]).includes(raw) ? raw : id(raw)),
    policyCode: closedPolicyCode,
    mediaType: closedMediaType,
    tool: closedTool,
    app: closedApp,
    keys: (raw) => (isClosedKeys(raw) && guard.hit(raw) === null ? raw : hashedId(raw)),
    subject: closedSubject,
  };
}

/**
 * The grammar-only id closer (no identity guard). The exporter never uses it to WRITE a
 * value (it uses `allowlist(guard).id`); verify uses `sameId` to compare.
 */
export function closedId(raw: string): string {
  return CLOSED_ID.test(raw) ? raw : hashedId(raw);
}

/**
 * Whether `emitted` is what an exporter could have written for `raw`: the raw value itself
 * (a closed id with no identity) or its hashed form (any other value). Either way it binds
 * the two, and the verifier needs no copy of the exporting host's identity.
 */
export function sameId(raw: string, emitted: string | undefined): boolean {
  return emitted !== undefined && (emitted === closedId(raw) || emitted === hashedId(raw));
}

/** A policy code: as is when it is a member of `POLICY_REASON_CODES`, else hashed. */
export function closedPolicyCode(raw: string): string {
  return (POLICY_REASON_CODES as readonly string[]).includes(raw) ? raw : hashedId(raw);
}

/** A media type: as is when it is a member of `MEDIA_TYPES` (exact match), else hashed. */
export function closedMediaType(raw: string): string {
  return (MEDIA_TYPES as readonly string[]).includes(raw) ? raw : hashedId(raw);
}

/** The arms an arm field may carry as is (#518's ledger arms); any other value is an id. */
export const KNOWN_ARMS = ["myco-gate", "hcu+shell"] as const;

/** The grammar-only arm closer (see `closedId`). */
export function closedArm(raw: string): string {
  return (KNOWN_ARMS as readonly string[]).includes(raw) ? raw : closedId(raw);
}

/** `sameId` for an arm field (a known arm is written as is). */
export function sameArm(raw: string, emitted: string | undefined): boolean {
  return emitted !== undefined && (emitted === closedArm(raw) || emitted === hashedId(raw));
}

/** The schema pattern of an arm field. */
export const ARM_SOURCE = `^(?:myco-gate|hcu\\+shell|${CLOSED_ID_SOURCE.slice(1, -1)})$`;

/**
 * Every field the exporter takes from a run, and what it becomes. The doc's table and the
 * property test are generated from / checked against this list: a new input field without
 * an entry here is a reviewed change (`test/proof/allowlist.test.ts`).
 */
export const FIELD_TREATMENT = {
  "run.runId": "id",
  "run.taskId": "id",
  "run.arm": "arm",
  "run.simulated": "boolean",
  "action.actor": "enum",
  "action.tool": "tool",
  "action.summary": "text",
  "action.keys": "keys",
  "action.app": "app",
  "evidence.evidenceId": "id",
  "evidence.evidenceKind": "id",
  "evidence.mediaType": "media-type",
  "evidence.path": "text",
  "evidence.content": "digest-only",
  "verdict.taskId": "id",
  "verdict.runId": "id",
  "verdict.verdict": "enum",
  "verdict.accepted": "boolean",
  "verdict.reasonCodes": "enum",
  "verdict.evidence": "id",
  "verdict.oracle.family": "id",
  "verdict.oracle.version": "id",
  "verdict.oracle.specSha256": "digest",
  "checkpoint.checkpoint": "integer",
  "checkpoint.verdict": "enum",
  "handoff.from": "id",
  "handoff.to": "id",
  "handoff.summary": "text",
  "handoff.checkpoint": "integer",
  "policy.policyId": "id",
  "policy.subject": "subject",
  "policy.decision": "enum",
  "policy.reasonCode": "policy-code",
  "ledger.lines": "ledger",
  "ledger.trialKey": "ledger-id",
  episode: "reference",
} as const;
