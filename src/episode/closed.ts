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
 *  - an id field is written as is when it matches `CLOSED_ID`, else replaced by its hashed form
 *    (equality, such as one run's episodes sharing a `runId`, stays checkable);
 *  - every FREE-TEXT field (typed text, shell commands, UI status, the instruction) is replaced
 *    by its hashed form, whatever it looks like. Key and app names keep their value only from a
 *    closed vocabulary (F1), else they get the hashed form.
 *
 * THE hashed form, on every field and every export surface (lead ruling 2026-11-26 23:06Z):
 * `h-<60 hex>`, the first 240 bits of the tagged sha256 (`exportDigest`), carrying no input text.
 * One form everywhere, so values stay comparable; it fits the 64-character key/app cap.
 *
 * PROVENANCE-BOUND (#579 O3, `src/export-guard/provenance.ts`): an `h-<60 hex>` input is kept as
 * is ONLY when the harness produced it, that is when the store's hash ledger records it for this
 * episode id at this exact path (`importDataset` records an imported dataset's hashed values).
 * Any other `h-<60 hex>` (an agent typed it, or it sits at another path or in another episode)
 * is re-hashed like any other value, so it can never carry agent-chosen hex out of the machine.
 * Export, import, export stays byte-identical. No other `h-` string is ever treated as hashed.
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
import {
  episodeScope,
  type HashLedger,
  keepOrHash,
  NO_LEDGER,
} from "../export-guard/provenance.ts";
import { REASON_CODES } from "../gate/api.ts";
import { heldIdentity, type IdentityEntry } from "./identity.ts";
import type { Episode } from "./types.ts";
import { episodeIdOf } from "./validate.ts";

/** A closed id (#553): starts alphanumeric, then letters, digits, `.`, `_`, `-`; at most 128. */
export const CLOSED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A short closed token (key names, app names): no space, no separator, at most 64. */
export const CLOSED_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/**
 * The closed arm vocabulary (#556 round 1, D1): a known arm, optionally with a variant of
 * lower-case letters, digits and hyphens (`myco-gate:retry`, written by the multi-step demo,
 * src/episode/demo.ts). Never a path: a drive-relative form (`c:users.x`, `C:Users`) is refused,
 * because `c` is not a known arm and a variant has no `.`, `/`, `\\` or upper case.
 */
export const KNOWN_ARMS = ["myco-gate", "hcu+shell"] as const;
export const ARM_GRAMMAR = /^(?:myco-gate|hcu\+shell)(?::[a-z0-9][a-z0-9-]{0,31})?$/;
/** THE hashed form (lead ruling 23:06Z): exactly `h-` and 60 lower-case hex, nothing else. */
export const HASHED = /^h-[0-9a-f]{60}$/;

/** The domain tag every text digest is computed under (versioned: a change is reviewed). */
export const EXPORT_TEXT_TAG = "myco.episode.export-text/1";

/** The hashed form of a raw value: `h-` and the first 60 hex (240 bits) of its tagged sha256. */
export const hashed = (raw: string): string => `h-${exportDigest(raw).slice(0, 60)}`;

export function exportDigest(raw: string): string {
  return createHash("sha256").update(`${EXPORT_TEXT_TAG}\u0000${raw}`, "utf8").digest("hex");
}

export type Treatment =
  | { readonly kind: "text" }
  | { readonly kind: "id" }
  | { readonly kind: "token"; readonly vocabulary: RegExp }
  | {
      readonly kind: "closed";
      readonly grammar: RegExp;
      /** Fixed vocabulary or a digest: cannot carry a joined identity (exempt from that check). */
      readonly exempt?: true;
    };

const text: Treatment = { kind: "text" };
const id: Treatment = { kind: "id" };
/**
 * F1 (lead ruling 2026-11-26 22:18Z): agent-produced key and app names go out verbatim ONLY when
 * they are in a closed vocabulary; anything else is digested (`h-<60 hex>`: the schema caps both
 * fields at 64 characters, so the 64-hex form does not fit).
 *
 * KNOWN_KEYS: a key or a key combination, up to three modifiers then one named key, any case
 * (`ctrl+s`, `Return`, `F5`, `ctrl+shift+Tab`).
 */
export const KNOWN_KEYS =
  /^(?:(?:ctrl|control|alt|option|shift|cmd|meta|super)\+){0,3}(?:[a-z0-9]|f(?:[1-9]|1[0-2])|enter|return|escape|esc|tab|space|backspace|delete|del|insert|home|end|pageup|pagedown|up|down|left|right)$/i;
/** REGISTERED_APPS: the app ids a launch action may name (the LibreOffice apps the gate drives). */
export const REGISTERED_APPS = /^(?:localc|lowriter|soffice|libreoffice|scalc|swriter)$/;
const keyName: Treatment = { kind: "token", vocabulary: KNOWN_KEYS };
const appId: Treatment = { kind: "token", vocabulary: REGISTERED_APPS };
const closed = (grammar: RegExp): Treatment => ({ kind: "closed", grammar });
const oneOf = (...values: readonly string[]): Treatment => ({
  kind: "closed",
  grammar: new RegExp(
    `^(?:${values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
  ),
  exempt: true,
});
const digest: Treatment = { kind: "closed", grammar: HEX64, exempt: true };

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
  "$.actions.items[].keys": keyName,
  "$.actions.items[].app": appId,
  "$.actions.items[].command": text,
  "$.actions.items[].claim": oneOf("done", "not-done", "no-claim"),
  "$.observations.capture": oneOf("recorded", "not-recorded"),
  "$.observations.items[].kind": oneOf("screenshot", "state", "ui-status"),
  "$.observations.items[].mediaType": oneOf("image/png", "text/csv", "application/json"),
  "$.observations.items[].label": oneOf("persisted", "ui-tree", "app-state"),
  "$.observations.items[].sha256": digest,
  // A content-addressed name (hex): exempt from the identity check, like a digest (#556 r3, S1).
  "$.observations.items[].file": {
    kind: "closed",
    grammar: /^blobs\/[0-9a-f]{64}\.(?:png|csv|json)$/,
    exempt: true,
  },
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
  "$.harness.arm": closed(ARM_GRAMMAR),
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

/** Whether `value` holds an identity string anywhere (folded, identity.ts: joined forms included). */
const holds = (value: string, joined: readonly IdentityEntry[]) =>
  heldIdentity(value, joined) !== undefined;

/** Where a value sits, for the provenance check: the input episode's id and the field's path. */
interface Site {
  readonly episodeId: string;
  readonly ledger: HashLedger;
  readonly joined: readonly IdentityEntry[];
}

function treat(path: string, value: string, site: Site): string {
  const t = FIELD_TREATMENT[templateOf(path)];
  if (t === undefined) throw new ExportInputError(templateOf(path));
  const scope = episodeScope(site.episodeId, path);
  switch (t.kind) {
    case "text":
      // Provenance-bound (#579 O3): an `h-<60 hex>` is kept only when the harness produced it
      // (the store's ledger records it here); anything else, an agent's `h-<60 hex>` included,
      // is hashed. So re-exporting an imported dataset is byte-identical, and nothing else is kept.
      return keepOrHash(value, scope, site.ledger, hashed);
    // An id or token that would be kept verbatim but holds an identity string (even joined,
    // `<Name>2`) is digested instead (lead ruling 21:52Z).
    // A harness-produced hashed id or token is closed and carries nothing: kept as is (#556 r3,
    // S2), so a re-export is byte-identical even when an identity's letters occur in the hash.
    // Any other `h-<60 hex>` is re-hashed (#579 O3): it is CLOSED_ID-shaped, but the identity
    // checks skip the hashed form, so an agent's one could carry a hex-letter identity.
    case "id":
      if (HASHED.test(value)) return keepOrHash(value, scope, site.ledger, hashed);
      return CLOSED_ID.test(value) && !holds(value, site.joined) ? value : hashed(value);
    case "token":
      if (HASHED.test(value)) return keepOrHash(value, scope, site.ledger, hashed);
      return t.vocabulary.test(value) && !holds(value, site.joined) ? value : hashed(value);
    case "closed":
      if (!t.grammar.test(value)) throw new ExportInputError(templateOf(path));
      return value;
  }
}

function walk(node: unknown, path: string, site: Site): unknown {
  if (typeof node === "string") return treat(path, node, site);
  if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`, site));
  if (node !== null && typeof node === "object")
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, walk(v, `${path}.${k}`, site)]),
    );
  return node;
}

/**
 * The closed form of an episode: every string allowlisted or hashed (above), and `episodeId`
 * recomputed over the closed content. Throws `ExportInputError` on a value the export may not
 * write or hash. `ledger` is the harness-side hash ledger of the store the episode was read from
 * (#579 O3): only an `h-<60 hex>` it records for this episode id and path is kept as is.
 */
export function closeEpisode(
  ep: Episode,
  joined: readonly IdentityEntry[] = [],
  ledger: HashLedger = NO_LEDGER,
): Episode {
  const site: Site = { episodeId: String(ep.episodeId), ledger, joined };
  const { episodeId: _old, ...rest } = walk(
    { ...ep, episodeId: "0".repeat(64) },
    "$",
    site,
  ) as Episode;
  return { ...rest, episodeId: episodeIdOf(rest) } as Episode;
}

/**
 * The hash-ledger entries of a CLOSED episode (#579 O3): every `h-<60 hex>` at a field the export
 * hashes (text, id, token), with its exact path. `importDataset` records them, after the dataset
 * validated, under the episode's id, so a re-export keeps exactly these values and no others.
 */
export function hashedLeaves(
  ep: Episode,
): Array<{ readonly path: string; readonly value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      const t = FIELD_TREATMENT[templateOf(path)];
      if (t !== undefined && t.kind !== "closed" && HASHED.test(node))
        out.push({ path, value: node });
    } else if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) visit(item, `${path}[${i}]`);
    } else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`);
    }
  };
  visit(ep, "$");
  return out;
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
              ? t.vocabulary.test(node) || HASHED.test(node)
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

/**
 * Joined identity strings (`<Name>2`, `xx<name>`) in the strings an exported episode keeps
 * verbatim: any non-exempt closed field, and an id or token that is not a digest. Paths and
 * classes only, never values. `closeEpisode` digests ids and tokens that hold one, so after
 * closing this finds only closed pattern fields (a task family, a task-set id, a version), which
 * refuse the export; on a hand-edited dataset it finds them anywhere.
 */
export function joinedIdentity(
  ep: unknown,
  joined: readonly IdentityEntry[],
): { readonly class: IdentityEntry[0]; readonly path: string }[] {
  const out: { class: IdentityEntry[0]; path: string }[] = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      const t = FIELD_TREATMENT[templateOf(path)];
      if (t === undefined || t.kind === "text" || (t.kind === "closed" && t.exempt)) return;
      if (HASHED.test(node)) return;
      // Every identity this string holds (folded: joined forms, full case folding; identity.ts).
      for (const entry of joined)
        if (heldIdentity(node, [entry]) !== undefined) out.push({ class: entry[0], path });
    } else if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) visit(item, `${path}[${i}]`);
    } else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`);
    }
  };
  visit(ep, "$");
  return out;
}
