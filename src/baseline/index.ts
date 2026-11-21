import type { Verdict, VerdictStatus } from "../core/verify.ts";

export type SubArm = "c1" | "c2";
export type Claim = "done" | "failure";
export interface Action {
  tool: string;
  arguments: unknown;
}
export interface Transcript {
  actions: Action[];
  claims: Claim[];
}
export interface DriverPrecondition {
  hostVersion: string;
  guestVersion: string;
  pipeReachable: boolean;
  sessionIdentityMatches: boolean;
}
export function driverReady(d: DriverPrecondition): boolean {
  return (
    d.hostVersion.length > 0 &&
    d.hostVersion === d.guestVersion &&
    d.pipeReachable &&
    d.sessionIdentityMatches
  );
}
export type Observation =
  | { kind: "persisted"; actual: string | number; expected: string | number }
  | { kind: "modified" | "dialog" | "driver-action" | "step-budget" | "unavailable" };
export function judge(
  _transcript: Transcript,
  driver: DriverPrecondition,
  observation: Observation,
): Verdict {
  if (!driverReady(driver)) return { status: "uncertain", reasons: ["driver-unreachable"] };
  switch (observation.kind) {
    case "persisted":
      return observation.actual === observation.expected
        ? { status: "verified", reasons: ["persisted-match"] }
        : { status: "refuted", reasons: ["persisted-mismatch"] };
    case "unavailable":
      return { status: "uncertain", reasons: ["unavailable"] };
    default:
      return { status: "refuted", reasons: [observation.kind] };
  }
}
const allowed = new Set(["get_window_state", "click", "type_text", "press_key", "scroll", "drag"]);
function hasToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasToken);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.entries(value).some(([k, v]) => k === "element_token" || hasToken(v))
  );
}
export type PurityResult =
  | { ok: true }
  | {
      ok: false;
      code: "element-token" | "tool-not-allowed" | "missing-coordinates";
      actionIndex: number;
    };
export function checkPurity(arm: SubArm, transcript: Transcript): PurityResult {
  if (arm === "c2") return { ok: true };
  if (hasToken(transcript))
    return {
      ok: false,
      code: "element-token",
      actionIndex: transcript.actions.findIndex(hasToken),
    };
  for (const [actionIndex, action] of transcript.actions.entries()) {
    if (!allowed.has(action.tool)) return { ok: false, code: "tool-not-allowed", actionIndex };
    if (
      action.tool !== "get_window_state" &&
      (!object(action.arguments) ||
        typeof action.arguments.x !== "number" ||
        !Number.isFinite(action.arguments.x) ||
        typeof action.arguments.y !== "number" ||
        !Number.isFinite(action.arguments.y))
    )
      return { ok: false, code: "missing-coordinates", actionIndex };
  }
  return { ok: true };
}
export interface BaselineRow {
  subArm: SubArm;
  index: number;
  params: { fixtureSeed: string; rowKey: string; column: string; newValue: string | number };
  cellRef: string;
  expected: string | number;
  previousValue: string | number;
  verdict: VerdictStatus;
  verdictReason: string;
  falseSuccess: boolean | null;
  audited: boolean;
  elapsedMs: number;
  steps: number;
  stepBudget: number;
  budgetExhausted: boolean;
  cost: number;
  modelCalls: number;
  tokens: { in: number; out: number };
  resetMs: number;
  acPower: boolean;
  caffeinate: boolean;
  screenshotSource: string;
  resumed: boolean;
  recoveryEvents: number;
  hostLoad: { loadAvg1: number };
  deviations: string[];
  driver: DriverPrecondition;
  transcript: Transcript;
}
export function rowKey(row: Pick<BaselineRow, "subArm" | "index">): string {
  return `${row.subArm}/${row.index}`;
}
const object = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const count = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const value = (x: unknown): x is string | number =>
  typeof x === "string" || (typeof x === "number" && Number.isFinite(x));
export function isBaselineRow(x: unknown): x is BaselineRow {
  if (
    !object(x) ||
    !object(x.params) ||
    !object(x.tokens) ||
    !object(x.hostLoad) ||
    !object(x.driver) ||
    !object(x.transcript)
  )
    return false;
  const p = x.params,
    d = x.driver,
    t = x.transcript;
  return (
    (x.subArm === "c1" || x.subArm === "c2") &&
    count(x.index) &&
    str(p.fixtureSeed) &&
    str(p.rowKey) &&
    str(p.column) &&
    value(p.newValue) &&
    str(x.cellRef) &&
    value(x.expected) &&
    value(x.previousValue) &&
    (x.verdict === "verified" || x.verdict === "refuted" || x.verdict === "uncertain") &&
    str(x.verdictReason) &&
    (typeof x.falseSuccess === "boolean" || x.falseSuccess === null) &&
    typeof x.audited === "boolean" &&
    count(x.elapsedMs) &&
    count(x.steps) &&
    count(x.stepBudget) &&
    x.stepBudget > 0 &&
    x.steps <= x.stepBudget &&
    typeof x.budgetExhausted === "boolean" &&
    x.budgetExhausted === (x.verdictReason === "step-budget") &&
    (!x.budgetExhausted || (x.steps === x.stepBudget && x.verdict === "refuted")) &&
    typeof x.cost === "number" &&
    Number.isFinite(x.cost) &&
    x.cost >= 0 &&
    count(x.modelCalls) &&
    count(x.tokens.in) &&
    count(x.tokens.out) &&
    count(x.resetMs) &&
    typeof x.acPower === "boolean" &&
    typeof x.caffeinate === "boolean" &&
    str(x.screenshotSource) &&
    typeof x.resumed === "boolean" &&
    count(x.recoveryEvents) &&
    typeof x.hostLoad.loadAvg1 === "number" &&
    Number.isFinite(x.hostLoad.loadAvg1) &&
    Array.isArray(x.deviations) &&
    x.deviations.every(str) &&
    str(d.hostVersion) &&
    str(d.guestVersion) &&
    typeof d.pipeReachable === "boolean" &&
    typeof d.sessionIdentityMatches === "boolean" &&
    Array.isArray(t.claims) &&
    t.claims.every((c: unknown) => c === "done" || c === "failure") &&
    Array.isArray(t.actions) &&
    t.actions.every((a: unknown) => object(a) && str(a.tool) && "arguments" in a)
  );
}
