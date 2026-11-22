/**
 * HIDDEN SPLIT — TIF-51 EF-002 state oracles.
 *
 * Nothing in src/ outside this directory may import src/foundry/oracles/ or
 * src/foundry/hidden/ (contract §6; enforced by test/foundry/split.test.ts).
 * This directory holds ANSWER DERIVATION: it computes the expected end state from the
 * intent and the initial state, and it reads what the app actually persisted.
 *
 * The no-leak rule (contract §4) is a type-level rule here: `expected()` cannot take
 * an `ActualState`. If a later refactor makes the answer a function of the agent's
 * output, that refactor will not compile.
 */

import type {
  ActualState,
  AppId,
  FixtureManifest,
  InitialState,
  OracleCheck,
  OracleVerdict,
  StateOracle,
  TaskIntent,
} from "../types.ts";
import { decodeBytes, FoundryReadError } from "../types.ts";

// ---------------------------------------------------------------------------
// Parsing: narrow `unknown` at the boundary, then read typed values.
// ---------------------------------------------------------------------------

interface TodoEntry {
  readonly text: string;
  readonly addedAt: string;
}

/** The parsed store. `items` keeps the app's field order; order is part of the contract. */
export interface TodoState {
  readonly items: readonly TodoEntry[];
  /**
   * The companion metadata file, when the app wrote one (`undefined` = never written,
   * which is not a disagreement). A persisted document-set check, not a UI check: the
   * app's second write pass can land without the first being reconciled with it.
   */
  readonly meta: TodoMeta | undefined;
}

export interface TodoMeta {
  readonly count: number | undefined;
}

function parseTodoMeta(files: Readonly<Record<string, Uint8Array>>): TodoMeta | undefined {
  const bytes = files["store.meta.json"];
  if (bytes === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBytes(bytes));
  } catch {
    throw new FoundryReadError("corrupt", "store.meta.json is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") return { count: undefined };
  return {
    count: "count" in parsed && typeof parsed.count === "number" ? parsed.count : undefined,
  };
}

function parseTodoStore(files: Readonly<Record<string, Uint8Array>>): TodoState {
  const bytes = files["store.json"];
  if (bytes === undefined) {
    throw new FoundryReadError("missing", "store.json is absent; the app never wrote its store");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBytes(bytes));
  } catch {
    throw new FoundryReadError("corrupt", "store.json is not valid JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("items" in parsed) ||
    !Array.isArray(parsed.items)
  ) {
    throw new FoundryReadError("corrupt", "store.json has no items array");
  }
  const items: TodoEntry[] = [];
  for (const entry of parsed.items) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("text" in entry) ||
      typeof entry.text !== "string"
    ) {
      throw new FoundryReadError("corrupt", "store.json has an item without a text field");
    }
    const addedAt = "added_at" in entry && typeof entry.added_at === "string" ? entry.added_at : "";
    items.push({ text: entry.text, addedAt });
  }
  return { items, meta: parseTodoMeta(files) };
}

/** The store's own normalisation (the app writes trimmed, single-spaced text). */
function normalisedForStore(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Derivation: honestly what the USER asked for, never what the app's bug does.
// ---------------------------------------------------------------------------

/**
 * Expected end state from intent + initial state only.
 *
 * Deliberately does NOT model the app's BUG-prefix drop: a model of the bug would
 * make the bug the expected answer, which is the trap the dogfood scenario dodges by
 * asserting a literal set. Here the honest expectation is "every item the user named
 * is present, with the text the user named".
 */
function expectedTodoState(intent: TaskIntent, initial: InitialState): TodoState {
  if (initial.kind !== "myco-todo") {
    throw new FoundryReadError(
      "unreadable",
      `myco-todo oracle got a ${initial.kind} initial state`,
    );
  }
  const initialFiles = { "store.json": initial.bytes, ...initial.companionFiles };
  const current = parseTodoStore(initialFiles).items.map((i) => i.text);
  // A metadata file the app already wrote must end up consistent with the final item count.
  const hadMeta = parseTodoMeta(initialFiles) !== undefined;
  const withMeta = (texts: readonly string[]): TodoState => ({
    items: texts.map((text) => ({ text, addedAt: "" })),
    meta: hadMeta ? { count: texts.length } : undefined,
  });
  switch (intent.kind) {
    case "todo.add-items":
      return withMeta([...current, ...intent.items.map(normalisedForStore)]);
    case "todo.rename-item": {
      // In place: the row keeps its position. Deleting the row and appending the new text
      // is a different state, and one the mutation audit proves the oracle distinguishes.
      const from = intent.from;
      const to = normalisedForStore(intent.to);
      const target = current.findIndex(
        (text) => normalisedForStore(text) === normalisedForStore(from),
      );
      if (target === -1) {
        // The intent names a row the initial store does not hold: nothing to rename.
        return withMeta(current);
      }
      return withMeta(current.map((text, index) => (index === target ? to : text)));
    }
    case "todo.delete-items": {
      const doomed = new Set(intent.items.map(normalisedForStore));
      return withMeta(current.filter((text) => !doomed.has(text)));
    }
    case "ledger.set-cell":
      throw new FoundryReadError(
        "unreadable",
        "the myco-todo oracle cannot evaluate a ledger intent",
      );
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compareTodo(actual: TodoState, expected: TodoState): OracleCheck[] {
  const actualTexts = actual.items.map((item) => item.text);
  const expectedTexts = expected.items.map((item) => item.text);
  const checks: OracleCheck[] = [];

  for (const text of expectedTexts) {
    const count = actualTexts.filter((t) => t === text).length;
    checks.push({
      name: `todo:present:${text}`,
      passed: count === 1,
      reason:
        count === 1 ? "present exactly once in the store" : `found ${count} copies in the store`,
      weight: 0,
    });
  }
  const expectedSet = new Set(expectedTexts);
  for (const text of actualTexts) {
    if (expectedSet.has(text)) continue;
    checks.push({
      name: `todo:unexpected:${text}`,
      passed: false,
      reason: "the store holds an entry the intent does not produce",
      weight: 0,
    });
  }
  const sameOrder = actualTexts.join("\u0000") === expectedTexts.join("\u0000");
  checks.push({
    name: "todo:order",
    passed: sameOrder,
    reason: sameOrder ? "order matches the intent" : `store order ${JSON.stringify(actualTexts)}`,
    weight: 0,
  });
  if (expected.meta !== undefined) {
    const actualMeta = actual.meta;
    if (actualMeta === undefined) {
      checks.push({
        name: "todo:meta:present",
        passed: false,
        reason: "the store's companion metadata file is missing",
        weight: 0,
      });
    } else if (actualMeta.count !== expected.meta.count) {
      checks.push({
        name: "todo:meta:count",
        passed: false,
        reason: `metadata count ${actualMeta.count ?? "absent"} disagrees with ${expected.meta.count} persisted items`,
        weight: 0,
      });
    } else {
      checks.push({
        name: "todo:meta:count",
        passed: true,
        reason: `metadata count matches the ${expected.meta.count} persisted items`,
        weight: 0,
      });
    }
  }
  const missingTimestamps = actual.items.filter((item) => item.addedAt === "").length;
  if (missingTimestamps > 0) {
    checks.push({
      name: "todo:written-by-app",
      passed: false,
      reason: `${missingTimestamps} entries have no added_at, so the app did not write this store`,
      weight: 0,
    });
  }
  const weight = checks.length === 0 ? 0 : 1 / checks.length;
  return checks.map((check) => ({ ...check, weight }));
}

export const TODO_ORACLE_VERSION = 1;

export function todoStateOracle(): StateOracle {
  return {
    app: "myco-todo",
    version: TODO_ORACLE_VERSION,
    read: parseTodoStore,
    expected: expectedTodoState,
    compare: (actual, expected) => compareTodo(actual as TodoState, expected as TodoState),
  };
}

// ---------------------------------------------------------------------------
// Verdict assembly (ADR-0002)
// ---------------------------------------------------------------------------

/**
 * Folds checks into a three-valued verdict: any `false` -> refuted; else any `null`
 * -> uncertain; else verified. A read failure is turned into `uncertain` by the
 * caller — never `refuted`, so "we could not look" cannot be scored as failure.
 */
export function verdictFromChecks(checks: readonly OracleCheck[]): OracleVerdict {
  const failed = checks.filter((check) => check.passed === false);
  const unknown = checks.filter((check) => check.passed === null);
  if (failed.length > 0) {
    return { status: "refuted", checks, reasons: failed.map((c) => `${c.name}: ${c.reason}`) };
  }
  if (unknown.length > 0) {
    return { status: "uncertain", checks, reasons: unknown.map((c) => `${c.name}: ${c.reason}`) };
  }
  return { status: "verified", checks, reasons: ["every persisted-state check passed"] };
}

/** Reads persisted state and grades it. A read error is `uncertain`, never `refuted`. */
export function verifyPersistedState(
  oracle: StateOracle,
  intent: TaskIntent,
  initial: InitialState,
  files: Readonly<Record<string, Uint8Array>>,
): OracleVerdict {
  let expected: unknown;
  try {
    expected = oracle.expected(intent, initial);
  } catch (error) {
    return {
      status: "uncertain",
      checks: [],
      reasons: [`could not derive the expected state: ${(error as Error).message}`],
    };
  }
  let actual: unknown;
  try {
    actual = oracle.read(files);
  } catch (error) {
    const reason =
      error instanceof FoundryReadError ? `${error.reason}: ${error.message}` : String(error);
    return {
      status: "uncertain",
      checks: [{ name: "state:readable", passed: null, reason, weight: 1 }],
      reasons: [`could not look at persisted state (${reason})`],
    };
  }
  return verdictFromChecks(oracle.compare(actual, expected));
}

export function verifyFixture(
  fixture: FixtureManifest,
  intent: TaskIntent,
  actual: ActualState,
): OracleVerdict {
  return verifyPersistedState(
    oracleForApp(fixture.app),
    intent,
    fixture.initialState,
    actual.files,
  );
}

export function oracleForApp(app: AppId): StateOracle {
  switch (app) {
    case "myco-todo":
      return todoStateOracle();
    case "ledger-csv":
      throw new FoundryReadError(
        "unreadable",
        "the ledger-csv oracle lands with the ledger fixtures",
      );
  }
}
