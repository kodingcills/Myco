/**
 * The corrections A/B pre-registration and the real-run preconditions, split out of
 * `src/pilot/ab.ts` so that `runPilot` (`src/pilot/runner.ts`) can apply the same
 * preconditions to any live A/B arm config without an import cycle. `ab.ts` re-exports all of
 * this; see its header for the design.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { HARNESS_CLASSES, m2TrialOpsSchema } from "../../schemas/m2-evidence.ts";
import { GATE_STATE_FILE } from "../benchmark/gated-rows.ts";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import { checkPacing, type PacingConfig, pilotConfig } from "./config.ts";
import { PILOT_HARNESS_CLASSES } from "./ledger.ts";

export const AB_EXPERIMENT = "corrections-ab";
export const PREREG_MD = "docs/benchmark/corrections-ab-prereg.md";
export const PREREG_JSON = "docs/benchmark/corrections-ab-prereg.json";
/** The lead's GO for real trials: a committed file. Absent until the lead gives it. */
export const LEAD_GO_FILE = "docs/benchmark/corrections-ab-go.json";
export const PREREG_SCHEMA = "myco.pilot.corrections-ab-prereg/1" as const;
/** #547's analysis CLI (merged). `analyzeAbPack` refuses a pack when it is missing. */
export const ANALYSIS_SCRIPT = "scripts/m2-corrections-ab.ts";
export const ANALYSIS_MODULE = "src/m2/corrections-ab.ts";

export type AbStage = 0 | 1;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const sha256File = (path: string) => sha256(readFileSync(path));

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
  if (!(p.analysis?.command ?? "").startsWith(`npx tsx ${ANALYSIS_SCRIPT} `))
    problems.push(`the analysis command must be npx tsx ${ANALYSIS_SCRIPT} (#547)`);
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
 * The pre-registered analysis command (`analysis.command`, with placeholders) filled in for one
 * pack: `<0|1>` the stage, `<pack>/X` and `<stage0-pack>/X` joined like the runner joins them,
 * `<pack's recorded sha256>` the pack's recorded hash, and the bracketed Stage-0 options kept
 * (without brackets) for Stage 1 and dropped for Stage 0. `analyzeAbPack` refuses unless this
 * equals the command it runs, so the frozen file always states the command actually run.
 */
export function fillAnalysisCommand(
  template: string,
  v: {
    readonly stage: AbStage;
    readonly pack: string;
    readonly stage0Pack: string;
    readonly declared: string;
  },
): string {
  const optional = /\s*\[([^\]]*)\]/;
  const withStage0 = template.replace(optional, (_m, inner: string) =>
    v.stage === 1 ? ` ${inner.trim()}` : "",
  );
  return withStage0
    .replaceAll("<0|1>", String(v.stage))
    .replaceAll("<pack's recorded sha256>", v.declared)
    .replace(/<stage0-pack>\/(\S+)/g, (_m, rest: string) => join(v.stage0Pack, rest))
    .replace(/<pack>\/(\S+)/g, (_m, rest: string) => join(v.pack, rest));
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

/** The pilot harness classes #518's attempt-event schema can name (today only `timeout`). */
export function r1Nameable(pilotClass: string): boolean {
  return (HARNESS_CLASSES as readonly string[]).includes(pilotClass);
}

// ---------------------------------------------------------------------------------------------
// Real-run gating
// ---------------------------------------------------------------------------------------------

/**
 * Why the lead's GO file does not approve a real run of `stage`: it must exist, be JSON, be
 * committed and unchanged from HEAD, name this pre-registration's markdown sha256, and list the
 * stage in `stages` (a GO for Stage 0 never admits Stage 1). Never throws: a malformed file is a
 * refusal, so this fails closed.
 */
export function leadGoProblems(repoRoot: string, loaded: LoadedPrereg, stage: AbStage): string[] {
  const goPath = join(repoRoot, LEAD_GO_FILE);
  if (!existsSync(goPath))
    return [`no lead GO: ${LEAD_GO_FILE} is not committed (real runs wait for the lead's GO)`];
  const out: string[] = [];
  let go: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(readFileSync(goPath, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      go = parsed as Record<string, unknown>;
  } catch {
    // reported below
  }
  if (go === null) out.push(`${LEAD_GO_FILE} is not a JSON object`);
  else {
    if (go.preregSha256 !== loaded.markdownSha256)
      out.push(`${LEAD_GO_FILE} names another pre-registration (preregSha256)`);
    if (!Array.isArray(go.stages) || !go.stages.includes(stage))
      out.push(`${LEAD_GO_FILE} does not approve Stage ${stage} (its stages do not list it)`);
  }
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", LEAD_GO_FILE], {
    cwd: repoRoot,
  });
  if (tracked.status !== 0) out.push(`${LEAD_GO_FILE} is not committed`);
  else {
    const clean = spawnSync("git", ["diff", "--quiet", "HEAD", "--", LEAD_GO_FILE], {
      cwd: repoRoot,
    });
    if (clean.status !== 0) out.push(`${LEAD_GO_FILE} differs from the committed copy`);
  }
  return out;
}

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
  out.push(...leadGoProblems(repoRoot, loaded, stage));
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
