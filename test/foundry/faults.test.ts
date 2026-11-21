import { describe, expect, it } from "vitest";
import { ledgerRowSchema } from "../../schemas/ledger-row.ts";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { type Fault, injectFault, recoverSave, relaunch } from "../../src/foundry/faults/index.ts";
import { faultLedgerRow, scoreTrial, summarise } from "../../src/foundry/oracles/blind.ts";
import { todoStateOracle, verifyPersistedState } from "../../src/foundry/oracles/state.ts";
import {
  bootApp,
  deleteItem,
  persistedFiles,
  visibleScreen,
} from "../../src/foundry/tasks/app-model.ts";
import { findTodoFixture, TODO_FIXTURE_SPECS } from "../../src/foundry/tasks/todo.ts";
import type { TaskIntent } from "../../src/foundry/types.ts";

const faults: Fault[] = [
  "stale-ui",
  "interrupted-write",
  "partial-persistence",
  "crash-mid-save",
  "permission-denied",
];
const fixture = findTodoFixture("ef-todo-partial-write-v1")!;
const spec = TODO_FIXTURE_SPECS.find((s) => s.fixtureId === fixture.fixtureId)!;
const intent: TaskIntent = { kind: "todo.delete-items", items: ["archive Q1 invoices"] };
const initial = fixture.initialState;
function ready() {
  const boot = bootApp(spec);
  if (initial.kind !== "myco-todo") throw new Error("wrong fixture");
  return deleteItem(
    {
      ...boot,
      files: {
        ...boot.files,
        ...Object.fromEntries(
          Object.entries(initial.companionFiles ?? {}).map(([k, v]) => [
            k,
            new TextDecoder().decode(v),
          ]),
        ),
      },
    },
    "archive Q1 invoices",
  );
}
function grade(state: ReturnType<typeof ready>, faultVersion = 1) {
  return scoreTrial({
    fixture,
    intent,
    actual: { kind: "myco-todo", files: persistedFiles(state) },
    screen: { visibleText: visibleScreen(state), reachable: !state.windowGone },
    trace: [],
    selfReport: { claimsSuccess: true, text: "done" },
    faultVersion,
  });
}

describe.each(faults)("%s fault", (fault) => {
  it("arms deterministically, fools the screen when available, and is caught by durable evidence", () => {
    const result = injectFault(ready(), { fault, version: 1, seed: 42 });
    expect(result).toEqual(injectFault(ready(), { fault, version: 1, seed: 42 }));
    expect(validateSchema(result.event, traceEventSchema)).toEqual([]);
    expect(result.faultVersion).toBe(1);
    expect(
      verifyPersistedState(todoStateOracle(), intent, initial, persistedFiles(result.state)).status,
    ).toBe("refuted");
    if (fault !== "crash-mid-save")
      expect(visibleScreen(result.state)).toContain("saved 3 item(s)");
    else expect(visibleScreen(result.state)).toEqual([]);
    const ledger = faultLedgerRow(grade(result.state), fault, true, 0);
    expect(validateSchema(ledger, ledgerRowSchema)).toEqual([]);
    expect(ledger.oracle).toBe("ground-truth:false");
    expect(faultLedgerRow(grade(result.state), fault, false, 0).oracle).not.toBe(
      "ground-truth:false",
    );
  });
  it("recovers after relaunch, fresh read and reapplication", () => {
    const broken = injectFault(ready(), { fault, version: 1, seed: 5 }).state;
    const read = relaunch(broken);
    const reapplied = read.rows.includes("archive Q1 invoices")
      ? deleteItem(read, "archive Q1 invoices")
      : read;
    const recovered = recoverSave(reapplied, 5);
    expect(validateSchema(recovered.event, traceEventSchema)).toEqual([]);
    expect(
      verifyPersistedState(todoStateOracle(), intent, initial, persistedFiles(recovered.state))
        .status,
    ).toBe("verified");
    expect(faultLedgerRow(grade(recovered.state), fault, true, 0).oracle).not.toBe(
      "ground-truth:false",
    );
  });
  it("refutes 200 seeded credulous trials", () => {
    for (let seed = 0; seed < 200; seed++) {
      const state = injectFault(ready(), { fault, version: 1, seed }).state;
      const result = grade(state);
      expect(result.verdict).not.toBe("verified");
      expect(faultLedgerRow(result, fault, true, seed).oracle).toBe("ground-truth:false");
    }
  });
  it("mutation audit: missing, extra and duplicate rows are refuted; control verifies", () => {
    const correct = recoverSave(ready(), 1).state;
    const mutations = [
      correct.rows.slice(1),
      [...correct.rows, "extra"],
      [...correct.rows, correct.rows[0]!],
    ];
    for (const rows of mutations) {
      const mutated = recoverSave({ ...correct, rows }, 1).state;
      expect(
        verifyPersistedState(todoStateOracle(), intent, initial, persistedFiles(mutated)).status,
      ).toBe("refuted");
    }
    expect(
      verifyPersistedState(todoStateOracle(), intent, initial, persistedFiles(correct)).status,
    ).toBe("verified");
  });
});

it("honest permission error and versioned scores", () => {
  const state = injectFault(ready(), {
    fault: "permission-denied",
    version: 2,
    seed: 1,
    reportError: true,
  }).state;
  expect(state.status).toContain("permission denied");
  expect(summarise([grade(state, 2)]).version.faultVersions).toEqual([2]);
});
