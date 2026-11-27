/**
 * Linux desktop fleet: the measurement artifact and its pure analysis.
 *
 * `analyzeFleet(levels, rows)` derives every summary number from the raw per-trial rows and
 * per-level wall times, and nothing else. `checkFleetMeasurement(m)` recomputes the summary
 * from the artifact's own rows and refuses the artifact (with problem codes) when the
 * committed summary differs, a cap is exceeded, a row is missing or duplicated, or the
 * artifact claims to be anything but a simulated, non-evidence measurement. So a committed
 * artifact can be re-checked by anyone from its rows (`pnpm myco-fleet --check <file>`).
 *
 * The stamps are fixed by the types: `simulated: true`, `evidence: false`,
 * `r1Evidence: false`, `windowsRow: false`, `costEstimate: null`. Scripted agents measure the
 * harness (fleet overhead and scaling), never an agent, and a Linux row is never a Windows
 * row: none of this counts as R1 evidence unless the lead rules otherwise.
 */

import {
  FLEET_MAX_DESKTOPS,
  FLEET_MAX_MEMORY_MB_PER_DESKTOP,
  FLEET_MAX_TOTAL_MEMORY_MB,
  fleetCapProblems,
} from "./caps.ts";

export const FLEET_MEASUREMENT_SCHEMA = "myco.linux-fleet.measurement/1";

export type Behaviour = "honest" | "skips-save" | "wrong-row";
export type Verdict = "verified" | "refuted" | "uncertain";

export interface FleetTrialRow {
  readonly k: number;
  readonly index: number;
  readonly taskId: string;
  readonly runId: string;
  readonly trialKey: string;
  readonly behaviour: Behaviour;
  readonly expectedVerdict: "verified" | "refuted";
  /** Trial start, in ms after the level's first trial started. */
  readonly startOffsetMs: number;
  readonly elapsedMs: number;
  readonly gate: { readonly verdict: Verdict | null; readonly accepted: boolean };
  readonly grade: {
    readonly status: "pass" | "fail" | "ungradable";
    readonly binding: string | null;
  };
  readonly disqualifiers: readonly string[];
  /** How many OTHER trials' markers were found in this trial. */
  readonly foreignMarkers: number;
  readonly countedVerified: boolean;
  /** The attempt ledger's end for this trial. */
  readonly ledger: "decided" | "harness-fault";
}

export interface FleetLevel {
  readonly k: number;
  readonly trials: number;
  /** The pool's wall clock for the whole level, setup and teardown included. */
  readonly wallMs: number;
  readonly peakConcurrent: number;
}

export interface FleetSummaryPoint {
  readonly k: number;
  readonly trials: number;
  readonly wallMs: number;
  readonly trialsPerHour: number;
  /** trialsPerHour at this K over trialsPerHour at the first level. */
  readonly speedupVsFirst: number;
  /** Gate verdict and independent grade both matched the scripted behaviour, no blocking disqualifier. */
  readonly correct: number;
  /** Gate `verified` while the grader did not say `pass`. Must be 0. */
  readonly falseVerified: number;
  /** Gate and grader disagree in either direction (verified/pass and refuted/fail agree). */
  readonly gateGraderDisagree: number;
  /** Trials with a `contaminated` or `leaked` disqualifier. */
  readonly contaminationEvents: number;
  readonly countedVerified: number;
  readonly harnessFaults: number;
}

export interface FleetMeasurement {
  readonly schema: typeof FLEET_MEASUREMENT_SCHEMA;
  readonly simulated: true;
  readonly evidence: false;
  readonly r1Evidence: false;
  readonly windowsRow: false;
  readonly costEstimate: null;
  readonly backend: string;
  /** The backend's own isolation report: whether other trials' roots are hidden. */
  readonly hostDirsHidden: boolean;
  readonly agent: string;
  /** The scripted agent's think time inside its desktop, per trial. */
  readonly agentThinkMs: number;
  readonly caps: {
    readonly maxDesktops: number;
    readonly maxMemoryMbPerDesktop: number;
    readonly maxTotalMemoryMb: number;
    readonly memoryMbPerDesktop: number;
  };
  readonly host: {
    readonly platform: string;
    readonly cpus: number;
    readonly memoryMb: number;
    readonly node: string;
  };
  readonly provenance: { readonly gitSha: string | null; readonly ciRunUrl: string | null };
  readonly trialsPerK: number;
  readonly levels: readonly FleetLevel[];
  readonly rows: readonly FleetTrialRow[];
  readonly summary: readonly FleetSummaryPoint[];
}

/** Disqualifiers that only withhold a count and never mean the verdict was wrong. */
const NON_BLOCKING = new Set(["shared-host-dirs"]);

const perHour = (count: number, ms: number) =>
  ms > 0 ? Math.round((count * 3_600_000 * 10) / ms) / 10 : 0;

const agrees = (r: FleetTrialRow) =>
  (r.gate.verdict === "verified" && r.grade.status === "pass") ||
  (r.gate.verdict === "refuted" && r.grade.status === "fail");

export function rowCorrect(r: FleetTrialRow): boolean {
  const wantGrade = r.expectedVerdict === "verified" ? "pass" : "fail";
  return (
    r.gate.verdict === r.expectedVerdict &&
    r.gate.accepted === (r.expectedVerdict === "verified") &&
    r.grade.status === wantGrade &&
    r.disqualifiers.every((d) => NON_BLOCKING.has(d))
  );
}

export function analyzeFleet(
  levels: readonly FleetLevel[],
  rows: readonly FleetTrialRow[],
): FleetSummaryPoint[] {
  let first = 0;
  return levels.map((lv, i) => {
    const mine = rows.filter((r) => r.k === lv.k);
    const rate = perHour(mine.length, lv.wallMs);
    if (i === 0) first = rate;
    return {
      k: lv.k,
      trials: mine.length,
      wallMs: lv.wallMs,
      trialsPerHour: rate,
      speedupVsFirst: first > 0 ? Math.round((rate / first) * 100) / 100 : 0,
      correct: mine.filter(rowCorrect).length,
      falseVerified: mine.filter((r) => r.gate.verdict === "verified" && r.grade.status !== "pass")
        .length,
      gateGraderDisagree: mine.filter((r) => r.gate.verdict !== null && !agrees(r)).length,
      contaminationEvents: mine.filter((r) =>
        r.disqualifiers.some((d) => d === "contaminated" || d === "leaked"),
      ).length,
      countedVerified: mine.filter((r) => r.countedVerified).length,
      harnessFaults: mine.filter((r) => r.ledger === "harness-fault").length,
    };
  });
}

/** Stable JSON (sorted keys) for comparing a committed summary with a recomputed one. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** Every problem with a measurement artifact, as `CODE detail` strings (empty: it checks out). */
export function checkFleetMeasurement(m: FleetMeasurement): string[] {
  const p: string[] = [];
  if (m.schema !== FLEET_MEASUREMENT_SCHEMA) p.push("SCHEMA");
  if (m.simulated !== true) p.push("NOT_SIMULATED");
  if (m.evidence !== false || m.r1Evidence !== false || m.windowsRow !== false)
    p.push("CLAIMS_EVIDENCE");
  if (m.costEstimate !== null) p.push("COST_NOT_NULL");
  if (
    m.caps.maxDesktops !== FLEET_MAX_DESKTOPS ||
    m.caps.maxMemoryMbPerDesktop !== FLEET_MAX_MEMORY_MB_PER_DESKTOP ||
    m.caps.maxTotalMemoryMb !== FLEET_MAX_TOTAL_MEMORY_MB
  )
    p.push("CAPS_NOT_CODE_CAPS");
  const ks = new Set<number>();
  for (const lv of m.levels) {
    if (ks.has(lv.k)) p.push(`DUPLICATE_LEVEL k=${lv.k}`);
    ks.add(lv.k);
    for (const c of fleetCapProblems({
      desktops: lv.k,
      memoryMbPerDesktop: m.caps.memoryMbPerDesktop,
    }))
      p.push(`${c} k=${lv.k}`);
    if (lv.peakConcurrent > lv.k) p.push(`FLEET_PEAK_OVER_CAP k=${lv.k}`);
    const mine = m.rows.filter((r) => r.k === lv.k);
    if (mine.length !== lv.trials || lv.trials !== m.trialsPerK) p.push(`ROW_COUNT k=${lv.k}`);
    const idx = new Set(mine.map((r) => r.index));
    if (idx.size !== mine.length || [...idx].some((i) => i < 0 || i >= lv.trials))
      p.push(`ROW_INDEX k=${lv.k}`);
    const span = Math.max(0, ...mine.map((r) => r.startOffsetMs + r.elapsedMs));
    if (span > lv.wallMs) p.push(`ROW_SPAN_OVER_WALL k=${lv.k}`);
  }
  for (const r of m.rows) if (!ks.has(r.k)) p.push(`ORPHAN_ROW ${r.trialKey}`);
  const keys = new Set<string>();
  const runIds = new Set<string>();
  for (const r of m.rows) {
    if (keys.has(r.trialKey)) p.push(`DUPLICATE_TRIAL ${r.trialKey}`);
    if (runIds.has(r.runId)) p.push(`DUPLICATE_RUN ${r.runId}`);
    keys.add(r.trialKey);
    runIds.add(r.runId);
    if (r.countedVerified && (r.disqualifiers.length > 0 || r.gate.verdict !== "verified"))
      p.push(`COUNTED_DISQUALIFIED ${r.trialKey}`);
    if (r.countedVerified && !m.hostDirsHidden) p.push(`COUNTED_ON_SHARED_HOST ${r.trialKey}`);
  }
  if (stable(analyzeFleet(m.levels, m.rows)) !== stable(m.summary)) p.push("SUMMARY_MISMATCH");
  return p;
}
