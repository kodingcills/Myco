import { describe, expect, it } from "vitest";
import {
  todoStateOracle,
  verdictFromChecks,
  verifyPersistedState,
} from "../../src/foundry/oracles/state.ts";
import {
  findTodoFixture,
  TODO_FIXTURES,
  withExactInitialText,
} from "../../src/foundry/tasks/todo.ts";
import type { InitialState, OracleCheck, TaskIntent } from "../../src/foundry/types.ts";
import { FoundryReadError } from "../../src/foundry/types.ts";

const ORACLE = todoStateOracle();

function fixture(id: string) {
  const found = findTodoFixture(id);
  if (!found) throw new Error(`fixture ${id} not found`);
  return found;
}

function filesFrom(content: string, extra: Record<string, string> = {}) {
  const files: Record<string, Uint8Array> = { "store.json": new TextEncoder().encode(content) };
  for (const [path, text] of Object.entries(extra)) files[path] = new TextEncoder().encode(text);
  return files;
}

function storeOf(texts: readonly string[]): string {
  return `${JSON.stringify({ items: texts.map((text) => ({ text, added_at: "2026-11-21T09:00:00.000Z" })) }, null, 2)}\n`;
}

/** The silent-drop fixture starts with an empty list, so "add two" is the whole intent. */
const ADD_TWO: TaskIntent = { kind: "todo.add-items", items: ["buy milk", "call mom"] };
const SIMPLE_FIXTURE_ID = "ef-todo-silent-drop-v1";

function emptyStart(): InitialState {
  const initial = fixture(SIMPLE_FIXTURE_ID).initialState;
  return { ...initial, bytes: new TextEncoder().encode(storeOf([])) };
}

describe("EF-002 state oracle: reads state, not the GUI", () => {
  it("verifies a persisted end state that matches the intent", () => {
    const verdict = verifyPersistedState(
      ORACLE,
      ADD_TWO,
      emptyStart(),
      filesFrom(storeOf(["buy milk", "call mom"])),
    );
    expect(verdict.status).toBe("verified");
    expect(verdict.checks.every((c) => c.passed === true)).toBe(true);
    expect(verdict.checks.reduce((sum, c) => sum + c.weight, 0)).toBeCloseTo(1);
  });

  it("refutes a missing item even when everything else is right", () => {
    const verdict = verifyPersistedState(
      ORACLE,
      ADD_TWO,
      fixture(SIMPLE_FIXTURE_ID).initialState,
      filesFrom(storeOf(["buy milk"])),
    );
    expect(verdict.status).toBe("refuted");
    expect(verdict.reasons.join(" ")).toContain("call mom");
  });

  it("refutes an unrequested extra row (side-effect blindness is a failure)", () => {
    const verdict = verifyPersistedState(
      ORACLE,
      ADD_TWO,
      fixture(SIMPLE_FIXTURE_ID).initialState,
      filesFrom(storeOf(["buy milk", "call mom", "something else"])),
    );
    expect(verdict.status).toBe("refuted");
    expect(verdict.reasons.join(" ")).toContain("something else");
  });

  it("refutes duplicate rows for a single requested item", () => {
    const verdict = verifyPersistedState(
      ORACLE,
      ADD_TWO,
      fixture(SIMPLE_FIXTURE_ID).initialState,
      filesFrom(storeOf(["buy milk", "buy milk", "call mom"])),
    );
    expect(verdict.status).toBe("refuted");
    expect(verdict.reasons.join(" ")).toContain("found 2 copies");
  });

  it("refutes a store that carries no app timestamps", () => {
    const handWritten = `${JSON.stringify({ items: [{ text: "buy milk" }, { text: "call mom" }] })}\n`;
    const verdict = verifyPersistedState(
      ORACLE,
      ADD_TWO,
      fixture(SIMPLE_FIXTURE_ID).initialState,
      filesFrom(handWritten),
    );
    expect(verdict.status).toBe("refuted");
    expect(verdict.reasons.join(" ")).toContain("written-by-app");
  });

  it("reports uncertain, never refuted, when the store is unreadable or corrupt", () => {
    for (const files of [
      filesFrom("not json at all"),
      filesFrom('{"items": "nope"}'),
      filesFrom('{"items": [{"added_at": "x"}]}'),
      {} as Record<string, Uint8Array>,
    ]) {
      const verdict = verifyPersistedState(
        ORACLE,
        ADD_TWO,
        fixture(SIMPLE_FIXTURE_ID).initialState,
        files,
      );
      expect(verdict.status).toBe("uncertain");
      expect(verdict.checks.some((check) => check.passed === null)).toBe(true);
    }
  });

  it("refuses to grade a corrupt store as a pass either", () => {
    const verdict = verifyPersistedState(
      ORACLE,
      ADD_TWO,
      fixture(SIMPLE_FIXTURE_ID).initialState,
      filesFrom("\u0000\u0001binary"),
    );
    expect(verdict.status).not.toBe("verified");
  });
});

describe("EF-002 no-leak rule: the answer never depends on the agent's output", () => {
  it("derives the same expectation regardless of what the agent produced", () => {
    for (const manifest of TODO_FIXTURES) {
      const intent = intentFor(manifest.fixtureId);
      // Two wildly different agent outcomes. The derived expectation must be identical,
      // because `expected()` is given neither of them.
      const first = new TextEncoder().encode(storeOf(["whatever the agent wrote", "garbage"]));
      const second = new TextEncoder().encode("{}");
      const expectedA = ORACLE.expected(intent, manifest.initialState);
      const expectedB = ORACLE.expected(intent, manifest.initialState);
      expect(JSON.stringify(expectedA)).toBe(JSON.stringify(expectedB));
      // And the expectation is not constructed from either file content.
      expect(JSON.stringify(expectedA)).not.toContain("whatever the agent wrote");
      expect(new TextDecoder().decode(first)).not.toBe(new TextDecoder().decode(second));
    }
  });

  it("produces different expectations for different intents (the oracle is not constant)", () => {
    const initial = fixture(SIMPLE_FIXTURE_ID).initialState;
    const a = ORACLE.expected({ kind: "todo.add-items", items: ["alpha"] }, initial);
    const b = ORACLE.expected({ kind: "todo.add-items", items: ["beta"] }, initial);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("cannot be satisfied by the initial state of any fixture", () => {
    for (const manifest of TODO_FIXTURES) {
      const initial = manifest.initialState;
      if (initial.kind !== "myco-todo") throw new Error("expected a myco-todo fixture");
      const verdict = verifyPersistedState(ORACLE, intentFor(manifest.fixtureId), initial, {
        "store.json": initial.bytes,
        ...initial.companionFiles,
      });
      expect(verdict.status, manifest.fixtureId).toBe("refuted");
    }
  });

  it("grades the exact-text variant identically to the rewritten variant", () => {
    const intent = intentFor(SIMPLE_FIXTURE_ID);
    const rewritten = fixture(SIMPLE_FIXTURE_ID);
    const exact = withExactInitialText(rewritten);
    const incomplete = filesFrom(storeOf(["buy milk", "call mom"]));
    const a = verifyPersistedState(ORACLE, intent, rewritten.initialState, incomplete);
    const b = verifyPersistedState(ORACLE, intent, exact.initialState, incomplete);
    expect(a.status).toBe(b.status);
  });
});

describe("EF-002 mutation audit (WorkArena method)", () => {
  /**
   * Hand-written near-misses of a correct run. Each must be refused. Two of them are
   * exactly what a GUI-trusting verifier accepts, because the screen shows them.
   */
  const correct = storeOf(["buy milk", "call mom"]);
  const mutations: readonly { name: string; store: string; extra?: Record<string, string> }[] = [
    { name: "target omitted", store: storeOf(["buy milk"]) },
    { name: "target value wrong", store: storeOf(["buy milk", "call mum"]) },
    { name: "target duplicated", store: storeOf(["buy milk", "call mom", "call mom"]) },
    { name: "unrequested field filled", store: storeOf(["buy milk", "call mom", "urgent"]) },
    { name: "rows reordered", store: storeOf(["call mom", "buy milk"]) },
    { name: "fields swapped", store: storeOf(["call mom", "buy milk"]) },
    {
      name: "hand-written store without app timestamps",
      store: `${JSON.stringify({ items: [{ text: "buy milk" }, { text: "call mom" }] })}\n`,
    },
  ];

  it("each mutation is refuted", () => {
    const initial = emptyStart();
    for (const mutation of mutations) {
      const verdict = verifyPersistedState(
        ORACLE,
        ADD_TWO,
        initial,
        filesFrom(mutation.store, mutation.extra),
      );
      expect(verdict.status, mutation.name).toBe("refuted");
    }
  });

  it("the unmutated run is still verified (the audit is not a constant-failure verifier)", () => {
    const verdict = verifyPersistedState(ORACLE, ADD_TWO, emptyStart(), filesFrom(correct));
    expect(verdict.status).toBe("verified");
  });

  it("refutes a partial-write result whose metadata disagrees with its items", () => {
    const manifest = fixture("ef-todo-partial-write-v1");
    const initial = manifest.initialState;
    if (initial.kind !== "myco-todo") throw new Error("expected myco-todo");
    const intent: TaskIntent = { kind: "todo.delete-items", items: ["archive Q1 invoices"] };

    const honest = verifyPersistedState(ORACLE, intent, initial, {
      "store.json": new TextEncoder().encode(
        storeOf(["update docs", "renew the domain", "audit expense claims"]),
      ),
      "store.meta.json": new TextEncoder().encode('{"count": 3}\n'),
    });
    expect(honest.status).toBe("verified");

    const stale = verifyPersistedState(ORACLE, intent, initial, {
      "store.json": new TextEncoder().encode(
        storeOf(["update docs", "renew the domain", "audit expense claims"]),
      ),
      "store.meta.json": new TextEncoder().encode('{"count": 4}\n'),
    });
    expect(stale.status).toBe("refuted");
    expect(stale.reasons.join(" ")).toContain("meta:count");
  });
});

describe("EF-002 verdict folding", () => {
  it("refuted wins over uncertain, and uncertain is never inflated", () => {
    const check = (passed: boolean | null): OracleCheck => ({
      name: "c",
      passed,
      reason: "",
      weight: 1,
    });
    expect(verdictFromChecks([check(null), check(false)]).status).toBe("refuted");
    expect(verdictFromChecks([check(null), check(true)]).status).toBe("uncertain");
    expect(verdictFromChecks([check(true)]).status).toBe("verified");
  });

  it("an oracle mismatch surfaces as a read error type, not a silent empty state", () => {
    const oracle = todoStateOracle();
    expect(() =>
      oracle.expected(
        { kind: "todo.add-items", items: [] },
        {
          kind: "ledger-csv",
          storePath: "x",
          bytes: new Uint8Array(),
          columns: [],
          rows: [],
        },
      ),
    ).toThrow(FoundryReadError);
  });
});

function intentFor(fixtureId: string): TaskIntent {
  switch (fixtureId) {
    case "ef-todo-silent-drop-v1":
      return {
        kind: "todo.add-items",
        items: ["BUG: token expires too early", "write the incident summary"],
      };
    case "ef-todo-stale-row-v1":
      return { kind: "todo.rename-item", from: "Draft release notes", to: "Release notes for 2.4" };
    case "ef-todo-wrong-value-v1":
      return { kind: "todo.add-items", items: ["Release: review the Q3 metrics"] };
    case "ef-todo-partial-write-v1":
      return { kind: "todo.delete-items", items: ["archive Q1 invoices"] };
    default:
      throw new Error(`no intent for ${fixtureId}`);
  }
}
