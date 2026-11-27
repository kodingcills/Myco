/**
 * HASH LOOK-ALIKES, shared by the episode export (`src/episode/closed.ts`) and track U's
 * container (`src/dataset/closed.ts`) (#612 D1 and D2).
 *
 * Two rules, so the two surfaces cannot drift apart again:
 *
 *  - D2, `malformedHash`: a value that starts like a hash (`h-` or `H-`) but is not exactly the
 *    hashed form `h-<60 hex>` (`H-<60 HEX>`, `h-<64 hex>`, `h-<59 hex>`, `h-x`) is never kept
 *    verbatim in an id field: the export re-hashes it, and a validator refuses it. So a reader
 *    can never mistake another `h-` form for a hash, and the exact `h-<60 hex>` invariant holds
 *    for every id the export writes (track U had this since #559 round 3, S1; the episode export
 *    did not).
 *  - D1, `skipsIdentityCheck`: the identity check may skip an `h-<60 hex>` value ONLY in a field
 *    the exporter itself hashes (free text, ids, tokens), where that form is either the
 *    exporter's own output or a harness-produced value it keeps (#579 O3). In a CLOSED-PATTERN
 *    field (a task family, a task-set version, a fault class, an oracle family, the export
 *    filter) the exporter never hashes, so an `h-<60 hex>` there is just text that happens to
 *    match the grammar, and it is checked like any other value: a hex-letter identity (`cafe`,
 *    `ada`) inside it refuses the export, and the validator reports it.
 *
 * Imports only `provenance.ts` (and nothing from any surface or from `src/benchmark`).
 */
import { isHashedForm } from "./provenance.ts";

/** Starts like a hash: `h-` or `H-`. */
export const HASH_LIKE = /^[hH]-/;

/** A hash look-alike that is not exactly `h-<60 hex>` (D2): re-hashed in ids, refused by validators. */
export const malformedHash = (value: string): boolean =>
  HASH_LIKE.test(value) && !isHashedForm(value);

/** How a surface treats a field (the same four kinds on both surfaces). */
export type FieldKind = "text" | "id" | "token" | "closed";

/** Whether the exporter writes the hashed form into a field of this kind (every kind but closed). */
export const exporterHashes = (kind: FieldKind): boolean => kind !== "closed";

/**
 * Whether the identity check may skip `value` at a field of `kind` (D1): only an exact
 * `h-<60 hex>` in a field the exporter hashes. Never in a closed-pattern field.
 */
export const skipsIdentityCheck = (kind: FieldKind, value: string): boolean =>
  exporterHashes(kind) && isHashedForm(value);
