/**
 * Track S pre-registration: canonical JSON and SHA-256.
 *
 * The pre-registration hash (capability-spec §3.1) is the SHA-256 of a value's canonical
 * JSON: object keys sorted by UTF-16 code unit, no whitespace, strings and numbers as
 * `JSON.stringify` writes them. Non-finite numbers, `undefined`, functions and other
 * non-JSON values are refused rather than silently dropped, so two different values can
 * never share a hash by losing a field.
 */

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw new Error("canonicalJson: not a plain object");
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value}`);
  }
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
