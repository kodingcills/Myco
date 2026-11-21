import { describe, expect, it } from "vitest";
import { checkPurity, driverReady, isBaselineRow, judge, rowKey, type BaselineRow, type Transcript } from "../../src/baseline/index.ts";

const driver = { hostVersion: "1", guestVersion: "1", pipeReachable: true, sessionIdentityMatches: true };
const transcript = (claims: Transcript["claims"]): Transcript => ({ actions: [], claims });
const row: BaselineRow = { subArm: "c1", index: 0, params: { fixtureSeed: "1", rowKey: "r", column: "c", newValue: "x" }, cellRef: "A1", expected: "x", previousValue: "y", verdict: "verified", verdictReason: "persisted-match", falseSuccess: false, audited: true, elapsedMs: 1, steps: 1, stepBudget: 30, modelCalls: 1, tokens: { in: 1, out: 1 }, resetMs: 1, acPower: true, caffeinate: true, screenshotSource: "agent-op", resumed: false, recoveryEvents: 0, hostLoad: { loadAvg1: 1 }, deviations: [], driver, transcript: transcript([]) };
describe("baseline", () => {
  // Guards against trusting the terminal claim instead of persisted state.
  it("scores both contradictory claims and exact values", () => {
    expect(judge(transcript(["done"]), driver, { kind: "persisted", actual: "wrong", expected: "right" }).status).toBe("refuted");
    expect(judge(transcript(["failure"]), driver, { kind: "persisted", actual: "right", expected: "right" }).status).toBe("verified");
    expect(judge(transcript([]), driver, { kind: "persisted", actual: "Hello", expected: "hello" }).status).toBe("refuted");
    expect(judge(transcript(["done", "failure"]), driver, { kind: "persisted", actual: "1.0", expected: 1 }).status).toBe("refuted");
  });
  // Guards against treating budget exhaustion or driver failures as ordinary observations.
  it("attributes budget and precondition failures", () => {
    expect(judge(transcript([]), driver, { kind: "step-budget" })).toEqual({ status: "refuted", reasons: ["step-budget"] });
    for (const bad of [{ ...driver, guestVersion: "2" }, { ...driver, pipeReachable: false }, { ...driver, sessionIdentityMatches: false }]) {
      expect(driverReady(bad)).toBe(false);
      expect(judge(transcript([]), bad, { kind: "step-budget" })).toEqual({ status: "uncertain", reasons: ["driver-unreachable"] });
    }
  });
  // Guards against nested token addressing and unapproved tools escaping the C1 guard.
  it("enforces C1 purity and exempts C2", () => {
    const t = { actions: [{ tool: "click", arguments: { nested: { element_token: "x" } } }], claims: [] };
    expect(checkPurity("c1", t)).toEqual({ ok: false, code: "element-token", actionIndex: 0 });
    expect(checkPurity("c2", t).ok).toBe(true);
    expect(checkPurity("c1", { actions: [{ tool: "unknown", arguments: {} }], claims: [] }).ok).toBe(false);
    expect(checkPurity("c1", transcript([])).ok).toBe(true);
  });
  // Guards required accounting and distinct sub-arm keys.
  it("validates rows and distinguishes arms", () => {
    expect(isBaselineRow(row)).toBe(true);
    expect(isBaselineRow({ ...row, stepBudget: 0 })).toBe(false);
    expect(isBaselineRow({ ...row, tokens: {} })).toBe(false);
    expect(rowKey(row)).not.toBe(rowKey({ ...row, subArm: "c2" }));
  });
});
