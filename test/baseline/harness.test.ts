import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditFalseSuccess,
  type BaselineRow,
  checkPurity,
  type DriverPrecondition,
  falseSuccess,
  isBaselineRow,
  judge,
  type Observation,
  planActions,
  rowKey,
  sumUsage,
  type Transcript,
} from "../../src/baseline/index.ts";
import type { VerdictStatus } from "../../src/core/verify.ts";

type Fixture = {
  transcript: Transcript;
  driver: DriverPrecondition;
  observation: Observation;
  status: VerdictStatus;
};
function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Fixture;
}
const names = [
  "i-wrong-done",
  "i-right-failure",
  "ii-import-boundary",
  "iii-budget",
  "iv-purity",
  "v-version",
  "v-pipe",
  "v-session",
  "modified",
  "dialog",
  "driver-action",
  "unavailable-ready",
  "empty",
  "multiple",
  "case-flip",
  "numeric-format",
];
const base = fixture("empty");
const row: BaselineRow = {
  subArm: "c1",
  index: 0,
  params: { fixtureSeed: "1", rowKey: "r", column: "c", newValue: "x" },
  cellRef: "A1",
  expected: "x",
  previousValue: "y",
  verdict: "verified",
  verdictReason: "persisted-match",
  falseSuccess: false,
  audited: true,
  independentValuePresent: true,
  usage: [{ prompt: 1, completion: 1 }],
  elapsedMs: 1,
  steps: 1,
  stepBudget: 30,
  budgetExhausted: false,
  cost: 0,
  modelCalls: 1,
  tokens: { in: 1, out: 1 },
  resetMs: 1,
  acPower: true,
  caffeinate: true,
  screenshotSource: "agent-op",
  resumed: false,
  recoveryEvents: 0,
  hostLoad: { loadAvg1: 1 },
  deviations: [],
  driver: base.driver,
  transcript: base.transcript,
};
describe("baseline", () => {
  it.each([
    ["i-right-failure", "verified"],
    ["i-wrong-done", "refuted"],
    ["unavailable-ready", "uncertain"],
  ] as const)("accepts HCU evidence from the shared judge for %s", (name, status) => {
    const f = fixture(name);
    const verdict = judge(f.transcript, f.driver, f.observation);
    expect(verdict.status).toBe(status);
    const evidence: BaselineRow = {
      ...row,
      subArm: "hcu",
      driver: f.driver,
      transcript: f.transcript,
      verdict: verdict.status,
      verdictReason: verdict.reasons.join(", "),
    };
    expect(isBaselineRow(evidence)).toBe(true);
    expect(rowKey(evidence)).toBe("hcu/0");
    expect(isBaselineRow({ ...evidence, subArm: "hcu+shell" })).toBe(false);
  });

  // Guards against ignoring persisted evidence, driver preconditions, or budget attribution.
  it.each(names)("scores fixture %s", (name) => {
    const f = fixture(name);
    expect(judge(f.transcript, f.driver, f.observation).status).toBe(f.status);
    if (name === "iii-budget")
      expect(judge(f.transcript, f.driver, f.observation).reasons).toEqual(["step-budget"]);
    if (["modified", "dialog"].includes(name))
      expect(judge(f.transcript, f.driver, f.observation).reasons).toEqual([name]);
    if (name === "driver-action")
      expect(judge(f.transcript, f.driver, f.observation)).toEqual({
        status: "refuted",
        reasons: ["driver-action"],
      });
    if (name === "unavailable-ready")
      expect(judge(f.transcript, f.driver, f.observation)).toEqual({
        status: "uncertain",
        reasons: ["unavailable"],
      });
    if (name.startsWith("v-"))
      expect(judge(f.transcript, f.driver, f.observation).reasons).toEqual(["driver-unreachable"]);
  });
  it.each([
    ["row-driver-action", true],
    ["row-budget", true],
    ["row-driver-action-exhausted", false],
    ["row-driver-action-uncertain", false],
    ["row-budget-short", false],
    // Guards the budget row rule: step-budget exhaustion must be refuted, never uncertain or verified.
    ["row-budget-uncertain", false],
    ["row-budget-verified", false],
    ["row-driver-action-at-budget", true],
  ])("validates fixture %s", (name, valid) => {
    const patch: unknown = JSON.parse(
      readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
    );
    expect(isBaselineRow({ ...row, ...(patch as object) })).toBe(valid);
  });
  // Guards against permitting token addressing, unknown tools, and missing coordinates in C1.
  it("enforces purity and exempts C2", () => {
    const valid = fixture("iv-purity").transcript;
    expect(checkPurity("c1", valid)).toEqual({ ok: true });
    const token = {
      actions: [{ tool: "click", arguments: { nested: { element_token: "x" } } }],
      claims: [],
    };
    expect(checkPurity("c1", token)).toEqual({ ok: false, code: "element-token", actionIndex: 0 });
    expect(checkPurity("c2", token)).toEqual({ ok: true });
    expect(
      checkPurity("c1", { actions: [{ tool: "unknown", arguments: {} }], claims: [] }),
    ).toMatchObject({ code: "tool-not-allowed" });
    expect(
      checkPurity("c1", { actions: [{ tool: "click", arguments: { x: 1 } }], claims: [] }),
    ).toMatchObject({ code: "missing-coordinates" });
    const extraToken = { ...valid, extra: { element_token: "x" } };
    expect(checkPurity("c1", extraToken)).toMatchObject({
      code: "element-token",
    });
  });
  // Guards against invalid budget, cost, version, and colliding sub-arm keys.
  it("validates row semantics", () => {
    expect(isBaselineRow(row)).toBe(true);
    for (const bad of [
      { steps: 31 },
      { steps: -1 },
      { cost: -1 },
      { budgetExhausted: true },
      { verdictReason: "step-budget" },
      { driver: { ...row.driver, hostVersion: "" } },
      { subArm: "other" },
      // Guards the verdict enum check: an unknown verdict string must not validate.
      { verdict: "bogus" },
      { audited: false, falseSuccess: false },
      { audited: false, falseSuccess: true },
      { acPower: "no" },
      { screenshotSource: "utm-host" },
      { driver: { ...row.driver, guestVersion: "2" } },
      { driver: { ...row.driver, pipeReachable: false } },
      { driver: { ...row.driver, sessionIdentityMatches: false } },
    ])
      expect(isBaselineRow({ ...row, ...bad })).toBe(false);
    expect(
      isBaselineRow({
        ...row,
        steps: 30,
        budgetExhausted: true,
        verdict: "refuted",
        verdictReason: "step-budget",
      }),
    ).toBe(true);
    expect(
      isBaselineRow({ ...row, audited: false, independentValuePresent: null, falseSuccess: null }),
    ).toBe(true);
    // A battery row is VALID evidence: acPower is recorded, never enforced.
    // Without this, reverting the schema to `acPower === true` would silently
    // mark every battery row invalid and no test would notice.
    expect(isBaselineRow({ ...row, acPower: false })).toBe(true);
    expect(
      isBaselineRow({
        ...row,
        audited: false,
        independentValuePresent: null,
        falseSuccess: false,
        verdict: "uncertain",
        verdictReason: "driver-unreachable",
        driver: { ...row.driver, sessionIdentityMatches: false },
      }),
    ).toBe(true);
    expect(rowKey(row)).not.toBe(rowKey({ ...row, subArm: "c2" }));
  });
});

describe("accounting and preconditions", () => {
  it("derives false success and handles audit errors", () => {
    expect([true, false, null].map((v) => falseSuccess("verified", v))).toEqual([
      false,
      true,
      null,
    ]);
    expect(falseSuccess("refuted", null)).toBe(false);
    expect(falseSuccess("uncertain", false)).toBe(false);
    expect(
      auditFalseSuccess("verified", () => {
        throw new Error();
      }).falseSuccess,
    ).toBe(null);
    expect(isBaselineRow({ ...row, independentValuePresent: false })).toBe(false);
  });
  it("sums usage and validates totals", () => {
    expect(sumUsage([])).toEqual({ cost: 0, tokens: { in: 0, out: 0 }, modelCalls: 0 });
    expect(sumUsage([{ prompt: 2, cost: 1 }, { completion: 3 }, {}])).toEqual({
      cost: 1,
      tokens: { in: 2, out: 3 },
      modelCalls: 3,
    });
    expect(isBaselineRow({ ...row, modelCalls: 2 })).toBe(false);
  });
  it("rejects a wrong cost total", () =>
    expect(isBaselineRow({ ...row, cost: 0.001 })).toBe(false));
  it("rejects a wrong input token total", () =>
    expect(isBaselineRow({ ...row, tokens: { ...row.tokens, in: 2 } })).toBe(false));
  it("rejects a wrong output token total", () =>
    expect(isBaselineRow({ ...row, tokens: { ...row.tokens, out: 2 } })).toBe(false));
  it("accepts floating point summation rounding", () =>
    expect(
      isBaselineRow({
        ...row,
        usage: [{ prompt: 1, completion: 1, cost: 0.1 }, { cost: 0.2 }],
        modelCalls: 2,
        cost: 0.3,
      }),
    ).toBe(true));
  it("rejects nonfinite and negative costs", () => {
    for (const cost of [NaN, Infinity, -1]) expect(isBaselineRow({ ...row, cost })).toBe(false);
  });
  it("emits no actions when any driver precondition fails", () => {
    const actions = [{ tool: "click", arguments: { x: 1, y: 2 } }];
    for (const patch of [
      { guestVersion: "mismatch" },
      { hostVersion: "" },
      { pipeReachable: false },
      { sessionIdentityMatches: false },
    ]) {
      expect(planActions({ ...row.driver, ...patch }, actions)).toEqual({
        actions: [],
        verdict: { status: "uncertain", reasons: ["driver-unreachable"] },
      });
    }
    expect(planActions(row.driver, actions)).toEqual({ actions, verdict: null });
  });
});
