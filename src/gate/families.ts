/**
 * Oracle families the gate can run (TIF-265). A family pairs an operator-side task spec
 * with an existing Myco oracle; nothing here is a new oracle.
 *
 *  - `todo-items`        : `persistedStoreOracle` (src/discovery/s0-sequence.ts), the oracle
 *                          `myco-run` uses; the store is parsed by the runner's `parseStore`.
 *  - `calc-record-edit`  : `calcRecordEditVerifier` (src/tasks/calc-record-edit.ts), M1's Calc
 *                          oracle, over the CSV the app saved (`parseCsvSpreadsheet`).
 *
 * A family's `decide` sees only the persisted bytes and the operator's spec. It cannot see
 * the request, so the agent's claim and any agent-supplied value never reach it.
 * M2-07 (multi-step Calc) and M2-08 (Writer) add families here.
 */
import { parseCsvSpreadsheet } from "../core/filepersist.ts";
import { parseStore } from "../discovery/live-runner.ts";
import { persistedStoreOracle } from "../discovery/s0-sequence.ts";
import { calcRecordEditVerifier, intentFor, validateIntent } from "../tasks/calc-record-edit.ts";
import type { CalcRecordEditParams } from "../tasks/intent.ts";

/** Thrown by `decide` when the persisted bytes do not parse as the family's format. */
export class StateCorruptError extends Error {
  override readonly name = "StateCorruptError";
}

/** What an oracle returns. The gate validates this shape before trusting it. */
export interface OracleOutput {
  readonly status: "verified" | "refuted" | "uncertain";
  readonly reasons: readonly string[];
}

export interface OracleFamily {
  readonly id: string;
  /** Bumped when the family's decision rule changes, so a ledger row names the rule it used. */
  readonly version: string;
  /** Validate an operator task spec at registry load. Returns an error message or undefined. */
  checkSpec(spec: unknown): string | undefined;
  /** Decide from persisted bytes and the operator's spec only. May throw. */
  decide(bytes: Uint8Array, spec: unknown, ref: string): OracleOutput;
}

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StateCorruptError("persisted state is not valid UTF-8");
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export const todoItemsFamily: OracleFamily = {
  id: "todo-items",
  version: "1",
  checkSpec(spec) {
    if (typeof spec !== "object" || spec === null) return "spec must be an object";
    const items = (spec as { items?: unknown }).items;
    if (!isStringArray(items) || items.length === 0)
      return "spec.items must be a non-empty array of strings";
    return undefined;
  },
  decide(bytes, spec) {
    const items = (spec as { items: string[] }).items;
    let store: { items: readonly string[] };
    try {
      store = parseStore(utf8(bytes));
    } catch (error) {
      if (error instanceof StateCorruptError) throw error;
      throw new StateCorruptError(`store does not parse: ${String(error)}`);
    }
    return persistedStoreOracle({ items: [...store.items] }, { items: [...items] });
  },
};

const CALC_FIELDS = ["fixtureSeed", "rowKey", "column", "newValue"] as const;

export const calcRecordEditFamily: OracleFamily = {
  id: "calc-record-edit",
  version: "1",
  checkSpec(spec) {
    if (typeof spec !== "object" || spec === null) return "spec must be an object";
    const record = spec as Record<string, unknown>;
    for (const field of CALC_FIELDS) {
      if (typeof record[field] !== "string") return `spec.${field} must be a string`;
    }
    const valid = validateIntent(record as unknown as CalcRecordEditParams);
    return valid.ok ? undefined : `spec does not target the fixture: ${valid.error}`;
  },
  decide(bytes, spec, ref) {
    const state = parseCsvSpreadsheet(utf8(bytes), ref);
    return calcRecordEditVerifier.verify(state, intentFor(spec as CalcRecordEditParams));
  },
};

export const FAMILIES: ReadonlyMap<string, OracleFamily> = new Map(
  [todoItemsFamily, calcRecordEditFamily].map((family) => [family.id, family]),
);
