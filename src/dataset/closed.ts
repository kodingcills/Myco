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
const HASHED = /^h-[0-9a-f]{64}$/;
const HASHED_SHORT = /^h-[0-9a-f]{60}$/;

export const EXPORT_TEXT_TAG = "myco.dataset.export-text/1";

export function exportDigest(raw: string): string {
  return createHash("sha256").update(`${EXPORT_TEXT_TAG}\u0000${raw}`, "utf8").digest("hex");
}

export type Treatment =
  | { readonly kind: "text" }
  | { readonly kind: "id"; readonly also?: RegExp }
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
  "$.harness.arm": closed(/^[a-z0-9][a-z0-9+._-]{0,63}$/),
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

function treat(table: Readonly<Record<string, Treatment>>, path: string, value: string): string {
  const t = table[templateOf(path)];
  if (t === undefined) throw new OpenValueError(templateOf(path));
  switch (t.kind) {
    case "text":
      // Idempotent: an already-hashed value is closed and carries nothing.
      return HASHED.test(value) ? value : `h-${exportDigest(value)}`;
    case "id":
      return CLOSED_ID.test(value) || t.also?.test(value) === true
        ? value
        : `h-${exportDigest(value)}`;
    case "token":
      return CLOSED_TOKEN.test(value) ? value : `h-${exportDigest(value).slice(0, 60)}`;
    case "closed":
      if (!t.grammar.test(value)) throw new OpenValueError(templateOf(path));
      return value;
  }
}

function walk(table: Readonly<Record<string, Treatment>>, node: unknown, path: string): unknown {
  if (typeof node === "string") return treat(table, path, node);
  if (Array.isArray(node)) return node.map((item, i) => walk(table, item, `${path}[${i}]`));
  if (node !== null && typeof node === "object")
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, walk(table, v, `${path}.${k}`)]),
    );
  return node;
}

/** The closed form of an episode; `episodeId` recomputed over the closed content. */
export function closeEpisode(ep: Episode): Episode {
  const { episodeId: _old, ...rest } = walk(
    EPISODE_FIELD_TREATMENT,
    { ...ep, episodeId: "0".repeat(64) },
    "$",
  ) as Episode;
  return { ...rest, episodeId: episodeIdOf(rest) } as Episode;
}

/** The closed form of a record's free fields (`desktop.backend`, `desktop.image`, `capture.path`). */
export function closeRecordFields<
  T extends { desktop: { backend: string; image: string }; capture: { path: string } },
>(record: T): T {
  return {
    ...record,
    desktop: {
      ...record.desktop,
      backend: treat(RECORD_FIELD_TREATMENT, "$.desktop.backend", record.desktop.backend),
      image: treat(RECORD_FIELD_TREATMENT, "$.desktop.image", record.desktop.image),
    },
    capture: {
      ...record.capture,
      path: treat(RECORD_FIELD_TREATMENT, "$.capture.path", record.capture.path),
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
      return CLOSED_TOKEN.test(value) || HASHED_SHORT.test(value);
    case "closed":
      return t.grammar.test(value);
  }
}

/** Strings of a closed episode outside their closed output grammar (paths, never values). */
export function openEpisodeStrings(ep: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      if (!accepts(EPISODE_FIELD_TREATMENT[templateOf(path)], node)) out.push(path);
    } else if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) visit(item, `${path}[${i}]`);
    } else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`);
    }
  };
  visit(ep, "$");
  return out;
}
