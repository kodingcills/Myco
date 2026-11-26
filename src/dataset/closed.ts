/**
 * Track U's export ALLOWLIST (TIF-265; the closed-schema pattern of #553, the same rules as the
 * episode export's `src/episode/closed.ts`, #556). What `exportDataset` writes carries only
 * closed-type strings.
 *
 * Why: the exporter's leak scan (`hygiene.ts`) is a deny-list, and deny-lists miss path forms.
 * #553's probe corpus got a planted username past it in 40 of 145 raw probes (`C:Users\x`,
 * `\\?\UNC\nas\homes\First Last`, `//nas/homes/First Last`, rootless `\DOCUME~1\First Last`,
 * `\Device\Mup\...`), and in 92 once #542's `redactText` had already turned
 * `C:\Users\First Last\x` into `<path> Last\x`. So the container no longer trusts the scan to
 * keep a path out. It never writes free text:
 *
 *  - a CLOSED field (enum, digest, timestamp, blob file, reason code, version) is written as is
 *    when it matches its grammar; anything else refuses the export, naming the field;
 *  - an id is written as is when it matches `CLOSED_ID`, else as `h-<sha256>`;
 *  - FREE TEXT (the instruction, typed text, shell commands, UI status, the capture path) is
 *    always `h-<sha256>`; short free tokens (key and app names) are kept only as closed tokens;
 *  - the record's desktop facts (`backend`, `image`) are ids.
 *
 * Self-contained on purpose: `src/dataset` may not import `src/episode` or `src/gate`
 * (test/desktops/import-boundary.test.ts), so the table is kept here, over the mirrored
 * `myco.episode/1` (`./episode.ts`), and `test/dataset/allowlist.test.ts` checks it covers every
 * string path of every variant. The leak scan stays: it runs on the raw episodes (a planted
 * marker or a secret still refuses the export, as a signal that a leak path exists) and on
 * every closed output, as a backstop. Digests are sha256 under a domain tag, unsalted: equal
 * values stay equal; a guessed exact input can be confirmed (as in #553).
 */
import { createHash } from "node:crypto";
import {
  EPISODE_COST_BASIS,
  EPISODE_FAULT_CLASSES,
  EPISODE_NO_GRADE_REASONS,
  EPISODE_OUTCOMES,
  EPISODE_SCHEMA,
  EPISODE_SOURCES,
  EPISODE_WRITER,
  type Episode,
  episodeIdOf,
} from "./episode.ts";

export const CLOSED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const CLOSED_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/**
 * The closed arm grammar (#556 round 1, D1, for track U's arms): a first segment of at least two
 * characters that starts with a lower-case letter (`myco-gate`, `hcu+shell`, track U's
 * `scripted-u-e2e`), then at most one `:variant`, using only lower-case letters, digits, `+` and
 * `-`. Never a path: a drive-relative form is refused (a one-letter drive cannot start an arm, and
 * an arm has no `.`, `_`, `/`, `\\` or upper case: `c:users.x`, `C:Users`, `myco-gate:users.x`).
 */
export const ARM_GRAMMAR = /^[a-z][a-z0-9+-]{1,31}(?::[a-z0-9][a-z0-9-]{0,31})?$/;
const HASHED = /^h-[0-9a-f]{64}$/;
const HASHED_SHORT = /^h-[0-9a-f]{60}$/;

export const EXPORT_TEXT_TAG = "myco.dataset.export-text/1";

export function exportDigest(raw: string): string {
  return createHash("sha256").update(`${EXPORT_TEXT_TAG}\u0000${raw}`, "utf8").digest("hex");
}

export type Treatment =
  | { readonly kind: "text" }
  | { readonly kind: "id"; readonly also?: RegExp }
  | { readonly kind: "token"; readonly vocabulary: RegExp }
  | {
      readonly kind: "closed";
      readonly grammar: RegExp;
      /** Fixed vocabulary or a digest: cannot carry a joined identity (exempt from that check). */
      readonly exempt?: true;
    };

/** An identity string and its kind (hygiene.ts `identityStrings`); never printed. */
export type JoinedIdentity = readonly [string, string];

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
/** REGISTERED_APPS: the app ids a launch action may name (the LibreOffice apps the desktops run). */
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
const timestamp = closed(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);

/** Every string path of a mirrored episode (`[]` = any index), and its treatment. */
export const EPISODE_FIELD_TREATMENT: Readonly<Record<string, Treatment>> = {
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
  // The mirror's one loosening (src/dataset may not import src/gate): code-shaped strings.
  "$.gate.reasonCodes[]": closed(/^[A-Z][A-Z0-9_]{1,63}$/),
  "$.gate.oracle.family": closed(/^[a-z0-9-]{1,64}$/),
  "$.gate.oracle.version": closed(/^[A-Za-z0-9._-]{1,32}$/),
  "$.gate.oracle.specSha256": digest,
  "$.groundTruth.source": oneOf("independent-grader", "none"),
  "$.groundTruth.graderVersion": closed(/^[a-z0-9][a-z0-9-]{0,47}\/[0-9]{1,6}$/),
  "$.groundTruth.status": oneOf("pass", "fail", "ungradable"),
  "$.groundTruth.fixtureSha256": digest,
  "$.groundTruth.persistedSha256": digest,
  "$.groundTruth.reason": oneOf(...EPISODE_NO_GRADE_REASONS),
  "$.harness.arm": closed(ARM_GRAMMAR),
  "$.harness.plannerModelId": id,
  "$.harness.corrections": oneOf("on", "off"),
  "$.harness.timing.startedAt": timestamp,
  "$.harness.timing.endedAt": timestamp,
  "$.harness.cost.basis": oneOf(EPISODE_COST_BASIS),
  "$.harness.fault.class": oneOf(...EPISODE_FAULT_CLASSES),
  "$.harness.fault.code": closed(/^[A-Z0-9_]{1,64}$/),
  "$.provenance.source": oneOf(...EPISODE_SOURCES),
  "$.provenance.runId": id,
  "$.provenance.trialKey": id,
  "$.provenance.attemptLedger.schema": oneOf("myco.m2.attempt-event/1"),
  "$.provenance.attemptLedger.headSha256": digest,
  "$.provenance.writer": oneOf(EPISODE_WRITER),
};

/** A versioned name, `name/N` (`local-process/1`, `myco-linux-desktop/1`): closed, never a path. */
export const VERSIONED_NAME = /^[a-z0-9][a-z0-9.-]{0,47}\/[0-9]{1,6}$/;
const desktopId: Treatment = { kind: "id", also: VERSIONED_NAME };

/** Track U's own free fields of a record: the desktop facts are ids, the capture path is text. */
export const RECORD_FIELD_TREATMENT: Readonly<Record<string, Treatment>> = {
  "$.desktop.backend": desktopId,
  "$.desktop.image": desktopId,
  "$.capture.path": text,
};

/** Refused input: names the field, never the value. */
export class OpenValueError extends Error {
  constructor(readonly path: string) {
    super(`${path} is not a closed value and is not a field the export may hash`);
  }
}

export const templateOf = (path: string) => path.replace(/\[\d+\]/g, "[]");

/**
 * The form identity matching compares (#556 round 3, B2/S3; #553's final verdict): full Unicode
 * case folding (NFKC, then upper case, then lower case, so `ß`/`ẞ` become `ss` and a dotless `ı`
 * or dotted `İ` becomes `i`), then letters and digits only (combining marks dropped). So a spaced
 * full name matches every joined form of it (`FirstLast`, `first.last`, `first_last`,
 * `First-Last`), and `GROSS` matches a configured `Groß`, in any case.
 */
export const fold = (s: string) =>
  s
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]/gu, "");

/** Whether `value` holds an identity string anywhere (folded; joined forms included). */
const holds = (value: string, joined: readonly JoinedIdentity[]) => {
  const v = fold(value);
  return joined.some(([, id]) => fold(id).length >= 3 && v.includes(fold(id)));
};

function treat(
  table: Readonly<Record<string, Treatment>>,
  path: string,
  value: string,
  joined: readonly JoinedIdentity[] = [],
): string {
  const t = table[templateOf(path)];
  if (t === undefined) throw new OpenValueError(templateOf(path));
  switch (t.kind) {
    case "text":
      // Idempotent: an already-hashed value is closed and carries nothing.
      return HASHED.test(value) ? value : `h-${exportDigest(value)}`;
    // An id or token that would be kept verbatim but holds an identity string (even joined,
    // `<Name>2`) is digested instead (lead ruling 21:52Z).
    case "id":
      // Idempotent (#556 round 3, S2): an already-hashed id is closed (it carries nothing).
      if (HASHED.test(value)) return value;
      return (CLOSED_ID.test(value) || t.also?.test(value) === true) && !holds(value, joined)
        ? value
        : `h-${exportDigest(value)}`;
    case "token":
      // Idempotent: an exact `h-<60 hex>` is already closed (it carries nothing).
      if (HASHED_SHORT.test(value)) return value;
      return t.vocabulary.test(value) && !holds(value, joined)
        ? value
        : `h-${exportDigest(value).slice(0, 60)}`;
    case "closed":
      if (!t.grammar.test(value)) throw new OpenValueError(templateOf(path));
      return value;
  }
}

function walk(
  table: Readonly<Record<string, Treatment>>,
  node: unknown,
  path: string,
  joined: readonly JoinedIdentity[],
): unknown {
  if (typeof node === "string") return treat(table, path, node, joined);
  if (Array.isArray(node)) return node.map((item, i) => walk(table, item, `${path}[${i}]`, joined));
  if (node !== null && typeof node === "object")
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, walk(table, v, `${path}.${k}`, joined)]),
    );
  return node;
}

/** The closed form of an episode; `episodeId` recomputed over the closed content. */
export function closeEpisode(ep: Episode, joined: readonly JoinedIdentity[] = []): Episode {
  const { episodeId: _old, ...rest } = walk(
    EPISODE_FIELD_TREATMENT,
    { ...ep, episodeId: "0".repeat(64) },
    "$",
    joined,
  ) as Episode;
  return { ...rest, episodeId: episodeIdOf(rest) } as Episode;
}

/** The closed form of a record's free fields (`desktop.backend`, `desktop.image`, `capture.path`). */
export function closeRecordFields<
  T extends { desktop: { backend: string; image: string }; capture: { path: string } },
>(record: T, joined: readonly JoinedIdentity[] = []): T {
  return {
    ...record,
    desktop: {
      ...record.desktop,
      backend: treat(RECORD_FIELD_TREATMENT, "$.desktop.backend", record.desktop.backend, joined),
      image: treat(RECORD_FIELD_TREATMENT, "$.desktop.image", record.desktop.image, joined),
    },
    capture: {
      ...record.capture,
      path: treat(RECORD_FIELD_TREATMENT, "$.capture.path", record.capture.path, joined),
    },
  };
}

function accepts(t: Treatment | undefined, value: string): boolean {
  if (t === undefined) return false;
  switch (t.kind) {
    case "text":
      return HASHED.test(value);
    case "id":
      return CLOSED_ID.test(value) || t.also?.test(value) === true || HASHED.test(value);
    case "token":
      return t.vocabulary.test(value) || HASHED_SHORT.test(value);
    case "closed":
      return t.grammar.test(value);
  }
}

/** Every string leaf of a JSON value with its path, iteratively (no recursion: a deep value cannot overflow). */
function stringLeaves(value: unknown): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  const stack: Array<readonly [unknown, string]> = [[value, "$"]];
  while (stack.length > 0) {
    const [node, path] = stack.pop() as readonly [unknown, string];
    if (typeof node === "string") out.push([path, node]);
    else if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push([node[i], `${path}[${i}]`]);
    } else if (node !== null && typeof node === "object") {
      const entries = Object.entries(node);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i] as [string, unknown];
        stack.push([v, `${path}.${k}`]);
      }
    }
  }
  return out;
}

/** Strings of a closed episode outside their closed output grammar (paths, never values). */
export function openEpisodeStrings(ep: unknown): string[] {
  return stringLeaves(ep)
    .filter(([path, v]) => !accepts(EPISODE_FIELD_TREATMENT[templateOf(path)], v))
    .map(([path]) => path);
}

/** A record's free fields outside their closed output grammar (paths, never values). */
export function openRecordStrings(record: unknown): string[] {
  const r = record as {
    desktop?: Record<string, unknown>;
    capture?: Record<string, unknown>;
  } | null;
  const out: string[] = [];
  for (const [path, v] of [
    ["$.desktop.backend", r?.desktop?.backend],
    ["$.desktop.image", r?.desktop?.image],
    ["$.capture.path", r?.capture?.path],
  ] as const)
    if (typeof v !== "string" || !accepts(RECORD_FIELD_TREATMENT[path], v)) out.push(path);
  return out;
}

/**
 * Joined identity strings (`<Name>2`, `xx<name>`) in the strings a closed episode or record keeps
 * verbatim: any non-exempt closed field, and an id or token that is not a digest. Kinds and
 * paths only, never values. Closing digests ids and tokens that hold one, so after closing this
 * finds only closed pattern fields (a task family, a task-set id, a version), which refuse the
 * export; on a hand-edited container it finds them anywhere.
 */
export function joinedIdentity(
  value: unknown,
  joined: readonly JoinedIdentity[],
  table: "episode" | "record" = "episode",
): Array<{ readonly kind: string; readonly path: string }> {
  const fields = table === "episode" ? EPISODE_FIELD_TREATMENT : RECORD_FIELD_TREATMENT;
  const out: Array<{ kind: string; path: string }> = [];
  for (const [path, v] of stringLeaves(value)) {
    const t = fields[templateOf(path)];
    if (t === undefined || t.kind === "text" || (t.kind === "closed" && t.exempt)) continue;
    if (HASHED.test(v) || HASHED_SHORT.test(v)) continue;
    const folded = fold(v);
    for (const [kind, id] of joined) {
      const f = fold(id);
      if (f.length >= 3 && folded.includes(f)) out.push({ kind, path });
    }
  }
  return out;
}

/**
 * Identity strings in a manifest (or any closed JSON whose strings are codes, versions and
 * digests): every string leaf that is not a 64-hex digest, folded. Kinds and paths only.
 */
export function manifestIdentity(
  value: unknown,
  joined: readonly JoinedIdentity[],
): Array<{ readonly kind: string; readonly path: string }> {
  const out: Array<{ kind: string; path: string }> = [];
  for (const [path, v] of stringLeaves(value)) {
    if (
      HEX64.test(v) ||
      /^blobs\/[0-9a-f]{64}\.[a-z]+$/.test(v) ||
      /^episodes\/[0-9a-f]{64}\.json$/.test(v)
    )
      continue;
    const folded = fold(v);
    for (const [kind, id] of joined) {
      const f = fold(id);
      if (f.length >= 3 && folded.includes(f)) out.push({ kind, path });
    }
  }
  return out;
}
