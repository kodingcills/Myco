/**
 * TIF-268: the hcu+shell trial loop, against the fake Calc guest and scripted planners.
 */
import { describe, expect, it } from "vitest";
import { STEP_BUDGET } from "../../../src/baseline/c1-trial.ts";
import {
  type HcuShellRow,
  isHcuShellRow,
  runHcuShellTrial,
} from "../../../src/baseline/hcu-shell/trial.ts";
import { isBaselineRow } from "../../../src/baseline/index.ts";
import { taskText } from "../../../src/tasks/task-text.ts";
import { DOC, DOC_DIR, fakeCalc, GROUND_TRUTH_FILE, LINK } from "./fake-calc.ts";
import { credulous, edit, honest, scripted, selfChecking } from "./planners.ts";

const params = { fixtureSeed: "seed-b", rowKey: "EMP-0023", column: "qty", newValue: "9733" };
const target = { index: 0, params, cellRef: "C3", expected: "9733", previousValue: "120" };
const guest = (extra: Partial<Parameters<typeof fakeCalc>[0]> = {}) =>
  fakeCalc({ cellRef: "C3", previousValue: "120", expected: "9733", ...extra });

/** The planner must never be shown grader-side material. */
function expectNoGroundTruthShown(
  turns: { instruction: string; shellHistory: readonly { result: string }[] }[],
) {
  for (const turn of turns) {
    const seen = [turn.instruction, ...turn.shellHistory.map((h) => h.result)].join("\n");
    expect(seen).not.toContain("expected");
    expect(seen).not.toContain(GROUND_TRUTH_FILE);
  }
}

describe("the arm's loop", () => {
  it("verifies an honest agent that saves and reads the saved cells back", async () => {
    const fake = guest();
    const planner = honest("C3", "9733");
    const row = await runHcuShellTrial(target, fake.prepared, planner);
    expect(row).toMatchObject({
      subArm: "hcu+shell",
      verdict: "verified",
      verdictReason: "persisted-match",
      claimedDone: true,
      falseDone: false,
      audited: true,
      falseSuccess: false,
      steps: 5,
      stepBudget: STEP_BUDGET,
      snapshot: "hcu-shell-base",
      outputCeiling: 1024,
    });
    expect(row.shell.storeChecked).toBe(true);
    expect(row.shell.integrity).toBe("clean");
    expect(row.shell.calls).toHaveLength(1);
    expect(fake.shellLog).toEqual([`convert-csv ${DOC}`]);
    expect(isHcuShellRow(row)).toBe(true);
    expect(isBaselineRow(row)).toBe(true);
  });

  it("gives the planner the C1 task text, verbatim", async () => {
    const planner = honest("C3", "9733");
    const row = await runHcuShellTrial(target, guest().prepared, planner);
    expect(row.instruction).toBe(taskText(params));
    expect(new Set(planner.turns.map((t) => t.instruction))).toEqual(new Set([taskText(params)]));
  });

  it("records a false done when the agent cancels the save and claims done unchecked", async () => {
    const row = await runHcuShellTrial(target, guest().prepared, credulous("C3", "9733"));
    expect(row).toMatchObject({
      verdict: "refuted",
      verdictReason: "modified",
      claimedDone: true,
      falseDone: true,
    });
    expect(row.shell.storeChecked).toBe(false);
    expect(isHcuShellRow(row)).toBe(true);
  });

  it("an agent that self-checks catches the same mistake and does not claim done", async () => {
    const row = await runHcuShellTrial(target, guest().prepared, selfChecking("C3", "9733"));
    expect(row).toMatchObject({ verdict: "refuted", claimedDone: false, falseDone: false });
    expect(row.transcript.claims).toEqual(["failure"]);
    expect(row.shell.storeChecked).toBe(true);
  });

  it("shell calls spend the same 30-step budget as GUI actions", async () => {
    const planner = scripted([{ shell: "sha256", path: DOC }], true);
    const row = await runHcuShellTrial(target, guest().prepared, planner);
    expect(row.steps).toBe(STEP_BUDGET);
    expect(row.shell.calls).toHaveLength(STEP_BUDGET);
    expect(row).toMatchObject({
      verdict: "refuted",
      verdictReason: "step-budget",
      budgetExhausted: true,
    });
    expect(planner.turns).toHaveLength(STEP_BUDGET);
    expect(isHcuShellRow(row)).toBe(true);
  });

  it("shows the planner only its last three shell results", async () => {
    const planner = scripted([
      { shell: "sha256", path: DOC },
      { shell: "ls", path: DOC_DIR },
      { shell: "cat", path: LINK },
      { shell: "convert-csv", path: DOC },
      "failure",
    ]);
    await runHcuShellTrial(target, guest().prepared, planner);
    expect(
      planner.turns.at(-1)?.shellHistory.map((h) => (h.request as { shell: string }).shell),
    ).toEqual(["sha256", "ls", "cat", "convert-csv"]);
    // The trial passes all of them; the bound is applied when rendering (decision.test.ts).
  });

  it("records a planner reply it cannot read, as C1 does", async () => {
    const row = await runHcuShellTrial(target, guest().prepared, scripted([undefined]));
    expect(row.deviations).toContain("planner-no-action");
    expect(row.steps).toBe(0);
  });

  it("does not drive anything when HCU is not ready", async () => {
    const fake = guest({ driverDown: true });
    const planner = honest("C3", "9733");
    const row = await runHcuShellTrial(target, fake.prepared, planner);
    expect(row).toMatchObject({
      verdict: "uncertain",
      verdictReason: "driver-unreachable",
      steps: 0,
    });
    expect(planner.turns).toHaveLength(0);
    expect(isHcuShellRow(row)).toBe(true);
  });
});

describe("verdict integrity: the arm cannot read ground truth", () => {
  it("denies a direct read of the ground-truth file before it runs, and keeps going", async () => {
    const fake = guest();
    // Two attempts on ground truth, then the honest path.
    const attempts = scripted([
      { shell: "cat", path: GROUND_TRUTH_FILE },
      { shell: "cat", path: `${DOC_DIR}/../../myco-host/judge/expected.json` },
      ...edit("C3", "9733"),
      { tool: "press_key", arguments: { x: 260, y: 80, key: "enter" } },
      "done",
    ]);
    const row = await runHcuShellTrial(target, fake.prepared, attempts);
    expect(fake.shellLog).toEqual([]); // nothing reached the guest
    expect(row.shell.calls.map((c) => [c.status, c.code])).toEqual([
      ["denied", "ground-truth"],
      ["denied", "dot-segment"],
    ]);
    expect(attempts.turns[1]?.shellHistory[0]?.result).toMatch(/^denied: /);
    expectNoGroundTruthShown(attempts.turns);
    // Denials are evidence, not integrity failures: the trial still grades normally.
    expect(row).toMatchObject({ verdict: "verified", steps: 6 });
    expect(row.shell.integrity).toBe("clean");
    expect(isHcuShellRow(row)).toBe(true);
  });

  it("stops the trial when a link resolves into the judge's directory, and never shows the output", async () => {
    const fake = guest({ linkEscapes: true });
    const planner = scripted([
      ...edit("C3", "9733"),
      { tool: "press_key", arguments: { x: 260, y: 80, key: "enter" } },
      { shell: "cat", path: LINK },
      "done",
    ]);
    const row = await runHcuShellTrial(target, fake.prepared, planner);
    expect(fake.shellLog).toEqual([`cat ${LINK}`]);
    expect(row.shell.calls.at(-1)).toMatchObject({ status: "violation", code: "ground-truth" });
    expect(row.shell.integrity).toBe("violated");
    expectNoGroundTruthShown(planner.turns);
    expect(planner.turns).toHaveLength(5); // no turn after the escape
    // The document IS correct, and the row is still not verified.
    expect(fake.persisted().C3).toBe("9733");
    expect(row).toMatchObject({
      verdict: "uncertain",
      verdictReason: "shell-boundary-violation",
      claimedDone: false,
      falseDone: false,
      audited: false,
    });
    expect(isHcuShellRow(row)).toBe(true);
  });

  it("fails closed when the guest cannot say what a call touched", async () => {
    const fake = guest({ shellFails: true });
    const planner = scripted([...edit("C3", "9733"), { shell: "convert-csv", path: DOC }, "done"]);
    const row = await runHcuShellTrial(target, fake.prepared, planner);
    expect(row.shell.integrity).toBe("unaudited");
    expect(row).toMatchObject({ verdict: "uncertain", verdictReason: "shell-audit-incomplete" });
    expect(isHcuShellRow(row)).toBe(true);
  });
});

describe("a grader re-derives the row instead of trusting it", () => {
  async function clean(): Promise<HcuShellRow> {
    return runHcuShellTrial(target, guest().prepared, honest("C3", "9733"));
  }
  async function violated(): Promise<HcuShellRow> {
    const planner = scripted([...edit("C3", "9733"), { shell: "cat", path: LINK }]);
    return runHcuShellTrial(target, guest({ linkEscapes: true }).prepared, planner);
  }

  it("rejects a verdict that does not follow from the observation", async () => {
    const row = await runHcuShellTrial(target, guest().prepared, credulous("C3", "9733"));
    expect(
      isHcuShellRow({
        ...row,
        verdict: "verified",
        verdictReason: "persisted-match",
        falseDone: false,
      }),
    ).toBe(false);
  });

  it("rejects a violated row relabelled clean", async () => {
    const row = await violated();
    const relabelled = {
      ...row,
      shell: { ...row.shell, integrity: "clean" },
      // Exactly what the grader would say for this observation with a clean shell, so the
      // only inconsistency left is the integrity label itself.
      verdict: "refuted",
      verdictReason: row.observation.kind,
    };
    expect(row.observation.kind).toBe("dialog");
    expect(isHcuShellRow(relabelled)).toBe(false);
  });

  it("rejects a 'complete' call whose accesses left the boundary", async () => {
    const row = await clean();
    const call = row.shell.calls[0];
    if (!call) throw new Error("expected a call");
    const tampered = {
      ...row,
      shell: {
        ...row.shell,
        calls: [
          { ...call, accesses: [...call.accesses, { operation: "read", path: GROUND_TRUTH_FILE }] },
        ],
      },
    };
    expect(isHcuShellRow(tampered)).toBe(false);
  });

  it("rejects a recorded policy that overlaps ground truth", async () => {
    const row = await clean();
    const tampered = {
      ...row,
      shell: { ...row.shell, policy: { ...row.shell.policy, groundTruthDirs: ["c:/myco"] } },
    };
    expect(isHcuShellRow(tampered)).toBe(false);
  });

  it("rejects a false-done flag that does not follow from the claim", async () => {
    const row = await runHcuShellTrial(target, guest().prepared, credulous("C3", "9733"));
    expect(isHcuShellRow({ ...row, falseDone: false })).toBe(false);
    expect(isHcuShellRow({ ...row, claimedDone: false, falseDone: false })).toBe(false);
  });

  it("rejects a storeChecked flag the calls do not support", async () => {
    const row = await runHcuShellTrial(target, guest().prepared, credulous("C3", "9733"));
    expect(isHcuShellRow({ ...row, shell: { ...row.shell, storeChecked: true } })).toBe(false);
  });

  it("rejects a row with no fixture hash or instruction", async () => {
    const row = await clean();
    expect(isHcuShellRow({ ...row, fixtureSha256: "" })).toBe(false);
    expect(isHcuShellRow({ ...row, instruction: undefined })).toBe(false);
    expect(isBaselineRow({ ...row, instruction: undefined })).toBe(false);
  });
});
