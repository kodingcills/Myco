import type { AppAdapter } from "../core/adapter.ts";
import type { FaultContext, FaultInjector } from "../core/eval.ts";
import type { Verdict } from "../core/verify.ts";

/**
 * The four M1 corruption classes (ADR-0005).
 *
 * Trust boundary: injectors are harness-trusted code. The recorded schedule is
 * trusted absolutely — nothing cross-checks it against observed guest state. A
 * lying injector can desync ground truth from reality; that is accepted by
 * design, since injectors and ground truth share one author.
 */
export type FaultClass = "kill-app" | "invalid-target" | "delayed-save" | "focus-change";

/** What each fault class means for the intent — the per-class ground-truth rule. */
export const FAULT_CLASS_MEANING: Record<FaultClass, string> = {
  "kill-app":
    "app terminated mid-program; the save never dispatched or never persisted, so the intent is unsatisfiable unless the kill follows a completed save",
  "invalid-target":
    "intent references a nonexistent row/column or a stale ref; unsatisfiable by construction — any `verified` verdict is a false success",
  "delayed-save":
    "save deferred or silently dropped; the live document shows the edit but the persisted file never receives it within the trial (OpenAdapt 54/72 shape)",
  "focus-change":
    "focus stolen before the save; typed input lands elsewhere or is lost and the save precondition breaks",
};

/**
 * Where in the program a fault fires. A number is a program step index
 * (0-based, counted over dispatched actions); the save-relative points fire
 * immediately before/after the step marked `isSave` (detected as the save
 * action). `before-trial` covers setup-only faults.
 */
export type FaultPoint = number | "before-trial" | "before-save" | "after-save";

export function describeFaultPoint(at: FaultPoint): string {
  return typeof at === "number" ? `step-${at}` : at;
}

/** One armed fault, as recorded into the trial's fault schedule (ADR-0005). */
export interface FaultScheduleEntry {
  injector: string;
  faultClass: FaultClass;
  params: Record<string, unknown>;
  at: FaultPoint;
}

/** Host-side record of every fault armed for one trial. */
export interface FaultSchedule {
  trialIndex: number;
  entries: FaultScheduleEntry[];
}

export interface FaultCause {
  injector: string;
  faultClass: FaultClass;
  meaning: string;
}

/**
 * Ground truth computed on the host from the fault schedule alone — never from
 * guest state (ADR-0005). A fault breaks the intent unless it fires after the
 * save has completed, where the edit is already persisted.
 */
export interface GroundTruth {
  intentSatisfiable: boolean;
  causes: FaultCause[];
}

export function deriveGroundTruth(schedule: FaultSchedule): GroundTruth {
  const causes: FaultCause[] = [];
  let satisfiable = true;
  for (const entry of schedule.entries) {
    const breaksIntent =
      entry.faultClass === "invalid-target" ||
      entry.faultClass === "delayed-save" ||
      (entry.faultClass === "kill-app" && entry.at !== "after-save") ||
      (entry.faultClass === "focus-change" && entry.at !== "after-save");
    if (breaksIntent) satisfiable = false;
    causes.push({
      injector: entry.injector,
      faultClass: entry.faultClass,
      meaning: FAULT_CLASS_MEANING[entry.faultClass],
    });
  }
  return { intentSatisfiable: satisfiable, causes };
}

/** Result of `assertExpectation`: does the ground truth encode this class's rule? */
export interface ExpectationAssertion {
  holds: boolean;
  description: string;
}

export interface FireContext {
  stepIndex: number;
  isSave: boolean;
  /** The inner (real) adapter, before any fault decoration. */
  adapter: AppAdapter;
  killSwitch?: KillSwitch;
}

/**
 * ADR-0005 `FaultInjector` `{ name, arm, assertExpectation }` mapped onto the
 * harness hooks from src/core/eval.ts. `setup`/`fire` are the arm path:
 * `setup` runs before the program is built; `fire` runs at the fault point
 * (dispatched by `armFaults`' step-counting adapter decorator).
 */
export interface FaultInjectorV2 extends FaultInjector {
  readonly faultClass: FaultClass;
  readonly at: FaultPoint;
  readonly params: Record<string, unknown>;

  /** The entry this injector contributes to the trial's fault schedule. */
  scheduleEntry(): FaultScheduleEntry;

  /** Expresses what this fault class means for ground truth (ADR-0005). */
  assertExpectation(groundTruth: GroundTruth): ExpectationAssertion;

  setup?(ctx: FaultContext): void;
  fire?(fc: FireContext): void;
  cleanup?(adapter: AppAdapter): void;
}

/**
 * Seam for the Windows path: the real implementation calls the guest agent's
 * `kill` op. The fake implements it in-memory.
 */
export interface KillSwitch {
  kill(reason: string): void;
  readonly alive: boolean;
}

export class InMemoryKillSwitch implements KillSwitch {
  #alive = true;
  readonly killedFor: string[] = [];
  readonly #app: { crash(): void };

  constructor(app: { crash(): void }) {
    this.#app = app;
  }

  get alive(): boolean {
    return this.#alive;
  }

  kill(reason: string): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.killedFor.push(reason);
    this.#app.crash();
  }
}

/** A verdict of `verified` against ground truth that says the intent failed. */
export interface TrialAudit {
  groundTruth: GroundTruth;
  falseSuccess: boolean;
}

export function auditTrial(schedule: FaultSchedule, verdict: Verdict | undefined): TrialAudit {
  const groundTruth = deriveGroundTruth(schedule);
  return {
    groundTruth,
    falseSuccess: verdict?.status === "verified" && !groundTruth.intentSatisfiable,
  };
}
