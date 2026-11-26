/**
 * Parallel fleet runner (track U, feeds capability L "Safe parallelism"). Runs N trials on a
 * desktop backend with a concurrency cap; each trial gets its own desktop (create, run the
 * agent, capture the persisted bytes, destroy), bound to its own trialKey and runId.
 *
 * Contamination check (capability spec L's guardrail, L-infra stage): every desktop is
 * seeded with a unique canary in `myco-canary.txt`. After the batch, each trial's captured bytes
 * and output are scanned for every OTHER trial's canary; one hit is a contamination event,
 * and `FleetResult.clean` is false. Duplicate trial keys, run ids or canaries refuse the
 * batch before any desktop starts (fail closed).
 *
 * Rows a scripted agent produces here are simulated: they are never evidence of agent
 * capability (capability spec §3.5).
 */
import {
  type CapturedBytes,
  type DesktopBackend,
  DesktopError,
  type DesktopErrorCode,
  type IsolationLevel,
  type RunResult,
  type SeedFile,
} from "./backend.ts";

export const CANARY_FILE = "myco-canary.txt";
const CANARY = /^[A-Za-z0-9-]{16,128}$/;

export interface FleetTrial {
  readonly trialKey: string;
  readonly taskId: string;
  readonly runId: string;
  readonly image: string;
  readonly seed: readonly SeedFile[];
  /** The agent program, run inside the desktop. */
  readonly argv: readonly string[];
  /** Relative path of the document the trial must leave behind. */
  readonly capturePath: string;
  /** Unique per trial; seeded into the desktop and scanned for everywhere else. */
  readonly canary: string;
  readonly timeoutMs: number;
}

export interface FleetOutcome {
  readonly trialKey: string;
  readonly taskId: string;
  readonly runId: string;
  readonly backend: string;
  readonly isolation: IsolationLevel;
  readonly networkEnforced: boolean;
  readonly image: string;
  readonly run: RunResult | null;
  readonly capture: CapturedBytes | null;
  /** A backend error code, or `ERROR` for anything else; null when the trial ran. */
  readonly error: DesktopErrorCode | "ERROR" | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface ContaminationEvent {
  readonly trialKey: string;
  /** The trial whose canary was found in `trialKey`'s output. */
  readonly canaryOf: string;
  readonly where: "capture" | "stdout" | "stderr";
}

export interface FleetResult {
  /** In input order. */
  readonly outcomes: readonly FleetOutcome[];
  readonly contamination: readonly ContaminationEvent[];
  readonly clean: boolean;
  /** The most desktops that were alive at once. */
  readonly maxConcurrent: number;
  readonly wallMs: number;
}

export interface FleetOptions {
  readonly concurrency: number;
  readonly now?: () => Date;
}

function checkTrials(trials: readonly FleetTrial[]): void {
  const keys = new Set<string>();
  const runs = new Set<string>();
  const canaries = new Set<string>();
  for (const t of trials) {
    if (keys.has(t.trialKey) || runs.has(t.runId) || canaries.has(t.canary)) {
      throw new DesktopError("BAD_SPEC");
    }
    if (typeof t.canary !== "string" || !CANARY.test(t.canary)) throw new DesktopError("BAD_SPEC");
    keys.add(t.trialKey);
    runs.add(t.runId);
    canaries.add(t.canary);
  }
}

export function findContamination(
  trials: readonly FleetTrial[],
  outcomes: readonly FleetOutcome[],
): ContaminationEvent[] {
  const events: ContaminationEvent[] = [];
  for (const outcome of outcomes) {
    const surfaces: Array<[ContaminationEvent["where"], string]> = [
      [
        "capture",
        outcome.capture === null ? "" : Buffer.from(outcome.capture.bytes).toString("latin1"),
      ],
      ["stdout", outcome.run?.stdout ?? ""],
      ["stderr", outcome.run?.stderr ?? ""],
    ];
    for (const other of trials) {
      if (other.trialKey === outcome.trialKey) continue;
      for (const [where, text] of surfaces) {
        if (text.includes(other.canary)) {
          events.push({ trialKey: outcome.trialKey, canaryOf: other.trialKey, where });
        }
      }
    }
  }
  return events;
}

export async function runFleet(
  backend: DesktopBackend,
  trials: readonly FleetTrial[],
  options: FleetOptions,
): Promise<FleetResult> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new DesktopError("BAD_SPEC");
  }
  checkTrials(trials);
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const outcomes: FleetOutcome[] = new Array(trials.length);
  let alive = 0;
  let maxConcurrent = 0;
  let next = 0;

  const runOne = async (trial: FleetTrial): Promise<FleetOutcome> => {
    const startedAt = now().toISOString();
    let run: RunResult | null = null;
    let capture: CapturedBytes | null = null;
    let error: FleetOutcome["error"] = null;
    let handle: Awaited<ReturnType<DesktopBackend["create"]>> | null = null;
    try {
      handle = await backend.create({
        trialKey: trial.trialKey,
        image: trial.image,
        network: "off",
        seed: [...trial.seed, { path: CANARY_FILE, bytes: Buffer.from(trial.canary) }],
      });
      alive += 1;
      maxConcurrent = Math.max(maxConcurrent, alive);
      run = await backend.run(handle, { argv: trial.argv, timeoutMs: trial.timeoutMs });
      capture = await backend.capture(handle, trial.capturePath);
    } catch (e) {
      error = e instanceof DesktopError ? e.code : "ERROR";
    } finally {
      if (handle !== null) {
        alive -= 1;
        try {
          await backend.destroy(handle);
        } catch (e) {
          error ??= e instanceof DesktopError ? e.code : "ERROR";
        }
      }
    }
    return {
      trialKey: trial.trialKey,
      taskId: trial.taskId,
      runId: trial.runId,
      backend: backend.kind,
      isolation: backend.isolation,
      networkEnforced: backend.enforcesNetworkOff,
      image: trial.image,
      run,
      capture,
      error,
      startedAt,
      finishedAt: now().toISOString(),
    };
  };

  const worker = async () => {
    while (next < trials.length) {
      const i = next++;
      outcomes[i] = await runOne(trials[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, trials.length) }, () => worker()),
  );
  const contamination = findContamination(trials, outcomes);
  return {
    outcomes,
    contamination,
    clean: contamination.length === 0,
    maxConcurrent,
    wallMs: Date.now() - started,
  };
}
