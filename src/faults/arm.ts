import type {
  Action,
  ActResult,
  AdapterCapabilities,
  AppAdapter,
  ProgramAction,
} from "../core/adapter.ts";
import type { FaultContext } from "../core/eval.ts";
import type { FaultInjectorV2, FaultSchedule, FireContext, KillSwitch } from "./types.ts";

/**
 * Wraps the real adapter for a whole armed fault set. Counts dispatched
 * actions (a `waitFor` loop re-observes without dispatching, so it does not
 * advance the counter) and fires each injector whose numeric fault point is
 * reached, always against the REAL adapter — never against another fault
 * layer, so composed faults cannot interfere. `before-save` and `after-save`
 * points fire via the composite's harness hooks (see armFaults), not here.
 */
export class ArmedAdapter implements AppAdapter {
  readonly #real: AppAdapter;
  readonly #injectors: FaultInjectorV2[];
  readonly #killSwitch?: KillSwitch;
  #dispatched = 0;

  constructor(real: AppAdapter, injectors: FaultInjectorV2[], killSwitch?: KillSwitch) {
    this.#real = real;
    this.#injectors = injectors;
    this.#killSwitch = killSwitch;
  }

  capabilities(): AdapterCapabilities {
    return this.#real.capabilities();
  }

  observe() {
    return this.#real.observe();
  }

  issueRef(nodeId: string): string | null {
    return this.#real.issueRef?.(nodeId) ?? null;
  }

  async act(action: ProgramAction): Promise<ActResult> {
    const isSave = action.kind === "keyPress" && action.keys === "ctrl+s";
    const fc: FireContext = {
      stepIndex: this.#dispatched,
      isSave,
      adapter: this.#real,
      killSwitch: this.#killSwitch,
    };
    for (const inj of this.#injectors) {
      if (typeof inj.at === "number" && inj.at === this.#dispatched) {
        inj.fire?.(fc);
      }
    }
    const result = await this.#real.act(action as Action);
    for (const inj of this.#injectors) {
      if (inj.at === "after-save" && isSave) {
        inj.fire?.({ ...fc, stepIndex: this.#dispatched });
      }
    }
    this.#dispatched += 1;
    return result;
  }
}

/** What `armFaults` hands back for one trial. */
export interface ArmedTrial {
  /** The real adapter behind one ArmedAdapter carrying all step-firing faults. */
  adapter: AppAdapter;
  /** Harness-level injector: runs setups, before-save faults, and cleanups. */
  injector: FaultInjectorV2;
  /** Recorded fault schedule for host-side ground truth (ADR-0005). */
  schedule: FaultSchedule;
  killSwitch: KillSwitch | undefined;
}

/**
 * Arms a set of injectors for one trial around a real adapter. Build the real
 * app first, then pass it here; give the returned `adapter` to the eval
 * config's `adapterFor` and the returned `injector` to `faults`.
 *
 * before-save faults fire from the composite's `beforeSave` hook, which the
 * harness calls between its pre-save and post-save program segments.
 *
 * The composite injector's `name` records every armed fault — a composed
 * trial reads `kill-app@step-1+delayed-save:mild` in the TrialResult, and the
 * schedule records all entries. All faults share one KillSwitch, so a
 * kill-app × delayed-save trial kills through the same seam the Windows
 * adapter will implement without disturbing the pending save timer.
 */
export function armFaults(
  trialIndex: number,
  real: AppAdapter,
  injectors: FaultInjectorV2[],
  killSwitch?: KillSwitch,
): ArmedTrial {
  if (injectors.length === 0) throw new Error("armFaults: at least one injector required");
  const schedule: FaultSchedule = {
    trialIndex,
    entries: injectors.map((inj) => inj.scheduleEntry()),
  };

  const stepFiring = injectors.filter(
    (inj) => typeof inj.at === "number" || inj.at === "after-save",
  );
  const adapter: AppAdapter =
    stepFiring.length > 0 ? new ArmedAdapter(real, stepFiring, killSwitch) : real;

  const realApp: AppAdapter & { alive?: boolean } = real;
  const appIsAlive = (): boolean => {
    if (killSwitch && !killSwitch.alive) return false;
    if (typeof realApp.alive === "boolean") return realApp.alive;
    return true;
  };

  const composite: FaultInjectorV2 = {
    name: injectors.map((inj) => inj.name).join("+"),
    faultClass: injectors[0]!.faultClass,
    at: injectors[0]!.at,
    params: { composed: injectors.length > 1 },
    scheduleEntry: injectors[0]!.scheduleEntry.bind(injectors[0]),
    assertExpectation(groundTruth) {
      const perFault = injectors.map((inj) => ({
        injector: inj.name,
        assertion: inj.assertExpectation(groundTruth),
      }));
      return {
        holds: perFault.every((p) => p.assertion.holds),
        description: perFault.map((p) => `${p.injector}: ${p.assertion.description}`).join("; "),
      };
    },
    beforeTrial(ctx: FaultContext) {
      for (const inj of injectors) inj.setup?.(ctx);
    },
    beforeSave() {
      // kill wins: once the app (or the shared kill switch) is dead, later
      // before-save fault points are never reached — causal, not interference
      if (!appIsAlive()) return;
      for (const inj of injectors) {
        if (inj.at !== "before-save") continue;
        inj.fire?.({ stepIndex: -1, isSave: true, adapter: real, killSwitch });
      }
    },
    afterProgram() {
      for (const inj of injectors) inj.cleanup?.(real);
    },
  };
  return { adapter, injector: composite, schedule, killSwitch };
}
