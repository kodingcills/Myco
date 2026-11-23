import { taskText } from "../tasks/task-text.ts";
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
  const transcript: Transcript = { actions: [], claims: [], deliveries: [] };
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
        const resultOfAction = await c1.execute(action);
        if (resultOfAction.verified !== undefined)
          deviations.push(`cua-action-${steps}-verified:${resultOfAction.verified}`);
        // The delivery mode is recorded for every action, because arm-003d
        // declares escalation as a run condition: a row produced with foreground
        // delivery is not the same measurement as one produced in background
        // (TIF-167).
        transcript.deliveries?.push({
          step: steps,
          mode: resultOfAction.deliveryMode,
          escalated: resultOfAction.escalated,
          outcome: resultOfAction.outcome,
        });
        // Only a routed refusal stops the trial: the delivery layer declined, so
        // nothing downstream can be learned from continuing. A stall does NOT
        // break here - the action was delivered, and stopping would silently
        // drop whatever the app actually did with it.
        if (resultOfAction.outcome === "routing-refused") {
          deviations.push("cua-action-refused");
          break;
        }
        if (resultOfAction.outcome === "delivered-stalled")
          deviations.push(`cua-action-${steps}-stalled`);
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
  const verdict = judge({ actions: [], claims: [], deliveries: [] }, prepared.driver, observation);
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
