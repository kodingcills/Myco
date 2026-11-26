/**
 * The export ALLOWLIST (TIF-265; the closed-schema pattern of #553). An exported episode carries
 * only closed-type strings.
 *
 * Why: `redactText` (clean.ts) rewrites host paths out of free text by pattern, and patterns
 * keep missing path forms. #553's probe corpus (spaced folders, `Documents and Settings`, 8.3
 * short names, UNC, mixed separators, encoded forms) put a planted username into 123 of 145
 * exported datasets through ordinary agent text: `C:\Users\First Last\x` is stored as
 * `<path> Last\x`, and the cleanliness scan cannot see a path in what is left. So the export
 * no longer trusts redaction. It never writes free text at all:
 *
 *  - a field of a CLOSED type is written as is when it matches its grammar: an enum member, a
 *    digest, a timestamp, a blob file name, a reason code, a version. A value that does not
 *    match is not guessed at: the export is refused, naming the field, never the value;
 *  - an id field is written as is when it matches `CLOSED_ID`, else replaced by
 *    `h-<sha256>` of the raw value (equality, such as one run's episodes sharing a `runId`,
 *    stays checkable);
 *  - every FREE-TEXT field (typed text, shell commands, UI status, the instruction) is replaced
 *    by `h-<sha256>` of the raw value, whatever it looks like. Two short free fields that the
 *    schema caps at 64 characters (key names, app names) keep their value only when it matches
 *    a closed token grammar (no space, no separator), else they get the 60-hex hashed form.
 *
 * Every string path an episode can hold is listed in `FIELD_TREATMENT`; a string at a path the
 * table does not name refuses the export (a new field is a reviewed change), and
 * `test/episode/allowlist.test.ts` checks the table against every schema variant. The
 * cleanliness scan stays as a BACKSTOP: it is no longer what keeps a path out.
 *
 * The local store is unchanged (it keeps the redacted text, on the machine that recorded it).
 * Only the export, the boundary where data leaves the machine, is closed. Hashes are sha256
 * under a domain tag, unsalted: a digest does not reveal its input, but someone who guesses
 * the exact input can confirm the guess (the price of checkable equality, as in #553).
 */
import { createHash } from "node:crypto";
import {
  EPISODE_COST_BASIS,
  EPISODE_FAULT_CLASSES,
  EPISODE_OUTCOMES,
  EPISODE_SCHEMA,
  EPISODE_SOURCES,
} from "../../schemas/episode.ts";
import { REASON_CODES } from "../gate/api.ts";
import type { Episode } from "./types.ts";
import { episodeIdOf } from "./validate.ts";

/** A closed id (#553): starts alphanumeric, then letters, digits, `.`, `_`, `-`; at most 128. */
export const CLOSED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A short closed token (key names, app names): no space, no separator, at most 64. */
export const CLOSED_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HASHED = /^h-[0-9a-f]{64}$/;
const HASHED_SHORT = /^h-[0-9a-f]{60}$/;

/** The domain tag every text digest is computed under (versioned: a change is reviewed). */
export const EXPORT_TEXT_TAG = "myco.episode.export-text/1";

export function exportDigest(raw: string): string {
  return createHash("sha256").update(`${EXPORT_TEXT_TAG}\u0000${raw}`, "utf8").digest("hex");
}

export type Treatment =
  | { readonly kind: "text" }
  | { readonly kind: "id" }
  | { readonly kind: "token" }
  | { readonly kind: "closed"; readonly grammar: RegExp };

const text: Treatment = { kind: "text" };
const id: Treatment = { kind: "id" };
const token: Treatment = { kind: "token" };
const closed = (grammar: RegExp): Treatment => ({ kind: "closed", grammar });
const oneOf = (...values: readonly string[]) =>
  closed(
    new RegExp(`^(?:${values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`),
  );
const digest = closed(HEX64);

/**
 * Every string path an episode can hold (`[]` stands for any array index), and its treatment.
 * Paths are JSON paths from the episode root.
 */
export const FIELD_TREATMENT: Readonly<Record<string, Treatment>> = {
  "$.schema": oneOf(EPISODE_SCHEMA),
  "$.episodeId": digest,
  "$.outcome": oneOf(...EPISODE_OUTCOMES),
  "$.task.id": id,
  "$.task.family": closed(/^[a-z0-9-]{1,64}$/),
  "$.task.taskSetVersion": closed(/^[A-Za-z0-9._-]{1,64}$/),
  "$.task.faultClass": closed(/^[a-z0-9-]{1,64}$/),
  "$.task.instruction": text,
  "$.task.instructionSha256": digest,
  "$.task.fixtureSha256": digest,
  "$.actions.capture": oneOf("recorded", "not-recorded"),
  "$.actions.items[].kind": oneOf(
    "click",
    "type",
    "key",
    "scroll",
    "launch",
    "wait",
    "shell",
    "gate-check",
    "observe",
  ),
  "$.actions.items[].button": oneOf("left", "right", "middle"),
  "$.actions.items[].text": text,
  "$.actions.items[].keys": token,
  "$.actions.items[].app": token,
  "$.actions.items[].command": text,
  "$.actions.items[].claim": oneOf("done", "not-done", "no-claim"),
  "$.observations.capture": oneOf("recorded", "not-recorded"),
  "$.observations.items[].kind": oneOf("screenshot", "state", "ui-status"),
  "$.observations.items[].mediaType": oneOf("image/png", "text/csv", "application/json"),
  "$.observations.items[].label": oneOf("persisted", "ui-tree", "app-state"),
  "$.observations.items[].sha256": digest,
  "$.observations.items[].file": closed(/^blobs\/[0-9a-f]{64}\.(?:png|csv|json)$/),
  "$.observations.items[].text": text,
  "$.agentClaim": oneOf("done", "not-done", "no-claim"),
  "$.gate.verdict": oneOf("verified", "refuted", "uncertain"),
  "$.gate.reasonCodes[]": oneOf(...REASON_CODES),
  "$.gate.oracle.family": closed(/^[a-z0-9-]{1,64}$/),
  "$.gate.oracle.version": closed(/^[A-Za-z0-9._-]{1,32}$/),
  "$.gate.oracle.specSha256": digest,
  "$.groundTruth.source": oneOf("independent-grader", "none"),
  // A grader version is `name/N` (`false-completion-grader/1`): closed, never a path.
  "$.groundTruth.graderVersion": closed(/^[a-z0-9][a-z0-9-]{0,47}\/[0-9]{1,6}$/),
  "$.groundTruth.status": oneOf("pass", "fail", "ungradable"),
  "$.groundTruth.fixtureSha256": digest,
  "$.groundTruth.persistedSha256": digest,
  "$.groundTruth.reason": oneOf(
    "no-independent-grader",
    "harness-fault",
    "agent-never-ran",
    "document-withheld",
  ),
  "$.harness.arm": closed(/^[a-z0-9][a-z0-9+._-]{0,63}$/),
  "$.harness.plannerModelId": id,
  "$.harness.corrections": oneOf("on", "off"),
  "$.harness.timing.startedAt": closed(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
  "$.harness.timing.endedAt": closed(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
  "$.harness.cost.basis": oneOf(EPISODE_COST_BASIS),
  "$.harness.fault.class": oneOf(...EPISODE_FAULT_CLASSES),
  "$.harness.fault.code": closed(/^[A-Z0-9_]{1,64}$/),
  "$.provenance.source": oneOf(...EPISODE_SOURCES),
  "$.provenance.runId": id,
  "$.provenance.trialKey": id,
  "$.provenance.attemptLedger.schema": oneOf("myco.m2.attempt-event/1"),
  "$.provenance.attemptLedger.headSha256": digest,
  "$.provenance.writer": oneOf("myco.episode-writer/1"),
};

/** Refused input: names the field, never the value (it may be the leak). */
export class ExportInputError extends Error {
  constructor(readonly path: string) {
    super(`export refused: ${path} is not a closed value and is not a field the export may hash`);
  }
}

/** `$.actions.items[3].text` -> `$.actions.items[].text`. */
export const templateOf = (path: string) => path.replace(/\[\d+\]/g, "[]");

function treat(path: string, value: string): string {
  const t = FIELD_TREATMENT[templateOf(path)];
  if (t === undefined) throw new ExportInputError(templateOf(path));
  switch (t.kind) {
    case "text":
      // Idempotent: an already-hashed value is closed (it carries nothing), so re-exporting an
      // imported dataset is byte-identical.
      return HASHED.test(value) ? value : `h-${exportDigest(value)}`;
    case "id":
      return CLOSED_ID.test(value) ? value : `h-${exportDigest(value)}`;
    case "token":
      return CLOSED_TOKEN.test(value) ? value : `h-${exportDigest(value).slice(0, 60)}`;
    case "closed":
      if (!t.grammar.test(value)) throw new ExportInputError(templateOf(path));
      return value;
  }
}

function walk(node: unknown, path: string): unknown {
  if (typeof node === "string") return treat(path, node);
  if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`));
  if (node !== null && typeof node === "object")
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, `${path}.${k}`)]));
  return node;
}

/**
 * The closed form of an episode: every string allowlisted or hashed (above), and `episodeId`
 * recomputed over the closed content. Throws `ExportInputError` on a value the export may not
 * write or hash.
 */
export function closeEpisode(ep: Episode): Episode {
  const { episodeId: _old, ...rest } = walk({ ...ep, episodeId: "0".repeat(64) }, "$") as Episode;
  return { ...rest, episodeId: episodeIdOf(rest) } as Episode;
}

/** Strings of an exported episode that are not in their closed output grammar (path, never value). */
export function openStrings(ep: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      const t = FIELD_TREATMENT[templateOf(path)];
      const ok =
        t !== undefined &&
        (t.kind === "text"
          ? HASHED.test(node)
          : t.kind === "id"
            ? CLOSED_ID.test(node) || HASHED.test(node)
            : t.kind === "token"
              ? CLOSED_TOKEN.test(node) || HASHED_SHORT.test(node)
              : t.grammar.test(node));
      if (!ok) out.push(path);
    } else if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) visit(item, `${path}[${i}]`);
    } else if (node !== null && typeof node === "object")
      for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`);
  };
  visit(ep, "$");
  return out;
}
