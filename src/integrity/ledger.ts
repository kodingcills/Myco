/**
 * TIF-266 — a MAC-chained ledger, so an edited, deleted or reordered row is detected.
 *
 * Each line is `{ row, prev, mac }` where `mac = HMAC(key, prev || canonical(row))` and
 * `prev` is the previous line's `mac` (the genesis value for the first line). The head
 * (`mac` of the last line) is returned by `appendChainedRow`; a caller that keeps it can
 * also detect a truncated tail, which the chain alone cannot.
 *
 * The ledger format itself (columns, verdict fields) belongs to M2-04; this module only
 * wraps whatever row object it is given.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { canonical } from "./vault.ts";

export const LEDGER_GENESIS = "0".repeat(64);

export interface LedgerCheck {
  readonly ok: boolean;
  readonly rows: Record<string, unknown>[];
  readonly head: string;
  readonly violations: { line: number; detail: string }[];
}

const macOf = (key: Uint8Array, prev: string, row: unknown) =>
  createHmac("sha256", key).update(prev).update(canonical(row)).digest("hex");

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/** Append one row; returns the new head. */
export function appendChainedRow(
  path: string,
  key: Uint8Array,
  row: Record<string, unknown>,
): string {
  const prev = existsSync(path) ? checkChainedLedger(path, key).head : LEDGER_GENESIS;
  const mac = macOf(key, prev, row);
  appendFileSync(path, `${JSON.stringify({ row, prev, mac })}\n`);
  return mac;
}

/** Verify the chain. Rows are returned only up to the first broken link. */
export function checkChainedLedger(
  path: string,
  key: Uint8Array,
  expectedHead?: string,
): LedgerCheck {
  const violations: { line: number; detail: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  let head = LEDGER_GENESIS;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "");
  for (let i = 0; i < lines.length; i++) {
    let entry: { row?: unknown; prev?: unknown; mac?: unknown };
    try {
      entry = JSON.parse(lines[i] ?? "");
    } catch {
      violations.push({ line: i + 1, detail: "not JSON" });
      break;
    }
    const { row, prev, mac } = entry;
    if (
      row === null ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      typeof prev !== "string" ||
      typeof mac !== "string"
    ) {
      violations.push({ line: i + 1, detail: "not a chained ledger line" });
      break;
    }
    if (!same(prev, head)) {
      violations.push({
        line: i + 1,
        detail: "prev does not match the previous line (deleted or reordered row)",
      });
      break;
    }
    if (!same(mac, macOf(key, prev, row))) {
      violations.push({ line: i + 1, detail: "MAC does not verify (row edited)" });
      break;
    }
    rows.push(row as Record<string, unknown>);
    head = mac;
  }
  if (violations.length === 0 && expectedHead !== undefined && !same(head, expectedHead))
    violations.push({
      line: lines.length,
      detail: "head differs from the one kept at write time (truncated tail?)",
    });
  return { ok: violations.length === 0, rows, head, violations };
}
