/**
 * Capability track K: the pre-registration (`docs/product/capability-spec.md` §3) and its
 * check. The committed file is `docs/product/capability-prereg/k-v1/prereg.json`.
 *
 * ## The pre-registration hash
 *
 * §3.1: "its SHA-256 over canonical JSON is the pre-registration hash". The file stores that
 * hash in its own `preregistrationHash` member, so the hash is computed over the canonical
 * JSON of the file WITHOUT that member (`preregHash`). Canonical JSON (`canonicalJson`):
 * object keys sorted by UTF-16 code unit, no whitespace, strings and finite numbers as
 * `JSON.stringify` writes them; anything else (undefined, a function, a non-finite number, a
 * non-plain object) is refused, so two readers can never disagree on the bytes.
 *
 * ## Draft or frozen
 *
 * The spec leaves the K step budget (80) and the `ms-long-v1` size (40) to the lead (§6), and
 * `ms-long-v1` is not built, so its manifest SHA-256 does not exist yet. The file therefore
 * says `status: "draft"` and lists every open item in `pending`. It is frozen only when
 * `pending` is empty, `status` is `"frozen"` and the manifest SHA-256 is set
 * (`checkKPrereg`'s `frozen`). The analysis (`./analysis.ts`) refuses evidence against a
 * draft: a draft can only analyse plumbing (simulated) packs.
 *
 * ## What the check pins
 *
 * The stored hash; the K section of the spec by SHA-256 (the bar as written); the bar's test,
 * side, alpha and discordant minimum (§1.5); the arms against `ARM_CONFIG`; the task set
 * version and fault kinds against `batch.ts`; the model id against the evidence planners;
 * the analysis script and modules, the instruction renderer and the grader entry by SHA-256.
 * File reads are injected (`PreregFiles`): this module imports only `node:crypto`, under the
 * `src/recovery/` import boundary (`test/recovery/boundary.test.ts`).
 */
import { createHash } from "node:crypto";
import {
  BAR_ALPHA,
  BAR_MIN_DISCORDANT,
  FAULT_KINDS,
  RECOVERY_CONTRAST,
  RECOVERY_EVIDENCE_PLANNERS,
  RECOVERY_TASKSET_VERSION,
} from "./batch.ts";
import { ARM_CONFIG } from "./trial.ts";

export const K_PREREG_SCHEMA = "myco.capability.prereg/1" as const;
export const K_PREREG_PATH = "docs/product/capability-prereg/k-v1/prereg.json";
export const K_SPEC_PATH = "docs/product/capability-spec.md";
export const K_SPEC_HEADING = "### K. Recovery";
export const K_ANALYSIS_SCRIPT = "scripts/k-recovery-analysis.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const SEED = /^[A-Za-z0-9._:-]{8,64}$/;

/** Canonical JSON (see the module header). Throws on a value it cannot write canonically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`canonical JSON: cannot write a ${typeof value}`);
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The pre-registration hash: SHA-256 of the canonical JSON without `preregistrationHash`. */
export function preregHash(prereg: Readonly<Record<string, unknown>>): string {
  const { preregistrationHash: _omit, ...body } = prereg;
  return sha256(canonicalJson(body));
}

/** The K section of the spec: from its heading up to the next `## ` or `### ` heading. */
export function specSection(markdown: string, heading: string = K_SPEC_HEADING): string | null {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (/^#{2,3} /.test(lines[i] as string)) {
      end = i;
      break;
    }
  return lines.slice(start, end).join("\n");
}

export const specSectionSha256 = (markdown: string) => {
  const section = specSection(markdown);
  return section === null ? null : sha256(section);
};

export interface PinnedFile {
  readonly path: string;
  readonly sha256: string;
}

export interface PendingItem {
  readonly field: string;
  readonly reason: string;
}

/** The shape of `prereg.json`. Validated by `checkKPrereg`, never trusted. */
export interface KPrereg {
  readonly schema: typeof K_PREREG_SCHEMA;
  readonly track: "K";
  readonly version: "k-v1";
  readonly status: "draft" | "frozen";
  readonly pending: readonly PendingItem[];
  readonly spec: {
    readonly path: string;
    readonly heading: string;
    readonly sectionSha256: string;
  };
  readonly bar: {
    readonly primaryMetric: string;
    readonly test: string;
    readonly sided: "one-sided";
    readonly alpha: number;
    readonly minDiscordant: number;
    readonly unit: string;
    readonly notShown: readonly string[];
    readonly secondary: readonly string[];
    readonly guardrails: readonly string[];
  };
  readonly contrast: string;
  readonly arms: Readonly<
    Record<
      "K" | "no-recovery",
      {
        readonly recoveryTools: boolean;
        readonly corrections: "on" | "off";
        readonly retryBudget: 0 | 1;
      }
    >
  >;
  readonly baseSurface: string;
  readonly taskSet: {
    readonly version: string;
    readonly family: string;
    readonly size: number;
    readonly editsPerTask: number;
    readonly faultedTasks: number;
    readonly faultKinds: readonly string[];
    readonly manifestPath: string;
    readonly manifestSha256: string | null;
  };
  readonly seeds: {
    readonly assignment: string;
    readonly bootstrap: string;
    readonly taskBuild: string;
  };
  readonly assignment: string;
  readonly stepBudget: number;
  readonly k: 1;
  readonly modelId: string;
  readonly harness: string;
  readonly instruction: PinnedFile & { readonly version: string };
  readonly grader: PinnedFile & { readonly version: string };
  readonly analysis: {
    readonly script: PinnedFile;
    readonly modules: readonly PinnedFile[];
    readonly command: string;
  };
  readonly evidence: string;
  readonly preregistrationHash: string;
}

/** File reads the check needs, injected so this module stays I/O-free. */
export interface PreregFiles {
  /** SHA-256 (hex) of a repo file's bytes, or null if it does not exist. */
  sha256(path: string): string | null;
  /** A repo file's text, or null if it does not exist. */
  text(path: string): string | null;
}

export interface PreregCheck {
  /** Empty when the file is a valid pre-registration (draft or frozen). */
  readonly problems: readonly string[];
  /** Valid, `status: "frozen"`, nothing pending, manifest SHA-256 set. */
  readonly frozen: boolean;
  /** The hash recomputed over the file. */
  readonly hash: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const MODULES_REQUIRED = [
  "src/recovery/analysis.ts",
  "src/recovery/batch.ts",
  "src/recovery/prereg.ts",
];

/** Validate a parsed `prereg.json` against the spec, the code and the committed files. */
export function checkKPrereg(raw: unknown, files: PreregFiles): PreregCheck {
  const problems: string[] = [];
  if (!isObject(raw))
    return { problems: ["the pre-registration is not an object"], frozen: false, hash: null };
  const p = raw as unknown as KPrereg;
  let hash: string | null = null;
  try {
    hash = preregHash(raw);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (hash !== null && p.preregistrationHash !== hash)
    problems.push(`preregistrationHash is not the hash of the file (${hash})`);
  if (p.schema !== K_PREREG_SCHEMA) problems.push(`schema is not ${K_PREREG_SCHEMA}`);
  if (p.track !== "K" || p.version !== "k-v1") problems.push("track and version must be K, k-v1");

  // The bar as written: the spec's K section, pinned by hash.
  const specText = files.text(K_SPEC_PATH);
  const sectionHash = specText === null ? null : specSectionSha256(specText);
  if (p.spec?.path !== K_SPEC_PATH || p.spec?.heading !== K_SPEC_HEADING)
    problems.push(`spec must point at ${K_SPEC_PATH}, ${K_SPEC_HEADING}`);
  if (sectionHash === null || p.spec?.sectionSha256 !== sectionHash)
    problems.push("spec.sectionSha256 is not the SHA-256 of the spec's K section as committed");
  const bar = p.bar;
  if (
    bar?.sided !== "one-sided" ||
    bar.alpha !== BAR_ALPHA ||
    bar.minDiscordant !== BAR_MIN_DISCORDANT
  )
    problems.push(
      `the bar must be one-sided, alpha ${BAR_ALPHA}, at least ${BAR_MIN_DISCORDANT} discordant tasks`,
    );
  if (!/exact one-sided McNemar/.test(String(bar?.test)))
    problems.push("the bar's test must be the exact one-sided McNemar");
  if (
    !/independent grader/.test(String(bar?.primaryMetric)) ||
    !/never the gate/.test(String(bar?.primaryMetric))
  )
    problems.push("the primary metric must be graded by the independent grader, never the gate");
  for (const list of ["notShown", "secondary", "guardrails"] as const)
    if (
      !Array.isArray(bar?.[list]) ||
      bar[list].length === 0 ||
      !bar[list].every((s) => typeof s === "string")
    )
      problems.push(`bar.${list} must be a non-empty list of strings`);

  // Arms and contrast, against the code.
  if (p.contrast !== RECOVERY_CONTRAST) problems.push(`contrast must be ${RECOVERY_CONTRAST}`);
  for (const arm of ["K", "no-recovery"] as const) {
    const want = ARM_CONFIG[arm];
    const got = p.arms?.[arm];
    if (
      got?.recoveryTools !== want.recoveryTools ||
      got.corrections !== want.corrections ||
      got.retryBudget !== want.retryBudget ||
      Object.keys(got).length !== 3
    )
      problems.push(`arms.${arm} is not the arm config in src/recovery/trial.ts`);
  }
  if (p.arms !== undefined && Object.keys(p.arms).length !== 2)
    problems.push("there are exactly two arms");

  // Task set.
  const ts = p.taskSet;
  if (ts?.version !== RECOVERY_TASKSET_VERSION)
    problems.push(`taskSet.version must be ${RECOVERY_TASKSET_VERSION}`);
  if (ts?.family !== "calc-multi-step") problems.push("taskSet.family must be calc-multi-step");
  for (const field of ["size", "editsPerTask", "faultedTasks"] as const)
    if (!Number.isInteger(ts?.[field]) || (ts[field] as number) < 1)
      problems.push(`taskSet.${field} must be a positive integer`);
  if (Number.isInteger(ts?.size) && ts.faultedTasks * 2 !== ts.size)
    problems.push(
      "taskSet.faultedTasks must be half the tasks (spec: a seeded fault on half of them)",
    );
  if (
    !Array.isArray(ts?.faultKinds) ||
    ts.faultKinds.length !== FAULT_KINDS.length ||
    !FAULT_KINDS.every((k, i) => ts.faultKinds[i] === k)
  )
    problems.push(`taskSet.faultKinds must be ${FAULT_KINDS.join(", ")}`);
  if (ts?.manifestSha256 !== null && !SHA256.test(String(ts?.manifestSha256)))
    problems.push("taskSet.manifestSha256 must be null (pending) or sha256 hex");
  if (typeof ts?.manifestSha256 === "string" && files.sha256(ts.manifestPath) !== ts.manifestSha256)
    problems.push("taskSet.manifestSha256 is not the SHA-256 of the committed manifest");

  // Seeds, budget, model.
  const seeds = p.seeds;
  const seedValues = [seeds?.assignment, seeds?.bootstrap, seeds?.taskBuild];
  if (!seedValues.every((s) => typeof s === "string" && SEED.test(s)))
    problems.push("seeds.assignment, bootstrap and taskBuild must be 8-64 safe characters");
  else if (new Set(seedValues).size !== 3) problems.push("the three seeds must differ");
  if (!Number.isInteger(p.stepBudget) || p.stepBudget < 1)
    problems.push("stepBudget must be a positive integer");
  if (p.k !== 1) problems.push("k must be 1 (one scored attempt per trial per arm)");
  if (!RECOVERY_EVIDENCE_PLANNERS.has(p.modelId))
    problems.push("modelId must be an evidence planner model id");

  // Pinned code: the analysis, the renderer and the grader entry, by SHA-256.
  const pinned: PinnedFile[] = [];
  if (p.analysis?.script?.path !== K_ANALYSIS_SCRIPT)
    problems.push(`analysis.script must be ${K_ANALYSIS_SCRIPT}`);
  const modules = Array.isArray(p.analysis?.modules) ? p.analysis.modules : [];
  const paths = modules.map((m) => m?.path);
  if (MODULES_REQUIRED.some((m) => !paths.includes(m)))
    problems.push(`analysis.modules must include ${MODULES_REQUIRED.join(", ")}`);
  if (
    !String(p.analysis?.command).startsWith(
      `npx tsx ${K_ANALYSIS_SCRIPT} --prereg ${K_PREREG_PATH} `,
    )
  )
    problems.push(`analysis.command must run ${K_ANALYSIS_SCRIPT} on ${K_PREREG_PATH}`);
  pinned.push(p.analysis?.script, ...modules, p.instruction, p.grader);
  for (const file of pinned) {
    if (!isObject(file) || typeof file.path !== "string" || !SHA256.test(String(file.sha256))) {
      problems.push("a pinned file needs a path and a sha256");
      continue;
    }
    const actual = files.sha256(file.path);
    if (actual !== file.sha256)
      problems.push(`${file.path}: sha256 does not match the committed file`);
  }

  // Draft or frozen.
  const pending = Array.isArray(p.pending) ? p.pending : null;
  if (
    pending === null ||
    !pending.every(
      (x) => isObject(x) && typeof x.field === "string" && typeof x.reason === "string",
    )
  )
    problems.push("pending must be a list of { field, reason }");
  if (p.status !== "draft" && p.status !== "frozen")
    problems.push("status must be draft or frozen");
  if (p.status === "frozen" && (pending?.length ?? 1) > 0)
    problems.push("a frozen pre-registration has nothing pending");
  if (p.status === "frozen" && ts?.manifestSha256 === null)
    problems.push("a frozen pre-registration needs the task set's manifest SHA-256");
  if (p.status === "draft" && pending?.length === 0) problems.push("a draft lists what is pending");
  if (ts?.manifestSha256 === null && !pending?.some((x) => x.field === "taskSet.manifestSha256"))
    problems.push("a null manifest SHA-256 must be listed as pending");

  return { problems, frozen: problems.length === 0 && p.status === "frozen", hash };
}
