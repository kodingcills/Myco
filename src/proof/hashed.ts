/**
 * Track Q (replayable proof): the HASHED-VALUE form, shared by every export surface (lead
 * ruling 23:06Z on #562: #559's track U container, the episode export superseding #556, and
 * these Q bundles).
 *
 * A value that may not be written as is (an id outside the closed grammar or carrying an
 * identity, a tool, app, key sequence, subject, policy code or media type outside its closed
 * vocabulary) becomes `h-<60hex>`: `h-` plus the first 60 hex characters (240 bits) of the
 * tagged SHA-256 of the FULL raw value (`textDigest`). Only the digest's hex is kept, so no
 * input text survives; 240 bits keep equality checkable with no practical collision.
 *
 * Idempotence: a value that is EXACTLY `h-<60hex>` (lower-case hex, nothing before or after)
 * is already hashed and is kept as is. Every other `h-` form (`h-<64hex>`, 59 or 61 hex digits,
 * upper-case hex, `H-...`) is a plain value and is hashed like any other.
 *
 * This form is ONLY for hashed values. Full content digests (`TextRef.sha256`,
 * `evidence.sha256`, the chain's `prevSha256`, the episode digest, the ledger head) stay the
 * full 64-hex SHA-256 (`HEX64`).
 *
 * This module imports nothing from the rest of `src/proof`, so `closed.ts` and `vocab.ts`
 * (which import each other) can both build schema patterns from it at load time.
 */
import { createHash } from "node:crypto";

/** The domain tag every text digest is computed under (versioned: a change is reviewed). */
export const TEXT_DIGEST_TAG = "myco.proof.text/1";

/** sha256 of a raw value under the text tag (64 hex). Equal inputs give equal digests. */
export function textDigest(raw: string): string {
  return createHash("sha256").update(`${TEXT_DIGEST_TAG}\u0000${raw}`, "utf8").digest("hex");
}

/** How many hex characters of the digest a hashed value keeps (240 bits). */
export const HASHED_HEX_CHARS = 60;

/** The hashed form, unanchored, for embedding in a schema pattern. */
export const HASHED_SOURCE = `h-[0-9a-f]{${HASHED_HEX_CHARS}}`;
const HASHED_RE = new RegExp(`^${HASHED_SOURCE}$`);

/** Any `h-` prefix, either case: reserved for the hashed form. */
export const RESERVED_PREFIX = /^h-/i;

/** Whether `raw` is exactly `h-<60hex>` (the only form treated as already hashed). */
export function isHashed(raw: string): boolean {
  return HASHED_RE.test(raw);
}

/** The hashed form of a raw value: `h-` + the first 60 hex of `textDigest(raw)`. */
export function hashedId(raw: string): string {
  return `h-${textDigest(raw).slice(0, HASHED_HEX_CHARS)}`;
}

/** Hash a value that may not be written as is, keeping an exact `h-<60hex>` as is. */
export function hashValue(raw: string): string {
  return isHashed(raw) ? raw : hashedId(raw);
}
