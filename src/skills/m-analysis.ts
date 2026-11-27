/**
 * Track M's pre-registered analysis (capability-spec §2 M, §1.4, §1.5, §3), run by
 * `scripts/m-learning-analysis.ts` over one pack:
 *
 *   <pack>/pack.json          myco.skills.rep-pack/1: the pre-registration hash and commit,
 *                             the base surface and the I/J outcomes it was chosen from, the
 *                             frozen store head
 *   <pack>/rows.jsonl         myco.skills.rep-row/1: every learn and test trial
 *   <pack>/store/skills.jsonl the store as frozen after the learn phase
 *
 * It REFUSES a pack (result `refused`) whose pre-registration hash does not match the committed
 * pre-registration, whose analysis files changed since the freeze, or that mixes simulated and
 * real rows; a real pack is also refused while the pre-registration is not ratified. Otherwise
 * it computes the bar and reports `shown` or `not-shown` with every reason. Simulated packs
 * are plumbing: their result is `simulated`, never `shown`.
 *
 * The primary metric is the grader-verified rate on the 40 test units (§1.1 via
 * `repOutcome`); the gate's verdict is never the measurement. Nothing here is R1 evidence.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTaskSet } from "../benchmark/taskset.ts";
import { wilson } from "../foundry/stats.ts";
import {
  BASE_SURFACES,
  type BaseSurface,
  type BaseSurfaceBasis,
  type LoadedMPrereg,
  M_PREREG_PATH,
  mSchedule,
  preregHash,
  preregProblems,
  readMPrereg,
  repoFileSha256,
  resolveBaseSurface,
} from "./m-prereg.ts";
import { checkText, forbiddenValuesFor, isSimulatedPlanner } from "./record.ts";
import { type RepRow, repOutcome, repRowProblems } from "./rep-row.ts";
import { GENESIS, verifyLog } from "./store.ts";

export const REP_PACK_SCHEMA = "myco.skills.rep-pack/1";
export const M_REPORT_SCHEMA = "myco.skills.m-report/1" as const;

export interface RepPackMeta {
  readonly schema: typeof REP_PACK_SCHEMA;
  readonly preregHash: string;
  readonly preregCommit: string;
  readonly baseSurface: BaseSurface;
  readonly baseSurfaceBasis: BaseSurfaceBasis;
  /** The store head after the learn phase: what every skills-on trial read. */
  readonly storeHead: string;
  /** Declared up front: a simulated pack is plumbing and never shown. */
  readonly simulated: boolean;
}

export interface RepPack {
  readonly meta: RepPackMeta;
  readonly rows: readonly RepRow[];
  /** The frozen store's `skills.jsonl` text. */
  readonly storeText: string;
}

export interface RateCell {
  readonly verified: number;
  readonly n: number;
  readonly rate: number | null;
  readonly wilson95: readonly [number, number] | null;
}

export interface PairedCell {
  readonly units: number;
  readonly both: number;
  readonly skillsOnOnly: number;
  readonly coldOnly: number;
  readonly neither: number;
  readonly discordant: number;
  /** Exact one-sided McNemar p (skills-on better than cold). */
  readonly p: number;
  readonly skillsOn: RateCell;
  readonly cold: RateCell;
}

export interface PerVerified {
  readonly stepsPerVerified: number | null;
  readonly wallMsPerVerified: number | null;
  /** Token-derived ESTIMATE over ALL trials / verified; null when any cost is null. */
  readonly estimatedUsdPerVerified: number | null;
  readonly falseDone: number;
  readonly trials: number;
}

export interface MReport {
  readonly schema: typeof M_REPORT_SCHEMA;
  readonly preregHash: string;
  readonly result: "shown" | "not-shown" | "refused" | "simulated";
  readonly refusals: readonly string[];
  readonly notShown: readonly string[];
  readonly baseSurface: BaseSurface | null;
  readonly primary: PairedCell | null;
  readonly secondary: {
    readonly repeat: PairedCell;
    readonly similar: PairedCell;
    readonly skillsOn: PerVerified;
    readonly cold: PerVerified;
  } | null;
  readonly guardrails: {
    readonly storedSkills: number;
    readonly storedFromNonVerified: number;
    readonly storedSourceNotPass: number;
    readonly scanHits: number;
  } | null;
  readonly r1Evidence: false;
}

/** Exact one-sided McNemar: P(X >= a) for X ~ Binomial(a + b, 1/2). */
export function mcnemarExactOneSided(a: number, b: number): number {
  const n = a + b;
  if (n === 0) return 1;
  let p = 0;
  let c = 1;
  for (let k = 0; k <= n; k++) {
    if (k >= a) p += c;
    c = (c * (n - k)) / (k + 1);
  }
  return Math.min(1, p / 2 ** n);
}

const rateCell = (verified: number, n: number): RateCell => ({
  verified,
  n,
  rate: n === 0 ? null : verified / n,
  wilson95: wilson(verified, n),
});

function paired(units: readonly string[], on: Map<string, RepRow>, cold: Map<string, RepRow>) {
  let both = 0;
  let skillsOnOnly = 0;
  let coldOnly = 0;
  let neither = 0;
  for (const u of units) {
    const a = on.get(u)?.verified === true;
    const b = cold.get(u)?.verified === true;
    if (a && b) both++;
    else if (a) skillsOnOnly++;
    else if (b) coldOnly++;
    else neither++;
  }
  return {
    units: units.length,
    both,
    skillsOnOnly,
    coldOnly,
    neither,
    discordant: skillsOnOnly + coldOnly,
    p: mcnemarExactOneSided(skillsOnOnly, coldOnly),
    skillsOn: rateCell(both + skillsOnOnly, units.length),
    cold: rateCell(both + coldOnly, units.length),
  };
}

function perVerified(rows: readonly RepRow[]): PerVerified {
  const v = rows.filter((r) => r.verified).length;
  const sum = (f: (r: RepRow) => number | null) =>
    rows.some((r) => f(r) === null) ? null : rows.reduce((s, r) => s + (f(r) as number), 0);
  const per = (total: number | null) => (total === null || v === 0 ? null : total / v);
  return {
    stepsPerVerified: per(sum((r) => r.steps)),
    wallMsPerVerified: per(sum((r) => r.wallMs)),
    estimatedUsdPerVerified: per(sum((r) => r.estimatedUsd)),
    falseDone: rows.filter((r) => r.outcome === "false-done" || r.outcome === "ungraded").length,
    trials: rows.length,
  };
}

/** Forbidden values of a published task: its intent and every fixture data cell. */
let published: ReturnType<typeof buildTaskSet> | undefined;
function forbiddenFor(taskId: string) {
  published ??= buildTaskSet();
  const set = published;
  const t = set.tasks.find((x) => x.taskId === taskId);
  const csv = t === undefined ? undefined : set.fixtures.get(t.fixtureFile);
  if (t === undefined || csv === undefined) return null;
  const rows = csv
    .split("\n")
    .filter((l) => l.length > 0)
    .slice(1)
    .map((l) => l.split(","));
  return forbiddenValuesFor({ intent: t.intent, fixtureRows: rows });
}

/** Read the pre-registration as committed at `commit`, or null (git's answer, never guessed). */
export function gitReadCommitted(repoRoot: string) {
  return (commit: string, path: string): string | null => {
    if (!/^[0-9a-f]{40}$/.test(commit)) return null;
    const r = spawnSync("git", ["show", `${commit}:${path}`], { cwd: repoRoot, encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  };
}

export interface AnalyzeOptions {
  readonly loaded: LoadedMPrereg;
  /** SHA-256 of a repo file, for the analysis-files check. */
  readonly fileSha256: (path: string) => string | null;
  /** The pre-registration's text at a commit, for the "committed" check. */
  readonly readCommitted: (commit: string, path: string) => string | null;
}

export function analyzeMPack(pack: RepPack, o: AnalyzeOptions): MReport {
  const { prereg: p, hash, manifest } = o.loaded;
  const refusals: string[] = [];
  const notShown: string[] = [];
  const meta = pack.meta;
  const base = {
    schema: M_REPORT_SCHEMA,
    preregHash: hash,
    r1Evidence: false as const,
  };

  // ---- refusals: the pack cannot be analysed under this pre-registration -------------------
  for (const problem of preregProblems(o.loaded, o.fileSha256))
    refusals.push(`PREREG_INVALID: ${problem}`);
  if (meta?.schema !== REP_PACK_SCHEMA) refusals.push("PACK_SCHEMA");
  if (meta?.preregHash !== hash) refusals.push("PREREG_HASH_MISMATCH");
  const committed = o.readCommitted(meta?.preregCommit ?? "", M_PREREG_PATH);
  let committedHash: string | null = null;
  try {
    committedHash = committed === null ? null : preregHash(JSON.parse(committed));
  } catch {
    committedHash = null;
  }
  if (committedHash !== hash) refusals.push("PREREG_NOT_COMMITTED");
  const simulatedRows = pack.rows.filter((r) => isSimulatedPlanner(r.plannerModelId)).length;
  if (meta?.simulated !== true && simulatedRows > 0) refusals.push("SIMULATED_ROWS_NEVER_COUNT");
  if (meta?.simulated === true && simulatedRows !== pack.rows.length)
    refusals.push("REAL_ROWS_IN_SIMULATED_PACK");
  if (meta?.simulated !== true && p.ratification?.status !== "ratified")
    refusals.push("PREREG_NOT_RATIFIED");
  if (refusals.length > 0)
    return {
      ...base,
      result: "refused",
      refusals,
      notShown: [],
      baseSurface: null,
      primary: null,
      secondary: null,
      guardrails: null,
    };

  // ---- base surface and parity ------------------------------------------------------------
  const resolved = resolveBaseSurface(meta.baseSurfaceBasis);
  if (!resolved.ok) notShown.push(`BASE_SURFACE: ${resolved.code}`);
  else if (resolved.surface !== meta.baseSurface) notShown.push("BASE_SURFACE_NOT_THE_RULE'S");
  if (!(BASE_SURFACES as readonly string[]).includes(meta.baseSurface))
    notShown.push("BASE_SURFACE_UNKNOWN");
  for (const r of pack.rows) {
    for (const code of repRowProblems(r)) notShown.push(`ROW ${r.runId}: ${code}`);
    if (r.preregHash !== hash || r.preregCommit !== meta.preregCommit)
      notShown.push(`ROW ${r.runId}: PREREG`);
    if (r.baseSurface !== meta.baseSurface) notShown.push(`ROW ${r.runId}: PARITY_BASE_SURFACE`);
    if (r.stepBudget !== p.stepBudget) notShown.push(`ROW ${r.runId}: PARITY_STEP_BUDGET`);
    if (!meta.simulated && r.plannerModelId !== p.modelId)
      notShown.push(`ROW ${r.runId}: PARITY_MODEL`);
  }
  if (new Set(pack.rows.map((r) => r.plannerModelId)).size > 1) notShown.push("PARITY_MIXED_MODEL");
  if (new Set(pack.rows.map((r) => r.runId)).size !== pack.rows.length)
    notShown.push("DUPLICATE_RUN_ID");

  // ---- coverage and schedule (no exclusions: every scheduled trial must be present) ---------
  const schedule = mSchedule(manifest, p.seeds.assignment);
  const learnRows = pack.rows.filter((r) => r.phase === "learn");
  const testRows = pack.rows.filter((r) => r.phase === "test");
  const learnRef = new Map(manifest.learn.map((l) => [l.taskId, l]));
  const unitRef = new Map(manifest.test.map((u) => [u.unitId, u]));
  if (learnRows.length !== schedule.learn.length)
    notShown.push(`INCOMPLETE_LEARN: ${learnRows.length} of ${schedule.learn.length}`);
  for (const r of learnRows) {
    const l = learnRef.get(r.taskId);
    if (schedule.learn[r.scheduleIndex] !== r.taskId) notShown.push(`SCHEDULE ${r.runId}`);
    if (!l || l.instructionSha256 !== r.instructionSha256 || l.fixtureSha256 !== r.fixtureSha256)
      notShown.push(`TASK_MISMATCH ${r.runId}`);
    if (r.storeHead !== GENESIS) notShown.push(`LEARN_NOT_COLD ${r.runId}`);
  }
  if (testRows.length !== schedule.test.length)
    notShown.push(`INCOMPLETE_TEST: ${testRows.length} of ${schedule.test.length}`);
  const on = new Map<string, RepRow>();
  const cold = new Map<string, RepRow>();
  for (const r of testRows) {
    const slot = schedule.test[r.scheduleIndex];
    if (slot === undefined || slot.unitId !== r.unitId || slot.arm !== r.arm)
      notShown.push(`SCHEDULE ${r.runId}`);
    const u = unitRef.get(r.unitId ?? "");
    if (
      !u ||
      u.taskId !== r.taskId ||
      u.kind !== r.kind ||
      u.instructionSha256 !== r.instructionSha256 ||
      u.fixtureSha256 !== r.fixtureSha256
    )
      notShown.push(`TASK_MISMATCH ${r.runId}`);
    const into = r.arm === "skills-on" ? on : cold;
    if (into.has(r.unitId ?? "")) notShown.push(`DUPLICATE_TRIAL ${r.unitId} ${r.arm}`);
    into.set(r.unitId ?? "", r);
    if (r.arm === "skills-on" && r.storeHead !== meta.storeHead)
      notShown.push(`STORE_HEAD ${r.runId}`);
  }

  // ---- guardrails: the store holds only grader-confirmed, gate-verified learn outcomes ------
  let storedSkills = 0;
  let storedFromNonVerified = 0;
  let storedSourceNotPass = 0;
  let scanHits = 0;
  try {
    const { events, head } = verifyLog(pack.storeText);
    if (head !== meta.storeHead) notShown.push("STORE_HEAD_NOT_PACK_HEAD");
    const byRun = new Map(learnRows.map((r) => [r.runId, r]));
    const admitted = new Set<string>();
    for (const e of events) {
      if (e.type !== "admit") continue;
      storedSkills++;
      admitted.add(e.record.skillId);
      const src = byRun.get(e.record.provenance.runId);
      if (
        src === undefined ||
        repOutcome(src) !== "verified" ||
        src.admittedSkillId !== e.record.skillId ||
        src.taskId !== e.record.provenance.taskId ||
        e.record.provenance.simulated !== meta.simulated
      )
        storedFromNonVerified++;
      if (src?.grade?.status !== "pass") storedSourceNotPass++;
      const forbidden = forbiddenFor(e.record.provenance.taskId);
      const texts = [...e.record.preconditions, ...e.record.steps];
      if (forbidden === null || texts.some((t) => checkText(t, forbidden) !== null)) scanHits++;
    }
    for (const r of learnRows)
      if (r.admittedSkillId !== null && !admitted.has(r.admittedSkillId))
        notShown.push(`SKILL_NOT_IN_STORE ${r.runId}`);
  } catch {
    notShown.push("STORE_UNREADABLE");
  }
  if (storedFromNonVerified > 0)
    notShown.push(`GUARDRAIL_STORED_FROM_NON_VERIFIED: ${storedFromNonVerified}`);
  if (storedSourceNotPass > 0) notShown.push(`GUARDRAIL_SOURCE_NOT_PASS: ${storedSourceNotPass}`);
  if (scanHits > 0) notShown.push(`GUARDRAIL_SCAN: ${scanHits}`);

  // ---- the bar -----------------------------------------------------------------------------
  const units = manifest.test.map((u) => u.unitId);
  const primary = paired(units, on, cold);
  const ofKind = (k: string) => manifest.test.filter((u) => u.kind === k).map((u) => u.unitId);
  const secondary = {
    repeat: paired(ofKind("repeat"), on, cold),
    similar: paired(ofKind("similar"), on, cold),
    skillsOn: perVerified([...on.values()]),
    cold: perVerified([...cold.values()]),
  };
  if (primary.discordant < p.bar.minDiscordant)
    notShown.push(`UNDERPOWERED_AT_N: ${primary.discordant} discordant of ${primary.units}`);
  else if (primary.skillsOnOnly <= primary.coldOnly) notShown.push("DIRECTION");
  else if (!(primary.p <= p.bar.alpha)) notShown.push(`P_ABOVE_ALPHA: ${primary.p}`);

  return {
    ...base,
    result: meta.simulated ? "simulated" : notShown.length === 0 ? "shown" : "not-shown",
    refusals,
    notShown,
    baseSurface: meta.baseSurface,
    primary,
    secondary,
    guardrails: { storedSkills, storedFromNonVerified, storedSourceNotPass, scanHits },
  };
}

/** Read a pack directory. */
export function readRepPack(dir: string): RepPack {
  const meta = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as RepPackMeta;
  const rows = readFileSync(join(dir, "rows.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RepRow);
  const storeText = readFileSync(join(dir, "store", "skills.jsonl"), "utf8");
  return { meta, rows, storeText };
}

/** The CLI's whole job: read, analyse, return the report. */
export function analyzeMPackDir(repoRoot: string, packDir: string): MReport {
  return analyzeMPack(readRepPack(packDir), {
    loaded: readMPrereg(repoRoot),
    fileSha256: repoFileSha256(repoRoot),
    readCommitted: gitReadCommitted(repoRoot),
  });
}
