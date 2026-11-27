/**
 * #599 follow-up 2: the keyed provenance seal (`src/export-guard/seal.ts`), the importer trust
 * boundary shared by the export surfaces. Every key here is random bytes made at run time and
 * written to a scratch file; no key value is committed or printed.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSealKey,
  requireSeal,
  SEAL_KEY_MIN_BYTES,
  SealError,
  SealKey,
  sealArtifact,
  sealHolds,
} from "../../src/export-guard/seal.ts";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A key file holding `bytes`, with `mode`. */
function keyFile(bytes: Uint8Array, mode = 0o600): string {
  const d = mkdtempSync(join(tmpdir(), "seal-"));
  made.push(d);
  const p = join(d, "seal.key");
  writeFileSync(p, bytes);
  chmodSync(p, mode);
  return p;
}
const codeOf = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(SealError);
    return (e as SealError).code;
  }
};

const D = "myco.test.seal/1";

describe("sealArtifact / sealHolds", () => {
  const key = new SealKey(randomBytes(32));

  it("holds for the exact bytes, domain and key; 64 lower-case hex", () => {
    const s = sealArtifact(key, D, "artifact");
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(sealHolds(key, D, "artifact", s)).toBe(true);
    expect(sealHolds(key, D, new TextEncoder().encode("artifact"), s)).toBe(true);
    expect(() => requireSeal(key, D, "artifact", s)).not.toThrow();
  });

  it("does not hold for other bytes, another domain, another key, or a malformed seal", () => {
    const s = sealArtifact(key, D, "artifact");
    expect(sealHolds(key, D, "artifact ", s)).toBe(false);
    expect(sealHolds(key, "myco.other.seal/1", "artifact", s)).toBe(false);
    expect(sealHolds(new SealKey(randomBytes(32)), D, "artifact", s)).toBe(false);
    for (const bad of ["", s.toUpperCase(), s.slice(2), `${s}00`, `${s.slice(0, 63)}g`])
      expect(sealHolds(key, D, "artifact", bad), String(bad.length)).toBe(false);
    expect(codeOf(() => requireSeal(key, D, "other", s))).toBe("SEAL_MISMATCH");
  });

  it("the domain and the digest cannot be shifted into each other", () => {
    expect(sealArtifact(key, "a", "b")).not.toBe(sealArtifact(key, "a\u0000", "b"));
  });
});

describe("SealKey and loadSealKey (the key never leaves the module)", () => {
  it("loads a private key file; a short key, an open mode or a missing file is a code", () => {
    const bytes = randomBytes(SEAL_KEY_MIN_BYTES);
    const key = loadSealKey(keyFile(bytes));
    expect(sealArtifact(key, D, "x")).toBe(sealArtifact(new SealKey(bytes), D, "x"));
    expect(codeOf(() => loadSealKey(keyFile(randomBytes(SEAL_KEY_MIN_BYTES - 1))))).toBe(
      "SEAL_KEY_SHORT",
    );
    expect(codeOf(() => new SealKey(new Uint8Array(0)))).toBe("SEAL_KEY_SHORT");
    if (process.platform !== "win32") {
      expect(codeOf(() => loadSealKey(keyFile(bytes, 0o640)))).toBe("SEAL_KEY_MODE");
      expect(codeOf(() => loadSealKey(keyFile(bytes, 0o604)))).toBe("SEAL_KEY_MODE");
    }
    expect(codeOf(() => loadSealKey(join(tmpdir(), "no-such-seal-key-file")))).toBe(
      "SEAL_KEY_UNREADABLE",
    );
  });

  it("serializes and prints as a placeholder, never its bytes", () => {
    const bytes = randomBytes(32);
    const key = new SealKey(bytes);
    const hex = bytes.toString("hex");
    for (const out of [JSON.stringify({ key }), String(key), `${key}`, JSON.stringify(key)]) {
      expect(out.includes(hex)).toBe(false);
      expect(out.includes(bytes.toString("base64"))).toBe(false);
    }
    expect(Object.keys(key)).toEqual([]);
  });

  it("a refusal message is its code only", () => {
    const e = new SealError("SEAL_MISMATCH");
    expect(e.message).toBe("SEAL_MISMATCH");
  });
});
