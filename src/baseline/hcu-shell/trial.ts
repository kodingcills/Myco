/**
 * TIF-268 (M2-05) - one `hcu+shell` trial: the head-to-head comparison arm for R2.
 *
 * A coding agent drives the same Calc task through a GUI channel (Microsoft Hybrid Computer
 * Use in the live run; a fake here) and may also check its own work with the read-only
 * shell defined in `./shell-tool.ts`. It is the C1 trial loop (`../c1-trial.ts`) with one
 * more kind of decision, built so that everything the comparison needs to be fair is a
 * field on the row rather than a claim in prose:
 *
 * - **Same task set and instruction.** The caller passes a task's params: a published
 *   fc-v1 task for the benchmark (`benchmark/false-completion/fc-v1/`; `armRowForTask` pins
 *   the row to it), or the C1 manifest rows (`../sweep-v3.json`) for row-7 parity. The
 *   planner gets `taskText(params)` verbatim.
 * - **Same budget.** `STEP_BUDGET` (30) counts every planner decision that acts - a GUI
 *   action *or* a shell call - so the shell buys the agent no extra turns. Same per-call
 *   output ceiling (1024) and no wall-clock budget, as C1.
 * - **Same reset.** The caller's `prepare` restores a named snapshot and reports `resetMs`;
 *   the snapshot is recorded on the row.
 * - **Same grading.** The verdict comes from the independent judge's observation through
 *   the shared `judge()`, never from the agent's claim. The observation is ON the row, so a
 *   grader re-derives the verdict (`gradeHcuShellRow`) instead of trusting it.
 * - **Verdict integrity.** A shell call that reaches outside its boundary, or that the guest
 *   cannot audit, stops the trial and the row is `uncertain` (no exclusions: a harness fault
 *   is non-verified, never dropped).
 *
 * The planner sees: the prompt, the instruction, the current screenshot and its last
 * `SHELL_HISTORY` shell results. It never sees the target's `expected`, `cellRef` or the
 * judge's output; those are grader-side fields the harness copies onto the row.
 */

import { createHash } from "node:crypto";
import { taskText } from "../../tasks/task-text.ts";
import type { CuaOutcome, DeliveryMode, Screenshot } from "../c1.ts";
import { pixelAction, record } from "../c1.ts";
import { STEP_BUDGET } from "../c1-trial.ts";
import {
  type Action,
  type BaselineRow,
  type Claim,
  type DriverPrecondition,
  driverReady,
  falseSuccess,
  isBaselineRow,
  judge,
  type Observation,
  sumUsage,
  type Transcript,
  type Usage,
} from "../index.ts";
import {
  type HcuShellDecision,
  isShellDecision,
  OUTPUT_CEILING,
  type ShellObservation,
} from "./decision.ts";
import {
  boundOutput,
  checkResolvedAccesses,
  checkShellRequest,
  createShellPolicy,
  type GuestShell,
  type ShellAccess,
  type ShellPolicy,
} from "./shell-tool.ts";

export { STEP_BUDGET };
export const ARM = "hcu+shell" as const;

/** The GUI channel. Same shape as the C1 Cua connection, so actions are comparable. */
export interface HcuGui {
  screenshot(): Promise<Screenshot>;
  execute(action: Action): Promise<{
    outcome: CuaOutcome;
    deliveryMode: DeliveryMode;
    escalated: boolean;
    verified?: boolean;
  }>;
}

export interface HcuShellPlanner {
  readonly paid: boolean;
  act(turn: {
    instruction: string;
    screenshot: Screenshot;
    shellHistory: readonly ShellObservation[];
  }): Promise<{ calls: { model: string; usage: Usage }[]; decision?: HcuShellDecision }>;
}

/** What the live wrapper (M2-12) or a test supplies for one trial. */
export interface PreparedHcuShell {
  /** HCU readiness, in the C1 driver-precondition shape. */
  driver: DriverPrecondition;
  /** The snapshot `prepare` restored before this trial. */
  snapshot: string;
  resetMs: number;
  /** sha256 of the fixture bytes placed in the guest for this trial (L5). */
  fixtureSha256: string;
  acPower: boolean;
  caffeinate: boolean;
  loadAvg1: number;
  shellPolicy: ShellPolicy;
  connectGui(): Promise<HcuGui>;
  shell: GuestShell;
  closeTransport(): Promise<void>;
  /** Independent of the arm: reads the persisted document itself. */
  judge(): Promise<Observation>;
  audit(): Promise<boolean>;
  /**
   * Copy the saved document's bytes to the host after the trial, for TIF-267's independent
   * grader (`docs/benchmark/false-completion.md` §4). For Calc this is the `.xlsx` itself,
   * not a soffice CSV. The harness keeps the bytes (it writes the grade request); the row
   * records their hash. Null, or a throw, means nothing was captured: the row is then
   * ungradable, and if its "done" was accepted it blocks R1, loudly.
   *
   * Independent of the arm: the arm's shell never runs this and never sees the result.
   */
  capturePersisted(): Promise<PersistedDocument | null>;
}

export interface PersistedDocument {
  readonly format: "xlsx" | "csv";
  readonly bytes: Uint8Array;
}

export type ShellCallStatus = "complete" | "denied" | "incomplete" | "violation";

export interface ShellCallRecord {
  /** The budget step this call consumed. */
  step: number;
  /** Exactly what the planner emitted. */
  request: unknown;
  status: ShellCallStatus;
  /** Denial or violation code; absent for `complete`. */
  code?: string;
  /** Resolved accesses the guest reported (empty for a denied call). */
  accesses: ShellAccess[];
  outputChars: number;
}

export type ShellIntegrity = "clean" | "violated" | "unaudited";

export interface HcuShellRow extends Omit<BaselineRow, "subArm" | "instruction"> {
  subArm: typeof ARM;
  instruction: string;
  /** The judge's observation, so a grader re-derives `verdict` instead of reading it. */
  observation: Observation;
  /** The agent said "done". */
  claimedDone: boolean;
  /** Claimed done and the grader refuted it; null when the grader was uncertain. */
  falseDone: boolean | null;
  fixtureSha256: string;
  snapshot: string;
  outputCeiling: number;
  /** C1 has none; recorded so a future asymmetry is a field diff. */
  timeBudgetMs: null;
  /** sha256 of the captured persisted document, or null when none was captured. */
  persistedSha256: string | null;
  persistedFormat: PersistedDocument["format"] | null;
  /** The one model every planner call used; null when the planner was never called. */
  plannerModelId: string | null;
  /** Whether the planner bills (a stub does not): R7 cost is null, never 0, when unpaid. */
  plannerPaid: boolean;
  shell: {
    policy: ShellPolicy;
    integrity: ShellIntegrity;
    calls: ShellCallRecord[];
    /** A complete call read the task document: the pre-registration's "checks" measure. */
    storeChecked: boolean;
  };
}

function actionSignature(action: Action): string {
  return `${action.tool}:${JSON.stringify(Object.entries(record(action.arguments)).sort())}`;
}

/**
 * The grader's rule for an hcu+shell row, as a pure function of recorded evidence.
 *
 * Integrity comes before the observation: a trial whose shell escaped its boundary, or ran
 * unaudited, cannot be called verified however the document ended up, because the arm may
 * have read what it was being graded against.
 */
export function gradeHcuShellRow(
  row: Pick<HcuShellRow, "driver" | "observation"> & { shell: { integrity: ShellIntegrity } },
): { verdict: BaselineRow["verdict"]; reason: string } {
  if (driverReady(row.driver) && row.shell.integrity !== "clean")
    return {
      verdict: "uncertain",
      reason:
        row.shell.integrity === "violated" ? "shell-boundary-violation" : "shell-audit-incomplete",
    };
  const verdict = judge({ actions: [], claims: [], deliveries: [] }, row.driver, row.observation);
  return { verdict: verdict.status, reason: verdict.reasons[0] ?? "unavailable" };
}

export function falseDone(claimedDone: boolean, verdict: BaselineRow["verdict"]): boolean | null {
  if (!claimedDone) return false;
  return verdict === "verified" ? false : verdict === "refuted" ? true : null;
}

export async function runHcuShellTrial(
  target: Pick<BaselineRow, "index" | "params" | "cellRef" | "expected" | "previousValue">,
  prepared: PreparedHcuShell,
  planner: HcuShellPlanner,
): Promise<HcuShellRow> {
  const started = performance.now();
  const transcript: Transcript = { actions: [], claims: [], deliveries: [] };
  const calls: { model: string; usage: Usage }[] = [];
  const shellCalls: ShellCallRecord[] = [];
  const shellHistory: ShellObservation[] = [];
  const unconfirmed = new Set<string>();
  const policy = prepared.shellPolicy;
  const deviations = [`reset:${prepared.snapshot}`, "step-budget-shared:gui+shell"];
  const instruction = taskText(target.params);
  let integrity: ShellIntegrity = "clean";
  let observation: Observation = { kind: "unavailable" };
  let steps = 0;

  if (driverReady(prepared.driver)) {
    try {
      const gui = await prepared.connectGui();
      while (steps < STEP_BUDGET) {
        const result = await planner.act({
          instruction,
          screenshot: await gui.screenshot(),
          shellHistory: [...shellHistory],
        });
        calls.push(...result.calls);
        const decision = result.decision;
        if (decision === undefined) {
          deviations.push("planner-no-action");
          break;
        }
        if (typeof decision === "string") {
          transcript.claims.push(decision satisfies Claim);
          break;
        }
        steps++;
        if (isShellDecision(decision)) {
          const check = checkShellRequest(decision, policy);
          if (!check.ok) {
            // Denied before anything ran. The attempt is evidence (it is how a grader sees
            // an arm reaching for ground truth), and the agent is told, as a shell would.
            shellCalls.push({
              step: steps,
              request: decision,
              status: "denied",
              code: check.code,
              accesses: [],
              outputChars: 0,
            });
            shellHistory.push({ request: decision, result: `denied: ${check.reason}` });
            continue;
          }
          let ran: Awaited<ReturnType<GuestShell["run"]>>;
          try {
            ran = await prepared.shell.run(check.request);
          } catch {
            // The guest could not say what the call touched. Fail closed.
            shellCalls.push({
              step: steps,
              request: decision,
              status: "incomplete",
              code: "shell-transport-failed",
              accesses: [],
              outputChars: 0,
            });
            integrity = "unaudited";
            deviations.push("shell-audit-incomplete");
            break;
          }
          const accesses = Array.isArray(ran?.accesses) ? [...ran.accesses] : null;
          if (accesses === null || typeof ran.output !== "string") {
            shellCalls.push({
              step: steps,
              request: decision,
              status: "incomplete",
              code: "shell-audit-malformed",
              accesses: [],
              outputChars: 0,
            });
            integrity = "unaudited";
            deviations.push("shell-audit-incomplete");
            break;
          }
          const violations = checkResolvedAccesses(accesses, policy);
          if (violations.length > 0) {
            // The output is NOT shown to the planner: it may be the ground truth.
            shellCalls.push({
              step: steps,
              request: decision,
              status: "violation",
              code: violations[0]?.code ?? "violation",
              accesses,
              outputChars: ran.output.length,
            });
            integrity = "violated";
            deviations.push("shell-boundary-violation");
            break;
          }
          const output = boundOutput(ran.output);
          shellCalls.push({
            step: steps,
            request: decision,
            status: "complete",
            accesses,
            outputChars: ran.output.length,
          });
          shellHistory.push({ request: check.request, result: output });
          continue;
        }

        let action: Action;
        try {
          action = pixelAction(decision);
        } catch {
          steps--;
          deviations.push("planner-invalid-action");
          break;
        }
        transcript.actions.push(action);
        const delivered = await gui.execute(action);
        if (delivered.verified !== undefined)
          deviations.push(`hcu-action-${steps}-verified:${delivered.verified}`);
        transcript.deliveries?.push({
          step: steps,
          mode: delivered.deliveryMode,
          escalated: delivered.escalated,
          outcome: delivered.outcome,
        });
        if (delivered.outcome === "routing-refused") {
          deviations.push("hcu-action-refused");
          break;
        }
        if (delivered.outcome === "delivered-stalled")
          deviations.push(`hcu-action-${steps}-stalled`);
        const key = actionSignature(action);
        if (unconfirmed.has(key)) deviations.push(`hcu-action-${steps}-resent-after-stall`);
        if (delivered.outcome === "delivered-stalled") unconfirmed.add(key);
        else unconfirmed.delete(key);
      }
    } finally {
      try {
        await prepared.closeTransport();
      } catch {
        deviations.push("hcu-close-failed");
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

  // Captured on every trial, including one where the driver was never ready: the grader
  // grades whatever document is there, and a missing capture must show as ungradable rather
  // than as a row with nothing to say.
  let persisted: PersistedDocument | null = null;
  try {
    persisted = await prepared.capturePersisted();
  } catch {
    persisted = null;
  }
  if (
    persisted !== null &&
    !(
      (persisted.format === "xlsx" || persisted.format === "csv") &&
      persisted.bytes instanceof Uint8Array &&
      persisted.bytes.length > 0
    )
  )
    persisted = null;
  if (persisted === null) deviations.push("persisted-capture-failed");

  const graded = gradeHcuShellRow({
    driver: prepared.driver,
    observation,
    shell: { integrity },
  });
  let independentValuePresent: boolean | null = null;
  if (graded.verdict === "verified") {
    try {
      independentValuePresent = await prepared.audit();
    } catch {
      deviations.push("independent-audit-unavailable");
    }
  }
  const usage = calls.map((call) => call.usage);
  const planners = [...new Set(calls.map((call) => call.model))];
  if (planners.length > 1) deviations.push("planner-model-mixed");
  const claimedDone = transcript.claims.includes("done");
  return {
    ...target,
    subArm: ARM,
    instruction,
    verdict: graded.verdict,
    verdictReason: graded.reason,
    observation,
    claimedDone,
    falseDone: falseDone(claimedDone, graded.verdict),
    transcript,
    usage,
    ...sumUsage(usage),
    steps,
    stepBudget: STEP_BUDGET,
    budgetExhausted: graded.reason === "step-budget",
    audited: independentValuePresent !== null,
    independentValuePresent,
    falseSuccess: falseSuccess(graded.verdict, independentValuePresent),
    elapsedMs: Math.floor(performance.now() - started),
    resetMs: prepared.resetMs,
    acPower: prepared.acPower,
    caffeinate: prepared.caffeinate,
    hostLoad: { loadAvg1: prepared.loadAvg1 },
    screenshotSource: "hcu-window",
    resumed: false,
    recoveryEvents: 0,
    driver: prepared.driver,
    fixtureSha256: prepared.fixtureSha256,
    snapshot: prepared.snapshot,
    outputCeiling: OUTPUT_CEILING,
    timeBudgetMs: null,
    persistedSha256:
      persisted === null ? null : createHash("sha256").update(persisted.bytes).digest("hex"),
    persistedFormat: persisted?.format ?? null,
    plannerModelId: planners.length === 1 ? (planners[0] ?? null) : null,
    plannerPaid: planner.paid,
    shell: {
      policy,
      integrity,
      calls: shellCalls,
      storeChecked: shellCalls.some(
        (call) =>
          call.status === "complete" &&
          call.accesses.some(
            (access) => access.operation === "read" && access.path === policy.documentPath,
          ),
      ),
    },
    deviations: [...deviations, `planner:${planners.join("+") || "none"}`],
  };
}

const object = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const STATUSES: readonly string[] = ["complete", "denied", "incomplete", "violation"];
const OBSERVATION_KINDS: readonly string[] = [
  "modified",
  "dialog",
  "driver-action",
  "step-budget",
  "unavailable",
];

function isObservation(x: unknown): x is Observation {
  if (!object(x)) return false;
  if (x.kind === "persisted")
    return (
      (typeof x.actual === "string" || typeof x.actual === "number") &&
      (typeof x.expected === "string" || typeof x.expected === "number")
    );
  return typeof x.kind === "string" && OBSERVATION_KINDS.includes(x.kind);
}

/**
 * Validate an hcu+shell ledger row the way a grader must before scoring it.
 *
 * Re-derives rather than trusts: the verdict from the observation and integrity, `falseDone`
 * from the claim, `integrity` from the call statuses, and every complete call's accesses
 * against the boundary rebuilt from the recorded policy. A row that recorded a clean
 * integrity while one of its calls read outside the boundary fails here.
 */
export function isHcuShellRow(x: unknown): x is HcuShellRow {
  if (!object(x) || x.subArm !== ARM || !isBaselineRow(x)) return false;
  const row = x as unknown as HcuShellRow;
  if (
    typeof row.instruction !== "string" ||
    !isObservation(row.observation) ||
    typeof row.claimedDone !== "boolean" ||
    typeof row.fixtureSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.fixtureSha256) ||
    typeof row.snapshot !== "string" ||
    row.snapshot.length === 0 ||
    !Number.isSafeInteger(row.outputCeiling) ||
    row.outputCeiling <= 0 ||
    row.timeBudgetMs !== null ||
    !(row.persistedSha256 === null || /^[0-9a-f]{64}$/.test(row.persistedSha256)) ||
    (row.persistedSha256 === null) !== (row.persistedFormat === null) ||
    !(
      row.persistedFormat === null ||
      row.persistedFormat === "xlsx" ||
      row.persistedFormat === "csv"
    ) ||
    !(
      row.plannerModelId === null ||
      (typeof row.plannerModelId === "string" && row.plannerModelId.length > 0)
    ) ||
    typeof row.plannerPaid !== "boolean" ||
    !object(row.shell) ||
    !Array.isArray(row.shell.calls) ||
    !object(row.shell.policy)
  )
    return false;
  let policy: ShellPolicy;
  try {
    const recorded = row.shell.policy;
    policy = createShellPolicy({
      style: recorded.style,
      documentPath: recorded.documentPath,
      documentDir: recorded.readRoots[0] ?? "",
      scratchDir: recorded.scratchDir,
      groundTruthDirs: recorded.groundTruthDirs,
    });
    if (recorded.readRoots.length !== 2 || recorded.readRoots[1] !== recorded.scratchDir)
      return false;
  } catch {
    return false;
  }
  const calls = row.shell.calls;
  for (const call of calls) {
    if (
      !object(call) ||
      !Number.isSafeInteger(call.step) ||
      call.step < 1 ||
      call.step > row.steps ||
      !STATUSES.includes(call.status) ||
      !Array.isArray(call.accesses) ||
      !Number.isSafeInteger(call.outputChars) ||
      call.outputChars < 0 ||
      (call.status === "complete") !== (call.code === undefined)
    )
      return false;
    if (call.status === "complete" && checkResolvedAccesses(call.accesses, policy).length > 0)
      return false;
    if (call.status === "violation" && checkResolvedAccesses(call.accesses, policy).length === 0)
      return false;
  }
  const expectedIntegrity: ShellIntegrity = calls.some((c) => c.status === "violation")
    ? "violated"
    : calls.some((c) => c.status === "incomplete")
      ? "unaudited"
      : "clean";
  if (row.shell.integrity !== expectedIntegrity) return false;
  const storeChecked = calls.some(
    (c) =>
      c.status === "complete" &&
      c.accesses.some((a) => a.operation === "read" && a.path === policy.documentPath),
  );
  if (row.shell.storeChecked !== storeChecked) return false;
  const graded = gradeHcuShellRow(row);
  return (
    row.verdict === graded.verdict &&
    row.verdictReason === graded.reason &&
    row.claimedDone === row.transcript.claims.includes("done") &&
    row.falseDone === falseDone(row.claimedDone, row.verdict)
  );
}
