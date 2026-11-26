/**
 * The pilot's SIMULATED dry run: the full runner path (config, launch plan and audit,
 * ledger, the real `runGatedTrial` on a sealed vault, `gatedArmRow`, export) with a fake
 * transport. No model, no `claude` process, no VM, $0. Never evidence: the planner is
 * `simulated:pilot-dry-run`, the run and its export carry a `SIMULATED` marker, and
 * `checkBenchmark(..., { evidence: true })` refuses the rows (`test/pilot/dry-run.test.ts`).
 *
 * The fake agent is the TIF-274 scripted credulous policy (`scriptedDocument`): it always
 * claims done and leaves behind the document its task's fault class implies.
 */
import { scriptedDocument } from "../benchmark/r1-dryrun.ts";
import type { TokenUsage } from "./cost.ts";
import type { AttemptContext, PilotDriver, PilotTransport } from "./runner.ts";

export const PILOT_DRY_RUN_PLANNER = "simulated:pilot-dry-run";

/**
 * A virtual clock for the dry run: `sleep` advances `now` instead of waiting, so the pacing
 * logic runs exactly as it would live (and tests can read the waits) without a real delay.
 */
export function virtualClock(start = 0): {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly waits: number[];
} {
  let t = start;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

export interface FakeDriverOptions {
  /** Token usage the fake reports per attempt (null: unmeasured, so cost is null). */
  readonly usage?: (ctx: AttemptContext) => TokenUsage | null;
  /** Called before the fake "agent" runs; throw a `HarnessFault` here to simulate one. */
  readonly beforeAgent?: (ctx: AttemptContext) => void | Promise<void>;
}

export function fakeDriver(
  opts: FakeDriverOptions = {},
): PilotDriver & { readonly launched: string[] } {
  const launched: string[] = [];
  return {
    simulated: true,
    launched,
    transport(ctx: AttemptContext): PilotTransport {
      const doc = new TextEncoder().encode(scriptedDocument(ctx.task));
      return {
        async runAgent() {
          launched.push(ctx.trialKey);
          await opts.beforeAgent?.(ctx);
        },
        async captureAfterStop() {
          return { "persisted/doc.csv": doc };
        },
        report() {
          return { claim: "done", usage: opts.usage?.(ctx) ?? null };
        },
      };
    },
  };
}
