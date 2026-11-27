/**
 * Track R evaluation: canonical JSON and SHA-256, for the r-v1 pre-registration hash and the
 * fr-v1 manifest hash (capability-spec §3: "its SHA-256 over canonical JSON is the
 * pre-registration hash").
 *
 * Canonical JSON here: object keys sorted by UTF-16 code unit order, no whitespace, strings and
 * numbers as `JSON.stringify` writes them. Non-finite numbers, `undefined`, functions and other
 * non-JSON values are refused, so two encodings of one value cannot hash differently.
 */
import { createHash } from "node:crypto";

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("canonicalJson: only plain objects");
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof value}`);
}

/** SHA-256 (hex) over the canonical JSON of `value`. */
export const canonicalSha256 = (value: unknown): string => sha256Hex(canonicalJson(value));
