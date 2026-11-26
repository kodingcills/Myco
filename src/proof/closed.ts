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

/** A closed id: starts alphanumeric, then letters, digits, `.`, `_`, `-`; at most 128. */
export const CLOSED_ID_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
export const CLOSED_ID = new RegExp(CLOSED_ID_SOURCE);
export const HEX64_SOURCE = "^[0-9a-f]{64}$";
export const HEX64 = new RegExp(HEX64_SOURCE);
/** A reason or policy code, or the hashed form of a value that was not one. */
export const CODE_SOURCE = "^(?:[A-Z][A-Z0-9_]{1,63}|h-[0-9a-f]{64})$";
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** A media type (`type/subtype`), or the hashed form. */
export const MEDIA_TYPE_SOURCE = "^(?:[a-z]+/[a-z0-9.+-]{1,64}|h-[0-9a-f]{64})$";
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,64}$/;
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

/** An id: written as is when it matches `CLOSED_ID`, else replaced by its hashed form. */
export function closedId(raw: string): string {
  return CLOSED_ID.test(raw) ? raw : hashedId(raw);
}

/** A code: as is when it matches the code grammar, else hashed. */
export function closedCode(raw: string): string {
  return CODE.test(raw) ? raw : hashedId(raw);
}

/** A media type: as is when it matches `type/subtype`, else hashed. */
export function closedMediaType(raw: string): string {
  return MEDIA_TYPE.test(raw) ? raw : hashedId(raw);
}

/** The arms an arm field may carry as is (#518's ledger arms); any other value is an id. */
export const KNOWN_ARMS = ["myco-gate", "hcu+shell"] as const;

export function closedArm(raw: string): string {
  return (KNOWN_ARMS as readonly string[]).includes(raw) ? raw : closedId(raw);
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
  "action.tool": "id",
  "action.summary": "text",
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
  "policy.subject": "id",
  "policy.decision": "enum",
  "policy.reasonCode": "code",
  "ledger.lines": "ledger",
  "ledger.trialKey": "ledger-id",
  episode: "reference",
} as const;
