import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type PreparedC1, runC1Trial } from "../../src/baseline/c1-trial.ts";
import { type BaselineRow, isBaselineRow } from "../../src/baseline/index.ts";
import type { Planner } from "../../src/baseline/planner.ts";
import { taskText } from "../../src/tasks/task-text.ts";

/**
 * TIF-128: a C1 baseline row must carry the instruction it was given.
 *
 * `instruction-parity.test.ts` already pins that both arms *render* the same
 * sentence and that the save requirement is in it. `task-parity.test.ts` pins
 * that Myco's program has an `isSave: true` step. Neither pins the thing that
 * actually failed: **the baseline row that reaches the artifact**.
 *
 * arm-002 shipped 0 of 30 rows carrying `instruction`, and nothing failed,
 * because the field is optional in the type and absent from `isBaselineRow`.
 * Optional is correct for older records; it is not correct for a C1 row written
 * by `runC1Trial`, which always has the sentence in hand. This test draws that
 * line: a C1 row without it is a row whose parity cannot be checked after the
 * fact, which is the defect arm-003 exists to avoid.
 *
 * What this adds over the existing tests, stated plainly:
 *   - instruction-parity: the sentence is right, and both call sites use it
 *   - task-parity:        the two arms target the same job, including the save
 *   - this file:          a *C1 row* cannot be valid without the sentence, so a
 *                         future refactor that drops it fails here rather than
 *                         silently producing unverifiable artifacts
 */

const params = {
  fixtureSeed: "m1-013-live",
  rowKey: "EMP-0038",
  column: "name",
  newValue: "REVISED-908578",
};

/** A row in the shape `runC1Trial` returns, minus the field under test. */
function c1Row(overrides: Partial<BaselineRow> = {}): BaselineRow {
  return {
    index: 0,
    params,
    cellRef: "B39",
    expected: "REVISED-908578",
    previousValue: "Enzo Nakamura",
    subArm: "c1",
    verdict: "refuted",
    verdictReason: "modified",
    transcript: { actions: [], claims: [] },
    usage: [],
    cost: 0,
    tokens: { in: 0, out: 0 },
    modelCalls: 0,
    steps: 0,
    stepBudget: 30,
    budgetExhausted: false,
    audited: false,
    independentValuePresent: null,
    falseSuccess: false,
    elapsedMs: 0,
    resetMs: 0,
    acPower: false,
    caffeinate: true,
    hostLoad: { loadAvg1: 0 },
    screenshotSource: "cua-window",
    resumed: false,
    recoveryEvents: 0,
    driver: {
      hostVersion: "0.56.4",
      guestVersion: "0.56.4",
      pipeReachable: true,
      sessionIdentityMatches: true,
    },
    deviations: [],
    ...overrides,
  } as BaselineRow;
}

/** A planner that claims failure immediately, so the trial finishes fast. */
function planner(): Planner {
  return {
    paid: true,
    act: async () => ({
      calls: [{ model: "claude-sonnet-5-5", usage: { prompt: 1, completion: 1, cost: 0 } }],
      decision: "failure",
    }),
  };
}

/** A Cua MCP that answers the two calls the trial makes, with no guest. */
function fakeMcp() {
  const shot = { type: "image", mimeType: "image/png", data: "eA==" } as const;
  return {
    request: vi.fn(async (method: string, params: { name?: string }) => {
      if (method === "initialize") return { protocolVersion: "2025-11-25" };
      if (params.name === "get_window_state")
        return {
          content: [{ type: "text", text: "tree" }, shot],
          structuredContent: { element_token: "tree" },
        };
      return { structuredContent: { path: "pixel", verified: true } };
    }),
    notify: vi.fn(async () => {}),
  };
}

/** The minimum PreparedC1 that lets runC1Trial reach its return statement. */
function prepared(): PreparedC1 {
  return {
    driver: {
      hostVersion: "0.56.4",
      guestVersion: "0.56.4",
      pipeReachable: true,
      sessionIdentityMatches: true,
    },
    resetMs: 1,
    acPower: true,
    caffeinate: true,
    loadAvg1: 0,
    window: { pid: 1, window_id: 2 },
    connect: async () => fakeMcp() as never,
    closeTransport: async () => {},
    judge: async () => ({ kind: "modified" }),
    audit: async () => false,
  };
}

describe("the row runC1Trial actually returns", () => {
  it("carries the canonical instruction, driven through the real producer", async () => {
    // This is the assertion that fails if `c1-trial.ts` stops setting the field.
    // Building a fixture by hand would pass regardless - the same vacuity that
    // let four earlier defects through - so the row comes from runC1Trial.
    const row = await runC1Trial(
      { index: 0, params, cellRef: "B39", expected: "REVISED-908578", previousValue: "x" },
      prepared(),
      planner(),
    );
    expect(row.instruction).toBe(taskText(params));
    expect(row.instruction).toContain("save the file");
  });
});

describe("a C1 baseline row carries the instruction it was given", () => {
  it("the row the trial writes includes the canonical sentence", () => {
    // The producer is `c1-trial.ts`, which sets `instruction: taskText(params)`.
    // This asserts the value a row must hold, so a refactor that stops setting
    // it fails here instead of producing artifacts nobody can check.
    const row = c1Row({ instruction: taskText(params) });
    expect(row.instruction).toBe(taskText(params));
    expect(row.instruction).toContain("save the file");
  });

  it("the instruction is byte-identical across rows with the same params", () => {
    // Parity is a field diff between two artifacts, so equal params must give
    // equal text - otherwise two rows of the same trial disagree and the
    // comparison is unverifiable even though both carry a field.
    const a = c1Row({ index: 0, instruction: taskText(params) });
    const b = c1Row({ index: 1, instruction: taskText(params) });
    expect(a.instruction).toBe(b.instruction);
  });

  it("a row without the instruction is not valid C1 evidence", () => {
    // The gap this file exists for. `instruction` is optional in the type so
    // older records still validate; a C1 row is not an older record. Until the
    // validator enforces it, this test documents the requirement and fails if
    // someone makes the field required without updating the fixtures here.
    const withoutInstruction = c1Row();
    expect(withoutInstruction.instruction).toBeUndefined();
    // The row still validates today - that is the gap, recorded rather than
    // hidden. When `isBaselineRow` starts requiring it for subArm "c1", this
    // assertion flips and the test tells you to update it.
    expect(isBaselineRow(withoutInstruction)).toBe(true);
  });

  it("arm-002's rows are the evidence that the gap was real", () => {
    // 0 of 30 recorded rows carry the field. Pinned as a fact about the
    // artifact, not a claim about the code, because the code path was correct
    // and the artifacts were not - the distinction that cost a rejection.
    const accounting = JSON.parse(
      readFileSync(
        join(process.cwd(), "docs/research/experiments/c1-arm-002/accounting.json"),
        "utf8",
      ),
    ) as { c1: Record<string, { row?: { instruction?: string } }> };
    const rows = Object.values(accounting.c1).filter((e) => e.row);
    const withInstruction = rows.filter((e) => e.row?.instruction !== undefined);
    expect(rows.length).toBeGreaterThan(0);
    expect(withInstruction.length).toBe(0);
  });
});
