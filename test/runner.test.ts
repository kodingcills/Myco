import { describe, expect, it } from "vitest";
import { StaleRefError } from "../src/core/adapter.ts";
import { type Program, predicate } from "../src/core/program.ts";
import { runProgram } from "../src/core/runner.ts";
import { findNode } from "../src/core/state.ts";
import { FakeSpreadsheetApp } from "../src/fake/app.ts";

function tmpFile(name: string): string {
  return `/tmp/myco-test-${name}-${process.pid}.csv`;
}

describe("runner", () => {
  it("aborts with a structured GuardFailure when a precondition fails", async () => {
    const app = new FakeSpreadsheetApp({ filePath: tmpFile("pre") });
    const cellFilled = predicate(
      "cell A1 non-empty",
      (s) => (findNode(s, "A1")?.value ?? "") !== "",
      (s) => `A1=${JSON.stringify(findNode(s, "A1")?.value)}`,
    );
    const program: Program = {
      name: "needs-filled-cell",
      steps: [
        {
          action: { kind: "setValue", ref: "A1", value: "x" },
          preconditions: [cellFilled],
          postconditions: [],
        },
      ],
    };
    const outcome = await runProgram(app, program);
    expect(outcome.completed).toBe(false);
    expect(outcome.guardFailure?.phase).toBe("precondition");
    expect(outcome.guardFailure?.predicateName).toBe("cell A1 non-empty");
    expect(outcome.guardFailure?.step).toBe(0);
    expect(typeof outcome.guardFailure?.observed).toBe("string");
    expect(outcome.steps).toHaveLength(0);
  });

  it("aborts when a postcondition fails", async () => {
    const app = new FakeSpreadsheetApp({ filePath: tmpFile("post") });
    const alwaysWrong = predicate(
      "always false",
      () => false,
      () => "nothing matters",
    );
    const program: Program = {
      name: "post-fails",
      steps: [
        {
          action: { kind: "setValue", ref: "B2", value: "y" },
          preconditions: [],
          postconditions: [alwaysWrong],
        },
      ],
    };
    const outcome = await runProgram(app, program);
    expect(outcome.completed).toBe(false);
    expect(outcome.guardFailure?.phase).toBe("postcondition");
    expect(outcome.guardFailure?.step).toBe(0);
    expect(outcome.steps).toHaveLength(1);
  });

  it("throws StaleRefError when acting on an out-of-grid ref", async () => {
    const app = new FakeSpreadsheetApp({ filePath: tmpFile("stale"), rows: 4, cols: 2 });
    await expect(app.act({ kind: "click", ref: "Z99" })).rejects.toBeInstanceOf(StaleRefError);
  });

  it("throws StaleRefError on non-existent UI element refs", async () => {
    const app = new FakeSpreadsheetApp({ filePath: tmpFile("stale2") });
    await expect(app.act({ kind: "click", ref: "btn:does-not-exist" })).rejects.toBeInstanceOf(
      StaleRefError,
    );
  });

  it("completes a happy path and records per-step state versions", async () => {
    const app = new FakeSpreadsheetApp({ filePath: tmpFile("happy") });
    const program: Program = {
      name: "set-and-save",
      steps: [
        {
          action: { kind: "setValue", ref: "C3", value: "done" },
          preconditions: [
            predicate(
              "C3 blank",
              (s) => findNode(s, "C3")?.value === "",
              (s) => `C3=${findNode(s, "C3")?.value}`,
            ),
          ],
          postconditions: [
            predicate(
              "C3 set",
              (s) => findNode(s, "C3")?.value === "done",
              (s) => `C3=${findNode(s, "C3")?.value}`,
            ),
          ],
        },
        {
          action: { kind: "keyPress", keys: "ctrl+s" },
          preconditions: [],
          postconditions: [
            predicate(
              "not dirty",
              (s) => !s.facts.dirty,
              () => "dirty flag",
            ),
          ],
        },
      ],
    };
    const outcome = await runProgram(app, program);
    expect(outcome.completed).toBe(true);
    expect(outcome.steps).toHaveLength(2);
    expect(outcome.steps[0]?.stateVersionAfter).toBeGreaterThan(
      outcome.steps[0]?.stateVersionBefore ?? 0,
    );
  });
});
