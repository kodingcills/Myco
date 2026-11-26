/**
 * Recursive orchestration (capability track V): the operator's hard limits.
 *
 * Every limit is mandatory and host-side. They are parsed once, strictly, from operator
 * config (a file the operator writes, outside every agent-reachable root, or an object the
 * harness builds); unknown fields, missing fields and non-positive or non-integer values are
 * refused, so a typo can never silently leave a limit off. The parsed value is deeply frozen
 * and the orchestrator keeps its own copy in a private field: no planner or worker is handed
 * anything that could write it (docs/orchestrate/recursive-orchestration.md, "Security model").
 *
 * Cost is a token-derived ESTIMATE from operator-set prices, never billed USD; an unmetered
 * worker has a null cost, never 0 (R7 rule).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ORCHESTRATOR_LIMITS_VERSION = "myco.orchestrate.limits/v1";

export interface OrchestratorLimits {
  readonly version: typeof ORCHESTRATOR_LIMITS_VERSION;
  /** Total tokens (input + output, planners and workers) the whole run may use. */
  readonly maxTotalTokens: number;
  /**
   * Tokens reserved for, and allowed to, one worker. A spawn is refused unless the run's
   * used + reserved tokens plus this reservation stay within `maxTotalTokens`, so the total
   * holds even with every desktop busy (the live transport caps the worker at this).
   */
  readonly maxTokensPerWorker: number;
  /** Estimated cost ceiling, in micro-USD (an estimate from the prices below, never billed). */
  readonly maxEstimatedCostMicroUsd: number;
  /** Operator price used for the estimate, micro-USD per million input tokens. */
  readonly estimateMicroUsdPerMInputTokens: number;
  /** Operator price used for the estimate, micro-USD per million output tokens. */
  readonly estimateMicroUsdPerMOutputTokens: number;
  /** Wall-clock budget for the whole run, from `run()` start. */
  readonly maxWallMs: number;
  /** Deepest node allowed: the root planner is depth 0, its workers depth 1. */
  readonly maxDepth: number;
  /** Desktops (worker trials) live at once. */
  readonly maxConcurrentDesktops: number;
  /** Spawns (workers and sub-planners) one planner may make. */
  readonly maxSpawnsPerPlanner: number;
  /** Spawns in the whole run: the storm cap. */
  readonly maxTotalSpawns: number;
}

const FIELDS = [
  "maxTotalTokens",
  "maxTokensPerWorker",
  "maxEstimatedCostMicroUsd",
  "estimateMicroUsdPerMInputTokens",
  "estimateMicroUsdPerMOutputTokens",
  "maxWallMs",
  "maxDepth",
  "maxConcurrentDesktops",
  "maxSpawnsPerPlanner",
  "maxTotalSpawns",
] as const satisfies readonly (keyof OrchestratorLimits)[];

export class LimitsError extends Error {
  override readonly name = "LimitsError";
}

/** Parse operator limits; throws `LimitsError` on anything but a complete, valid object. */
export function parseLimits(raw: unknown): OrchestratorLimits {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new LimitsError("limits must be an object");
  const record = raw as Record<string, unknown>;
  const allowed = new Set<string>(["version", ...FIELDS]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new LimitsError(`unknown limit field(s): ${unknown.join(", ")}`);
  if (record.version !== ORCHESTRATOR_LIMITS_VERSION)
    throw new LimitsError(`limits.version must be ${ORCHESTRATOR_LIMITS_VERSION}`);
  const out: Record<string, unknown> = { version: ORCHESTRATOR_LIMITS_VERSION };
  for (const field of FIELDS) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
      throw new LimitsError(`limits.${field} must be a positive integer (it is mandatory)`);
    out[field] = value;
  }
  const limits = out as unknown as OrchestratorLimits;
  if (limits.maxTokensPerWorker > limits.maxTotalTokens)
    throw new LimitsError("limits.maxTokensPerWorker exceeds limits.maxTotalTokens");
  return Object.freeze(limits);
}

/** Resolve through symlinks for the longest existing prefix. */
export function realish(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(head.slice(parent.length).replace(/^[/\\]/, ""));
    head = parent;
  }
  return join(realpathSync(head), ...tail);
}

/** True when `child` is `parent` or inside it (case-folded on macOS and Windows). */
export function within(child: string, parent: string): boolean {
  const fold = process.platform === "darwin" || process.platform === "win32";
  const rel = fold ? relative(parent.toLowerCase(), child.toLowerCase()) : relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Why `path` is agent-reachable (inside or containing an agent root), or undefined. */
export function agentReachable(path: string, agentRoots: readonly string[]): string | undefined {
  const real = realish(path);
  for (const root of agentRoots.map(realish)) {
    if (within(real, root)) return `${real} is inside agent-reachable root ${root}`;
    if (within(root, real)) return `agent-reachable root ${root} is inside ${real}`;
  }
  return undefined;
}

/**
 * Load limits from an operator file. Refused when the file is agent-reachable: a limits file
 * an agent can write is not operator config.
 */
export function loadLimitsFile(
  path: string,
  opts: { readonly agentRoots: readonly string[] },
): OrchestratorLimits {
  const clash = agentReachable(path, opts.agentRoots);
  if (clash) throw new LimitsError(`limits file is agent-writable: ${clash}`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new LimitsError(`limits file unreadable: ${(error as Error).name}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LimitsError("limits file is not JSON");
  }
  return parseLimits(raw);
}

/** Estimated micro-USD for a usage, from the operator's prices. Integer, rounded up. */
export function estimateMicroUsd(
  limits: OrchestratorLimits,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
): number {
  return Math.ceil(
    (usage.inputTokens * limits.estimateMicroUsdPerMInputTokens +
      usage.outputTokens * limits.estimateMicroUsdPerMOutputTokens) /
      1_000_000,
  );
}
