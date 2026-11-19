import type { FaultContext } from "../core/eval.ts";
import type {
  ExpectationAssertion,
  FaultClass,
  FaultInjectorV2,
  FaultPoint,
  GroundTruth,
  KillSwitch,
} from "./types.ts";
import { FAULT_CLASS_MEANING } from "./types.ts";

export type Severity = "mild" | "severe";

/** Shared scaffolding: name/class/point/params + the recorded schedule entry. */
abstract class TypedInjector implements FaultInjectorV2 {
  abstract readonly faultClass: FaultClass;
  abstract readonly at: FaultPoint;
  params: Record<string, unknown> = {};

  abstract get name(): string;

  scheduleEntry() {
    return {
      injector: this.name,
      faultClass: this.faultClass,
      params: { ...this.params },
      at: this.at,
    };
  }

  /**
   * Common per-class rule: unless the fault fired after a completed save (the
   * edit is then already persisted), the class's meaning demands the intent be
   * recorded unsatisfiable.
   */
  protected expectUnsatisfiable(
    groundTruth: GroundTruth,
    allowAfterSave: boolean,
  ): ExpectationAssertion {
    if (allowAfterSave && this.at === "after-save") {
      return {
        holds: true,
        description: `${this.faultClass} fired after-save: intent may still be satisfied`,
      };
    }
    return {
      holds: !groundTruth.intentSatisfiable,
      description: `${this.faultClass}: ${FAULT_CLASS_MEANING[this.faultClass]} — ground truth must record the intent as unsatisfiable (got ${groundTruth.intentSatisfiable ? "satisfiable" : "unsatisfiable"})`,
    };
  }

  abstract assertExpectation(groundTruth: GroundTruth): ExpectationAssertion;
}

export interface KillAppOptions {
  /** Program step index (0-based) at which the app dies. Default: before-save. */
  at?: FaultPoint;
  /** Kill seam; default in-memory against a fake-app `crash()`. */
  killSwitch?: KillSwitch;
}

/**
 * kill-app — terminate the app mid-program. The fake path calls
 * `crash()`; the Windows adapter implements `KillSwitch` by calling the guest
 * agent's `kill` op, and passing a `killSwitch` here selects it.
 */
export class KillAppInjector extends TypedInjector {
  readonly faultClass = "kill-app" as const;
  readonly at: FaultPoint;
  readonly #killSwitch: KillSwitch | undefined;
  killed: string | null = null;

  constructor(options: KillAppOptions = {}) {
    super();
    this.at = options.at ?? "before-save";
    this.#killSwitch = options.killSwitch;
    this.params = { at: this.at };
  }

  get name(): string {
    return `kill-app@${typeof this.at === "number" ? `step-${this.at}` : this.at}`;
  }

  fire(fc: {
    stepIndex: number;
    isSave: boolean;
    adapter: unknown;
    killSwitch?: KillSwitch;
  }): void {
    const reason = `kill-app fault at ${typeof this.at === "number" ? `step ${this.at}` : this.at}`;
    const switchToUse = this.#killSwitch ?? fc.killSwitch;
    const app = fc.adapter as { crash?: () => void };
    if (switchToUse) {
      switchToUse.kill(reason);
    } else if (typeof app.crash === "function") {
      app.crash();
    } else {
      throw new Error("kill-app: no KillSwitch and adapter has no crash()");
    }
    this.killed = reason;
  }

  assertExpectation(groundTruth: GroundTruth): ExpectationAssertion {
    // After the save completes the edit is already persisted; a kill there
    // must not be scored as a detection.
    return this.expectUnsatisfiable(groundTruth, true);
  }
}

export type InvalidTargetMode = "nonexistent-row" | "nonexistent-column" | "stale-ref";

export interface InvalidTargetOptions {
  mode?: InvalidTargetMode;
}
/**
 * invalid-target — the intent references a nonexistent row/column or a stale
 * ref, so the program cannot deliver the edit. Modes:
 * - nonexistent-row / nonexistent-column: rewrite `taskParams.cell` so the
 *   family builds the program against a target outside the grid;
 * - stale-ref: the program's click resolves a ref issued for a superseded
 *   `stateVersion`, producing `StaleRefError` on dispatch (fault point: the
 *   click, step 0).
 * Ground truth: the intent is unsatisfiable by construction; any `verified`
 * verdict is a false success.
 */
export class InvalidTargetInjector extends TypedInjector {
  readonly faultClass = "invalid-target" as const;
  readonly at: FaultPoint;
  readonly mode: InvalidTargetMode;
  newCell: string | null = null;
  /** Ref issued then aged out, for the stale-ref mode. */
  staleRef: string | null = null;
  #rewroteParams = false;

  constructor(options: InvalidTargetOptions = {}) {
    super();
    this.mode = options.mode ?? "nonexistent-row";
    this.at = this.mode === "stale-ref" ? 0 : "before-trial";
    this.params = { mode: this.mode, at: this.at };
  }

  get name(): string {
    return `invalid-target:${this.mode}`;
  }

  setup(ctx: FaultContext): void {
    const params = ctx.taskParams;
    const current = String(params.cell ?? "B2");
    const rowDigits = current.replace(/^\D+/, "") || "1";
    switch (this.mode) {
      case "nonexistent-row":
        this.newCell = `A${Number.parseInt(rowDigits, 10) + 10_000}`;
        params.cell = this.newCell;
        break;
      case "nonexistent-column":
        this.newCell = `ZZZ9${rowDigits}`;
        params.cell = this.newCell;
        break;
      case "stale-ref":
        // params stay valid; the staleness is armed per-fire below.
        break;
    }
    this.#rewroteParams = true;
  }

  fire(fc: {
    stepIndex: number;
    isSave: boolean;
    adapter: unknown;
    killSwitch?: KillSwitch;
  }): void {
    if (this.mode !== "stale-ref") return;
    const app = fc.adapter as { markNextRefStale?: () => void };
    if (typeof app.markNextRefStale !== "function") {
      throw new Error("invalid-target: adapter cannot produce stale refs");
    }
    // The next ref the runner resolves (the program's click) is issued bound
    // to a superseded stateVersion, so dispatch throws StaleRefError.
    app.markNextRefStale();
    this.staleRef = "(next issued ref is stale)";
  }

  get rewroteParams(): boolean {
    return this.#rewroteParams;
  }

  assertExpectation(groundTruth: GroundTruth): ExpectationAssertion {
    // invalid-target breaks the intent regardless of fault point.
    return this.expectUnsatisfiable(groundTruth, false);
  }
}

export interface DelayedSaveOptions {
  /** mild: save deferred past the trial window. severe: save silently dropped. */
  severity?: Severity;
  /** Defer window for mild; the verifier reads persisted state well after this. */
  delayMs?: number;
  at?: FaultPoint;
}

/**
 * delayed-save — the save is deferred (mild) or silently dropped (severe) at
 * the save step. The live document shows the edit; the persisted file lags or
 * never receives it. This is the OpenAdapt failure shape (54/72 bad saves
 * reported saved): only the persisted-state check catches it.
 */
export class DelayedSaveInjector extends TypedInjector {
  readonly faultClass = "delayed-save" as const;
  readonly at: FaultPoint;
  readonly severity: Severity;
  readonly delayMs: number;
  applied = false;

  constructor(options: DelayedSaveOptions = {}) {
    super();
    this.severity = options.severity ?? "mild";
    this.delayMs = options.delayMs ?? 60_000;
    this.at = options.at ?? "before-save";
    this.params = { severity: this.severity, delayMs: this.delayMs, at: this.at };
  }

  get name(): string {
    return `delayed-save:${this.severity}`;
  }

  fire(fc: {
    stepIndex: number;
    isSave: boolean;
    adapter: unknown;
    killSwitch?: KillSwitch;
  }): void {
    const app = fc.adapter as {
      setSaveDelay?: (ms: number) => void;
      dropSave?: () => void;
    };
    if (this.severity === "severe" && typeof app.dropSave === "function") {
      app.dropSave();
    } else if (typeof app.setSaveDelay === "function") {
      app.setSaveDelay(this.severity === "severe" ? Number.MAX_SAFE_INTEGER : this.delayMs);
    } else {
      throw new Error("delayed-save: adapter supports neither dropSave nor setSaveDelay");
    }
    this.applied = true;
  }

  assertExpectation(groundTruth: GroundTruth): ExpectationAssertion {
    return this.expectUnsatisfiable(groundTruth, true);
  }
}

export interface FocusChangeOptions {
  at?: FaultPoint;
  /** Node focus is stolen to; the edit lands there or is lost. */
  stealerId?: string;
}

/**
 * focus-change — steal focus mid-typing. Default fault point is step 1 (the
 * typing step in the standard set-cell program), so the value lands on the
 * focused cell or is lost; stealing before-save instead breaks the save's
 * focus precondition.
 */
export class FocusChangeInjector extends TypedInjector {
  readonly faultClass = "focus-change" as const;
  readonly at: FaultPoint;
  readonly stealerId: string;
  fired = false;

  constructor(options: FocusChangeOptions = {}) {
    super();
    this.at = options.at ?? 1;
    this.stealerId = options.stealerId ?? "system:notification";
    this.params = { at: this.at, stealerId: this.stealerId };
  }

  get name(): string {
    return `focus-change@${typeof this.at === "number" ? `step-${this.at}` : this.at}`;
  }

  fire(fc: {
    stepIndex: number;
    isSave: boolean;
    adapter: unknown;
    killSwitch?: KillSwitch;
  }): void {
    const app = fc.adapter as { stealFocus?: (target?: string) => void };
    if (typeof app.stealFocus !== "function") {
      throw new Error("focus-change: adapter cannot steal focus");
    }
    app.stealFocus(this.stealerId);
    this.fired = true;
  }

  assertExpectation(groundTruth: GroundTruth): ExpectationAssertion {
    return this.expectUnsatisfiable(groundTruth, true);
  }
}
