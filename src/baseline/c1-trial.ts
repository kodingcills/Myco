import { taskText } from "../tasks/task-text.ts";
import { connectC1, type Mcp, pixelAction, record } from "./c1.ts";
import {
  type BaselineRow,
  type Claim,
  type DriverPrecondition,
  driverReady,
  falseSuccess,
  judge,
  type Observation,
  sumUsage,
  type Transcript,
} from "./index.ts";
import type { Planner } from "./planner.ts";

/**
 * Keys whose intent is "save the file" rather than a keystroke.
 *
 * Case-insensitive because the planner writes `Ctrl+s` (`planner.ts:82`) and the
 * grammar in `c1.ts:38` permits any case; matching only the lowercase form would
 * route some saves and not others.
 */
export function isSaveKey(key: unknown): boolean {
  return typeof key === "string" && key.toLowerCase().replace(/\s+/g, "") === "ctrl+s";
}

export const STEP_BUDGET = 30;
export const RESET_SNAPSHOT = "cua-c1-base";

export interface PreparedC1 {
  driver: DriverPrecondition;
  resetMs: number;
  acPower: boolean;
  caffeinate: boolean;
  loadAvg1: number;
  window: { pid: number; window_id: number };
  connect(): Promise<Mcp>;
  closeTransport(): Promise<void>;
  judge(): Promise<Observation>;
  audit(): Promise<boolean>;
  /**
   * Save the open document with the same semantics M1 uses, and report whether
   * it took.
   *
   * Deliberately one method rather than an agent handle: the trial must gain the
   * save CAPABILITY and not a general agent channel. M1's `ctrl+s` step does not
   * send a raw key combo - `calc-adapter.ts:429` routes it to a helper that
   * answers the "Non-standard file format" dialog a converted .xlsx raises on
   * first save. C1's raw `press_key` has no such handling, which is why
   * arm-003c's first and only save attempt came back `cua-action-refused`.
   *
   * Optional so a caller with no agent transport still typechecks; when absent
   * the trial records a deviation rather than silently sending the raw combo.
   */
  save?(): Promise<boolean>;
}

export async function runC1Trial(
  target: Pick<BaselineRow, "index" | "params" | "cellRef" | "expected" | "previousValue">,
  prepared: PreparedC1,
  planner: Planner,
): Promise<BaselineRow> {
  const started = performance.now();
  const transcript: Transcript = { actions: [], claims: [] };
  const calls: Awaited<ReturnType<Planner["act"]>>["calls"] = [];
  const deviations = ["reset:cua-c1-base", "step-budget-asymmetry"];
  let observation: Observation = { kind: "unavailable" };
  let steps = 0;
  if (driverReady(prepared.driver)) {
    try {
      const c1 = await connectC1(await prepared.connect(), prepared.window);
      // The canonical intent, shared with Myco's arm. Rendered once here and
      // recorded on the row so instruction parity is checkable by diffing two
      // fields rather than reading source.
      const instruction = taskText(target.params);
      while (steps < STEP_BUDGET) {
        const result = await planner.act(instruction, await c1.screenshot());
        calls.push(...result.calls);
        const decision = result.decision;
        if (!decision) {
          deviations.push("planner-no-action");
          break;
        }
        if (typeof decision === "string") {
          transcript.claims.push(decision satisfies Claim);
          break;
        }
        const action = pixelAction(decision);
        transcript.actions.push(action);
        steps++;
        // A save key is not a pixel action on this arm. M1 performs the save
        // through a helper that answers the format dialog; sending the raw combo
        // here would fail for a reason that has nothing to do with the model, so
        // it is routed to the same capability instead.
        if (action.tool === "press_key" && isSaveKey(record(action.arguments).key)) {
          if (!prepared.save) {
            deviations.push("cua-save-unavailable");
            break;
          }
          const saved = await prepared.save();
          if (!saved) {
            deviations.push("cua-save-failed");
            break;
          }
          continue;
        }
        const resultOfAction = await c1.execute(action);
        if (resultOfAction.verified !== undefined)
          deviations.push(`cua-action-${steps}-verified:${resultOfAction.verified}`);
        if (resultOfAction.refused) {
          deviations.push("cua-action-refused");
          break;
        }
      }
    } finally {
      try {
        await prepared.closeTransport();
      } catch {
        deviations.push("cua-close-failed");
      }
    }
    try {
      observation = await prepared.judge();
    } catch {
      deviations.push("independent-judge-unavailable");
    }
    if (steps === STEP_BUDGET && observation.kind !== "driver-action")
      observation = { kind: "step-budget" };
  }
  // The scorer receives only independent observations and the driver precondition.
  const verdict = judge({ actions: [], claims: [] }, prepared.driver, observation);
  let independentValuePresent: boolean | null = null;
  if (verdict.status === "verified") {
    try {
      independentValuePresent = await prepared.audit();
    } catch {
      deviations.push("independent-audit-unavailable");
    }
  }
  const usage = calls.map((call) => call.usage);
  const planners = [...new Set(calls.map((call) => call.model))];
  return {
    ...target,
    subArm: "c1",
    instruction: taskText(target.params),
    verdict: verdict.status,
    verdictReason: verdict.reasons[0] ?? "unavailable",
    transcript,
    usage,
    ...sumUsage(usage),
    steps,
    stepBudget: STEP_BUDGET,
    budgetExhausted: observation.kind === "step-budget",
    audited: independentValuePresent !== null,
    independentValuePresent,
    falseSuccess: falseSuccess(verdict.status, independentValuePresent),
    elapsedMs: Math.floor(performance.now() - started),
    resetMs: prepared.resetMs,
    acPower: prepared.acPower,
    caffeinate: prepared.caffeinate,
    hostLoad: { loadAvg1: prepared.loadAvg1 },
    screenshotSource: "cua-window",
    resumed: false,
    recoveryEvents: 0,
    driver: prepared.driver,
    deviations: [
      ...deviations,
      `planner:${planners.join("+") || "none"}`,
      ...(calls.some(
        ({ model, usage }) => model === "claude-sonnet-5-5" && usage.prompt === undefined,
      )
        ? ["cost-includes-unconfirmed-call-reservation"]
        : []),
    ],
  };
}
