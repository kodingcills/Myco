import { connectC1, type Mcp, pixelAction } from "./c1.ts";
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
      const { rowKey, column, newValue } = target.params;
      const instruction = `Set the ${column} cell for record ${rowKey} to ${JSON.stringify(newValue)}.`;
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
