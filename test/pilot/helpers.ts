/**
 * Shared fixtures for the pilot tests: the published fc-v1 task set, the reviewed config,
 * a private temp run directory and a dry run on a virtual clock. No model, no `claude`, no VM.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_PACING, type PacingConfig, pilotConfig } from "../../src/pilot/config.ts";
import { fakeDriver, PILOT_DRY_RUN_PLANNER, virtualClock } from "../../src/pilot/dry-run.ts";
import { publishedTasks } from "../../src/pilot/reviewed.ts";
import { type PilotDriver, runPilot } from "../../src/pilot/runner.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const PUBLISHED = publishedTasks(ROOT);
export const SOURCES = ["src/gate/families.ts", "src/gate/calc-document.ts"].map((p) =>
  join(ROOT, p),
);

/** Subscription-quota wording (lead ruling, PR #598 round 2, D3): each one stops the run. */
export const USAGE_LIMIT_PHRASES = [
  "Claude AI usage limit reached|1700000000",
  "Claude usage limit reached. Your limit will reset at 3pm (America/New_York).",
  "5-hour limit reached ∙ resets 3pm",
  "5 hour limit reached",
  "Weekly limit reached ∙ resets Mon",
  "weekly limit reached",
  "Opus limit reached ∙ resets 11pm",
  "Sonnet limit reached · resets 3pm",
  "Your limit will reset at 5pm",
  "Limit resets at 9am",
  "daily limit exceeded",
  "usage_limit_reached",
] as const;

export const tmp = (prefix = "myco-pilot-") => mkdtempSync(join(tmpdir(), prefix));

export function config(pacing: Partial<PacingConfig> = {}) {
  return pilotConfig(PUBLISHED, { ...DEFAULT_PACING, ...pacing });
}

export async function dryRun(
  outDir: string,
  opts: {
    driver?: PilotDriver;
    pacing?: Partial<PacingConfig>;
    clock?: ReturnType<typeof virtualClock>;
    log?: string[];
  } = {},
) {
  const clock = opts.clock ?? virtualClock();
  const result = await runPilot({
    config: config(opts.pacing),
    published: PUBLISHED,
    outDir,
    repoRoot: ROOT,
    oracleSources: SOURCES,
    driver: opts.driver ?? fakeDriver(),
    plannerModelId: PILOT_DRY_RUN_PLANNER,
    sleep: clock.sleep,
    now: clock.now,
    log: (l) => opts.log?.push(l),
  });
  return { result, clock };
}
