import type { Verdict, VerdictStatus } from "../core/verify.ts";

export type SubArm = "c1" | "c2";
export type BaselineEvidenceArm = SubArm | "hcu";
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
  /**
   * The preflight's precise failure cause (`session-command-failed`,
   * `session-mismatch`, `pipe-unreachable`, `daemon-missing`, ...). Recorded so
   * a driver-unreachable verdict names *why*: without it, an arm that aborts on
   * a too-tight timeout and one that aborts on a genuinely dead driver produce
   * byte-identical artifacts, and neither is diagnosable from the row.
   */
  diagnostic?: string;
}
export function driverReady(d: DriverPrecondition): boolean {
  return (
    d.hostVersion.length > 0 &&
    d.hostVersion === d.guestVersion &&
    d.pipeReachable &&
    d.sessionIdentityMatches
  );
}
export function planActions(
  driver: DriverPrecondition,
  actions: Action[],
): { actions: Action[]; verdict: Verdict | null } {
  return driverReady(driver)
    ? { actions, verdict: null }
    : {
        actions: [],
        // Same reason shape as judge(): name the cause, not just the class.
        verdict: {
          status: "uncertain",
          reasons: ["driver-unreachable", ...(driver.diagnostic ? [driver.diagnostic] : [])],
        },
      };
}
export function falseSuccess(
  verdict: VerdictStatus,
  independentValuePresent: boolean | null,
): boolean | null {
  return verdict === "verified"
    ? independentValuePresent === null
      ? null
      : !independentValuePresent
    : false;
}
export function auditFalseSuccess(
  verdict: VerdictStatus,
  audit: () => boolean,
): { independentValuePresent: boolean | null; falseSuccess: boolean | null } {
  let independentValuePresent: boolean | null;
  try {
    independentValuePresent = audit();
  } catch {
    independentValuePresent = null;
  }
  return { independentValuePresent, falseSuccess: falseSuccess(verdict, independentValuePresent) };
}
export interface Usage {
  prompt?: number;
  completion?: number;
  cost?: number;
}
export function sumUsage(usage: Usage[]): {
  cost: number;
  tokens: { in: number; out: number };
  modelCalls: number;
} {
  return usage.reduce<{ cost: number; tokens: { in: number; out: number }; modelCalls: number }>(
    (total, call) => ({
      cost: total.cost + (call.cost ?? 0),
      tokens: {
        in: total.tokens.in + (call.prompt ?? 0),
        out: total.tokens.out + (call.completion ?? 0),
      },
      modelCalls: total.modelCalls + 1,
    }),
    { cost: 0, tokens: { in: 0, out: 0 }, modelCalls: 0 },
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
  if (!driverReady(driver))
    return {
      status: "uncertain",
      reasons: ["driver-unreachable", ...(driver.diagnostic ? [driver.diagnostic] : [])],
    };
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
  subArm: BaselineEvidenceArm;
  index: number;
  /**
   * The exact text the planner was given for this trial. Recorded so the two
   * arms' instruction parity is a field diff, not a source-reading exercise.
   * See docs/research/experiments/c1-parity.md for why that mattered.
   */
  instruction?: string;
  /** Narrowed to match Myco's `CalcRecordEditParams`: a numeric value here would
   *  render `to 9733,` while Myco's identical intent renders `to "9733",`, which is
   *  an input-shape divergence in a task-text comparison (TIF-104). */
  params: { fixtureSeed: string; rowKey: string; column: string; newValue: string };
  cellRef: string;
  expected: string | number;
  previousValue: string | number;
  verdict: VerdictStatus;
  verdictReason: string;
  falseSuccess: boolean | null;
  audited: boolean;
  independentValuePresent: boolean | null;
  usage: Usage[];
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
    (x.subArm === "c1" || x.subArm === "c2" || x.subArm === "hcu") &&
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
    (typeof x.independentValuePresent === "boolean" || x.independentValuePresent === null) &&
    x.audited === (x.independentValuePresent !== null) &&
    x.falseSuccess === falseSuccess(x.verdict, x.independentValuePresent) &&
    Array.isArray(x.usage) &&
    x.usage.every(
      (u: unknown) =>
        object(u) &&
        (u.prompt === undefined || count(u.prompt)) &&
        (u.completion === undefined || count(u.completion)) &&
        (u.cost === undefined ||
          (typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0)),
    ) &&
    // Allow rounding error from floating-point summation, scaled for larger totals.
    typeof x.cost === "number" &&
    Number.isFinite(x.cost) &&
    x.cost >= 0 &&
    Number.isFinite(sumUsage(x.usage).cost) &&
    Math.abs(x.cost - sumUsage(x.usage).cost) <=
      1e-9 * (1 + Math.max(x.cost, sumUsage(x.usage).cost)) &&
    x.modelCalls === sumUsage(x.usage).modelCalls &&
    x.tokens.in === sumUsage(x.usage).tokens.in &&
    x.tokens.out === sumUsage(x.usage).tokens.out &&
    count(x.elapsedMs) &&
    count(x.steps) &&
    count(x.stepBudget) &&
    x.stepBudget > 0 &&
    x.steps <= x.stepBudget &&
    typeof x.budgetExhausted === "boolean" &&
    (x.verdictReason !== "driver-action" || x.verdict === "refuted") &&
    (x.verdictReason !== "driver-action" || !x.budgetExhausted) &&
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
    x.screenshotSource !== "utm-host" &&
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
    (driverReady({
      hostVersion: d.hostVersion,
      guestVersion: d.guestVersion,
      pipeReachable: d.pipeReachable,
      sessionIdentityMatches: d.sessionIdentityMatches,
    }) ||
      (x.verdict === "uncertain" && x.verdictReason === "driver-unreachable")) &&
    Array.isArray(t.claims) &&
    t.claims.every((c: unknown) => c === "done" || c === "failure") &&
    Array.isArray(t.actions) &&
    t.actions.every((a: unknown) => object(a) && str(a.tool) && "arguments" in a)
  );
}
