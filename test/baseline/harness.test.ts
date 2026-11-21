import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type BaselineRow,
  checkPurity,
  type DriverPrecondition,
  isBaselineRow,
  judge,
  type Observation,
  rowKey,
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
  // Guards against ignoring persisted evidence, driver preconditions, or budget attribution.
  it.each(names)("scores fixture %s", (name) => {
    const f = fixture(name);
    expect(judge(f.transcript, f.driver, f.observation).status).toBe(f.status);
    if (name === "iii-budget")
      expect(judge(f.transcript, f.driver, f.observation).reasons).toEqual(["step-budget"]);
    if (["modified", "dialog", "driver-action"].includes(name))
      expect(judge(f.transcript, f.driver, f.observation).reasons).toEqual([name]);
    if (name.startsWith("v-"))
      expect(judge(f.transcript, f.driver, f.observation).reasons).toEqual(["driver-unreachable"]);
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
      { audited: false, falseSuccess: false },
      { audited: false, falseSuccess: true },
      { acPower: false },
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
    expect(isBaselineRow({ ...row, audited: false, falseSuccess: null })).toBe(true);
    expect(
      isBaselineRow({
        ...row,
        audited: false,
        falseSuccess: null,
        verdict: "uncertain",
        verdictReason: "driver-unreachable",
        driver: { ...row.driver, sessionIdentityMatches: false },
      }),
    ).toBe(true);
    expect(rowKey(row)).not.toBe(rowKey({ ...row, subArm: "c2" }));
  });
});
