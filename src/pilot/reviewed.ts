/**
 * The reviewed, project-local pilot config (`benchmark/pilot/r1/config.json`). The runner
 * uses the committed file, and refuses it unless everything in it except `pacing` equals what
 * `pilotConfig()` derives from the published task set: the argv, the one MCP server, the
 * tool grant, the environment allowlist and the 30 trials cannot drift from the reviewed code.
 * Pacing is the operator's knob: validated by `checkPacing`, and overridable per invocation
 * (an override changes the config hash, so it is a new run directory, never a resume).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import {
  canonicalJson,
  checkPacing,
  type PacingConfig,
  type PilotConfig,
  pilotConfig,
} from "./config.ts";

export const REVIEWED_CONFIG = "benchmark/pilot/r1/config.json";

export function publishedTasks(repoRoot: string): BenchmarkTask[] {
  return readFileSync(join(repoRoot, "benchmark/false-completion/fc-v1/tasks.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l) as BenchmarkTask);
}

export function loadReviewedConfig(
  repoRoot: string,
  published: readonly BenchmarkTask[],
  overrides: Partial<PacingConfig> = {},
  file = join(repoRoot, REVIEWED_CONFIG),
): PilotConfig {
  const committed = JSON.parse(readFileSync(file, "utf8")) as PilotConfig;
  const pacing = checkPacing({ ...committed.pacing });
  const expected = pilotConfig(published, pacing);
  if (canonicalJson(committed) !== canonicalJson(expected))
    throw new Error(
      `${REVIEWED_CONFIG} has drifted from the reviewed code (only pacing may differ): regenerate it with \`npx tsx scripts/m2-r1-pilot.ts config\` and review the diff`,
    );
  return pilotConfig(published, checkPacing({ ...pacing, ...overrides }));
}
