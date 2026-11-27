/**
 * The KEYED PROVENANCE SEAL (#599 follow-up 2): the importer trust boundary of the export
 * surfaces.
 *
 * A hash ledger (`provenance.ts`) is built from an artifact the harness wrote: a dataset, a
 * container, a proof bundle. Until #599 the importer trusted ANY artifact that validated, and a
 * validator cannot tell who wrote a value: a hand-edited artifact that still validated (an
 * agent's `h-<60 hex>` planted in a hashed field, the chain recomputed) was recorded as harness
 * output, and the next export kept the agent's hex verbatim.
 *
 * The seal is `HMAC-SHA256(key, domain \0 sha256(artifact bytes))`, written next to the artifact
 * by the harness when it writes the artifact. An importer that requires the seal refuses an
 * artifact whose seal does not hold: any edit to the bytes, a seal from another surface (the
 * domain is part of the MAC input), or a seal made under another key. Whoever lacks the key
 * cannot forge one, which an unkeyed digest (a manifest hash, a chain head) cannot give: anyone
 * can recompute those.
 *
 * What it is NOT: a public signature. The key is harness-private, so only the harness can check
 * a seal; a third party verifies a proof bundle by its chain and an out-of-band head, as before.
 * It is not a defense against the harness itself, which holds the key (the trusted boundary).
 *
 * The key is loaded AT THE POINT OF USE from a key file (AGENTS.md, secrets: a path travels,
 * never the key), is never printed, and every refusal message is a code with no value. The key
 * object keeps its bytes in a private field and serializes as a fixed placeholder.
 *
 * This module imports nothing from any surface (and nothing from `src/benchmark`).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** At least this many key bytes (256 bits). */
export const SEAL_KEY_MIN_BYTES = 32;

/** The written form of a seal: exactly 64 lower-case hex. */
export const SEAL_FORM = /^[0-9a-f]{64}$/;

/** A refusal: a code only, never a value, a path or key material. */
export class SealError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SealError";
  }
}

/** The harness's seal key. Opaque: its bytes never leave this module. */
export class SealKey {
  readonly #bytes: Buffer;

  constructor(bytes: Uint8Array) {
    if (bytes.byteLength < SEAL_KEY_MIN_BYTES) throw new SealError("SEAL_KEY_SHORT");
    this.#bytes = Buffer.from(bytes);
  }

  /** Internal: the MAC under this key. */
  mac(input: string): string {
    return createHmac("sha256", this.#bytes).update(input, "utf8").digest("hex");
  }

  toJSON(): string {
    return "[seal key]";
  }

  toString(): string {
    return "[seal key]";
  }
}

/**
 * Load the seal key from a key file, at the point of use. The file's bytes are the key (at least
 * `SEAL_KEY_MIN_BYTES`). On POSIX a file readable or writable by group or others is refused
 * (`SEAL_KEY_MODE`): a key others can read is not harness-private. Refusals are codes only.
 */
export function loadSealKey(path: string): SealKey {
  let bytes: Buffer;
  try {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0)
      throw new SealError("SEAL_KEY_MODE");
    bytes = readFileSync(path);
  } catch (e) {
    if (e instanceof SealError) throw e;
    throw new SealError("SEAL_KEY_UNREADABLE");
  }
  return new SealKey(bytes);
}

const macInput = (domain: string, artifact: string | Uint8Array): string =>
  `${domain}\u0000${createHash("sha256").update(artifact).digest("hex")}`;

/** The seal of `artifact` (its exact bytes) under `key`, for one surface's `domain`. */
export function sealArtifact(key: SealKey, domain: string, artifact: string | Uint8Array): string {
  return key.mac(macInput(domain, artifact));
}

/** Whether `seal` holds for exactly these bytes, this domain and this key (constant time). */
export function sealHolds(
  key: SealKey,
  domain: string,
  artifact: string | Uint8Array,
  seal: string,
): boolean {
  if (!SEAL_FORM.test(seal)) return false;
  const want = Buffer.from(sealArtifact(key, domain, artifact), "hex");
  return timingSafeEqual(want, Buffer.from(seal, "hex"));
}

/** Refuse (`SEAL_MISMATCH`) unless the seal holds. */
export function requireSeal(
  key: SealKey,
  domain: string,
  artifact: string | Uint8Array,
  seal: string,
): void {
  if (!sealHolds(key, domain, artifact, seal)) throw new SealError("SEAL_MISMATCH");
}
