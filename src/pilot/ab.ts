/**
 * The corrections ON/OFF A/B RUNNER (track E follow-up, Tier 2): runs the two arms of the
 * pre-registered A/B on #524's pilot runner and produces the packs the A/B ANALYSIS (#547,
 * `src/m2/corrections-ab.ts`, `scripts/m2-corrections-ab.ts`) consumes. It does not analyse:
 * `analyzeAbPack` calls #547's CLI.
 *
 * The design is fixed by the pre-registration (`docs/benchmark/corrections-ab-prereg.md`, the
 * lead's decision verbatim, and its machine form `corrections-ab-prereg.json`), committed
 * before any run. Its SHA-256 is recorded in every arm config, run header and pack, and a pack
 * whose recorded hash is not the committed file's is refused (`checkAbPack`; #547 checks the
 * same with `--prereg-file` / `--prereg-declared`).
 *
 * What this module guarantees, each failing closed:
 *  - IDENTICAL ARMS: the two arm configs are byte-identical apart from `corrections`
 *    (`diffArmConfigs` refuses any other difference, at any depth), and so are their launch
 *    plans apart from the gate's own `--corrections` flag (`launchPlanDiff`).
 *  - SEEDED ORDER: the task order, the chunks and which arm runs first in each chunk come from
 *    the stage's pre-registered seed alone (`abSchedule`), are written to `schedule.json` on
 *    the first run and re-derived and compared on every resume.
 *  - PACING AND RESUME: each chunk runs each arm through `runPilot` (#524's pacing, PAUSE,
 *    lock, crash recovery, harness faults re-run in place under the topped-up-run ruling).
 *    A pause between chunks and a chunk budget per invocation leave headroom on Ultra.
 *  - #518: every attempt goes through `AttemptLedgerWriter` with its host-side anchor.
 *  - GATE MISS: every decided trial is graded by the independent grader as soon as it is
 *    decided; a trial the gate VERIFIED that the grader does not pass halts the whole run
 *    and writes an integrity-incident record. Nothing resumes until an operator acknowledges
 *    it with an ack file naming the record's sha256 (`ackIncident`; never automatic).
 *  - EXPERIMENT ONLY: every arm row, the OFF arm included, carries `experiment`, and every
 *    pack an `EXPERIMENT` marker: refused by `checkBenchmark(..., { evidence: true })` and the
 *    M2 pack CLI (`src/m2/provenance.ts`). A simulated run is also `SIMULATED`.
 *  - RESET BOOT CLASS: recorded per decided trial (`ab-trials.jsonl`); a live trial with a
 *    missing or non-cold boot class halts the run.
 *
 * Independence: this is harness code. It calls the grader (`src/benchmark/grade/`) and the gate
 * side by side; the grader still shares no code with the gate.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { HARNESS_CLASSES, m2TrialOpsSchema } from "../../schemas/m2-evidence.ts";
import { type BenchmarkArmRow, checkBenchmark } from "../benchmark/check.ts";
import { GATE_STATE_FILE } from "../benchmark/gated-rows.ts";
import { grade } from "../benchmark/grade/grade.ts";
import { type BenchmarkGradeRow, gradeRow } from "../benchmark/grade/row.ts";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import { AttemptLedgerWriter, anchorPathFor, verifyAttemptLedger } from "../m2/attempt-ledger.ts";
import { EXPERIMENT_FILE } from "../m2/provenance.ts";
import {
  canonicalJson,
  checkPacing,
  configSha256,
  type PacingConfig,
  type PilotConfig,
  pilotConfig,
} from "./config.ts";
import { trialLaunchPlan } from "./launch.ts";
import { loadLedger, PILOT_HARNESS_CLASSES, PROGRESS_FILE } from "./ledger.ts";
import { publishedTasks } from "./reviewed.ts";
import {
  type AttemptSink,
  type DecidedTrial,
  exportRun,
  PAUSE_FILE,
  type PilotDriver,
  type PilotTransport,
  runPilot,
  SIMULATED_FILE,
  SIMULATED_PLANNER_PREFIX,
} from "./runner.ts";

export const AB_EXPERIMENT = "corrections-ab";
export const PREREG_MD = "docs/benchmark/corrections-ab-prereg.md";
export const PREREG_JSON = "docs/benchmark/corrections-ab-prereg.json";
/** The lead's GO for real trials: a committed file. Absent until the lead gives it. */
export const LEAD_GO_FILE = "docs/benchmark/corrections-ab-go.json";
export const PREREG_SCHEMA = "myco.pilot.corrections-ab-prereg/1" as const;
export const AB_PACK_SCHEMA = "myco.pilot.corrections-ab-pack/1" as const;
export const AB_RUN_SCHEMA = "myco.pilot.corrections-ab-run/1" as const;
export const INCIDENT_SCHEMA = "myco.pilot.ab-integrity-incident/1" as const;
export const ACK_SCHEMA = "myco.pilot.ab-incident-ack/1" as const;
export const AB_EVIDENCE_USE = "experiment-only (never R1 evidence)" as const;
/** #547's analysis CLI. Present once #547 merges; until then `analyzeAbPack` says pending. */
export const ANALYSIS_SCRIPT = "scripts/m2-corrections-ab.ts";
export const ANALYSIS_MODULE = "src/m2/corrections-ab.ts";
export const AB_DRY_RUN_PLANNER = "simulated:corrections-ab-dry-run";

export type AbArm = "on" | "off";
export type AbStage = 0 | 1;
export const AB_ARMS: readonly AbArm[] = ["on", "off"];

/** Thrown for a refusal the operator must act on (exit 3 in the CLI), never a bug. */
export class AbRefusal extends Error {
  override name = "AbRefusal";
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const sha256File = (path: string) => sha256(readFileSync(path));

// ---------------------------------------------------------------------------------------------
// Pre-registration
// ---------------------------------------------------------------------------------------------

export interface AbStagePrereg {
  readonly role: string;
  readonly taskSet: "pilot-30" | "fc-v1";
  readonly pairs: number;
  readonly k: 1;
  readonly seed: string;
  readonly effectClaim: boolean;
}

export interface AbPrereg {
  readonly schema: typeof PREREG_SCHEMA;
  readonly experiment: typeof AB_EXPERIMENT;
  readonly markdown: string;
  readonly markdownSha256: string;
  readonly hypothesis: string;
  readonly primaryMetric: string;
  readonly successBar: string;
  readonly stages: { readonly "0": AbStagePrereg; readonly "1": AbStagePrereg };
  readonly test: {
    readonly name: string;
    readonly sided: "one-sided";
    readonly alpha: number;
    readonly miss: string;
    readonly report: readonly string[];
  };
  readonly pacing: {
    readonly trial: PacingConfig;
    readonly chunkPairs: number;
    readonly interChunkPauseS: number;
    readonly chunksPerInvocation: number;
  };
  readonly stoppingRule: readonly string[];
  readonly failClosed: string;
  readonly analysis: { readonly command: string; readonly module: string; readonly pr: number };
  readonly realRuns: string;
}

export interface LoadedPrereg {
  readonly prereg: AbPrereg;
  /** sha256 of the committed markdown: what packs record and #547 compares. */
  readonly markdownSha256: string;
  readonly jsonSha256: string;
}

/** Load and validate the committed pre-registration; throws with every problem named. */
export function loadPrereg(repoRoot: string): LoadedPrereg {
  const mdPath = join(repoRoot, PREREG_MD);
  const jsonPath = join(repoRoot, PREREG_JSON);
  const markdownSha256 = sha256File(mdPath);
  const jsonSha256 = sha256File(jsonPath);
  const p = JSON.parse(readFileSync(jsonPath, "utf8")) as AbPrereg;
  const problems: string[] = [];
  if (p.schema !== PREREG_SCHEMA) problems.push(`schema is not ${PREREG_SCHEMA}`);
  if (p.experiment !== AB_EXPERIMENT) problems.push(`experiment is not ${AB_EXPERIMENT}`);
  if (p.markdown !== PREREG_MD) problems.push(`markdown is not ${PREREG_MD}`);
  if (p.markdownSha256 !== markdownSha256)
    problems.push(
      `markdownSha256 ${p.markdownSha256} is not the committed ${PREREG_MD}'s ${markdownSha256}`,
    );
  const s0 = p.stages?.["0"];
  const s1 = p.stages?.["1"];
  if (s0?.taskSet !== "pilot-30" || s0.pairs !== 30 || s0.k !== 1 || s0.effectClaim !== false)
    problems.push("Stage 0 must be the pilot's 30 tasks, k 1, 30 pairs, no effect claim");
  if (s1?.taskSet !== "fc-v1" || s1.pairs !== 100 || s1.k !== 1 || s1.effectClaim !== true)
    problems.push("Stage 1 must be fc-v1, k 1, 100 pairs, the confirmatory effect claim");
  for (const [n, s] of [
    ["0", s0],
    ["1", s1],
  ] as const)
    if (typeof s?.seed !== "string" || !/^[A-Za-z0-9._:-]{8,64}$/.test(s.seed))
      problems.push(`Stage ${n} needs a seed of 8-64 safe characters`);
  if (s0?.seed === s1?.seed) problems.push("Stage 1's seed must be fresh (not Stage 0's)");
  if (p.test?.sided !== "one-sided" || p.test.alpha !== 0.05)
    problems.push("the primary test must be one-sided at alpha 0.05");
  if (!/sign test/i.test(p.test?.name ?? ""))
    problems.push("the primary test must be the exact sign test");
  if (!/never the gate/i.test(p.primaryMetric ?? ""))
    problems.push("the primary metric must be grader-verified, never the gate");
  if (!(p.analysis?.command ?? "").includes(ANALYSIS_SCRIPT))
    problems.push(`the analysis command must be ${ANALYSIS_SCRIPT} (#547)`);
  const pc = p.pacing;
  try {
    checkPacing(pc.trial);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (!Number.isInteger(pc?.chunkPairs) || pc.chunkPairs < 1 || pc.chunkPairs > 50)
    problems.push("pacing.chunkPairs must be an integer in [1, 50]");
  if (!Number.isInteger(pc?.interChunkPauseS) || pc.interChunkPauseS < 0)
    problems.push("pacing.interChunkPauseS must be a non-negative integer");
  if (!Number.isInteger(pc?.chunksPerInvocation) || pc.chunksPerInvocation < 1)
    problems.push("pacing.chunksPerInvocation must be a positive integer");
  if (problems.length > 0)
    throw new Error(`invalid corrections A/B pre-registration: ${problems.join("; ")}`);
  return { prereg: p, markdownSha256, jsonSha256 };
}

/**
 * Problems with the pre-registration's commit state: both files tracked by git and unchanged
 * from HEAD. A real run refuses unless this is empty ("committed BEFORE any run").
 */
export function preregCommitProblems(repoRoot: string): string[] {
  const out: string[] = [];
  for (const f of [PREREG_MD, PREREG_JSON]) {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", f], { cwd: repoRoot });
    if (tracked.status !== 0) {
      out.push(`${f} is not committed`);
      continue;
    }
    const clean = spawnSync("git", ["diff", "--quiet", "HEAD", "--", f], { cwd: repoRoot });
    if (clean.status !== 0) out.push(`${f} differs from the committed copy`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tasks, schedule, arm configs
// ---------------------------------------------------------------------------------------------

/** The stage's task ids: Stage 0 the pilot's 30 (`pilotConfig`), Stage 1 all of fc-v1. */
export function stageTasks(
  loaded: LoadedPrereg,
  stage: AbStage,
  published: readonly BenchmarkTask[],
): string[] {
  const s = loaded.prereg.stages[`${stage}`];
  const ids =
    s.taskSet === "pilot-30"
      ? [...pilotConfig(published).trials]
      : published
          .filter((t) => t.taskSetVersion === "fc-v1")
          .map((t) => t.taskId)
          .sort();
  if (ids.length !== s.pairs)
    throw new Error(`Stage ${stage} selects ${ids.length} tasks, pre-registered at ${s.pairs}`);
  return ids;
}

/** A deterministic integer in [0, n) from `seed` and a counter (sha256, no Math.random). */
function seededInt(seed: string, counter: number, n: number): number {
  const h = createHash("sha256").update(`${seed}:${counter}`).digest();
  return h.readUIntBE(0, 6) % n;
}

export interface AbChunk {
  readonly index: number;
  /** The chunk's task ids, in run order (each arm runs them in this order). */
  readonly tasks: readonly string[];
  /** Which arm runs the chunk first. */
  readonly armOrder: readonly [AbArm, AbArm];
}

/**
 * The seeded schedule: a Fisher-Yates shuffle of the tasks by `seed`, cut into chunks of
 * `chunkPairs`, and per chunk a seeded coin for which arm goes first. Pure: the same seed and
 * tasks always give the same schedule.
 */
export function abSchedule(
  seed: string,
  taskIds: readonly string[],
  chunkPairs: number,
): AbChunk[] {
  const order = [...taskIds].sort();
  let c = 0;
  for (let i = order.length - 1; i > 0; i--) {
    const j = seededInt(seed, c++, i + 1);
    [order[i], order[j]] = [order[j] as string, order[i] as string];
  }
  const chunks: AbChunk[] = [];
  for (let i = 0; i < order.length; i += chunkPairs) {
    const onFirst = seededInt(seed, 1_000_000 + chunks.length, 2) === 0;
    chunks.push({
      index: chunks.length,
      tasks: order.slice(i, i + chunkPairs),
      armOrder: onFirst ? ["on", "off"] : ["off", "on"],
    });
  }
  return chunks;
}

export const trialKeyPrefix = (stage: AbStage, arm: AbArm) => `ab-s${stage}-${arm}`;
export const experimentLabel = (stage: AbStage) => `${AB_EXPERIMENT}/stage-${stage}`;

/** One arm's runner config: the pilot config with the stage's trials, the arm and the stage. */
export function armConfig(
  loaded: LoadedPrereg,
  stage: AbStage,
  arm: AbArm,
  published: readonly BenchmarkTask[],
): PilotConfig {
  const base = pilotConfig(published, loaded.prereg.pacing.trial);
  return {
    ...base,
    trials: stageTasks(loaded, stage, published),
    corrections: arm,
    experiment: { name: AB_EXPERIMENT, stage, preregSha256: loaded.markdownSha256 },
  };
}

function diffPaths(a: unknown, b: unknown, path: string, out: string[]): void {
  if (canonicalJson(a) === canonicalJson(b)) return;
  const obj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (obj(a) && obj(b)) {
    const ka = a as Record<string, unknown>;
    const kb = b as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(ka), ...Object.keys(kb)])].sort())
      diffPaths(ka[k], kb[k], path === "" ? k : `${path}.${k}`, out);
    return;
  }
  out.push(path === "" ? "(root)" : path);
}

/**
 * The paths at which the two arm configs differ, other than `corrections`, plus a problem if
 * either arm's `corrections` is not its own. Empty means the arms are identical apart from
 * corrections; anything else refuses the run (and the pack).
 */
export function diffArmConfigs(on: unknown, off: unknown): string[] {
  const out: string[] = [];
  const onC = (on as { corrections?: unknown } | null)?.corrections;
  const offC = (off as { corrections?: unknown } | null)?.corrections;
  if (onC !== "on") out.push(`the ON arm's corrections is ${JSON.stringify(onC)}, not "on"`);
  if (offC !== "off") out.push(`the OFF arm's corrections is ${JSON.stringify(offC)}, not "off"`);
  const paths: string[] = [];
  diffPaths(on, off, "", paths);
  for (const p of paths.filter((p) => p !== "corrections"))
    out.push(`the arms differ at ${p} (only corrections may differ)`);
  return out;
}

/**
 * The launch plans of the two arms for one task differ only by the gate's own
 * `--corrections <families>` suffix on the ON arm's gate server. Returns the problems.
 */
export function launchPlanDiff(
  on: PilotConfig,
  off: PilotConfig,
  task: BenchmarkTask,
  repoRoot: string,
): string[] {
  const ids = { runId: "ab-plan-check", trialKey: "ab-plan-check" };
  const dir = resolve(repoRoot, "runs", "ab-plan-check");
  const a = trialLaunchPlan(on, task, ids, dir, repoRoot);
  const b = trialLaunchPlan(off, task, ids, dir, repoRoot);
  const out: string[] = [];
  if (canonicalJson(a.argv) !== canonicalJson(b.argv)) out.push("the agent argv differs");
  if (a.mcpConfigPath !== b.mcpConfigPath) out.push("the MCP config path differs");
  const names = Object.keys(a.mcpServers).sort();
  if (canonicalJson(names) !== canonicalJson(Object.keys(b.mcpServers).sort()))
    out.push("the MCP server set differs");
  for (const n of names) {
    const sa = a.mcpServers[n];
    const sb = b.mcpServers[n];
    if (sa === undefined || sb === undefined) continue;
    if (sa.command !== sb.command || canonicalJson(sa.env) !== canonicalJson(sb.env))
      out.push(`server ${n} differs beyond its args`);
    const extra = sa.args.slice(sb.args.length);
    const prefixSame = canonicalJson(sa.args.slice(0, sb.args.length)) === canonicalJson(sb.args);
    const okSuffix =
      extra.length === 0 ||
      (extra.length === 2 && extra[0] === "--corrections" && n === "myco-gate");
    if (!prefixSame || !okSuffix)
      out.push(`server ${n}'s args differ beyond the ON arm's --corrections flag`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Integrity incidents (gate misses)
// ---------------------------------------------------------------------------------------------

export interface IntegrityIncident {
  readonly schema: typeof INCIDENT_SCHEMA;
  readonly kind: "gate-miss";
  readonly stage: AbStage;
  readonly arm: AbArm;
  readonly trialKey: string;
  readonly taskId: string;
  readonly gateVerdict: "verified";
  readonly accepted: boolean;
  readonly graderStatus: "fail" | "ungradable";
  readonly graderVersion: string;
  readonly persistedSha256: string | null;
  readonly at: string;
  readonly rule: string;
}

export const incidentsDir = (stageRoot: string) => join(stageRoot, "incidents");

export interface IncidentStatus {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly acknowledged: boolean;
  readonly problem: string | null;
}

/** Every incident under the stage root and whether a valid operator ack file covers it. */
export function incidentStatus(stageRoot: string): IncidentStatus[] {
  const dir = incidentsDir(stageRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".ack.json"))
    .sort()
    .map((f) => {
      const id = f.slice(0, -".json".length);
      const path = join(dir, f);
      const sha = sha256File(path);
      const ackPath = join(dir, `${id}.ack.json`);
      let problem: string | null = null;
      if (!existsSync(ackPath)) problem = "no operator ack file";
      else {
        try {
          const ack = JSON.parse(readFileSync(ackPath, "utf8")) as Record<string, unknown>;
          if (ack.schema !== ACK_SCHEMA) problem = `ack schema is not ${ACK_SCHEMA}`;
          else if (ack.incidentSha256 !== sha)
            problem = "the ack names a different incident sha256 (re-read the record and ack it)";
          else if (typeof ack.operator !== "string" || ack.operator.trim() === "")
            problem = "the ack names no operator";
          else if (typeof ack.statement !== "string" || ack.statement.trim().length < 10)
            problem = "the ack carries no statement of what was reviewed";
        } catch {
          problem = "the ack file is not JSON";
        }
      }
      return { id, path, sha256: sha, acknowledged: problem === null, problem };
    });
}

/** Refuse when any incident under the stage root is not acknowledged by an operator. */
export function assertNoPendingIncidents(stageRoot: string): void {
  const pending = incidentStatus(stageRoot).filter((i) => !i.acknowledged);
  if (pending.length > 0)
    throw new AbRefusal(
      `refusing to resume: ${pending.length} unacknowledged integrity incident(s) (gate VERIFIED, grader did not pass): ${pending.map((i) => `${i.path} (${i.problem})`).join("; ")}. ` +
        "Review each record, file it, then acknowledge it with `ack-incident` (see docs/benchmark/pilot-runbook.md, corrections A/B). Never automatic.",
    );
}

/**
 * Write an operator's ack for one incident. The operator must name the record's sha256 (so
 * the ack is for the record they read). The runner never calls this; only the CLI's
 * `ack-incident`, run by a person, does.
 */
export function ackIncident(
  stageRoot: string,
  id: string,
  ack: { readonly operator: string; readonly statement: string; readonly incidentSha256: string },
  now: () => number = Date.now,
): string {
  const st = incidentStatus(stageRoot).find((i) => i.id === id);
  if (st === undefined) throw new AbRefusal(`no incident ${id} under ${incidentsDir(stageRoot)}`);
  if (ack.incidentSha256 !== st.sha256)
    throw new AbRefusal(
      `incident ${id}'s sha256 is ${st.sha256}, not ${ack.incidentSha256}: read the record first`,
    );
  if (ack.operator.trim() === "" || ack.statement.trim().length < 10)
    throw new AbRefusal("an ack needs an operator and a statement of what was reviewed");
  const path = join(incidentsDir(stageRoot), `${id}.ack.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ schema: ACK_SCHEMA, incident: id, ...ack, at: new Date(now()).toISOString() }, null, 2)}\n`,
    { flag: "wx" },
  );
  return path;
}

// ---------------------------------------------------------------------------------------------
// Grading, #518 sink, per-trial records
// ---------------------------------------------------------------------------------------------

/** Grade one decided trial's captured bytes with the independent grader. */
export type GradeFn = (
  task: BenchmarkTask,
  persisted: Uint8Array | null,
  trialKey: string,
) => BenchmarkGradeRow;

/** The real grader on the published bundle (the gate never sees this, nor this the gate). */
export function bundleGrader(bundleDir: string): GradeFn {
  return (task, persisted, trialKey) =>
    gradeRow(
      trialKey,
      task.taskId,
      grade({
        fixtureCsv: readFileSync(join(bundleDir, task.fixtureFile)),
        fixtureSha256: task.fixtureSha256,
        // The gate reads CSV only (until the xlsx gate lands): the captured document is CSV.
        persisted: persisted === null ? null : { format: "csv", bytes: persisted },
        intent: task.intent,
        columnTypes: task.columnTypes,
      }),
    );
}

export const GRADES_FILE = "grades.jsonl";
export const AB_TRIALS_FILE = "ab-trials.jsonl";
export const R1_LEDGER_FILE = "attempts.jsonl";
/** Faulted attempts whose pilot class #518's vocabulary cannot name (see `R1AttemptSink`). */
export const R1_UNCLASSIFIED_FILE = "attempts-unclassified.jsonl";

/** The pilot harness classes #518's attempt-event schema can name (today only `timeout`). */
export function r1Nameable(pilotClass: string): boolean {
  return (HARNESS_CLASSES as readonly string[]).includes(pilotClass);
}

/**
 * #518's attempt ledger for one arm directory: `<armDir>/attempts.jsonl`, chained, with its
 * host-side anchor at `anchorPathFor(armDir)`; refused inside the agent's trial directories.
 *
 * #518's event schema names harness faults from the M2 VM vocabulary (`HARNESS_CLASSES`:
 * convert-deadline, deploy-copy, sshd, timeout, load). The pilot's transport faults
 * (rate-limit, auth, error-result, crash, spawn-failed, transport-error) have no name there,
 * and writing a wrong class into a tamper-evident ledger would be a false record. So a fault
 * #518 can name is ended with its own class; one it cannot is NOT ended in #518 (the attempt
 * stays open there, which the chain allows) and is written, with its exact pilot class, to
 * `attempts-unclassified.jsonl` beside it; the pack discloses the count. A real run refuses
 * until #518's vocabulary covers the pilot's classes (`realRunRefusals`; TO FILE).
 */
export class R1AttemptSink implements AttemptSink {
  readonly path: string;
  readonly anchorPath: string;
  readonly #writer: AttemptLedgerWriter;

  constructor(armDir: string) {
    this.path = join(armDir, R1_LEDGER_FILE);
    this.anchorPath = anchorPathFor(armDir);
    this.#writer = new AttemptLedgerWriter(this.path, {
      anchorPath: this.anchorPath,
      forbiddenRoots: [join(armDir, "trials")],
    });
  }

  start(a: { trialKey: string; taskId: string }): void {
    this.#writer.start({ ...a, arm: "myco-gate" });
  }

  end(
    trialKey: string,
    result: { outcome: "completed" } | { outcome: "harness-fault"; harnessClass: string },
  ): void {
    if (result.outcome === "harness-fault" && !r1Nameable(result.harnessClass)) {
      appendFileSync(
        join(dirname(this.path), R1_UNCLASSIFIED_FILE),
        `${JSON.stringify({ schema: "myco.pilot.ab-r1-unclassified/1", trialKey, outcome: "harness-fault", pilotHarnessClass: result.harnessClass })}\n`,
      );
      return;
    }
    this.#writer.end(trialKey, result);
  }

  /** Close an attempt the runner died in: start it first if the crash beat its start event. */
  recoverCrash(a: { trialKey: string; taskId: string }): void {
    const lines = existsSync(this.path)
      ? readFileSync(this.path, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as unknown)
      : [];
    const events = verifyAttemptLedger(lines).events.filter((e) => e.trialKey === a.trialKey);
    const started = events.some((e) => e.kind === "start");
    const unclassified = readJsonl(join(dirname(this.path), R1_UNCLASSIFIED_FILE)).some(
      (u) => (u as { trialKey?: string }).trialKey === a.trialKey,
    );
    const ended = events.some((e) => e.kind === "end") || unclassified;
    if (ended) return;
    if (!started) this.start(a);
    this.end(a.trialKey, { outcome: "harness-fault", harnessClass: "crash" });
  }
}

const readJsonl = (path: string): unknown[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as unknown)
    : [];

interface AbTrialRecord {
  readonly schema: "myco.pilot.ab-trial/1";
  readonly trialKey: string;
  readonly arm: AbArm;
  readonly stage: AbStage;
  /** #546's boot class, or null when the transport did not measure it. */
  readonly resetBootClass: "cold" | "fast" | null;
  readonly hostLoad1mStart: number;
  readonly graderStatus: BenchmarkGradeRow["status"];
  readonly gateVerdict: string | null;
}

interface HookContext {
  readonly stageRoot: string;
  readonly armDir: string;
  readonly stage: AbStage;
  readonly arm: AbArm;
  readonly grader: GradeFn;
  readonly live: boolean;
  readonly now: () => number;
  readonly load1m: () => number;
}

/**
 * Record a decided trial's grade and boot class, and decide whether it halts the run: a gate
 * miss (an integrity incident, recorded first) or, on a live run, a reset that is not a
 * recorded cold boot.
 */
function recordDecided(
  ctx: HookContext,
  d: Pick<DecidedTrial, "task" | "trialKey" | "armRow" | "persisted"> & {
    readonly resetBootClass: "cold" | "fast" | null;
  },
): string | null {
  const g = ctx.grader(d.task, d.persisted, d.trialKey);
  appendFileSync(join(ctx.armDir, GRADES_FILE), `${JSON.stringify(g)}\n`);
  const rec: AbTrialRecord = {
    schema: "myco.pilot.ab-trial/1",
    trialKey: d.trialKey,
    arm: ctx.arm,
    stage: ctx.stage,
    resetBootClass: d.resetBootClass,
    hostLoad1mStart: Math.max(0, ctx.load1m()),
    graderStatus: g.status,
    gateVerdict: d.armRow.gate?.verdict ?? null,
  };
  appendFileSync(join(ctx.armDir, AB_TRIALS_FILE), `${JSON.stringify(rec)}\n`);
  if (d.armRow.gate?.verdict === "verified" && g.status !== "pass") {
    const incident: IntegrityIncident = {
      schema: INCIDENT_SCHEMA,
      kind: "gate-miss",
      stage: ctx.stage,
      arm: ctx.arm,
      trialKey: d.trialKey,
      taskId: d.task.taskId,
      gateVerdict: "verified",
      accepted: d.armRow.accepted,
      graderStatus: g.status,
      graderVersion: g.graderVersion,
      persistedSha256: d.armRow.persistedSha256,
      at: new Date(ctx.now()).toISOString(),
      rule: "fail-closed: a gate miss (gate VERIFIED, grader fails) is an integrity incident; the run halts and nothing resumes until an operator acknowledges this record",
    };
    mkdirSync(incidentsDir(ctx.stageRoot), { recursive: true });
    const path = join(incidentsDir(ctx.stageRoot), `incident-${d.trialKey}.json`);
    writeFileSync(path, `${JSON.stringify(incident, null, 2)}\n`, { flag: "wx" });
    return `HALTED: integrity incident, the gate VERIFIED ${d.trialKey} and the independent grader says ${g.status}; record ${path}. Nothing resumes until an operator acknowledges it (ack-incident).`;
  }
  if (ctx.live && d.resetBootClass !== "cold")
    return `HALTED: ${d.trialKey}'s reset boot class is ${d.resetBootClass ?? "unrecorded"}, not a recorded cold boot (#546's guard); review before resuming`;
  return null;
}

/**
 * Grade decided trials that have no grade yet (the runner died between deciding a trial and
 * grading it), from the saved document. Returns the first halt reason, if any.
 */
function reconcileGrades(ctx: HookContext, published: readonly BenchmarkTask[]): string | null {
  const state = loadLedger(join(ctx.armDir, PROGRESS_FILE));
  if (state.header === null) return null;
  const graded = new Set(
    readJsonl(join(ctx.armDir, GRADES_FILE)).map((g) => (g as { trialKey: string }).trialKey),
  );
  const byId = new Map(published.map((t) => [t.taskId, t]));
  let halt: string | null = null;
  for (const list of state.byTask.values())
    for (const rec of list) {
      if (rec.end?.outcome !== "decided" || rec.end.armRow === null) continue;
      if (graded.has(rec.start.trialKey)) continue;
      const doc = join(ctx.armDir, "trials", rec.start.trialKey, "doc.csv");
      const why = recordDecided(ctx, {
        task: byId.get(rec.start.taskId) as BenchmarkTask,
        trialKey: rec.start.trialKey,
        armRow: rec.end.armRow,
        persisted: existsSync(doc) ? readFileSync(doc) : null,
        resetBootClass: null,
      });
      halt ??= why;
    }
  return halt;
}

// ---------------------------------------------------------------------------------------------
// Running a stage
// ---------------------------------------------------------------------------------------------

export interface AbRunOptions {
  readonly repoRoot: string;
  readonly published: readonly BenchmarkTask[];
  readonly loaded: LoadedPrereg;
  readonly stage: AbStage;
  /** The A/B root; the stage runs in `<outRoot>/stage<N>/{on,off}`. */
  readonly outRoot: string;
  readonly driver: PilotDriver;
  readonly plannerModelId: string;
  readonly oracleSources: readonly string[];
  readonly grader?: GradeFn;
  /** Chunks with work to run in this invocation (default: the pre-registered budget). */
  readonly maxChunks?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly load1m?: () => number;
  /** Live only: the plan sha the operator approved (`abPlanSha256`), passed on per arm. */
  readonly liveLaunchSha256?: string;
}

export interface AbRunResult {
  readonly status: "complete" | "paused" | "incomplete" | "halted";
  readonly reason: string | null;
  readonly stage: AbStage;
  readonly chunksRun: number;
  readonly chunksDone: number;
  readonly chunks: number;
}

export const stageRoot = (outRoot: string, stage: AbStage) =>
  join(resolve(outRoot), `stage${stage}`);

/** How far a stage is: decided trials over both arms, and its incidents. Never a p-value. */
export function stageProgress(
  outRoot: string,
  stage: AbStage,
): {
  readonly started: boolean;
  readonly decided: number;
  readonly expected: number;
  readonly faultedAttempts: number;
  readonly incidents: number;
  readonly unacknowledged: number;
  readonly complete: boolean;
} {
  const root = stageRoot(outRoot, stage);
  const headerPath = join(root, "ab-run.json");
  const incidents = incidentStatus(root);
  if (!existsSync(headerPath))
    return {
      started: false,
      decided: 0,
      expected: 0,
      faultedAttempts: 0,
      incidents: incidents.length,
      unacknowledged: incidents.filter((i) => !i.acknowledged).length,
      complete: false,
    };
  const schedule = JSON.parse(readFileSync(join(root, "schedule.json"), "utf8")) as AbChunk[];
  const expected = 2 * schedule.reduce((n, c) => n + c.tasks.length, 0);
  let decided = 0;
  let faultedAttempts = 0;
  for (const arm of AB_ARMS) {
    const state = loadLedger(join(root, arm, PROGRESS_FILE));
    for (const list of state.byTask.values())
      for (const rec of list) {
        if (rec.end?.outcome === "decided") decided++;
        else if (rec.end?.outcome === "harness-fault") faultedAttempts++;
      }
  }
  return {
    started: true,
    decided,
    expected,
    faultedAttempts,
    incidents: incidents.length,
    unacknowledged: incidents.filter((i) => !i.acknowledged).length,
    complete: decided === expected,
  };
}

/** The identity of a stage's plan: both arm configs, the schedule and the pre-registration. */
export function abPlanSha256(
  loaded: LoadedPrereg,
  stage: AbStage,
  published: readonly BenchmarkTask[],
): string {
  const on = armConfig(loaded, stage, "on", published);
  const off = armConfig(loaded, stage, "off", published);
  const schedule = abSchedule(
    loaded.prereg.stages[`${stage}`].seed,
    stageTasks(loaded, stage, published),
    loaded.prereg.pacing.chunkPairs,
  );
  return sha256(
    canonicalJson({
      on: configSha256(on),
      off: configSha256(off),
      schedule,
      prereg: loaded.markdownSha256,
      preregJson: loaded.jsonSha256,
    }),
  );
}

/** The arm configs, refused unless identical apart from corrections (config and launch plan). */
export function checkedArmConfigs(
  loaded: LoadedPrereg,
  stage: AbStage,
  published: readonly BenchmarkTask[],
  repoRoot: string,
): { readonly on: PilotConfig; readonly off: PilotConfig } {
  const on = armConfig(loaded, stage, "on", published);
  const off = armConfig(loaded, stage, "off", published);
  const problems = diffArmConfigs(on, off);
  const first = published.find((t) => t.taskId === on.trials[0]);
  if (first !== undefined) problems.push(...launchPlanDiff(on, off, first, repoRoot));
  if (problems.length > 0)
    throw new AbRefusal(
      `the A/B arms are not identical apart from corrections: ${problems.join("; ")}`,
    );
  return { on, off };
}

export async function runAbStage(opts: AbRunOptions): Promise<AbRunResult> {
  const { loaded, stage, published } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const simulated = opts.plannerModelId.startsWith(SIMULATED_PLANNER_PREFIX);
  const root = stageRoot(opts.outRoot, stage);
  if (!simulated && opts.liveLaunchSha256 !== abPlanSha256(loaded, stage, published))
    throw new AbRefusal(
      "a live A/B run needs liveLaunchSha256 equal to the approved plan's abPlanSha256 (the CLI's --plan-sha256)",
    );
  mkdirSync(root, { recursive: true });

  // 1. Nothing resumes over an unacknowledged incident; Stage 1 needs a clean Stage 0.
  assertNoPendingIncidents(root);
  if (stage === 1) {
    const s0 = stageProgress(opts.outRoot, 0);
    if (!s0.complete)
      throw new AbRefusal(
        `Stage 1 starts only after Stage 0 is complete in ${opts.outRoot} (${s0.decided}/${s0.expected} trials decided)`,
      );
    if (s0.incidents > 0)
      throw new AbRefusal(
        `Stage 1 starts only after a Stage 0 with zero gate misses; Stage 0 recorded ${s0.incidents} integrity incident(s) (a lead decision, not an ack, reopens this)`,
      );
  }

  // 2. The arms, the schedule and the run header (re-derived and compared on resume).
  const configs = checkedArmConfigs(loaded, stage, published, opts.repoRoot);
  const s = loaded.prereg.stages[`${stage}`];
  const schedule = abSchedule(s.seed, configs.on.trials, loaded.prereg.pacing.chunkPairs);
  const header = {
    schema: AB_RUN_SCHEMA,
    experiment: AB_EXPERIMENT,
    stage,
    simulated,
    plannerModelId: opts.plannerModelId,
    preregSha256: loaded.markdownSha256,
    preregJsonSha256: loaded.jsonSha256,
    seed: s.seed,
    configSha256: { on: configSha256(configs.on), off: configSha256(configs.off) },
    scheduleSha256: sha256(canonicalJson(schedule)),
  };
  const headerPath = join(root, "ab-run.json");
  if (existsSync(headerPath)) {
    const prior = JSON.parse(readFileSync(headerPath, "utf8")) as unknown;
    if (canonicalJson(prior) !== canonicalJson(header))
      throw new AbRefusal(
        `${headerPath} was written under a different plan (pre-registration, seed, configs, schedule, mode or planner): a changed plan is a new A/B directory`,
      );
  } else {
    writeFileSync(headerPath, `${JSON.stringify(header, null, 2)}\n`);
    writeFileSync(join(root, "schedule.json"), `${JSON.stringify(schedule, null, 2)}\n`);
    writeFileSync(
      join(root, EXPERIMENT_FILE),
      `Corrections ON/OFF A/B, Stage ${stage}: ${AB_EVIDENCE_USE}. Both arms, the OFF arm included.\n`,
    );
    if (simulated)
      writeFileSync(
        join(root, SIMULATED_FILE),
        "SIMULATED corrections A/B dry run. Fake transport, no model, no VM, $0. Never evidence.\n",
      );
  }

  const grader =
    opts.grader ?? bundleGrader(join(opts.repoRoot, "benchmark", "false-completion", "fc-v1"));
  const maxChunks = opts.maxChunks ?? loaded.prereg.pacing.chunksPerInvocation;
  const pauseFiles = [join(root, PAUSE_FILE), join(resolve(opts.outRoot), PAUSE_FILE)];
  let chunksRun = 0;
  let chunksDone = 0;

  for (const chunk of schedule) {
    let worked = false;
    for (const arm of chunk.armOrder) {
      const armDir = join(root, arm);
      mkdirSync(armDir, { recursive: true });
      const ctx: HookContext = {
        stageRoot: root,
        armDir,
        stage,
        arm,
        grader,
        live: !simulated,
        now,
        load1m: opts.load1m ?? (() => loadavg()[0] ?? 0),
      };
      // A trial decided but never graded (a crash in between) is graded now, before anything
      // else runs: a gate miss there halts here.
      const missed = reconcileGrades(ctx, published);
      if (missed !== null) return result("halted", missed);
      assertNoPendingIncidents(root);
      if (pauseFiles.some((p) => existsSync(p)))
        return result(
          "paused",
          `paused: ${PAUSE_FILE} file present; remove it and re-run to resume`,
        );

      const r = await runPilot({
        config: configs[arm],
        published,
        outDir: armDir,
        repoRoot: opts.repoRoot,
        oracleSources: opts.oracleSources,
        driver: opts.driver,
        plannerModelId: opts.plannerModelId,
        sleep,
        now,
        log,
        trialKeyPrefix: trialKeyPrefix(stage, arm),
        only: chunk.tasks,
        attemptSink: new R1AttemptSink(armDir),
        armRowLabel: { experiment: experimentLabel(stage) },
        pauseFiles,
        afterDecided: (d) =>
          recordDecided(ctx, {
            task: d.task,
            trialKey: d.trialKey,
            armRow: d.armRow,
            persisted: d.persisted,
            resetBootClass: d.report.resetBootClass ?? null,
          }),
        // The operator approved the whole stage plan (checked above); each arm's runner then
        // gets its own config's sha256, which is what `runPilot` demands of a live driver.
        ...(simulated ? {} : { liveLaunchSha256: configSha256(configs[arm]) }),
      });
      if (r.ran + r.faulted > 0) worked = true;
      if (r.status !== "complete")
        return result(r.status, `chunk ${chunk.index}, arm ${arm}: ${r.reason ?? r.status}`);
    }
    chunksDone++;
    if (worked) {
      chunksRun++;
      log(`stage ${stage}: chunk ${chunk.index} done (${chunk.armOrder.join(" then ")})`);
      if (chunksDone < schedule.length) {
        if (chunksRun >= maxChunks)
          return result(
            "paused",
            `paused after ${chunksRun} chunk(s) (the per-invocation budget, for builder and verifier headroom); re-run the same command to continue`,
          );
        await sleep(loaded.prereg.pacing.interChunkPauseS * 1000);
      }
    }
  }
  return result("complete", null);

  function result(status: AbRunResult["status"], reason: string | null): AbRunResult {
    return { status, reason, stage, chunksRun, chunksDone, chunks: schedule.length };
  }
}

/**
 * The simulated driver for the A/B: #524's fake (the scripted credulous agent) plus a
 * simulated cold reset, so the boot-class path is exercised. Never evidence.
 */
export function abFakeDriver(inner: PilotDriver): PilotDriver {
  if (!inner.simulated) throw new Error("abFakeDriver wraps simulated drivers only");
  return {
    simulated: true,
    transport(ctx): PilotTransport {
      const t = inner.transport(ctx);
      return {
        runAgent: (p, g) => t.runAgent(p, g),
        captureAfterStop: () => t.captureAfterStop(),
        report: () => ({ ...t.report(), resetBootClass: "cold" }),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------------------------

export interface AbPackManifest {
  readonly schema: typeof AB_PACK_SCHEMA;
  readonly experiment: typeof AB_EXPERIMENT;
  readonly stage: AbStage;
  readonly evidenceUse: typeof AB_EVIDENCE_USE;
  readonly simulated: boolean;
  readonly prereg: {
    readonly markdown: string;
    readonly markdownSha256: string;
    readonly json: string;
    readonly jsonSha256: string;
  };
  readonly configSha256: { readonly on: string; readonly off: string };
  readonly scheduleSha256: string;
  readonly attemptLedgers: Readonly<
    Record<AbArm, { events: number; anchorEntries: number; unclassifiedFaultEnds: number }>
  >;
  readonly incidents: readonly { id: string; sha256: string; acknowledged: boolean }[];
  readonly analysis: string;
}

/**
 * Export a stage as an A/B pack: `<pack>/{on,off}/{arm.jsonl, grades.jsonl, run-config.json,
 * faulted-attempts.jsonl, ab-trials.jsonl, attempts.jsonl, docs/}`, `ab-pack.json` and the
 * `EXPERIMENT` marker (plus `SIMULATED` for a dry run). No `pack.json`: an A/B pack is not an
 * M2 evidence pack. Refuses an existing directory, an ungraded decided trial, or arms that
 * differ apart from corrections.
 */
export function exportAbPack(
  outRoot: string,
  stage: AbStage,
  packDir: string,
  repoRoot: string,
): AbPackManifest {
  const root = stageRoot(outRoot, stage);
  const headerPath = join(root, "ab-run.json");
  if (!existsSync(headerPath)) throw new AbRefusal(`${root} has no A/B run`);
  if (existsSync(packDir)) throw new AbRefusal(`${packDir} exists: an export never overwrites`);
  const header = JSON.parse(readFileSync(headerPath, "utf8")) as {
    simulated: boolean;
    preregSha256: string;
    preregJsonSha256: string;
    configSha256: { on: string; off: string };
    scheduleSha256: string;
  };
  const configs: Partial<Record<AbArm, PilotConfig>> = {};
  const ledgerOf: Partial<Record<AbArm, AbPackManifest["attemptLedgers"][AbArm]>> = {};
  mkdirSync(packDir, { recursive: true });
  for (const arm of AB_ARMS) {
    const armDir = join(root, arm);
    const dest = join(packDir, arm);
    const { armRows } = exportRun(armDir, dest);
    const grades = readJsonl(join(armDir, GRADES_FILE)) as BenchmarkGradeRow[];
    const byKey = new Map(grades.map((g) => [g.trialKey, g]));
    const missing = armRows.filter((r) => !byKey.has(r.trialKey)).map((r) => r.trialKey);
    if (missing.length > 0)
      throw new AbRefusal(`${arm}: ${missing.length} decided trial(s) not graded (${missing[0]})`);
    writeFileSync(
      join(dest, GRADES_FILE),
      armRows.map((r) => `${JSON.stringify(byKey.get(r.trialKey))}\n`).join(""),
    );
    const state = loadLedger(join(armDir, PROGRESS_FILE));
    const cfgFromLedger = state.header?.configSha256;
    if (cfgFromLedger !== header.configSha256[arm])
      throw new AbRefusal(`${arm}: the arm's ledger was not written under the A/B header's config`);
    for (const f of [AB_TRIALS_FILE, R1_LEDGER_FILE, R1_UNCLASSIFIED_FILE])
      if (existsSync(join(armDir, f))) copyFileSync(join(armDir, f), join(dest, f));
    const anchor = anchorPathFor(armDir);
    ledgerOf[arm] = {
      events: readJsonl(join(armDir, R1_LEDGER_FILE)).length,
      anchorEntries: readJsonl(anchor).length,
      unclassifiedFaultEnds: readJsonl(join(armDir, R1_UNCLASSIFIED_FILE)).length,
    };
  }
  // The run configs #547 compares: re-derived from the committed pre-registration, and
  // refused unless they are exactly the configs the arms' ledgers were written under.
  const committed = loadPrereg(repoRoot);
  if (committed.markdownSha256 !== header.preregSha256)
    throw new AbRefusal(
      `the run recorded pre-registration ${header.preregSha256}, the committed one is ${committed.markdownSha256}: refused`,
    );
  const published = publishedTasks(repoRoot);
  for (const arm of AB_ARMS) {
    const cfg = armConfig(committed, stage, arm, published);
    if (configSha256(cfg) !== header.configSha256[arm])
      throw new AbRefusal(
        `${arm}: the committed pre-registration no longer derives the config this run used (pre-registration changed after the run?)`,
      );
    configs[arm] = cfg;
    writeFileSync(join(packDir, arm, "run-config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
  }
  const diff = diffArmConfigs(configs.on, configs.off);
  if (diff.length > 0) throw new AbRefusal(`refusing the pack: ${diff.join("; ")}`);
  const incidents = incidentStatus(root).map((i) => ({
    id: i.id,
    sha256: i.sha256,
    acknowledged: i.acknowledged,
  }));
  if (incidents.length > 0) {
    mkdirSync(join(packDir, "incidents"), { recursive: true });
    for (const f of readdirSync(incidentsDir(root)))
      copyFileSync(join(incidentsDir(root), f), join(packDir, "incidents", f));
  }
  const manifest: AbPackManifest = {
    schema: AB_PACK_SCHEMA,
    experiment: AB_EXPERIMENT,
    stage,
    evidenceUse: AB_EVIDENCE_USE,
    simulated: header.simulated,
    prereg: {
      markdown: PREREG_MD,
      markdownSha256: header.preregSha256,
      json: PREREG_JSON,
      jsonSha256: header.preregJsonSha256,
    },
    configSha256: header.configSha256,
    scheduleSha256: header.scheduleSha256,
    attemptLedgers: ledgerOf as AbPackManifest["attemptLedgers"],
    incidents,
    analysis: analysisCommand(packDir, stage),
  };
  writeFileSync(join(packDir, "ab-pack.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(packDir, EXPERIMENT_FILE),
    `Corrections ON/OFF A/B pack, Stage ${stage}: ${AB_EVIDENCE_USE}. Both arms, the OFF arm included.\n`,
  );
  if (header.simulated)
    writeFileSync(
      join(packDir, SIMULATED_FILE),
      "SIMULATED corrections A/B dry run. Fake transport, no model, no VM, $0. Never evidence.\n",
    );
  return manifest;
}

/** #547's CLI invocation for a pack (Stage 1 also names the Stage-0 pack). */
export function analysisArgs(packDir: string, stage: AbStage, stage0Pack?: string): string[] {
  const p = (arm: AbArm, f: string) => join(packDir, arm, f);
  const manifestPath = join(packDir, "ab-pack.json");
  const declared = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as AbPackManifest).prereg.markdownSha256
    : "<ab-pack.json prereg.markdownSha256>";
  return [
    "--stage",
    String(stage),
    "--on-arm",
    p("on", "arm.jsonl"),
    "--on-grades",
    p("on", GRADES_FILE),
    "--off-arm",
    p("off", "arm.jsonl"),
    "--off-grades",
    p("off", GRADES_FILE),
    "--on-config",
    p("on", "run-config.json"),
    "--off-config",
    p("off", "run-config.json"),
    ...(stage === 1
      ? [
          "--stage0-on-arm",
          join(stage0Pack ?? "<stage-0 pack>", "on", "arm.jsonl"),
          "--stage0-off-arm",
          join(stage0Pack ?? "<stage-0 pack>", "off", "arm.jsonl"),
        ]
      : []),
    "--prereg-file",
    PREREG_MD,
    "--prereg-declared",
    declared,
  ];
}

export function analysisCommand(packDir: string, stage: AbStage, stage0Pack?: string): string {
  return `npx tsx ${ANALYSIS_SCRIPT} ${analysisArgs(packDir, stage, stage0Pack).join(" ")}`;
}

/**
 * This runner's own pack check (the interface #547 also enforces): the manifest, the markers,
 * the pre-registration hash against the COMMITTED files, labelled rows, identical arm configs.
 */
export function checkAbPack(
  packDir: string,
  repoRoot: string,
): { readonly ok: boolean; readonly errors: readonly string[]; readonly stage: AbStage | null } {
  const errors: string[] = [];
  const mPath = join(packDir, "ab-pack.json");
  if (!existsSync(mPath)) return { ok: false, errors: ["no ab-pack.json"], stage: null };
  const m = JSON.parse(readFileSync(mPath, "utf8")) as AbPackManifest;
  if (m.schema !== AB_PACK_SCHEMA) errors.push(`ab-pack.json schema is not ${AB_PACK_SCHEMA}`);
  if (m.evidenceUse !== AB_EVIDENCE_USE) errors.push("ab-pack.json does not say experiment-only");
  if (!existsSync(join(packDir, EXPERIMENT_FILE))) errors.push("no EXPERIMENT marker");
  if (m.simulated && !existsSync(join(packDir, SIMULATED_FILE)))
    errors.push("a simulated pack without its SIMULATED marker");
  const mdSha = sha256File(join(repoRoot, PREREG_MD));
  const jsonSha = sha256File(join(repoRoot, PREREG_JSON));
  if (m.prereg?.markdownSha256 !== mdSha)
    errors.push(
      `the pack's recorded pre-registration sha256 ${String(m.prereg?.markdownSha256)} is not the committed ${PREREG_MD}'s ${mdSha}: refused`,
    );
  if (m.prereg?.jsonSha256 !== jsonSha)
    errors.push(`the pack's recorded ${PREREG_JSON} sha256 is not the committed file's: refused`);
  const cfg = (arm: AbArm) => {
    const p = join(packDir, arm, "run-config.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as PilotConfig) : null;
  };
  const on = cfg("on");
  const off = cfg("off");
  if (on === null || off === null) errors.push("a run-config.json is missing");
  else {
    errors.push(...diffArmConfigs(on, off));
    for (const [arm, c] of [
      ["on", on],
      ["off", off],
    ] as const) {
      if (c.experiment?.preregSha256 !== m.prereg?.markdownSha256)
        errors.push(`${arm}: run-config.json names another pre-registration`);
      if (configSha256(c) !== m.configSha256?.[arm])
        errors.push(`${arm}: run-config.json is not the config the run recorded`);
    }
  }
  for (const arm of AB_ARMS) {
    const rows = readJsonl(join(packDir, arm, "arm.jsonl")) as BenchmarkArmRow[];
    const unlabelled = rows.filter((r) => r.experiment !== experimentLabel(m.stage)).length;
    if (rows.length === 0) errors.push(`${arm}: no arm rows`);
    if (unlabelled > 0) errors.push(`${arm}: ${unlabelled} row(s) without the experiment label`);
  }
  return { ok: errors.length === 0, errors, stage: m.stage };
}

export interface AbAnalysis {
  readonly status: "analysed" | "refused" | "analysis-pending";
  readonly exitCode: number | null;
  readonly command: string;
  readonly errors: readonly string[];
  /** #547's printed `AbResult`, when it ran. */
  readonly result: unknown;
}

/**
 * Check the pack (refuse on any error, the pre-registration hash included), then run #547's
 * analysis CLI on it. Until #547 merges the analysis is `analysis-pending` (TO FILE: drop the
 * fallback once it lands); the pack check still runs.
 */
export function analyzeAbPack(packDir: string, repoRoot: string, stage0Pack?: string): AbAnalysis {
  const checked = checkAbPack(packDir, repoRoot);
  const stage = checked.stage ?? 0;
  const command = analysisCommand(packDir, stage, stage0Pack);
  if (!checked.ok)
    return { status: "refused", exitCode: null, command, errors: checked.errors, result: null };
  if (stage === 1 && stage0Pack === undefined)
    return {
      status: "refused",
      exitCode: null,
      command,
      errors: ["Stage 1 analysis needs the Stage-0 pack (its rows are excluded)"],
      result: null,
    };
  if (!existsSync(join(repoRoot, ANALYSIS_SCRIPT)) || !existsSync(join(repoRoot, ANALYSIS_MODULE)))
    return {
      status: "analysis-pending",
      exitCode: null,
      command,
      errors: [
        `${ANALYSIS_SCRIPT} (#547) is not on this branch yet: the pack passed this runner's checks; run the command above once #547 merges`,
      ],
      result: null,
    };
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", ANALYSIS_SCRIPT, ...analysisArgs(packDir, stage, stage0Pack)],
    { cwd: repoRoot, encoding: "utf8" },
  );
  let result: unknown = null;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    // #547 printed no JSON (a usage error): reported through the exit code and stderr.
  }
  return {
    status: "analysed",
    exitCode: r.status,
    command,
    errors: r.status === 0 ? [] : [r.stderr.trim().split("\n").slice(-3).join(" ")],
    result,
  };
}

// ---------------------------------------------------------------------------------------------
// Real-run gating
// ---------------------------------------------------------------------------------------------

/**
 * Why a REAL A/B run cannot start now. Empty only when every precondition holds; the CLI also
 * refuses afterwards because no live driver is wired (the VM-side capture is a later step).
 *  - the pre-registration is committed and unchanged;
 *  - the lead's GO is committed (`LEAD_GO_FILE`) for this stage and pre-registration;
 *  - the gate can read the tasks' persisted format (fc-v1 persists xlsx; the gate reads CSV
 *    until the xlsx replacement for #503 lands);
 *  - #546's cold-boot guard is merged (the trial-ops schema has `resetBootClass`).
 */
export function realRunRefusals(
  repoRoot: string,
  loaded: LoadedPrereg,
  stage: AbStage,
  published: readonly BenchmarkTask[],
): string[] {
  const out = preregCommitProblems(repoRoot).map((p) => `pre-registration: ${p}`);
  const goPath = join(repoRoot, LEAD_GO_FILE);
  if (!existsSync(goPath))
    out.push(`no lead GO: ${LEAD_GO_FILE} is not committed (real runs wait for the lead's GO)`);
  else {
    const go = JSON.parse(readFileSync(goPath, "utf8")) as Record<string, unknown>;
    if (go.preregSha256 !== loaded.markdownSha256 || !(go.stages as unknown[])?.includes(stage))
      out.push(`${LEAD_GO_FILE} does not approve Stage ${stage} of this pre-registration`);
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", LEAD_GO_FILE], {
      cwd: repoRoot,
    });
    if (tracked.status !== 0) out.push(`${LEAD_GO_FILE} is not committed`);
  }
  const gateFormat = extname(GATE_STATE_FILE).slice(1);
  const ids = new Set(stageTasks(loaded, stage, published));
  const formats = [
    ...new Set(published.filter((t) => ids.has(t.taskId)).map((t) => t.persistedFormat)),
  ];
  const unreadable = formats.filter((f) => f !== gateFormat);
  if (unreadable.length > 0)
    out.push(
      `the gate cannot read the task format: Stage ${stage}'s tasks persist ${unreadable.join(", ")} and the gate reads ${gateFormat} only (${GATE_STATE_FILE}); real runs wait for the xlsx gate replacement for #503`,
    );
  const unnameable = PILOT_HARNESS_CLASSES.filter((c) => !r1Nameable(c));
  if (unnameable.length > 0)
    out.push(
      `#518's attempt-event vocabulary cannot name the pilot's harness faults (${unnameable.join(", ")}): real runs wait until it does (TO FILE), so every attempt's end is in #518's ledger`,
    );
  const props = (m2TrialOpsSchema as { properties?: Record<string, unknown> }).properties ?? {};
  if (!Object.hasOwn(props, "resetBootClass"))
    out.push(
      "#546's cold-boot guard is not merged (the trial-ops schema has no resetBootClass): real runs wait for it",
    );
  return out;
}

/** The evidence refusal for a pack's arm, through the shared check (`evidence: true`). */
export function evidenceRefusals(packDir: string, arm: AbArm): readonly string[] {
  const rows = readJsonl(join(packDir, arm, "arm.jsonl"));
  const grades = readJsonl(join(packDir, arm, GRADES_FILE));
  return checkBenchmark(rows, grades, {
    expectTrials: { "myco-gate": rows.length },
    expectUnregistrable: {
      "myco-gate": (rows as BenchmarkArmRow[]).filter((r) => r.gate?.unregistrable === true).length,
    },
    evidence: true,
  }).errors;
}
