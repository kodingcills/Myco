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
 *    Crash-safe: the incident is written (atomically) BEFORE the grade, every invocation
 *    re-derives misses from the rows and writes any missing record before anything runs, and
 *    export, check-pack and Stage 1 re-derive misses from the rows, never trusting a flag.
 *  - REAL RUNS: `runAbStage` refuses a live run before any trial unless the explicit flag, the
 *    printed plan's sha256 and every `realRunRefusals` precondition hold (`liveAbRefusals`);
 *    `runPilot` re-checks the preconditions from each arm config (`liveExperimentRefusals`).
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
  renameSync,
  writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type BenchmarkArmRow, checkBenchmark } from "../benchmark/check.ts";
import { grade } from "../benchmark/grade/grade.ts";
import { type BenchmarkGradeRow, gradeRow } from "../benchmark/grade/row.ts";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import { AttemptLedgerWriter, anchorPathFor, verifyAttemptLedger } from "../m2/attempt-ledger.ts";
import { EXPERIMENT_FILE } from "../m2/provenance.ts";
import {
  AB_EXPERIMENT,
  type AbStage,
  ANALYSIS_MODULE,
  ANALYSIS_SCRIPT,
  fillAnalysisCommand,
  type LoadedPrereg,
  loadPrereg,
  PREREG_JSON,
  PREREG_MD,
  r1Nameable,
  realRunRefusals,
  sha256File,
  stageTasks,
} from "./ab-prereg.ts";
import { canonicalJson, configSha256, type PilotConfig, pilotConfig } from "./config.ts";
import { trialLaunchPlan } from "./launch.ts";
import { loadLedger, PROGRESS_FILE } from "./ledger.ts";
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

export {
  AB_EXPERIMENT,
  type AbPrereg,
  type AbStage,
  type AbStagePrereg,
  ANALYSIS_MODULE,
  ANALYSIS_SCRIPT,
  fillAnalysisCommand,
  LEAD_GO_FILE,
  type LoadedPrereg,
  leadGoProblems,
  loadPrereg,
  PREREG_JSON,
  PREREG_MD,
  PREREG_SCHEMA,
  preregCommitProblems,
  r1Nameable,
  realRunRefusals,
  sha256File,
  stageTasks,
} from "./ab-prereg.ts";

export const AB_PACK_SCHEMA = "myco.pilot.corrections-ab-pack/1" as const;
export const AB_RUN_SCHEMA = "myco.pilot.corrections-ab-run/1" as const;
export const INCIDENT_SCHEMA = "myco.pilot.ab-integrity-incident/1" as const;
export const ACK_SCHEMA = "myco.pilot.ab-incident-ack/1" as const;
export const AB_EVIDENCE_USE = "experiment-only (never R1 evidence)" as const;
export const AB_DRY_RUN_PLANNER = "simulated:corrections-ab-dry-run";

export type AbArm = "on" | "off";
export const AB_ARMS: readonly AbArm[] = ["on", "off"];

/** Thrown for a refusal the operator must act on (exit 3 in the CLI), never a bug. */
export class AbRefusal extends Error {
  override name = "AbRefusal";
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------------------------
// Schedule, arm configs
// ---------------------------------------------------------------------------------------------

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
/**
 * The experiment marker every arm row carries (#547's row shape, `BenchmarkArmRow.experiment`):
 * the stage, the arm and the stage's pre-registered seed (one seed per run; Stage 1's is fresh).
 */
export const experimentMarker = (
  stage: AbStage,
  arm: AbArm,
  seed: string,
): NonNullable<BenchmarkArmRow["experiment"]> => ({ id: AB_EXPERIMENT, stage, arm, seed });

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
  return compareLaunchPlans(
    trialLaunchPlan(on, task, ids, dir, repoRoot),
    trialLaunchPlan(off, task, ids, dir, repoRoot),
  );
}

type LaunchPlanShape = Pick<ReturnType<typeof trialLaunchPlan>, "argv" | "mcpConfigPath"> & {
  readonly mcpServers: Readonly<
    Record<
      string,
      { readonly command: string; readonly args: readonly string[]; readonly env?: unknown }
    >
  >;
};

/** The problems between the ON (`a`) and OFF (`b`) launch plans of one task (pure). */
export function compareLaunchPlans(a: LaunchPlanShape, b: LaunchPlanShape): string[] {
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

/**
 * A live trial whose reset was not a recorded cold boot (#546's guard; pre-registration
 * "Harness faults, ledger, resets": such a trial "halts the run"). Sticky like a gate miss:
 * written atomically before the run proceeds, re-derived on resume from `ab-trials.jsonl`, and
 * cleared only by an operator's ack (`ack-incident`), never automatically.
 */
export interface BootClassIncident {
  readonly schema: typeof INCIDENT_SCHEMA;
  readonly kind: "boot-class";
  readonly stage: AbStage;
  readonly arm: AbArm;
  readonly trialKey: string;
  readonly taskId: string;
  /** What was recorded for the reset: `"fast"`, `null` (unmeasured or missing), or anything else. */
  readonly resetBootClass: unknown;
  readonly at: string;
  readonly rule: string;
}

/** Any record under `incidents/`: a gate miss or a non-cold live reset. */
export type AbIncident = IntegrityIncident | BootClassIncident;

export const incidentsDir = (stageRoot: string) => join(stageRoot, "incidents");

export interface IncidentStatus {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly acknowledged: boolean;
  readonly problem: string | null;
}

export const incidentId = (trialKey: string) => `incident-${trialKey}`;
export const bootIncidentId = (trialKey: string) => `incident-boot-${trialKey}`;

/**
 * The incident record at `path`, or null unless it is a well-formed record for its id: a
 * gate-miss record (id `incident-<trialKey>`) or a boot-class record (id
 * `incident-boot-<trialKey>`, whose boot class is not `"cold"`).
 */
export function readIncident(path: string, id: string): AbIncident | null {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as AbIncident;
    if (r.schema !== INCIDENT_SCHEMA || typeof r.trialKey !== "string") return null;
    if ((r.arm !== "on" && r.arm !== "off") || (r.stage !== 0 && r.stage !== 1)) return null;
    if (r.kind === "gate-miss")
      return r.gateVerdict === "verified" && incidentId(r.trialKey) === id ? r : null;
    if (r.kind === "boot-class")
      return Object.hasOwn(r, "resetBootClass") &&
        r.resetBootClass !== "cold" &&
        bootIncidentId(r.trialKey) === id
        ? r
        : null;
    return null;
  } catch {
    return null;
  }
}

/** The valid incident record for a trial under `incidentsRoot`, if one matches arm and stage. */
function incidentFor(
  dir: string,
  trialKey: string,
  arm: AbArm,
  stage: AbStage,
): { readonly path: string; readonly record: IntegrityIncident } | null {
  const id = incidentId(trialKey);
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  const record = readIncident(path, id);
  return record?.kind === "gate-miss" && record.arm === arm && record.stage === stage
    ? { path, record }
    : null;
}

/**
 * The gate misses in a set of arm rows and their grades, derived from the rows alone (never
 * from a flag or an incident file): every row the gate VERIFIED whose grade is not `pass`. A
 * verified row with no grade at all counts as a miss too (fail closed).
 */
export function gateMissesFromRows(
  rows: readonly {
    readonly trialKey: string;
    readonly gate?: { readonly verdict?: string | null } | null;
  }[],
  grades: ReadonlyMap<string, { readonly status: string }>,
): string[] {
  return rows
    .filter((r) => r.gate?.verdict === "verified" && grades.get(r.trialKey)?.status !== "pass")
    .map((r) => r.trialKey);
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
      if (readIncident(path, id) === null)
        problem =
          "not a valid gate-miss incident record or boot-class incident record (repair it by hand; it cannot be acknowledged as is)";
      else if (!existsSync(ackPath)) problem = "no operator ack file";
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
      `refusing to resume: ${pending.length} unacknowledged integrity incident(s) (a gate miss, or a live reset that was not a recorded cold boot): ${pending.map((i) => `${i.path} (${i.problem})`).join("; ")}. ` +
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
  if (readIncident(st.path, id) === null)
    throw new AbRefusal(
      `${st.path} is not a valid gate-miss incident record or boot-class incident record: refused`,
    );
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

/** What recording a decided trial needs (exported for the crash and boot-class unit tests). */
export interface HookContext {
  readonly stageRoot: string;
  readonly armDir: string;
  readonly stage: AbStage;
  readonly arm: AbArm;
  readonly grader: GradeFn;
  readonly live: boolean;
  readonly now: () => number;
  readonly load1m: () => number;
  readonly crashPoint?: ((step: RecordStep, trialKey: string) => void) | undefined;
}

/** The steps of recording a decided trial, in write order (for crash-point tests). */
export type RecordStep = "graded" | "incident" | "trial-record" | "grade";

/** Write a file atomically (temp + rename): a crash leaves the old state or the whole file. */
function writeAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, text, { flag: "wx" });
  renameSync(tmp, path);
}

/**
 * Write the gate-miss incident for one trial unless a valid one is already there (a resume
 * after a crash re-derives it; it never rewrites a record an operator may have read).
 * Returns the record's path and whether an operator has acknowledged it.
 */
function ensureIncident(
  ctx: HookContext,
  d: { readonly trialKey: string; readonly taskId: string; readonly armRow: BenchmarkArmRow },
  g: BenchmarkGradeRow,
  how: "on decision" | "re-derived on resume",
): { readonly path: string; readonly acknowledged: boolean } {
  const dir = incidentsDir(ctx.stageRoot);
  const prior = incidentFor(dir, d.trialKey, ctx.arm, ctx.stage);
  if (prior === null) {
    const path = join(dir, `${incidentId(d.trialKey)}.json`);
    if (existsSync(path))
      // A file there that is not this trial's valid record: never overwritten, never ackable.
      return { path, acknowledged: false };
    const incident: IntegrityIncident = {
      schema: INCIDENT_SCHEMA,
      kind: "gate-miss",
      stage: ctx.stage,
      arm: ctx.arm,
      trialKey: d.trialKey,
      taskId: d.taskId,
      gateVerdict: "verified",
      accepted: d.armRow.accepted,
      graderStatus: g.status === "ungradable" ? "ungradable" : "fail",
      graderVersion: g.graderVersion,
      persistedSha256: d.armRow.persistedSha256,
      at: new Date(ctx.now()).toISOString(),
      rule: `fail-closed: a gate miss (gate VERIFIED, grader fails) is an integrity incident; the run halts and nothing resumes until an operator acknowledges this record (recorded ${how})`,
    };
    mkdirSync(dir, { recursive: true });
    writeAtomic(path, `${JSON.stringify(incident, null, 2)}\n`);
  }
  const path = join(dir, `${incidentId(d.trialKey)}.json`);
  const st = incidentStatus(ctx.stageRoot).find((i) => i.path === path);
  return { path, acknowledged: st?.acknowledged === true };
}

const missReason = (trialKey: string, status: string, path: string) =>
  `HALTED: integrity incident, the gate VERIFIED ${trialKey} and the independent grader says ${status}; record ${path}. Nothing resumes until an operator acknowledges it (ack-incident).`;

/** A recorded boot class as text: `fast`, `unrecorded` (null or missing), or the raw value. */
const bootClassText = (c: unknown) =>
  c === null || c === undefined ? "unrecorded" : typeof c === "string" ? c : JSON.stringify(c);

const bootReason = (trialKey: string, cls: unknown, path: string) =>
  `HALTED: ${trialKey}'s reset boot class is ${bootClassText(cls)}, not a recorded cold boot (#546's guard); record ${path}. Nothing resumes until an operator acknowledges it (ack-incident).`;

/**
 * Write the boot-class incident for one live trial unless a valid one is already there (never
 * rewritten). Atomic, and written before the trial's record and grade, so a crash anywhere
 * after the reset leaves either this record or a state `reconcileGrades` re-derives it from.
 */
function ensureBootIncident(
  ctx: HookContext,
  d: { readonly trialKey: string; readonly taskId: string },
  resetBootClass: unknown,
  how: "on decision" | "re-derived on resume",
): { readonly path: string; readonly acknowledged: boolean } {
  const dir = incidentsDir(ctx.stageRoot);
  const id = bootIncidentId(d.trialKey);
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) {
    const incident: BootClassIncident = {
      schema: INCIDENT_SCHEMA,
      kind: "boot-class",
      stage: ctx.stage,
      arm: ctx.arm,
      trialKey: d.trialKey,
      taskId: d.taskId,
      resetBootClass: resetBootClass === undefined ? null : resetBootClass,
      at: new Date(ctx.now()).toISOString(),
      rule: `fail-closed: a live trial whose reset is not a recorded cold boot halts the run (#546; pre-registration "Harness faults, ledger, resets"); nothing resumes until an operator acknowledges this record, and a live pack with such a trial is refused regardless (recorded ${how})`,
    };
    mkdirSync(dir, { recursive: true });
    writeAtomic(path, `${JSON.stringify(incident, null, 2)}\n`);
  }
  // A file there that is not this trial's valid record (wrong arm, stage or content) is never
  // overwritten and never acknowledged: `incidentStatus` reports it, and the run stays halted.
  const rec = readIncident(path, id);
  const st = incidentStatus(ctx.stageRoot).find((i) => i.path === path);
  const valid = rec !== null && rec.arm === ctx.arm && rec.stage === ctx.stage;
  return { path, acknowledged: valid && st?.acknowledged === true };
}

/**
 * The boot classes recorded per trial in an arm's `ab-trials.jsonl` (every record of a trial,
 * in file order; a record without the field contributes `undefined`).
 */
function bootClassesByKey(path: string): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  for (const r of readJsonl(path)) {
    const key = (r as { trialKey?: unknown } | null)?.trialKey;
    if (typeof key !== "string") continue;
    out.set(key, [...(out.get(key) ?? []), (r as { resetBootClass?: unknown }).resetBootClass]);
  }
  return out;
}

/**
 * Whether a trial's recorded boot classes (every `ab-trials.jsonl` record for it) make it a
 * recorded cold boot: true only when there is at least one record and EVERY record says exactly
 * `"cold"`. A missing field (`undefined`), `null`, `"fast"`, an unknown string or a non-string
 * anywhere in the list makes it not cold, and one record never masks another (#563 round 1 D1:
 * a `find`-based check returned the `undefined` element itself and so passed it as cold).
 * `recorded` is the first non-cold value (`null` for a missing field or no record), for the
 * incident record and the halt message.
 */
export function bootVerdict(classes: readonly unknown[]): {
  readonly cold: boolean;
  readonly recorded: unknown;
} {
  const badIdx = classes.findIndex((c) => c !== "cold");
  if (classes.length > 0 && badIdx < 0) return { cold: true, recorded: "cold" };
  return { cold: false, recorded: badIdx < 0 ? null : (classes[badIdx] ?? null) };
}

/**
 * Why a live pack's rows are not all recorded cold boots: each row needs at least one
 * `ab-trials.jsonl` record and every record for it must say exactly `"cold"` (`"fast"`, `null`,
 * a missing field or any other value is refused). Pure; export and check-pack both apply it.
 */
export function bootClassProblems(
  armRows: readonly { readonly trialKey: string }[],
  trialsPath: string,
): string[] {
  const byKey = bootClassesByKey(trialsPath);
  const out: string[] = [];
  for (const row of armRows) {
    const classes = byKey.get(row.trialKey) ?? [];
    if (classes.length === 0)
      out.push(
        `${row.trialKey} has no ${AB_TRIALS_FILE} record (its reset boot class is unrecorded)`,
      );
    else if (!bootVerdict(classes).cold)
      out.push(
        `${row.trialKey}'s reset boot class is ${classes.map(bootClassText).join("/")}, not a recorded cold boot`,
      );
  }
  return out;
}

/**
 * Record a decided trial and decide whether it halts the run. Crash-safe by write order: the
 * incidents (a gate miss; on a live run, a reset that is not a recorded cold boot) are written
 * FIRST, then the `ab-trials.jsonl` boot-class record, and the grade LAST,
 * so a grade on disk always means everything before it is on disk. A crash before the grade
 * leaves the trial ungraded and `reconcileGrades` re-records it (keeping an existing incident);
 * `reconcileGrades` also re-derives misses from the grades already written, so even a state
 * where a grade exists without its incident halts on resume.
 */
export function recordDecided(
  ctx: HookContext,
  d: Pick<DecidedTrial, "task" | "trialKey" | "armRow" | "persisted"> & {
    readonly resetBootClass: "cold" | "fast" | null;
  },
): string | null {
  const crash = (step: RecordStep) => ctx.crashPoint?.(step, d.trialKey);
  const g = ctx.grader(d.task, d.persisted, d.trialKey);
  crash("graded");
  const miss = d.armRow.gate?.verdict === "verified" && g.status !== "pass";
  let halt: string | null = null;
  if (miss) {
    const inc = ensureIncident(ctx, { ...d, taskId: d.task.taskId }, g, "on decision");
    if (!inc.acknowledged) halt = missReason(d.trialKey, g.status, inc.path);
  }
  const trialsPath = join(ctx.armDir, AB_TRIALS_FILE);
  const prior = readJsonl(trialsPath).find(
    (r) => (r as { trialKey?: string }).trialKey === d.trialKey,
  ) as AbTrialRecord | undefined;
  // With record(s) already on disk (a re-record after a crash), every one of them decides the
  // class, strictly: a damaged record with no field is not cold and cannot fall back to the
  // reset's own report, and a later non-cold record is never masked by an earlier one.
  const priorBoot =
    prior === undefined ? null : bootVerdict(bootClassesByKey(trialsPath).get(d.trialKey) ?? []);
  const resetBootClass: unknown =
    priorBoot === null ? d.resetBootClass : priorBoot.cold ? "cold" : priorBoot.recorded;
  // A live non-cold reset: its sticky record goes to disk before the trial record and grade.
  if (ctx.live && resetBootClass !== "cold") {
    const inc = ensureBootIncident(
      ctx,
      { ...d, taskId: d.task.taskId },
      resetBootClass,
      "on decision",
    );
    if (!inc.acknowledged) halt ??= bootReason(d.trialKey, resetBootClass, inc.path);
  }
  crash("incident");
  if (prior === undefined) {
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
    appendFileSync(trialsPath, `${JSON.stringify(rec)}\n`);
  }
  crash("trial-record");
  appendFileSync(join(ctx.armDir, GRADES_FILE), `${JSON.stringify(g)}\n`);
  crash("grade");
  return halt;
}

/** The decided trials in an arm's progress ledger, with their arm rows. */
function decidedTrials(
  armDir: string,
): { readonly trialKey: string; readonly taskId: string; readonly armRow: BenchmarkArmRow }[] {
  const state = loadLedger(join(armDir, PROGRESS_FILE));
  const out: { trialKey: string; taskId: string; armRow: BenchmarkArmRow }[] = [];
  if (state.header === null) return out;
  for (const list of state.byTask.values())
    for (const rec of list)
      if (rec.end?.outcome === "decided" && rec.end.armRow !== null)
        out.push({
          trialKey: rec.start.trialKey,
          taskId: rec.start.taskId,
          armRow: rec.end.armRow,
        });
  return out;
}

const gradesByKey = (armDir: string) =>
  new Map(
    (readJsonl(join(armDir, GRADES_FILE)) as BenchmarkGradeRow[]).map((g) => [g.trialKey, g]),
  );

/**
 * Bring an arm's records up to date with its progress ledger before anything else runs:
 *  - a decided trial with no grade (the runner died before its grade was written) is recorded
 *    now from the saved document, which writes its incident if it is a miss;
 *  - every graded trial is re-checked from the rows: a gate-VERIFIED trial whose grade is not
 *    `pass` and that has no valid incident record gets one now (re-derived) and halts;
 *  - on a live run, every graded trial's boot class is re-checked from `ab-trials.jsonl`: one
 *    that is not a recorded cold boot gets its boot-class incident now and halts.
 * A re-recorded trial's boot class is unknown (`null`): a live run halts on it (never `cold`).
 * Either incident halts until an operator acknowledges it; nothing here clears one.
 * Returns the first halt reason, if any.
 */
export function reconcileGrades(
  ctx: HookContext,
  published: readonly BenchmarkTask[],
): string | null {
  const byId = new Map(published.map((t) => [t.taskId, t]));
  const grades = gradesByKey(ctx.armDir);
  const boots = bootClassesByKey(join(ctx.armDir, AB_TRIALS_FILE));
  let halt: string | null = null;
  for (const t of decidedTrials(ctx.armDir)) {
    const g = grades.get(t.trialKey);
    if (g === undefined) {
      const task = byId.get(t.taskId);
      if (task === undefined)
        throw new Error(`decided trial ${t.trialKey}: unknown task ${t.taskId}`);
      const doc = join(ctx.armDir, "trials", t.trialKey, "doc.csv");
      halt ??= recordDecided(ctx, {
        task,
        trialKey: t.trialKey,
        armRow: t.armRow,
        persisted: existsSync(doc) ? readFileSync(doc) : null,
        resetBootClass: null,
      });
      continue;
    }
    if (gateMissesFromRows([t.armRow], grades).length > 0) {
      const inc = ensureIncident(ctx, t, g, "re-derived on resume");
      if (!inc.acknowledged) halt ??= missReason(t.trialKey, g.status, inc.path);
    }
    // A live graded trial's boot class, re-derived from its ab-trials.jsonl record(s): a
    // missing record, or any record that is not exactly "cold", needs its sticky incident.
    if (ctx.live) {
      const boot = bootVerdict(boots.get(t.trialKey) ?? []);
      if (!boot.cold) {
        const inc = ensureBootIncident(ctx, t, boot.recorded, "re-derived on resume");
        if (!inc.acknowledged) halt ??= bootReason(t.trialKey, boot.recorded, inc.path);
      }
    }
  }
  return halt;
}

/**
 * A stage's gate misses re-derived from its run directory (decided rows and their grades),
 * plus decided trials with no grade yet: what Stage 1's precondition reads, never the
 * incident files alone.
 */
export function stageGateMisses(
  outRoot: string,
  stage: AbStage,
): { readonly misses: readonly string[]; readonly ungraded: readonly string[] } {
  const root = stageRoot(outRoot, stage);
  const misses: string[] = [];
  const ungraded: string[] = [];
  for (const arm of AB_ARMS) {
    const armDir = join(root, arm);
    const rows = decidedTrials(armDir);
    const grades = gradesByKey(armDir);
    ungraded.push(...rows.filter((r) => !grades.has(r.trialKey)).map((r) => r.trialKey));
    misses.push(
      ...gateMissesFromRows(
        rows.filter((r) => grades.has(r.trialKey)).map((r) => ({ ...r, gate: r.armRow.gate })),
        grades,
      ),
    );
  }
  return { misses, ungraded };
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
  /** Live only: the operator's explicit `--launch-real-trials`. */
  readonly launchRealTrials?: boolean;
  /**
   * Fault injection for tests (simulated runs only; ignored, and refused, on a live run):
   * called at each step of recording a decided trial, so a test can throw there to stand in
   * for the runner dying between two writes.
   */
  readonly crashPoint?: (step: RecordStep, trialKey: string) => void;
}

/**
 * Why a LIVE A/B run cannot start: the explicit flag, the printed plan's sha256, and every
 * `realRunRefusals` precondition (pre-registration committed, the lead's GO, the gate can read
 * the tasks' format, #518's vocabulary, #546's cold-boot guard). Empty only when all hold.
 * `runPilot` re-checks the same preconditions from each arm config (`liveExperimentRefusals`).
 */
export function liveAbRefusals(
  opts: Pick<
    AbRunOptions,
    | "repoRoot"
    | "loaded"
    | "stage"
    | "published"
    | "liveLaunchSha256"
    | "launchRealTrials"
    | "crashPoint"
  >,
): string[] {
  const out: string[] = [];
  if (opts.launchRealTrials !== true)
    out.push("a live A/B run needs the explicit --launch-real-trials flag (launchRealTrials)");
  if (opts.liveLaunchSha256 !== abPlanSha256(opts.loaded, opts.stage, opts.published))
    out.push(
      "a live A/B run needs liveLaunchSha256 equal to the printed plan's abPlanSha256 (the CLI's --plan-sha256)",
    );
  if (opts.crashPoint !== undefined)
    out.push("fault injection (crashPoint) is for simulated runs only");
  out.push(...realRunRefusals(opts.repoRoot, opts.loaded, opts.stage, opts.published));
  return out;
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
  // Every task of the stage, not just the first: a plan may depend on the task.
  const byId = new Map(published.map((t) => [t.taskId, t]));
  for (const id of on.trials) {
    const task = byId.get(id);
    if (task === undefined) problems.push(`task ${id} is not published`);
    else problems.push(...launchPlanDiff(on, off, task, repoRoot).map((p) => `${id}: ${p}`));
  }
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
  // 0. A live run: every real-run precondition, before anything is written or started.
  if (!simulated) {
    const refusals = liveAbRefusals(opts);
    if (refusals.length > 0)
      throw new AbRefusal(
        `refusing a live corrections A/B run (no trial started):\n${refusals.map((r) => `  - ${r}`).join("\n")}`,
      );
  }
  mkdirSync(root, { recursive: true });

  // 1. Nothing resumes over an unacknowledged incident; Stage 1 needs a clean Stage 0.
  assertNoPendingIncidents(root);
  if (stage === 1) {
    const s0 = stageProgress(opts.outRoot, 0);
    if (!s0.complete)
      throw new AbRefusal(
        `Stage 1 starts only after Stage 0 is complete in ${opts.outRoot} (${s0.decided}/${s0.expected} trials decided)`,
      );
    const derived = stageGateMisses(opts.outRoot, 0);
    if (derived.ungraded.length > 0)
      throw new AbRefusal(
        `Stage 1 starts only after every Stage 0 trial is graded; ${derived.ungraded.length} are not (${derived.ungraded[0]}): resume Stage 0 first`,
      );
    if (s0.incidents > 0 || derived.misses.length > 0)
      throw new AbRefusal(
        `Stage 1 starts only after a Stage 0 with zero gate misses; Stage 0 recorded ${s0.incidents} integrity incident(s) and its rows show ${derived.misses.length} gate miss(es) (a lead decision, not an ack, reopens this)`,
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
        crashPoint: simulated ? opts.crashPoint : undefined,
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
        armRowLabel: { experiment: experimentMarker(stage, arm, s.seed) },
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
  /** The stage's pre-registered seed: every row's `experiment.seed`. */
  readonly seed: string;
  /** The planner every row ran (the run header's). */
  readonly plannerModelId: string;
  readonly attemptLedgers: Readonly<
    Record<AbArm, { events: number; anchorEntries: number; unclassifiedFaultEnds: number }>
  >;
  readonly incidents: readonly { id: string; sha256: string; acknowledged: boolean }[];
  /** The gate misses re-derived from the rows at export, each tied to its incident record. */
  readonly gateMisses: readonly AbGateMiss[];
  readonly analysis: string;
}

export interface AbGateMiss {
  readonly arm: AbArm;
  readonly trialKey: string;
  readonly incident: string;
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
    seed: string;
    plannerModelId: string;
  };
  const configs: Partial<Record<AbArm, PilotConfig>> = {};
  const ledgerOf: Partial<Record<AbArm, AbPackManifest["attemptLedgers"][AbArm]>> = {};
  const gateMisses: AbGateMiss[] = [];
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
    // Gate misses re-derived from the rows themselves: each needs its valid incident record.
    for (const key of gateMissesFromRows(armRows, byKey)) {
      const inc = incidentFor(incidentsDir(root), key, arm, stage);
      if (inc === null)
        throw new AbRefusal(
          `${arm}: ${key} is a gate miss (gate VERIFIED, grader ${byKey.get(key)?.status}) with no valid incident record: resume the run to record it; refusing the pack`,
        );
      gateMisses.push({ arm, trialKey: key, incident: incidentId(key) });
    }
    // A live pack: every trial a recorded cold boot (#546; the pre-registration halts on any
    // other). Refused whatever the incidents say: an ack lets a run continue, not a pack count.
    if (header.simulated !== true) {
      const boot = bootClassProblems(armRows, join(armDir, AB_TRIALS_FILE));
      if (boot.length > 0)
        throw new AbRefusal(
          `${arm}: a live pack needs every trial's reset to be a recorded cold boot; ${boot.length} is not (${boot[0]}): refusing the pack`,
        );
    }
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
    writeFileSync(
      join(packDir, arm, ANALYSIS_CONFIG_FILE),
      `${JSON.stringify(analysisConfig(cfg, header.plannerModelId), null, 2)}\n`,
    );
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
    seed: header.seed,
    plannerModelId: header.plannerModelId,
    attemptLedgers: ledgerOf as AbPackManifest["attemptLedgers"],
    incidents,
    gateMisses,
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

/** Each arm's run config in the shape #547's parity check reads (`--on-config`/`--off-config`). */
export const ANALYSIS_CONFIG_FILE = "analysis-config.json";

/**
 * The arm's run config with the keys #547 requires recorded (`REQUIRED_CONFIG_KEYS`): the
 * retry budget, the planner the rows ran and their output ceiling (the pilot sets none). Pure
 * derivation from the runner's config, so the two arms still differ only in `corrections`.
 */
export function analysisConfig(cfg: PilotConfig, plannerModelId: string): Record<string, unknown> {
  return {
    ...cfg,
    retryBudget: cfg.pacing.maxAttemptsPerTrial,
    plannerModelId,
    outputCeiling: null,
  };
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
    p("on", ANALYSIS_CONFIG_FILE),
    "--off-config",
    p("off", ANALYSIS_CONFIG_FILE),
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
 * the pre-registration hash against the repository's files (a real run also requires them
 * committed: `realRunRefusals`), labelled rows, identical arm configs, and every gate miss the
 * rows show tied to its incident record.
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
      `the pack's recorded pre-registration sha256 ${String(m.prereg?.markdownSha256)} is not the repository's ${PREREG_MD} (${mdSha}): refused`,
    );
  if (m.prereg?.jsonSha256 !== jsonSha)
    errors.push(
      `the pack's recorded ${PREREG_JSON} sha256 is not the repository's file's: refused`,
    );
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
      const ap = join(packDir, arm, ANALYSIS_CONFIG_FILE);
      const analysed = existsSync(ap) ? (JSON.parse(readFileSync(ap, "utf8")) as unknown) : null;
      if (canonicalJson(analysed) !== canonicalJson(analysisConfig(c, m.plannerModelId)))
        errors.push(`${arm}: ${ANALYSIS_CONFIG_FILE} is not derived from run-config.json`);
    }
  }
  const derived: AbGateMiss[] = [];
  const listed = new Map((m.incidents ?? []).map((i) => [i.id, i]));
  for (const arm of AB_ARMS) {
    const rows = readJsonl(join(packDir, arm, "arm.jsonl")) as BenchmarkArmRow[];
    const want = canonicalJson(experimentMarker(m.stage, arm, m.seed));
    const unlabelled = rows.filter((r) => canonicalJson(r.experiment ?? null) !== want).length;
    if (rows.length === 0) errors.push(`${arm}: no arm rows`);
    if (unlabelled > 0) errors.push(`${arm}: ${unlabelled} row(s) without the experiment label`);
    // A live pack (anything not marked simulated): every row a recorded cold boot.
    if (m.simulated !== true)
      errors.push(
        ...bootClassProblems(rows, join(packDir, arm, AB_TRIALS_FILE)).map(
          (p) => `${arm}: ${p} (a live pack needs every reset to be a recorded cold boot)`,
        ),
      );
    // Gate misses, re-derived from the pack's rows and grades (never from a flag): each needs
    // its incident record in the pack, listed in the manifest with that file's sha256.
    const grades = readJsonl(join(packDir, arm, GRADES_FILE)) as BenchmarkGradeRow[];
    const byKey = new Map(grades.map((g) => [g.trialKey, g]));
    const ungraded = rows.filter((r) => !byKey.has(r.trialKey)).length;
    if (ungraded > 0 || grades.length !== rows.length)
      errors.push(
        `${arm}: ${grades.length} grade(s) for ${rows.length} row(s) (${ungraded} row(s) ungraded)`,
      );
    for (const key of gateMissesFromRows(rows, byKey)) {
      const id = incidentId(key);
      derived.push({ arm, trialKey: key, incident: id });
      const path = join(packDir, "incidents", `${id}.json`);
      const rec = existsSync(path) ? readIncident(path, id) : null;
      if (rec?.kind !== "gate-miss" || rec.arm !== arm || rec.stage !== m.stage)
        errors.push(
          `${arm}: ${key} is a gate miss (gate VERIFIED, grader ${byKey.get(key)?.status ?? "none"}) with no valid incident record in the pack`,
        );
      else if (listed.get(id)?.sha256 !== sha256File(path))
        errors.push(
          `${arm}: ${key}'s incident record is not listed in ab-pack.json with its sha256`,
        );
    }
  }
  for (const i of m.incidents ?? []) {
    const path = join(packDir, "incidents", `${i.id}.json`);
    if (!existsSync(path) || sha256File(path) !== i.sha256)
      errors.push(
        `ab-pack.json lists incident ${i.id}, but the pack's record is missing or differs`,
      );
  }
  if (canonicalJson(m.gateMisses ?? null) !== canonicalJson(derived))
    errors.push(
      `ab-pack.json's gateMisses is not what the rows show (${derived.length} gate miss(es))`,
    );
  return { ok: errors.length === 0, errors, stage: m.stage };
}

export interface AbAnalysis {
  readonly status: "analysed" | "refused";
  readonly exitCode: number | null;
  readonly command: string;
  readonly errors: readonly string[];
  /** #547's printed `AbResult`, when it ran. */
  readonly result: unknown;
}

/**
 * Check the pack (refuse on any error, the pre-registration hash included), check that the
 * pre-registered `analysis.command`, filled in for this pack, is exactly the command about to
 * run (refused otherwise), then run #547's analysis CLI on it. A missing #547 is a refusal.
 */
export function analyzeAbPack(packDir: string, repoRoot: string, stage0Pack?: string): AbAnalysis {
  const checked = checkAbPack(packDir, repoRoot);
  const stage = checked.stage ?? 0;
  const command = analysisCommand(packDir, stage, stage0Pack);
  const refused = (errors: readonly string[]): AbAnalysis => ({
    status: "refused",
    exitCode: null,
    command,
    errors,
    result: null,
  });
  if (!checked.ok) return refused(checked.errors);
  if (stage === 1 && stage0Pack === undefined)
    return refused(["Stage 1 analysis needs the Stage-0 pack (its rows are excluded)"]);
  const manifest = JSON.parse(
    readFileSync(join(packDir, "ab-pack.json"), "utf8"),
  ) as AbPackManifest;
  const preregistered = fillAnalysisCommand(loadPrereg(repoRoot).prereg.analysis.command, {
    stage,
    pack: packDir,
    stage0Pack: stage0Pack ?? "",
    declared: manifest.prereg.markdownSha256,
  });
  if (preregistered !== command)
    return refused([
      `the pre-registered analysis command (${PREREG_JSON} analysis.command, filled in for this pack) is not the command the runner would run: refused. Pre-registered: ${preregistered}`,
    ]);
  if (!existsSync(join(repoRoot, ANALYSIS_SCRIPT)) || !existsSync(join(repoRoot, ANALYSIS_MODULE)))
    return refused([`${ANALYSIS_SCRIPT} (#547) is missing: nothing analysed`]);
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
