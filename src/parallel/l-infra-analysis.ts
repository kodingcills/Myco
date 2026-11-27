/**
 * Track L — L-infra analysis: the zero-contamination result, recomputed from the rows.
 *
 * Pure: `analyzeLInfra(run, rows, taskSet)` decides the result from the committed rows and
 * the committed task set, and nothing else. `recomputeLInfra(dir)` reads a run's files
 * (`run.json`, `rows.jsonl`), hashes their bytes and analyses them, so anyone can recompute
 * a committed result (`pnpm myco-l-infra-analyze <dir> --check`).
 *
 * The result `meets` only when ALL of these hold (capability-spec §L stage 1 and its
 * guardrails that rows can show):
 * - at least `MIN_TRIALS` L-infra trials, at levels the host admitted;
 * - 0 contamination events: no trial holds another trial's canary, and no trial's canary
 *   was found elsewhere (`contaminated`, `leaked`, or a non-empty `foreignMarkers`);
 * - 0 unscanned trials: every trial's own canary was seen and its scan was complete, so a
 *   0 is not the product of a scan that saw nothing;
 * - every admitted level ran every satisfiable task exactly once; run ids are disjoint;
 * - every row's fixture SHA-256 is its task's;
 * - every desktop was torn down (no process left, root removed);
 * - every trial got the gate verdict its scripted behaviour implies (`verified`), with no
 *   disqualifier but `shared-host-dirs` (which, on `linux-plain`, only withholds the count);
 * - the positive control ran and was detected (victim `contaminated`, leaker `leaked`).
 *
 * `meetsAsSpecified` also needs every level the spec names (N = 1, 2, 4, 8) to have been
 * admitted. A level the host's caps refused is a deviation, listed, never hidden.
 *
 * SIMULATED: never evidence of agent capability (capability-spec §3 item 5).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  L_INFRA_LEVELS,
  L_INFRA_ROW_SCHEMA,
  L_INFRA_RUN_SCHEMA,
  type LInfraRow,
  type LInfraRun,
  type LInfraTaskSet,
} from "./l-infra.ts";

export const L_INFRA_RESULT_SCHEMA = "myco.parallel-l-infra-result/1";
/** capability-spec §L stage 1: at least 200 trials before any model run. */
export const MIN_TRIALS = 200;
/** The only disqualifier an honest L-infra trial may carry (`linux-plain` never counts). */
const ALLOWED_DISQUALIFIERS: ReadonlySet<string> = new Set(["shared-host-dirs"]);
const CONTAMINATION: ReadonlySet<string> = new Set(["contaminated", "leaked"]);
const UNSCANNED: ReadonlySet<string> = new Set(["own-marker-missing", "scan-incomplete"]);

export interface LInfraLevelResult {
  readonly n: number;
  readonly admitted: boolean;
  readonly trials: number;
  readonly contaminationEvents: number;
  readonly wallMs: number | null;
  readonly trialsPerHour: number | null;
  readonly peakConcurrent: number | null;
}

export interface LInfraResult {
  readonly schema: typeof L_INFRA_RESULT_SCHEMA;
  readonly simulated: true;
  readonly evidence: false;
  readonly backend: string;
  readonly agent: string;
  readonly taskSet: LInfraRun["taskSet"];
  readonly provenance: LInfraRun["provenance"];
  readonly levelsSpecified: readonly number[];
  readonly levels: readonly LInfraLevelResult[];
  readonly trials: number;
  readonly contaminationEvents: number;
  /** Rule of three: the 95% upper bound on the per-trial contamination rate given 0 events. */
  readonly contaminationRateUpper95: number | null;
  readonly unscanned: number;
  readonly teardownFailures: number;
  readonly fixtureMismatches: number;
  readonly duplicateRunIds: number;
  readonly coverageProblems: readonly string[];
  readonly unexpectedOutcomes: number;
  readonly countedVerified: number;
  readonly positiveControl: {
    readonly ran: boolean;
    readonly victimContaminated: boolean;
    readonly leakerLeaked: boolean;
    readonly detected: boolean;
  };
  readonly failures: readonly string[];
  readonly deviations: readonly string[];
  readonly meets: boolean;
  readonly meetsAsSpecified: boolean;
}

const perHour = (count: number, ms: number | null): number | null =>
  ms && ms > 0 ? Math.round((count * 3_600_000 * 10) / ms) / 10 : null;

const isEvent = (r: LInfraRow): boolean =>
  r.foreignMarkers.length > 0 || r.disqualifiers.some((d) => CONTAMINATION.has(d));
const isUnscanned = (r: LInfraRow): boolean =>
  !r.ownMarkerSeen || r.disqualifiers.some((d) => UNSCANNED.has(d));
const tornDown = (r: LInfraRow): boolean =>
  r.teardown?.processesGone === true &&
  r.teardown.rootRemoved &&
  !r.disqualifiers.includes("teardown");

export function analyzeLInfra(
  run: LInfraRun,
  rows: readonly LInfraRow[],
  taskSet: LInfraTaskSet,
): LInfraResult {
  const failures: string[] = [];
  if (run.schema !== L_INFRA_RUN_SCHEMA) failures.push("run.json: wrong schema");
  if (run.simulated !== true || run.evidence !== false)
    failures.push("run.json: must be simulated and not evidence");
  if (rows.some((r) => r.schema !== L_INFRA_ROW_SCHEMA || r.simulated !== true))
    failures.push("rows: a row has the wrong schema or is not simulated");
  if (
    run.taskSet.version !== taskSet.version ||
    run.taskSet.tasksSha256 !== taskSet.tasksSha256 ||
    run.taskSet.manifestSha256 !== taskSet.manifestSha256 ||
    run.taskSet.satisfiable !== taskSet.tasks.length
  )
    failures.push("run.json: task set does not match the committed bundle");

  const trials = rows.filter((r) => r.kind === "trial");
  const control = rows.filter((r) => r.kind === "control");
  const fixtureOf = new Map(taskSet.tasks.map((t) => [t.taskId, t.fixtureSha256]));
  const admitted = new Set(run.levels.filter((l) => l.admitted).map((l) => l.n));

  // Coverage: every admitted level ran every task exactly once; nothing else ran.
  const coverageProblems: string[] = [];
  for (const n of admitted) {
    const at = trials.filter((r) => r.n === n).map((r) => r.taskId);
    const seen = new Set(at);
    const missing = taskSet.tasks.filter((t) => !seen.has(t.taskId)).length;
    if (missing > 0) coverageProblems.push(`N=${n}: ${missing} task(s) missing`);
    if (at.length !== seen.size) coverageProblems.push(`N=${n}: a task ran twice`);
    if (at.some((id) => !fixtureOf.has(id))) coverageProblems.push(`N=${n}: unknown task`);
  }
  for (const r of trials)
    if (!admitted.has(r.n)) {
      coverageProblems.push(`N=${r.n}: rows at a level that was not admitted`);
      break;
    }

  const ids = rows.map((r) => r.runId);
  const duplicateRunIds = ids.length - new Set(ids.map((id) => id.toLowerCase())).size;
  const contaminationEvents = trials.filter(isEvent).length;
  const unscanned = trials.filter(isUnscanned).length;
  const teardownFailures = rows.filter((r) => !tornDown(r)).length;
  const fixtureMismatches = rows.filter((r) => fixtureOf.get(r.taskId) !== r.fixtureSha256).length;
  const unexpectedOutcomes = trials.filter(
    (r) => r.verdict !== "verified" || r.disqualifiers.some((d) => !ALLOWED_DISQUALIFIERS.has(d)),
  ).length;
  // A trial counts only with no disqualifier; on linux-plain this is always 0.
  const countedVerified = trials.filter(
    (r) => r.verdict === "verified" && r.disqualifiers.length === 0,
  ).length;

  const victim = control.find((r) => r.role === "victim");
  const leaker = control.find((r) => r.role === "leaker");
  const victimContaminated =
    !!victim &&
    !!leaker &&
    victim.disqualifiers.includes("contaminated") &&
    victim.foreignMarkers.includes(leaker.runId);
  const leakerLeaked = !!leaker && leaker.disqualifiers.includes("leaked");
  const positiveControl = {
    ran: run.control.ran && control.length === 2,
    victimContaminated,
    leakerLeaked,
    detected: run.control.ran && victimContaminated && leakerLeaked,
  };

  if (trials.length < MIN_TRIALS)
    failures.push(`${trials.length} trial(s), fewer than ${MIN_TRIALS}`);
  if (contaminationEvents > 0) failures.push(`${contaminationEvents} contamination event(s)`);
  if (unscanned > 0) failures.push(`${unscanned} unscanned trial(s)`);
  if (teardownFailures > 0) failures.push(`${teardownFailures} teardown failure(s)`);
  if (fixtureMismatches > 0) failures.push(`${fixtureMismatches} fixture hash mismatch(es)`);
  if (duplicateRunIds > 0) failures.push(`${duplicateRunIds} duplicate run id(s)`);
  failures.push(...coverageProblems);
  if (unexpectedOutcomes > 0) failures.push(`${unexpectedOutcomes} unexpected outcome(s)`);
  if (!positiveControl.detected) failures.push("positive control not run or not detected");
  if (admitted.size === 0) failures.push("no level was admitted");

  const deviations = L_INFRA_LEVELS.filter((n) => !admitted.has(n)).map((n) => {
    const l = run.levels.find((x) => x.n === n);
    return l ? `N=${n} not admitted on this host: ${l.problems.join("; ")}` : `N=${n} not planned`;
  });

  const levels: LInfraLevelResult[] = run.levels.map((l) => {
    const at = trials.filter((r) => r.n === l.n);
    return {
      n: l.n,
      admitted: l.admitted,
      trials: at.length,
      contaminationEvents: at.filter(isEvent).length,
      wallMs: l.wallMs,
      trialsPerHour: perHour(at.length, l.wallMs),
      peakConcurrent: l.peakConcurrent,
    };
  });

  const meets = failures.length === 0;
  return {
    schema: L_INFRA_RESULT_SCHEMA,
    simulated: true,
    evidence: false,
    backend: run.backend,
    agent: run.agent,
    taskSet: run.taskSet,
    provenance: run.provenance,
    levelsSpecified: [...L_INFRA_LEVELS],
    levels,
    trials: trials.length,
    contaminationEvents,
    contaminationRateUpper95:
      contaminationEvents === 0 && trials.length > 0
        ? Math.round((3 / trials.length) * 1e6) / 1e6
        : null,
    unscanned,
    teardownFailures,
    fixtureMismatches,
    duplicateRunIds,
    coverageProblems,
    unexpectedOutcomes,
    countedVerified,
    positiveControl,
    failures,
    deviations,
    meets,
    meetsAsSpecified: meets && deviations.length === 0,
  };
}

// ---------------------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------------------

export const RUN_FILE = "run.json";
export const ROWS_FILE = "rows.jsonl";
export const RESULT_FILE = "result.json";

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export function serializeRun(run: LInfraRun): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

export function serializeRows(rows: readonly LInfraRow[]): string {
  return rows.map((r) => `${JSON.stringify(r)}\n`).join("");
}

/** The result file: the analysis plus the SHA-256 of the exact bytes it was computed from. */
export interface LInfraResultFile extends LInfraResult {
  readonly runSha256: string;
  readonly rowsSha256: string;
}

export function resultFileOf(
  runText: string,
  rowsText: string,
  set: LInfraTaskSet,
): LInfraResultFile {
  const run = JSON.parse(runText) as LInfraRun;
  const rows = rowsText
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LInfraRow);
  return {
    ...analyzeLInfra(run, rows, set),
    runSha256: sha256(runText),
    rowsSha256: sha256(rowsText),
  };
}

export function serializeResult(result: LInfraResultFile): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** Recompute a run dir's result from its `run.json` and `rows.jsonl` bytes. */
export function recomputeLInfra(dir: string, set: LInfraTaskSet): LInfraResultFile {
  return resultFileOf(
    readFileSync(join(dir, RUN_FILE), "utf8"),
    readFileSync(join(dir, ROWS_FILE), "utf8"),
    set,
  );
}
