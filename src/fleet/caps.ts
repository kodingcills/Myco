/**
 * Linux desktop fleet (workstream 2, track U): HARD caps on desktop count and memory.
 *
 * These are ceilings in code, not defaults. Every fleet entry point checks them before any
 * desktop is created and refuses to start beyond them, with a code. An operator cannot
 * raise them by a flag or an env var: raising one is a code change, reviewed as Tier 2.
 *
 * - `FLEET_MAX_DESKTOPS`: no fleet runs more desktops at once than this.
 * - `FLEET_MAX_MEMORY_MB_PER_DESKTOP`: no desktop is given a memory cap above this.
 * - `FLEET_MAX_TOTAL_MEMORY_MB`: desktops × memory per desktop never exceeds this.
 *
 * The track L pool still applies its own admission check against the host
 * (`src/parallel/caps.ts`: memory budget ≤ host memory, CPU budget ≤ host CPUs) on top of
 * these; the fleet hands it a budget of exactly desktops × memory per desktop, so the pool
 * can never run more than the fleet allowed. After a run, the fleet also checks that the
 * pool's observed peak never exceeded the desktop count (`FLEET_PEAK_OVER_CAP`).
 */

export const FLEET_MAX_DESKTOPS = 8;
export const FLEET_MAX_MEMORY_MB_PER_DESKTOP = 2048;
export const FLEET_MAX_TOTAL_MEMORY_MB = 8192;

export const FLEET_CAP_CODES = [
  "FLEET_BAD_CAP",
  "FLEET_TOO_MANY_DESKTOPS",
  "FLEET_DESKTOP_MEMORY_OVER_CAP",
  "FLEET_TOTAL_MEMORY_OVER_CAP",
  "FLEET_PEAK_OVER_CAP",
] as const;
export type FleetCapCode = (typeof FLEET_CAP_CODES)[number];

export class FleetCapRefused extends Error {
  constructor(readonly codes: readonly FleetCapCode[]) {
    super(`fleet refused: ${codes.join(", ")}`);
    this.name = "FleetCapRefused";
  }
}

export interface FleetSize {
  /** Desktops at once (the pool's `maxConcurrent`). */
  readonly desktops: number;
  readonly memoryMbPerDesktop: number;
}

const positiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Every cap this size breaks, as codes (empty when it is within every cap). */
export function fleetCapProblems(size: FleetSize): FleetCapCode[] {
  if (!positiveInt(size.desktops) || !positiveInt(size.memoryMbPerDesktop))
    return ["FLEET_BAD_CAP"];
  const out: FleetCapCode[] = [];
  if (size.desktops > FLEET_MAX_DESKTOPS) out.push("FLEET_TOO_MANY_DESKTOPS");
  if (size.memoryMbPerDesktop > FLEET_MAX_MEMORY_MB_PER_DESKTOP)
    out.push("FLEET_DESKTOP_MEMORY_OVER_CAP");
  if (size.desktops * size.memoryMbPerDesktop > FLEET_MAX_TOTAL_MEMORY_MB)
    out.push("FLEET_TOTAL_MEMORY_OVER_CAP");
  return out;
}

/** Throws `FleetCapRefused` unless the size is within every cap. */
export function assertFleetCaps(size: FleetSize): void {
  const problems = fleetCapProblems(size);
  if (problems.length > 0) throw new FleetCapRefused(problems);
}
