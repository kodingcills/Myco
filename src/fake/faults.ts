import type { FaultInjector } from "../core/eval.ts";
import type { FakeSpreadsheetApp } from "./app.ts";

function appOf(ctx: { adapter: unknown }): FakeSpreadsheetApp {
  return ctx.adapter as FakeSpreadsheetApp;
}

export function killApp(): FaultInjector {
  return {
    name: "kill-app-before-save",
    beforeSave(ctx) {
      appOf(ctx).crash();
    },
  };
}

export function invalidTarget(): FaultInjector {
  return {
    name: "invalid-target",
    beforeTrial(ctx) {
      ctx.taskParams.cell = "Z99";
    },
  };
}

export function delayedSave(ms = 60_000): FaultInjector {
  return {
    name: "delayed-save",
    beforeTrial(ctx) {
      appOf(ctx).setSaveDelay(ms);
    },
  };
}

export function focusChange(): FaultInjector {
  return {
    name: "focus-change",
    beforeSave(ctx) {
      appOf(ctx).stealFocus();
    },
  };
}
