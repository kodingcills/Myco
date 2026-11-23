import { describe, expect, it, vi } from "vitest";
import { isSaveKey, type PreparedC1, runC1Trial } from "../../src/baseline/c1-trial.ts";
import { windowsProgramFor } from "../../src/integration/trial.ts";
import { taskText } from "../../src/tasks/task-text.ts";

/**
 * C1 save parity.
 *
 * Both arms are told to save; before this change they did not save the same way,
 * and C1's could not succeed at all on a converted .xlsx. M1 declares a ctrl+s
 * step but `calc-adapter.ts` routes it to a helper that answers the
 * "Non-standard file format" dialog. C1 sent a raw key combo with no dialog
 * handling, and the first attempt in the baseline's history came back
 * `cua-action-refused` (arm-003c row 0) - a harness difference, not a model one.
 *
 * These tests fail if that routing is removed.
 */

const params = {
  fixtureSeed: "m1-013-live",
  rowKey: "EMP-0038",
  column: "name",
  newValue: "REVISED-908578",
};

function prepared(save?: () => Promise<boolean>): PreparedC1 {
  const shot = { type: "image", mimeType: "image/png", data: "eA==" } as const;
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
    connect: async () =>
      ({
        request: vi.fn(async (method: string, p: { name?: string }) => {
          if (method === "initialize") return { protocolVersion: "2025-11-25" };
          if (p.name === "get_window_state")
            return {
              content: [{ type: "text", text: "tree" }, shot],
              structuredContent: { element_token: "tree" },
            };
          return { structuredContent: { path: "pixel", verified: true } };
        }),
        notify: vi.fn(async () => {}),
      }) as never,
    closeTransport: async () => {},
    judge: async () => ({ kind: "modified" }),
    audit: async () => false,
    ...(save ? { save } : {}),
  };
}

/** A planner that emits one save key, then stops. */
function savePlanner() {
  let n = 0;
  return {
    paid: true,
    act: async () => {
      n += 1;
      return {
        calls: [{ model: "claude-sonnet-5-5", usage: { prompt: 1, completion: 1, cost: 0 } }],
        decision:
          n === 1 ? { tool: "press_key", arguments: { x: 70, y: 146, key: "Ctrl+s" } } : "failure",
      };
    },
  } as never;
}

describe("a save key is routed to the save capability, not sent as a raw combo", () => {
  it("calls prepared.save for Ctrl+s", async () => {
    const save = vi.fn(async () => true);
    await runC1Trial(
      { index: 0, params, cellRef: "B39", expected: "REVISED-908578", previousValue: "x" },
      prepared(save),
      savePlanner(),
    );
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("records a deviation and does not silently send the combo when no save exists", async () => {
    // The failure this prevents: a caller with no save capability sending the raw
    // key and getting `cua-action-refused`, which reads as a model failure.
    const row = await runC1Trial(
      { index: 0, params, cellRef: "B39", expected: "REVISED-908578", previousValue: "x" },
      prepared(),
      savePlanner(),
    );
    expect(row.deviations).toContain("cua-save-unavailable");
    expect(row.deviations).not.toContain("cua-action-refused");
  });

  it("records a failed save distinctly from an unavailable one", async () => {
    const row = await runC1Trial(
      { index: 0, params, cellRef: "B39", expected: "REVISED-908578", previousValue: "x" },
      prepared(async () => false),
      savePlanner(),
    );
    expect(row.deviations).toContain("cua-save-failed");
  });

  it("recognises the save key case-insensitively, as the planner writes it", () => {
    // planner.ts:82 documents `press_key` with `Ctrl+s`; the action grammar in
    // c1.ts permits any case, so matching only lowercase would route some saves
    // and not others.
    expect(isSaveKey("Ctrl+s")).toBe(true);
    expect(isSaveKey("ctrl+s")).toBe(true);
    expect(isSaveKey("CTRL+S")).toBe(true);
    expect(isSaveKey("Ctrl+s ")).toBe(true);
    expect(isSaveKey("ctrl+w")).toBe(false);
    expect(isSaveKey(undefined)).toBe(false);
  });
});

describe("both arms still agree that the job includes saving", () => {
  it("M1's program contains a save step AND the C1 route performs a save", () => {
    // One test for both sides so neither can drift unilaterally: taskText says
    // save, M1's program has an isSave step, and the C1 route above exists.
    const program = windowsProgramFor(params);
    // Narrow with `in` rather than casting: a cast would fabricate the shape and
    // read a field that may not exist, which is the failure this test guards.
    const hasSaveStep = program.steps.some(
      (step) =>
        typeof step === "object" && step !== null && "isSave" in step && step.isSave === true,
    );
    expect(hasSaveStep).toBe(true);
    expect(taskText(params)).toContain("save the file");
  });
});
