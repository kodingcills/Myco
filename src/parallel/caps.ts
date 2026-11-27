/**
 * Track L (safe parallelism) — resource caps, validated before a pool starts.
 *
 * Every cap is checked up front and the pool refuses to start on any problem (fail
 * closed): a cap that is missing, not a positive integer, above the hard ceiling, or that
 * would oversubscribe the host. At run time the pool enforces them:
 *
 * - `maxConcurrent`: a semaphore; the pool records the peak it observed.
 * - `memoryMbPerTrial`, `cpuSecondsPerTrial`: the backend's per-trial watchdog kills the
 *   trial's whole desktop when its processes exceed them (`resource-cap` outcome, never
 *   verified). A container or microVM backend may use cgroups instead.
 * - `trialTimeoutMs`: wall clock per trial; on expiry the desktop is destroyed.
 * - admission: `maxConcurrent × memoryMbPerTrial ≤ memoryBudgetMb ≤ host memory` and
 *   `maxConcurrent × cpusPerTrial ≤ cpuBudget ≤ host CPUs`.
 */

import { availableParallelism, totalmem } from "node:os";

/** No pool runs more than this many desktops at once, whatever the host. */
export const HARD_MAX_CONCURRENT = 64;

export interface ResourceCapsInput {
  readonly maxConcurrent: number;
  readonly memoryMbPerTrial: number;
  readonly cpusPerTrial: number;
  readonly cpuSecondsPerTrial: number;
  readonly trialTimeoutMs: number;
  /** Defaults to 75% of host memory. */
  readonly memoryBudgetMb?: number;
  /** Defaults to the host's available parallelism. */
  readonly cpuBudget?: number;
}

export type ResourceCaps = Required<ResourceCapsInput>;

export interface HostResources {
  readonly memoryMb: number;
  readonly cpus: number;
}

export function hostResources(): HostResources {
  return { memoryMb: Math.floor(totalmem() / (1024 * 1024)), cpus: availableParallelism() };
}

export const DEFAULT_CAPS: ResourceCapsInput = {
  maxConcurrent: 2,
  memoryMbPerTrial: 1024,
  cpusPerTrial: 1,
  cpuSecondsPerTrial: 120,
  trialTimeoutMs: 180_000,
};

export type CapsResult =
  | { readonly ok: true; readonly caps: ResourceCaps }
  | { readonly ok: false; readonly problems: readonly string[] };

function positiveInt(name: string, value: unknown, problems: string[]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    problems.push(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
    return Number.NaN;
  }
  return value;
}

export function resolveCaps(
  input: ResourceCapsInput,
  host: HostResources = hostResources(),
): CapsResult {
  const problems: string[] = [];
  const maxConcurrent = positiveInt("maxConcurrent", input.maxConcurrent, problems);
  const memoryMbPerTrial = positiveInt("memoryMbPerTrial", input.memoryMbPerTrial, problems);
  const cpusPerTrial = positiveInt("cpusPerTrial", input.cpusPerTrial, problems);
  const cpuSecondsPerTrial = positiveInt("cpuSecondsPerTrial", input.cpuSecondsPerTrial, problems);
  const trialTimeoutMs = positiveInt("trialTimeoutMs", input.trialTimeoutMs, problems);
  const memoryBudgetMb = positiveInt(
    "memoryBudgetMb",
    input.memoryBudgetMb ?? Math.floor(host.memoryMb * 0.75),
    problems,
  );
  const cpuBudget = positiveInt("cpuBudget", input.cpuBudget ?? host.cpus, problems);
  if (problems.length > 0) return { ok: false, problems };
  if (maxConcurrent > HARD_MAX_CONCURRENT)
    problems.push(`maxConcurrent ${maxConcurrent} exceeds the hard ceiling ${HARD_MAX_CONCURRENT}`);
  if (memoryBudgetMb > host.memoryMb)
    problems.push(`memoryBudgetMb ${memoryBudgetMb} exceeds host memory ${host.memoryMb} MB`);
  if (cpuBudget > host.cpus) problems.push(`cpuBudget ${cpuBudget} exceeds host CPUs ${host.cpus}`);
  if (maxConcurrent * memoryMbPerTrial > memoryBudgetMb)
    problems.push(
      `maxConcurrent × memoryMbPerTrial = ${maxConcurrent * memoryMbPerTrial} MB exceeds memoryBudgetMb ${memoryBudgetMb}`,
    );
  if (maxConcurrent * cpusPerTrial > cpuBudget)
    problems.push(
      `maxConcurrent × cpusPerTrial = ${maxConcurrent * cpusPerTrial} exceeds cpuBudget ${cpuBudget}`,
    );
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    caps: Object.freeze({
      maxConcurrent,
      memoryMbPerTrial,
      cpusPerTrial,
      cpuSecondsPerTrial,
      trialTimeoutMs,
      memoryBudgetMb,
      cpuBudget,
    }),
  };
}
