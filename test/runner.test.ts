import { describe, expect, it } from "vitest";
import { type StaleRefError, UnknownRefError } from "../src/core/adapter.ts";
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
          action: { kind: "setValue", ref: { nodeId: "A1" }, value: "x" },
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
          action: { kind: "setValue", ref: { nodeId: "B2" }, value: "y" },
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

  it("returns null from issueRef for a node outside the grid", async () => {
    const app = new FakeSpreadsheetApp({ filePath: tmpFile("stale"), rows: 4, cols: 2 });
    expect(app.issueRef("Z99")).toBeNull();
  });

  it("throws UnknownRefError on refs never issued by the app", async () => {
    const app = new FakeSpreadsheetApp({ filePath: tmpFile("stale2") });
    await expect(app.act({ kind: "click", ref: "btn:does-not-exist" })).rejects.toBeInstanceOf(
      UnknownRefError,
    );
  });

  it("completes a happy path and records per-step state versions", async () => {
    const app = new FakeSpreadsheetApp({ filePath: tmpFile("happy") });
    const program: Program = {
      name: "set-and-save",
      steps: [
        {
          action: { kind: "setValue", ref: { nodeId: "C3" }, value: "done" },
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

  it("StaleRefError carries both versions when acting on a ref from an older stateVersion", async () => {
    const app = new FakeSpreadsheetApp({ filePath: tmpFile("versioned") });
    const ref = app.issueRef("B2");
    expect(ref).toMatch(/^ref:\d+:B2$/);
    await app.act({ kind: "setValue", ref: app.issueRef("A1") as string, value: "bump version" });
    await expect(app.act({ kind: "click", ref: ref as string })).rejects.toMatchObject({
      name: "StaleRefError",
      ref: ref as string,
    });
    try {
      await app.act({ kind: "click", ref: ref as string });
      expect.unreachable("should throw StaleRefError");
    } catch (error) {
      const stale = error as InstanceType<typeof StaleRefError>;
      expect(stale.name).toBe("StaleRefError");
      expect(stale.refVersion).toBeLessThan(stale.currentVersion);
      expect(stale.ref).toBe(ref);
    }
  });

  it("a ref stays valid while the stateVersion is unchanged", async () => {
    const app = new FakeSpreadsheetApp({ filePath: tmpFile("stable") });
    const ref = app.issueRef("B2") as string;
    const result = await app.act({ kind: "click", ref });
    expect(result.outcome).toBe("delivered_verified");
  });

  it("preserves executed steps when the app dies mid-program", async () => {
    // A mid-program death must be distinguishable from a failed launch: the
    // evidence has to show which steps ran before the app became unobservable.
    // M1-011 recovery and the corrupted-trial audit both depend on it.
    const app = new FakeSpreadsheetApp({ filePath: tmpFile("middeath") });
    let observes = 0;
    const dying = {
      observe: async () => {
        observes += 1;
        // initial observe + step 0's post-act observe succeed; step 1's throws
        if (observes >= 3) throw new Error("app gone: RPC server unavailable");
        return app.observe();
      },
      act: (action: Parameters<typeof app.act>[0]) => app.act(action),
      capabilities: () => app.capabilities(),
      issueRef: (nodeId: string) => app.issueRef(nodeId),
    };
    const program: Program = {
      name: "two-clicks",
      steps: [
        {
          action: { kind: "click", ref: { nodeId: "A1" } },
          preconditions: [],
          postconditions: [],
        },
        {
          action: { kind: "click", ref: { nodeId: "B2" } },
          preconditions: [],
          postconditions: [],
        },
      ],
    };
    const outcome = await runProgram(dying, program);
    expect(outcome.completed).toBe(false);
    expect(outcome.guardFailure?.phase).toBe("postcondition");
    expect(outcome.guardFailure?.predicateName).toBe("observe-after-action");
    expect(outcome.guardFailure?.step).toBe(1);
    expect(outcome.guardFailure?.observed).toContain("RPC server unavailable");
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0]?.step).toBe(0);
  });
});
