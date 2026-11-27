/**
 * Track M's pre-registration (capability-spec §3): load and check
 * `docs/product/capability-prereg/m-v1/prereg.json`, compute its pre-registration hash
 * (SHA-256 over canonical JSON), resolve the base surface by the pre-registered rule, and
 * derive the seeded trial schedule.
 *
 * The pre-registration names every file its analysis runs (the CLI and the `src/skills`
 * modules it imports) with each file's SHA-256, so a change to the analysis after the freeze
 * is visible: `preregProblems` reports it and the analysis refuses to run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "./record.ts";
import { type RepManifest, repManifestProblems, repManifestSha256 } from "./rep-taskset.ts";

export const M_PREREG_PATH = "docs/product/capability-prereg/m-v1/prereg.json";
export const M_PREREG_SCHEMA = "myco.capability-prereg/1";
export const M_PREREG_VERSION = "m-v1";

/** The surfaces M can be measured on: I's primary arm, J's primary arm, or plain C1. */
export const BASE_SURFACES = ["C1", "C1+I", "hcu+shell+J"] as const;
export type BaseSurface = (typeof BASE_SURFACES)[number];

export interface MPrereg {
  readonly schema: typeof M_PREREG_SCHEMA;
  readonly track: "M";
  readonly version: typeof M_PREREG_VERSION;
  readonly ratification: {
    readonly status: "proposed" | "ratified";
    readonly pending: readonly { readonly id: string; readonly proposed: string }[];
  };
  readonly baseSurface: {
    readonly rule: string;
    readonly candidates: readonly { readonly capability: "I" | "J"; readonly surface: string }[];
    readonly fallback: "C1";
    readonly measurementOrder: readonly string[];
  };
  readonly taskSet: {
    readonly version: "rep-v1";
    readonly manifest: string;
    readonly manifestSha256: string;
    readonly learn: number;
    readonly repeat: number;
    readonly similar: number;
    readonly testUnits: number;
  };
  readonly seeds: {
    readonly taskBuild: string;
    readonly assignment: string;
    readonly bootstrap: string;
  };
  readonly stepBudget: number;
  readonly retryBudget: number;
  readonly modelId: string;
  readonly arms: { readonly treatment: "skills-on"; readonly control: "cold" };
  readonly bar: {
    readonly test: string;
    readonly sided: "one-sided";
    readonly alpha: number;
    readonly minDiscordant: number;
    readonly direction: "skills-on better than cold";
  };
  readonly rowSchema: string;
  readonly packSchema: string;
  readonly analysis: {
    readonly command: string;
    readonly files: readonly { readonly path: string; readonly sha256: string }[];
  };
  readonly [k: string]: unknown;
}

export interface LoadedMPrereg {
  readonly prereg: MPrereg;
  /** SHA-256 over the canonical JSON of the file: what every pack records. */
  readonly hash: string;
  readonly manifest: RepManifest;
}

/** The pre-registration hash: SHA-256 over canonical JSON (capability-spec §3.1). */
export function preregHash(prereg: unknown): string {
  return sha256(canonicalJson(prereg));
}

/** Read the committed pre-registration and its manifest. Does not check them. */
export function readMPrereg(repoRoot: string, path = M_PREREG_PATH): LoadedMPrereg {
  const prereg = JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as MPrereg;
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, prereg.taskSet.manifest), "utf8"),
  ) as RepManifest;
  return { prereg, hash: preregHash(prereg), manifest };
}

const SEED = /^[A-Za-z0-9._:-]{8,64}$/;

/**
 * Every way the loaded pre-registration breaks capability-spec §2 M or §3. Empty when it
 * holds. `fileSha256` reads a repo file's bytes (injected so the tests can tamper).
 */
export function preregProblems(
  loaded: LoadedMPrereg,
  fileSha256: (path: string) => string | null,
): string[] {
  const { prereg: p, manifest } = loaded;
  const out: string[] = [];
  if (p.schema !== M_PREREG_SCHEMA) out.push("schema");
  if (p.track !== "M" || p.version !== M_PREREG_VERSION) out.push("track/version");
  if (p.ratification?.status !== "proposed" && p.ratification?.status !== "ratified")
    out.push("ratification.status");
  if (p.ratification?.status === "ratified" && (p.ratification.pending ?? []).length > 0)
    out.push("a ratified pre-registration has no pending rulings");
  const ts = p.taskSet;
  if (ts?.version !== "rep-v1") out.push("taskSet.version");
  if (ts?.learn !== 30 || ts.repeat !== 30 || ts.similar !== 30 || ts.testUnits !== 60)
    out.push("taskSet counts are not the ruled 30/30/30 (60 test units, lead 06:30Z)");
  if (ts?.manifestSha256 !== repManifestSha256(manifest))
    out.push("taskSet.manifestSha256 does not match the committed manifest");
  if (manifest.buildSeed !== p.seeds?.taskBuild)
    out.push("the manifest was not built with seeds.taskBuild");
  out.push(...repManifestProblems(manifest).map((m) => `manifest: ${m}`));
  const s = p.seeds;
  for (const k of ["taskBuild", "assignment", "bootstrap"] as const)
    if (typeof s?.[k] !== "string" || !SEED.test(s[k])) out.push(`seeds.${k}`);
  if (s && new Set([s.taskBuild, s.assignment, s.bootstrap]).size !== 3)
    out.push("seeds must be distinct");
  if (p.stepBudget !== 30) out.push("stepBudget is not the spec's 30");
  if (p.retryBudget !== 0) out.push("retryBudget is not the spec's 0");
  if (!/^claude-[a-z0-9.-]+$/.test(p.modelId ?? "")) out.push("modelId is not a model id");
  if (p.arms?.treatment !== "skills-on" || p.arms.control !== "cold") out.push("arms");
  const b = p.bar;
  if (
    !/mcnemar/i.test(b?.test ?? "") ||
    b.sided !== "one-sided" ||
    b.alpha !== 0.05 ||
    b.minDiscordant !== 5 ||
    b.direction !== "skills-on better than cold"
  )
    out.push("bar is not the spec's exact one-sided McNemar at 0.05 with 5 discordant");
  const bs = p.baseSurface;
  if (
    bs?.fallback !== "C1" ||
    bs.candidates?.[0]?.capability !== "I" ||
    bs.candidates[0].surface !== "C1+I" ||
    bs.candidates[1]?.capability !== "J" ||
    bs.candidates[1].surface !== "hcu+shell+J" ||
    bs.candidates.length !== 2
  )
    out.push("baseSurface candidates are not I (C1+I), J (hcu+shell+J), fallback C1");
  if ((bs?.measurementOrder ?? []).join(">") !== "I>J>M")
    out.push("baseSurface.measurementOrder is not I>J>M");
  if (p.rowSchema !== "myco.skills.rep-row/1") out.push("rowSchema");
  if (p.packSchema !== "myco.skills.rep-pack/1") out.push("packSchema");
  const files = p.analysis?.files ?? [];
  if (files.length === 0) out.push("analysis.files is empty");
  for (const f of files) {
    const actual = fileSha256(f.path);
    if (actual === null) out.push(`analysis file ${f.path} is missing`);
    else if (actual !== f.sha256) out.push(`analysis file ${f.path} changed since the freeze`);
  }
  if (!(p.analysis?.command ?? "").startsWith("npx tsx scripts/m-learning-analysis.ts "))
    out.push("analysis.command");
  return out;
}

/** Read a repo file's SHA-256, or null when it does not exist. */
export function repoFileSha256(repoRoot: string): (path: string) => string | null {
  return (path) => {
    try {
      return sha256(readFileSync(join(repoRoot, path)));
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Base surface (capability-spec §2 M "Base surface: the best shown of I, J, else C1"; §5.4)
// ---------------------------------------------------------------------------------------------

export interface CapabilityOutcome {
  /** I must be decided before M runs; J may not have run. */
  readonly status: "shown" | "not-shown" | "not-run";
  /** The capability arm's grader-verified rate in its own measured run (for the tie-break). */
  readonly verifiedRate: number | null;
  /** The pre-registration hash that capability's result was analysed under. */
  readonly preregHash: string | null;
}

export interface BaseSurfaceBasis {
  readonly I: CapabilityOutcome;
  readonly J: CapabilityOutcome;
}

/**
 * The pre-registered rule: M is measured after I is decided (and after J, if J ran). Of the
 * capabilities whose bar is shown, the one with the higher grader-verified rate in its own
 * run is the base (a tie goes to I, measured first); if none is shown, C1. Returns the
 * surface, or a refusal code.
 */
export function resolveBaseSurface(
  basis: BaseSurfaceBasis,
): { ok: true; surface: BaseSurface } | { ok: false; code: string } {
  if (basis.I.status === "not-run") return { ok: false, code: "I_NOT_DECIDED" };
  for (const [name, o] of [
    ["I", basis.I],
    ["J", basis.J],
  ] as const) {
    if (o.status === "not-run") continue;
    if (o.preregHash === null || !/^[0-9a-f]{64}$/.test(o.preregHash))
      return { ok: false, code: `${name}_PREREG_MISSING` };
    if (o.status === "shown" && (o.verifiedRate === null || !(o.verifiedRate >= 0)))
      return { ok: false, code: `${name}_RATE_MISSING` };
  }
  const iShown = basis.I.status === "shown";
  const jShown = basis.J.status === "shown";
  if (iShown && jShown)
    return {
      ok: true,
      surface:
        (basis.J.verifiedRate as number) > (basis.I.verifiedRate as number)
          ? "hcu+shell+J"
          : "C1+I",
    };
  if (iShown) return { ok: true, surface: "C1+I" };
  if (jShown) return { ok: true, surface: "hcu+shell+J" };
  return { ok: true, surface: "C1" };
}

// ---------------------------------------------------------------------------------------------
// Schedule (capability-spec §1.3: seeded, interleaved, ABBA per task)
// ---------------------------------------------------------------------------------------------

export type MArm = "skills-on" | "cold";

export interface MSchedule {
  /** Learn-phase task ids, in run order. */
  readonly learn: readonly string[];
  /** Test-phase trials, in run order: each unit twice, arms in ABBA blocks over units. */
  readonly test: readonly { readonly unitId: string; readonly arm: MArm }[];
}

const rank = (seed: string, item: string) => sha256(`${seed}\u0000${item}`);

/** The pre-registered run order, derived from the assignment seed only. */
export function mSchedule(manifest: RepManifest, assignmentSeed: string): MSchedule {
  const sortBy = (prefix: string) => (a: string, b: string) => {
    const x = rank(assignmentSeed, `${prefix}:${a}`);
    const y = rank(assignmentSeed, `${prefix}:${b}`);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const learn = manifest.learn.map((r) => r.taskId).sort(sortBy("learn"));
  const units = manifest.test.map((u) => u.unitId).sort(sortBy("test"));
  const first: MArm =
    Number.parseInt(rank(assignmentSeed, "first-arm").slice(0, 1), 16) % 2 === 0
      ? "cold"
      : "skills-on";
  const second: MArm = first === "cold" ? "skills-on" : "cold";
  const test = units.flatMap((unitId, i) =>
    i % 2 === 0
      ? [
          { unitId, arm: first },
          { unitId, arm: second },
        ]
      : [
          { unitId, arm: second },
          { unitId, arm: first },
        ],
  );
  return { learn, test };
}
