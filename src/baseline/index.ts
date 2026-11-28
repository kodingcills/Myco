import type { Verdict, VerdictStatus } from "../core/verify.ts";

export type SubArm = "c1" | "c2";
export type BaselineEvidenceArm = SubArm | "hcu" | "hcu+shell"; // hcu+shell: TIF-268
export type Claim = "done" | "failure";
/** The transport outcomes TIF-167 distinguishes. Static lookup, so a Record. */
const DELIVERY_OUTCOMES: Record<string, true> = {
  "routing-refused": true,
  delivered: true,
  "delivered-stalled": true,
  "save-failed": true,
};

export interface Action {
  tool: string;
  arguments: unknown;
}
/**
 * How one action was delivered, and what became of it.
 *
 * Recorded per action rather than aggregated because arm-003d declares delivery
 * mode as a run condition (TIF-167): a row produced with foreground escalation
 * measures something different from one produced entirely in background, and a
 * count would hide which actions escalated.
 */
export interface ActionDelivery {
  step: number;
  mode: "background" | "foreground";
  /** True when background refused and the action was retried once in foreground. */
  escalated: boolean;
  outcome: "routing-refused" | "delivered" | "delivered-stalled" | "save-failed";
}
export interface Transcript {
  actions: Action[];
  claims: Claim[];
  /**
   * Delivery mode per action (TIF-167): which mode carried each action, and what
   * became of it.
   *
   * Optional because rows recorded before the field existed are still valid
   * evidence, and they must not be edited to satisfy a later rule. New
   * transcripts always carry it - `runC1Trial` initialises it - and the type
   * makes that a compile-time requirement for anyone building one.
   */
  deliveries?: ActionDelivery[];
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
  /**
   * Set when the record predates instruction recording (TIF-104), so a C1 row
   * without `instruction` is a known gap rather than a silent omission.
   *
   * The rule `isBaselineRow` enforces: a C1 row must carry `instruction` OR
   * carry this marker. A row carrying both is accepted, but the pair is
   * contradictory - the marker asserts the field is absent - so writers should
   * set one or the other and never both. That keeps arm-002's 29 recorded rows
   * valid as evidence - they were produced before the field existed and their
   * absence is a documented fact, not a defect in the artifact - while making a
   * NEW row that forgets the instruction fail validation instead of shipping
   * unverifiable evidence. Requiring the field unconditionally was the
   * alternative and it would have silently invalidated all 29.
   */
  instructionUnrecorded?: true;
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
    (x.subArm === "c1" || x.subArm === "c2" || x.subArm === "hcu" || x.subArm === "hcu+shell") &&
    count(x.index) &&
    str(p.fixtureSeed) &&
    str(p.rowKey) &&
    str(p.column) &&
    value(p.newValue) &&
    str(x.cellRef) &&
    value(x.expected) &&
    value(x.previousValue) &&
    (x.verdict === "verified" || x.verdict === "refuted" || x.verdict === "uncertain") &&
    // TIF-128: a C1 row records the instruction it was given, or declares that it
    // predates the field. See `instructionUnrecorded` for why both are needed.
    // TIF-268: an hcu+shell row is new, so it has no pre-field exemption.
    (x.subArm !== "hcu+shell" || str(x.instruction)) &&
    (x.subArm !== "c1" ||
      // `str` already rejects "", so no separate length check is needed.
      str(x.instruction) ||
      (x.instruction === undefined && x.instructionUnrecorded === true)) &&
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
    t.actions.every((a: unknown) => object(a) && str(a.tool) && "arguments" in a) &&
    // TIF-167: delivery modes, WHEN RECORDED, must be well formed.
    //
    // Deliberately permissive about absence. An earlier version required the
    // field on every C1 row and used an `instructionUnrecorded`-style marker to
    // excuse the rows that predate it - which meant editing 34 committed trial
    // rows. That is not this change's call: TIF-104's marker covered adding a new
    // field to rows being written at the time, not retrofitting a validator onto
    // recorded evidence. The rows are the artifact; they do not change because a
    // later rule would prefer them to.
    //
    // So absence is accepted and malformation is not. That still catches the thing
    // worth catching - a writer emitting a delivery record nobody can interpret -
    // while leaving every recorded row byte-identical. The writer guarantee that
    // NEW rows carry the field lives where the writer is (c1-trial.ts initialises
    // `deliveries: []`), and the compile-time `Transcript` type enforces it for
    // anyone constructing a transcript in TypeScript.
    (t.deliveries === undefined ||
      (Array.isArray(t.deliveries) &&
        t.deliveries.every(
          (v: unknown) =>
            object(v) &&
            count(v.step) &&
            (v.mode === "background" || v.mode === "foreground") &&
            typeof v.escalated === "boolean" &&
            DELIVERY_OUTCOMES[v.outcome as string] === true,
        )))
  );
}
