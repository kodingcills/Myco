import { describe, expect, it } from "vitest";
import { ledgerRowSchema } from "../../schemas/ledger-row.ts";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { type Fault, injectFault, recoverSave, relaunch } from "../../src/foundry/faults/index.ts";
import { faultLedgerRow, scoreTrial, summarise } from "../../src/foundry/oracles/blind.ts";
import { todoStateOracle, verifyPersistedState } from "../../src/foundry/oracles/state.ts";
import {
  addItem,
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
    ).not.toBe("verified");
    if (fault !== "crash-mid-save")
      expect(visibleScreen(result.state)).toContain("saved 3 item(s)");
    else expect(visibleScreen(result.state)).toEqual([]);
    const ledger = faultLedgerRow(grade(result.state), fault, true, 0);
    expect(validateSchema(ledger, ledgerRowSchema)).toEqual([]);
    expect(ledger.oracle).toBe(
      fault === "interrupted-write" ? "ground-truth:uncertain" : "ground-truth:false",
    );
    expect(faultLedgerRow(grade(result.state), fault, false, 0).oracle).not.toBe(
      "ground-truth:false",
    );
  });
  it("recovers after relaunch, fresh read and reapplication", () => {
    const broken = injectFault(ready(), { fault, version: 1, seed: 5 }).state;
    let read: typeof broken;
    if (fault === "interrupted-write") {
      expect(() => relaunch(broken)).toThrow();
      // An unreadable document is rebuilt by re-entering the user's intended rows.
      read = { ...broken, rows: [], listbox: [], windowGone: false };
    } else {
      read = relaunch(broken);
      for (const row of [...read.rows]) read = deleteItem(read, row);
    }
    let reapplied = read;
    for (const row of ready().rows) reapplied = addItem(reapplied, row);
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
    const states = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const state = injectFault(ready(), { fault, version: 1, seed }).state;
      states.add(JSON.stringify(state.files));
      const result = grade(state);
      expect(result.verdict).not.toBe("verified");
      expect(faultLedgerRow(result, fault, true, seed).oracle).toBe(
        fault === "interrupted-write" ? "ground-truth:uncertain" : "ground-truth:false",
      );
    }
    if (fault !== "permission-denied") expect(states.size).toBeGreaterThan(1);
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

it("distinguishes each fault's persistence and screen behavior", () => {
  const baseline = ready();
  const states = faults.map(
    (fault) => injectFault(baseline, { fault, version: 1, seed: 42 }).state,
  );
  expect(new Set(states.map((state) => JSON.stringify(state.files))).size).toBe(5);
  const [stale, torn, partial, crashed, denied] = states;
  expect(relaunch(stale!).listbox).not.toEqual(stale!.listbox);
  expect(() => JSON.parse(torn!.files["store.json"]!)).toThrow();
  expect(partial!.files["store.json"]).toBe(baseline.files["store.json"]);
  expect(partial!.files["store.meta.json"]).not.toBe(baseline.files["store.meta.json"]);
  expect(crashed!.windowGone).toBe(true);
  expect(denied!.files).toEqual(baseline.files);
  const screenOnly = (text: string, n: number) => text.includes(`saved ${n} item(s)`);
  for (const state of states)
    expect(screenOnly(visibleScreen(state).join("\n"), state.listbox.length)).toBe(
      !state.windowGone,
    );
});

it("torn write is unreadable without companion metadata", () => {
  const state = ready();
  const { "store.meta.json": _meta, ...files } = state.files;
  const torn = injectFault(
    { ...state, files },
    { fault: "interrupted-write", version: 1, seed: 7 },
  );
  expect(
    verifyPersistedState(todoStateOracle(), intent, initial, persistedFiles(torn.state)).status,
  ).toBe("uncertain");
});

it("records honest permission refusal distinctly", () => {
  const state = injectFault(ready(), {
    fault: "permission-denied",
    version: 1,
    seed: 1,
    reportError: true,
  }).state;
  const result = scoreTrial({
    fixture,
    intent,
    actual: { kind: "myco-todo", files: persistedFiles(state) },
    screen: { visibleText: visibleScreen(state), reachable: true },
    trace: [],
    selfReport: { claimsSuccess: false, text: "permission denied" },
    faultVersion: 1,
  });
  expect(result.verdict).toBe("refuted");
  expect(result.falseSuccess).toBe(false);
  expect(grade(state).falseSuccess).toBe(true);
  const row = faultLedgerRow(result, "permission-denied", false, 1, true);
  expect(row.state).toBe("refusal");
  expect(row.refusalCode).toBe("permission-denied");
  expect(validateSchema(row, ledgerRowSchema)).toEqual([]);
});

it("rejects empty, mixed, or missing versions", () => {
  const result = grade(ready());
  expect(() => summarise([])).toThrow();
  for (const key of ["fixtureVersion", "oracleVersion", "faultVersion"] as const) {
    expect(() => summarise([result, { ...result, [key]: result[key] + 1 }])).toThrow();
    expect(() =>
      summarise([{ ...result, [key]: undefined } as unknown as typeof result]),
    ).toThrow();
  }
});

it("the companion-file mutation catches an items-only verifier", () => {
  const broken = injectFault(ready(), { fault: "partial-persistence", version: 1, seed: 1 }).state;
  const files = persistedFiles(broken);
  expect(verifyPersistedState(todoStateOracle(), intent, initial, files).status).toBe("refuted");
  if (initial.kind !== "myco-todo") throw new Error("wrong fixture");
  const withoutCompanion = { ...initial, companionFiles: {} };
  expect(
    verifyPersistedState(todoStateOracle(), intent, withoutCompanion, {
      "store.json": files["store.json"]!,
    }).status,
  ).toBe("verified");
});

it("audits class-specific blind spots against the real oracle", () => {
  const control = recoverSave(ready(), 1).state;
  const correctItems = control.files["store.json"]!;
  const itemsOnly = (files: Readonly<Record<string, string>>) => {
    try {
      const actual = JSON.parse(files["store.json"]!).items.map(
        (item: { text: string }) => item.text,
      );
      return JSON.stringify(actual) === JSON.stringify(ready().rows);
    } catch {
      return false;
    }
  };
  const metaOnly = (files: Readonly<Record<string, string>>) => {
    try {
      return JSON.parse(files["store.meta.json"]!).count === ready().rows.length;
    } catch {
      return false;
    }
  };
  const injected = (fault: Fault, seed: number) =>
    injectFault(ready(), { fault, version: 1, seed }).state.files;
  const crash = injected("crash-mid-save", 1);
  const stale = injected("stale-ui", 1);
  const cases = [
    {
      name: "stale companion",
      files: {
        ...stale,
        "store.json": correctItems,
        "store.meta.json": ready().files["store.meta.json"]!,
      },
      blind: itemsOnly,
      status: "refuted",
    },
    {
      name: "stale altered row",
      files: injected("stale-ui", 1),
      blind: metaOnly,
      status: "refuted",
    },
    {
      name: "torn items",
      files: {
        ...injected("interrupted-write", 1),
        "store.meta.json": control.files["store.meta.json"]!,
      },
      blind: metaOnly,
      status: "uncertain",
    },
    {
      name: "partial meta only (even)",
      files: injected("partial-persistence", 0),
      blind: metaOnly,
      status: "refuted",
    },
    {
      name: "partial items only (odd)",
      files: injected("partial-persistence", 1),
      blind: itemsOnly,
      status: "refuted",
    },
    {
      name: "crash stale meta",
      files: { ...crash, "store.json": correctItems },
      blind: itemsOnly,
      status: "refuted",
    },
    {
      name: "permission denied",
      files: {
        ...injected("permission-denied", 1),
        "store.meta.json": control.files["store.meta.json"]!,
      },
      blind: metaOnly,
      status: "refuted",
    },
  ];
  for (const seed of [2, 3]) {
    cases.push(
      {
        name: `stale altered row ${seed}`,
        files: injected("stale-ui", seed),
        blind: metaOnly,
        status: "refuted",
      },
      {
        name: `torn items ${seed}`,
        files: {
          ...injected("interrupted-write", seed),
          "store.meta.json": control.files["store.meta.json"]!,
        },
        blind: metaOnly,
        status: "uncertain",
      },
      {
        name: `partial ${seed}`,
        files: injected("partial-persistence", seed),
        blind: seed % 2 ? itemsOnly : metaOnly,
        status: "refuted",
      },
      {
        name: `crash stale meta ${seed}`,
        files: { ...injected("crash-mid-save", seed), "store.json": correctItems },
        blind: itemsOnly,
        status: "refuted",
      },
      {
        name: `permission denied ${seed}`,
        files: {
          ...injected("permission-denied", seed),
          "store.meta.json": control.files["store.meta.json"]!,
        },
        blind: metaOnly,
        status: "refuted",
      },
    );
  }
  for (const entry of cases) {
    expect(entry.blind(entry.files), entry.name).toBe(true);
    expect(
      verifyPersistedState(
        todoStateOracle(),
        intent,
        initial,
        persistedFiles({ ...control, files: entry.files }),
      ).status,
      entry.name,
    ).toBe(entry.status);
  }
  expect(
    verifyPersistedState(todoStateOracle(), intent, initial, persistedFiles(control)).status,
  ).toBe("verified");
});
