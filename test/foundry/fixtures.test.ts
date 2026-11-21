import { describe, expect, it } from "vitest";
import { verifyFixture } from "../../src/foundry/oracles/state.ts";
import { compositeVerdict, observeScreenClaims } from "../../src/foundry/screen.ts";
import {
  addItem,
  bootApp,
  deleteItem,
  persistedFiles,
  saveApp,
  visibleScreen,
} from "../../src/foundry/tasks/app-model.ts";
import {
  findTodoFixture,
  TODO_FIXTURE_SPECS,
  withExactInitialText,
} from "../../src/foundry/tasks/todo.ts";
import type { FixtureManifest, TaskIntent } from "../../src/foundry/types.ts";

function specFor(fixtureId: string) {
  const spec = TODO_FIXTURE_SPECS.find((candidate) => candidate.fixtureId === fixtureId);
  if (!spec) throw new Error(`fixture ${fixtureId} not found`);
  return spec;
}

function fixtureFor(fixtureId: string): FixtureManifest {
  const fixture = findTodoFixture(fixtureId);
  if (!fixture) throw new Error(`fixture ${fixtureId} not found`);
  return fixture;
}

/** The four intents the EF-001 tasks ask for, in a form the oracle accepts. */
const INTENTS: Record<string, TaskIntent> = {
  "ef-todo-silent-drop-v1": {
    kind: "todo.add-items",
    items: [
      "bug: login page crashes on save",
      "BUG: token expires too early",
      "update the release notes",
      "write the incident summary",
    ],
  },
  "ef-todo-stale-row-v1": {
    kind: "todo.rename-item",
    from: "Draft release notes",
    to: "Release notes for 2.4",
  },
  "ef-todo-wrong-value-v1": { kind: "todo.add-items", items: ["Release: review the Q3 metrics"] },
  "ef-todo-partial-write-v1": { kind: "todo.delete-items", items: ["archive Q1 invoices"] },
};

/** Drives the app as a competent agent would: do the work the prompt asks, then save. */
function performTask(fixtureId: string) {
  const spec = specFor(fixtureId);
  const intent = INTENTS[fixtureId]!;
  let state = bootApp(spec);
  switch (intent.kind) {
    case "todo.add-items":
      for (const item of intent.items) state = addItem(state, item);
      break;
    case "todo.rename-item":
      state = deleteItem(state, intent.from);
      state = addItem(state, intent.to);
      break;
    case "todo.delete-items":
      for (const item of intent.items) state = deleteItem(state, item);
      break;
    case "ledger.set-cell":
      throw new Error("not a todo intent");
  }
  return saveApp(spec, state);
}

describe("EF-001 fixtures", () => {
  it("ships one fixture per defect class", () => {
    const defects = TODO_FIXTURE_SPECS.map((spec) => spec.defect).sort();
    expect(defects).toEqual(["partial-write", "silent-drop", "stale-row", "wrong-value"]);
  });

  it("declares every trap string it will show, and shows it", () => {
    for (const spec of TODO_FIXTURE_SPECS) {
      const saved = performTask(spec.fixtureId);
      const screen = visibleScreen(saved);
      const missing = spec.screenClaimsToTrap.filter(
        (claim) => !screen.some((line) => line.includes(claim)),
      );
      expect(missing, `${spec.fixtureId} claims not on screen`).toEqual([]);
    }
  });

  it("persists an initial state that differs from the task's expected end state", () => {
    for (const spec of TODO_FIXTURE_SPECS) {
      const fixture = fixtureFor(spec.fixtureId);
      const initial = fixture.initialState;
      const verdict = verifyFixture(fixture, INTENTS[spec.fixtureId]!, {
        kind: "myco-todo",
        files:
          initial.kind === "myco-todo"
            ? { "store.json": initial.bytes, ...initial.companionFiles }
            : {},
      });
      expect(verdict.status, `${spec.fixtureId} starts already solved`).toBe("refuted");
      expect(verdict.checks.length).toBeGreaterThan(0);
    }
  });

  it("rebuilds byte-identically (a fixture is data, not a run)", () => {
    const first = fixtureFor("ef-todo-silent-drop-v1");
    const second = withExactInitialText(first).initialState;
    expect(new TextDecoder().decode(second.bytes)).toContain("buy milk");
    expect(
      new TextDecoder().decode(fixtureFor("ef-todo-silent-drop-v1").initialState.bytes),
    ).toContain("buy milk");
  });
});

describe("EF-001 trap: a GUI-trusting verifier fails, the state oracle refuses", () => {
  it("every fixture ends with the screen claiming an outcome the store does not hold", () => {
    for (const spec of TODO_FIXTURE_SPECS) {
      const saved = performTask(spec.fixtureId);
      const fixture = fixtureFor(spec.fixtureId);
      const stateVerdict = verifyFixture(fixture, INTENTS[spec.fixtureId]!, {
        kind: "myco-todo",
        files: persistedFiles(saved),
      });
      const claims = observeScreenClaims(fixture, {
        visibleText: visibleScreen(saved),
        reachable: true,
      });
      const verdict = compositeVerdict(stateVerdict.status, claims);

      // The credulous reading: the screen shows the work and the status bar says saved.
      expect(visibleScreen(saved)).toContain(`saved ${saved.listbox.length} item(s)`);
      // The independent reading refuses it.
      expect(stateVerdict.status, `${spec.fixtureId} was not refuted`).toBe("refuted");
      expect(verdict.trustedUiClaim, `${spec.fixtureId} did not record a trusted UI claim`).toBe(
        true,
      );
      expect(verdict.verdict).toBe("refuted");
    }
  });

  it("a screen-only verifier ACCEPTS the same runs the state oracle refutes", () => {
    // An executable credulous grader: success iff the screen shows the saved-N banner.
    const screenOnly = (text: string, n: number) => text.includes(`saved ${n} item(s)`);
    for (const spec of TODO_FIXTURE_SPECS) {
      const saved = performTask(spec.fixtureId);
      const fixture = fixtureFor(spec.fixtureId);
      const credulous = screenOnly(visibleScreen(saved).join("\n"), saved.listbox.length);
      const state = verifyFixture(fixture, INTENTS[spec.fixtureId]!, {
        kind: "myco-todo",
        files: persistedFiles(saved),
      });
      expect(credulous, `${spec.fixtureId}: screen-only grader should be fooled`).toBe(true);
      expect(state.status, spec.fixtureId).toBe("refuted");
    }
  });

  it("a run that does nothing is refuted and is never reported as a false success", () => {
    for (const spec of TODO_FIXTURE_SPECS) {
      const fixture = fixtureFor(spec.fixtureId);
      const untouched = bootApp(spec);
      const stateVerdict = verifyFixture(fixture, INTENTS[spec.fixtureId]!, {
        kind: "myco-todo",
        files: persistedFiles(untouched),
      });
      // An untouched screen can still carry seed text the fixture watches; what matters is
      // that the state oracle refuses and no agent claim of success exists to be believed.
      expect(stateVerdict.status).toBe("refuted");
      const claims = observeScreenClaims(fixture, {
        visibleText: visibleScreen(untouched),
        reachable: true,
      });
      const verdict = compositeVerdict(stateVerdict.status, claims);
      expect(verdict.verdict).toBe("refuted");
    }
  });
});
