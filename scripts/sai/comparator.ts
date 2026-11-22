/**
 * Independent host-side comparators. These know nothing about Sai, the Judge, a status line or the
 * Foundry oracles: they compare expected items/bytes with what was actually read back from the
 * hosted computer's disk. A screen string, a Judge summary and a generated program's return value
 * are never inputs here.
 */
import { createHash } from "node:crypto";

export type Truth = "verified" | "refuted" | "unavailable";

export interface BytesComparison {
  truth: Truth;
  reason: string;
  expectedLength: number;
  actualLength: number | null;
  expectedSha256_12: string;
  actualSha256_12: string | null;
  hasBom: boolean | null;
  trailingNewline: boolean | null;
}

const sha12 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 12);

/**
 * Exact byte comparison. `actual === null` means the state was unreadable (unavailable);
 * `"absent"` means the readback worked and the file does not exist (refuted, never "empty").
 */
export function compareBytes(
  expected: Uint8Array,
  actual: Uint8Array | "absent" | null,
): BytesComparison {
  const base = {
    expectedLength: expected.length,
    expectedSha256_12: sha12(expected),
  };
  if (actual === null) {
    return {
      ...base,
      truth: "unavailable",
      reason: "state unreadable",
      actualLength: null,
      actualSha256_12: null,
      hasBom: null,
      trailingNewline: null,
    };
  }
  if (actual === "absent") {
    return {
      ...base,
      truth: "refuted",
      reason: "file absent",
      actualLength: null,
      actualSha256_12: null,
      hasBom: null,
      trailingNewline: null,
    };
  }
  const hasBom =
    actual.length >= 3 && actual[0] === 0xef && actual[1] === 0xbb && actual[2] === 0xbf;
  const last = actual[actual.length - 1];
  const trailingNewline = last === 0x0a || last === 0x0d;
  const same = actual.length === expected.length && expected.every((b, i) => actual[i] === b);
  return {
    ...base,
    truth: same ? "verified" : "refuted",
    reason: same
      ? "bytes identical"
      : hasBom
        ? "BOM present"
        : trailingNewline
          ? "trailing newline present"
          : "bytes differ",
    actualLength: actual.length,
    actualSha256_12: sha12(actual),
    hasBom,
    trailingNewline,
  };
}

export interface ItemsComparison {
  truth: Truth;
  reason: string;
  expected: string[];
  persisted: string[] | null;
  missing: string[];
  extras: string[];
  /** counts per item so duplicates are visible */
  duplicates: string[];
  orderMatches: boolean | null;
}

function tally(items: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}

/**
 * Compare the expected ordered item list with the persisted one. `persisted === null` is
 * unavailable (unreadable/malformed/inaccessible). Missing and extra items are multiset
 * differences; a duplicate is any item persisted more times than expected.
 */
export function compareItems(
  expected: readonly string[],
  persisted: readonly string[] | null,
  unavailableReason = "state unreadable",
): ItemsComparison {
  if (persisted === null) {
    return {
      truth: "unavailable",
      reason: unavailableReason,
      expected: [...expected],
      persisted: null,
      missing: [],
      extras: [],
      duplicates: [],
      orderMatches: null,
    };
  }
  const want = tally(expected);
  const got = tally(persisted);
  const missing: string[] = [];
  const extras: string[] = [];
  const duplicates: string[] = [];
  for (const [item, count] of want) {
    const have = got.get(item) ?? 0;
    for (let i = have; i < count; i += 1) missing.push(item);
    if (have > count) duplicates.push(item);
  }
  for (const [item, count] of got) {
    const need = want.get(item) ?? 0;
    for (let i = need; i < count; i += 1) extras.push(item);
  }
  const orderMatches =
    persisted.length === expected.length && expected.every((item, i) => persisted[i] === item);
  const verified = missing.length === 0 && extras.length === 0;
  return {
    truth: verified ? "verified" : "refuted",
    reason: verified
      ? orderMatches
        ? "items identical"
        : "same items, different order"
      : `missing ${missing.length}, extras ${extras.length}`,
    expected: [...expected],
    persisted: [...persisted],
    missing,
    extras,
    duplicates,
    orderMatches,
  };
}

/** Parse a persisted JSON array of strings; any other shape is unavailable (null), never "empty". */
export function parseItemStore(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text.replace(/^﻿/, ""));
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
    return null;
  } catch {
    return null;
  }
}

/** Outcome of an agent-side claim against truth. `claim` is what the system under test asserted. */
export type Claim = "success" | "failure" | "unchecked";
export type Verdict = "true-pass" | "false-pass" | "true-fail" | "false-fail" | "unscored";

export function scoreClaim(claim: Claim, truth: Truth): Verdict {
  if (claim === "unchecked" || truth === "unavailable") return "unscored";
  if (claim === "success") return truth === "verified" ? "true-pass" : "false-pass";
  return truth === "verified" ? "false-fail" : "true-fail";
}
