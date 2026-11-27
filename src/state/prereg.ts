/**
 * Capability track I: the frozen pre-registration (capability spec §3) and the pieces both the
 * analysis and the future run share: canonical JSON, the pre-registration hash, the
 * file-hash freeze of the analysis code, and the seeded ABBA assignment (§1.3).
 *
 * The pre-registration is `docs/product/capability-prereg/i-v1/prereg.json`. Its
 * **pre-registration hash** is the SHA-256 of its canonical JSON (sorted keys, no
 * whitespace), recorded beside it in `prereg.sha256` and in every pack. The analysis refuses
 * a pack whose hash is not that one (§3 item 2), and refuses to run at all when any frozen
 * analysis file no longer hashes to the value the pre-registration records.
 *
 * This module reads only committed repo files and node builtins. It imports nothing from
 * the gate, the grader, `groundTruth` or the fixture generator (spec §1.2 rule 4;
 * test/state/state-independence.test.ts).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const I_PREREG_DIR = "docs/product/capability-prereg/i-v1";
export const I_PREREG_JSON = `${I_PREREG_DIR}/prereg.json`;
export const I_PREREG_HASH_FILE = `${I_PREREG_DIR}/prereg.sha256`;
export const I_PREREG_SCHEMA = "myco.capability.prereg/1" as const;
export const I_ARMS = ["C1", "C1+I"] as const;
export type IArm = (typeof I_ARMS)[number];
export const I_CAPABILITY_ARM: IArm = "C1+I";
export const I_BASELINE_ARM: IArm = "C1";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Canonical JSON: object keys sorted at every depth, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("canonical JSON has no non-finite numbers");
  return JSON.stringify(value);
}

/** The pre-registration hash: SHA-256 over the canonical JSON (spec §3 item 1). */
export function preregHash(prereg: unknown): string {
  return sha256(canonicalJson(prereg));
}

export interface IBarComponent {
  readonly id: number;
  readonly metric: string;
  readonly test: "exact-mcnemar-one-sided" | "paired-bootstrap-ratio-upper";
  readonly alpha: number;
  readonly minDiscordant?: number;
  readonly resamples?: number;
  readonly threshold?: number;
  readonly requires: readonly number[];
}

export interface IPrereg {
  readonly schema: typeof I_PREREG_SCHEMA;
  readonly track: "I";
  readonly version: 1;
  readonly spec: {
    readonly path: string;
    readonly section: string;
    readonly sectionSha256: string;
  };
  readonly leadRulingPending: readonly string[];
  readonly harness: string;
  readonly arms: {
    readonly primary: { readonly capability: "C1+I"; readonly baseline: "C1" };
    readonly secondary: {
      readonly capability: string;
      readonly baseline: string;
      readonly partOfBar: false;
    };
  };
  readonly taskSet: {
    readonly version: "fc-v1";
    readonly manifest: string;
    readonly manifestSha256: string;
    readonly tasksFile: string;
    readonly tasks: 100;
    readonly satisfiable: 90;
    readonly invalidTarget: 10;
    readonly k: 1;
  };
  readonly seeds: {
    readonly assignment: string;
    readonly bootstrap: string;
    readonly taskBuild: string;
  };
  readonly assignment: { readonly scheme: string };
  readonly stepBudget: 30;
  readonly retryBudget: 0;
  readonly wallClockBudgetS: null;
  readonly scoredAttemptsPerTrial: 1;
  readonly modelId: string;
  readonly gate: "absent-in-both-arms";
  readonly primaryMetric: string;
  readonly verified: string;
  readonly bar: readonly IBarComponent[];
  readonly guardrails: readonly { readonly id: string; readonly rule: string }[];
  readonly notShown: readonly string[];
  readonly secondaryReported: readonly string[];
  readonly analysis: {
    readonly command: string;
    readonly files: Readonly<Record<string, string>>;
  };
}

export interface LoadedIPrereg {
  readonly prereg: IPrereg;
  /** The pre-registration hash (canonical JSON). */
  readonly hash: string;
}

/** The text of one `### <section>` of a markdown file, up to the next `##`/`###` heading. */
export function markdownSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.indexOf(`### ${heading}`);
  if (start < 0) throw new Error(`section "### ${heading}" not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (/^#{2,3} /.test(lines[i] as string)) {
      end = i;
      break;
    }
  return lines.slice(start, end).join("\n").trimEnd();
}

/**
 * Every problem with the pre-registration's content against the spec's track I section and
 * the frozen inputs, named. Empty means it is internally consistent and its frozen hashes
 * still hold. Reads `repoRoot` for the spec, the task-set manifest and the analysis files.
 */
export function preregProblems(p: IPrereg, repoRoot: string): string[] {
  const out: string[] = [];
  const read = (rel: string): Buffer | null => {
    try {
      return readFileSync(join(repoRoot, rel));
    } catch {
      out.push(`${rel} is missing`);
      return null;
    }
  };
  if (p.schema !== I_PREREG_SCHEMA) out.push(`schema is not ${I_PREREG_SCHEMA}`);
  if (p.track !== "I" || p.version !== 1) out.push("track must be I, version 1");
  const spec = read(p.spec?.path ?? "");
  if (spec) {
    try {
      const section = markdownSection(spec.toString("utf8"), p.spec.section);
      if (sha256(section) !== p.spec.sectionSha256)
        out.push(`the spec's "${p.spec.section}" section changed since the freeze`);
    } catch (e) {
      out.push((e as Error).message);
    }
  }
  if (p.arms?.primary?.capability !== "C1+I" || p.arms.primary.baseline !== "C1")
    out.push("the primary arms must be C1+I vs C1");
  if (p.arms?.secondary?.partOfBar !== false)
    out.push("the secondary arms are never part of the bar");
  const ts = p.taskSet;
  if (
    ts?.version !== "fc-v1" ||
    ts.tasks !== 100 ||
    ts.satisfiable !== 90 ||
    ts.invalidTarget !== 10 ||
    ts.k !== 1
  )
    out.push("the task set must be fc-v1: 100 tasks, 90 satisfiable, 10 invalid-target, k 1");
  const manifest = read(ts?.manifest ?? "");
  if (manifest && sha256(manifest) !== ts.manifestSha256)
    out.push(`${ts.manifest} does not hash to the frozen manifestSha256`);
  if (manifest) {
    const files = (JSON.parse(manifest.toString("utf8")) as { files?: Record<string, string> })
      .files;
    const tasks = read(ts.tasksFile);
    const name = ts.tasksFile.split("/").pop() as string;
    if (tasks && files?.[name] !== sha256(tasks))
      out.push(`${ts.tasksFile} does not hash to the manifest's entry`);
  }
  const s = p.seeds;
  for (const k of ["assignment", "bootstrap", "taskBuild"] as const)
    if (typeof s?.[k] !== "string" || !/^[A-Za-z0-9._:{},-]{8,64}$/.test(s[k]))
      out.push(`seeds.${k} needs 8-64 safe characters`);
  if (s && s.assignment === s.bootstrap) out.push("the assignment and bootstrap seeds must differ");
  if (p.stepBudget !== 30 || p.retryBudget !== 0 || p.scoredAttemptsPerTrial !== 1)
    out.push("step budget 30, retry budget 0, one scored attempt per trial (§1.3)");
  if (p.wallClockBudgetS !== null) out.push("no wall-clock budget (§1.3)");
  if (typeof p.modelId !== "string" || !/^claude-[a-z0-9.-]+$/.test(p.modelId))
    out.push("modelId must be a Claude model id (never a simulated label)");
  if (p.gate !== "absent-in-both-arms")
    out.push("gate presence must be equal: absent in both arms");
  if (!/never the gate/i.test(p.primaryMetric ?? ""))
    out.push("the primary metric must be grader-verified, never the gate");
  const [b1, b2, ...rest] = p.bar ?? [];
  if (
    rest.length > 0 ||
    b1?.test !== "exact-mcnemar-one-sided" ||
    b1.alpha !== 0.05 ||
    b1.minDiscordant !== 5 ||
    b1.requires.length !== 0
  )
    out.push("bar 1 must be the exact one-sided McNemar at alpha 0.05, at least 5 discordant");
  if (
    b2?.test !== "paired-bootstrap-ratio-upper" ||
    b2.alpha !== 0.05 ||
    b2.resamples !== 10_000 ||
    b2.threshold !== 1 ||
    b2.requires.length !== 1 ||
    b2.requires[0] !== 1
  )
    out.push(
      "bar 2 must be the paired-bootstrap ratio upper bound < 1.0, 10,000 resamples, after 1",
    );
  const ids = new Set((p.guardrails ?? []).map((g) => g.id));
  for (const g of ["invalid-target-false-done", "tool-output-scan"])
    if (!ids.has(g)) out.push(`guardrail ${g} is missing`);
  const files = p.analysis?.files ?? {};
  if (Object.keys(files).length === 0) out.push("analysis.files must freeze the analysis code");
  for (const [rel, want] of Object.entries(files)) {
    const bytes = read(rel);
    if (bytes && sha256(bytes) !== want) out.push(`${rel} changed since the freeze`);
  }
  if (!(p.analysis?.command ?? "").startsWith("npx tsx scripts/capability-i-analysis.ts "))
    out.push("the analysis command must be npx tsx scripts/capability-i-analysis.ts");
  return out;
}

/** Load the committed pre-registration, check it, and check its recorded hash. Throws. */
export function loadIPrereg(repoRoot: string): LoadedIPrereg {
  const prereg = JSON.parse(readFileSync(join(repoRoot, I_PREREG_JSON), "utf8")) as IPrereg;
  const hash = preregHash(prereg);
  const problems = preregProblems(prereg, repoRoot);
  const recorded = readFileSync(join(repoRoot, I_PREREG_HASH_FILE), "utf8").trim();
  if (recorded !== hash)
    problems.push(`${I_PREREG_HASH_FILE} records ${recorded}, the canonical hash is ${hash}`);
  if (problems.length > 0)
    throw new Error(`invalid track I pre-registration: ${problems.join("; ")}`);
  return { prereg, hash };
}

// ---------------------------------------------------------------------------------------------
// Seeded randomness and the ABBA assignment (§1.3)
// ---------------------------------------------------------------------------------------------

/**
 * A deterministic stream of uniforms in [0, 1) from a seed: SHA-256 of `<seed>:<counter>`,
 * first 6 bytes. Portable (no engine-specific PRNG), so anyone can recompute it.
 */
export function seededUniforms(seed: string): () => number {
  let counter = 0;
  return () => {
    const h = createHash("sha256").update(`${seed}:${counter++}`).digest();
    return h.readUIntBE(0, 6) / 2 ** 48;
  };
}

export interface ScheduledTrial {
  readonly order: number;
  readonly taskId: string;
  readonly arm: IArm;
}

/**
 * The (task, arm) trial order: tasks shuffled by the assignment seed (Fisher-Yates), then
 * paired into blocks of two tasks run ABBA (task 1 runs A then B, task 2 runs B then A), so
 * drift over a session falls on both arms. Which arm is A in a block is a seeded coin.
 * An odd last task runs A then B.
 */
export function assignmentSchedule(taskIds: readonly string[], seed: string): ScheduledTrial[] {
  if (new Set(taskIds).size !== taskIds.length) throw new Error("duplicate task id");
  const u = seededUniforms(seed);
  const tasks = [...taskIds].sort();
  for (let i = tasks.length - 1; i > 0; i--) {
    const j = Math.floor(u() * (i + 1));
    [tasks[i], tasks[j]] = [tasks[j] as string, tasks[i] as string];
  }
  const out: ScheduledTrial[] = [];
  for (let b = 0; b < tasks.length; b += 2) {
    const a: IArm = u() < 0.5 ? I_BASELINE_ARM : I_CAPABILITY_ARM;
    const other: IArm = a === I_BASELINE_ARM ? I_CAPABILITY_ARM : I_BASELINE_ARM;
    const first = tasks[b] as string;
    out.push({ order: out.length, taskId: first, arm: a });
    out.push({ order: out.length, taskId: first, arm: other });
    const second = tasks[b + 1];
    if (second !== undefined) {
      out.push({ order: out.length, taskId: second, arm: other });
      out.push({ order: out.length, taskId: second, arm: a });
    }
  }
  return out;
}
