/**
 * Compatibility layer over the M1 fault-injection suite (src/faults/, M1-010).
 * Kept so src/fake/ consumers and the M1-001 tests keep working; new code
 * should use src/faults/ directly for parameterization, schedules, and
 * composition.
 */

import type { AppAdapter } from "../core/adapter.ts";
import type { FaultInjector } from "../core/eval.ts";
import {
  DelayedSaveInjector,
  FocusChangeInjector,
  InvalidTargetInjector,
  KillAppInjector,
} from "../faults/injectors.ts";

function fakeAppOf(adapter: AppAdapter): { crash(): void } {
  return adapter as unknown as { crash(): void };
}

export function killApp(): FaultInjector {
  const inner = new KillAppInjector();
  return {
    name: inner.name,
    beforeSave(ctx) {
      inner.fire({ stepIndex: -1, isSave: true, adapter: fakeAppOf(ctx.adapter) });
    },
  };
}

export function invalidTarget(): FaultInjector {
  const inner = new InvalidTargetInjector();
  return {
    name: inner.name,
    beforeTrial(ctx) {
      inner.setup(ctx);
    },
  };
}

export function delayedSave(ms = 60_000): FaultInjector {
  const inner = new DelayedSaveInjector({ severity: "mild", delayMs: ms });
  return {
    name: inner.name,
    beforeTrial(ctx) {
      // compatibility: apply immediately, as the M1-001 tests expect
      const app = ctx.adapter as unknown as { setSaveDelay(delay: number): void };
      app.setSaveDelay(ms);
      inner.applied = true;
    },
  };
}

export function focusChange(): FaultInjector {
  const inner = new FocusChangeInjector({ at: "before-save" });
  return {
    name: inner.name,
    beforeSave(ctx) {
      inner.fire({ stepIndex: -1, isSave: true, adapter: ctx.adapter });
    },
  };
}
