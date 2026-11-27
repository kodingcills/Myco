/**
 * The corrections ON/OFF A/B evidence pack (TIF-274; the scorecard's experiment row `AB`), read
 * and checked. Layout and manifest: `schemas/m2-ab-pack.ts`.
 *
 * A separate pack kind, kept apart from R1 on purpose:
 *  - its manifest is `myco.m2.ab-pack/1` (row `AB`, `evidenceUse: "experiment-only (never R1
 *    evidence)"`), and it has no `rows`, so it can never be cited for an R row. The R-pack check
 *    (`checkPack`) validates `myco.m2.pack/1` and refuses this manifest, and it refuses the
 *    experiment-marked A/B rows in every R pack (`experimentRowsError`, #547);
 *  - the analysis is `checkCorrectionsAb` with `evidence: true` (no simulated planner, Stage 0's
 *    pilot set, Stage 1's exclusion of Stage-0 trials and pre-registration hash, the integrity
 *    halt), plus the same per-trial process rules as an R pack (`trialProcessErrors`: the load
 *    gate, the cold-boot check, causes, harness classes);
 *  - Stage 0 is plumbing: its effect is `not-claimed` (null), whatever the numbers say. A halted
 *    or otherwise failing pack is not ok, and the scorecard may not cite it.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { m2AbPackManifestSchema } from "../../schemas/m2-ab-pack.ts";
import { m2TrialOpsSchema } from "../../schemas/m2-evidence.ts";
import { validateSchema } from "../../schemas/validate.ts";
import type { BenchmarkArmRow } from "../benchmark/check.ts";
import type { BenchmarkGradeRow } from "../benchmark/grade/row.ts";
import { PREREG_JSON, PREREG_MD } from "../pilot/ab-prereg.ts";
import {
  AB_EVIDENCE_USE,
  type AbResult,
  type AbStage,
  checkCorrectionsAb,
} from "./corrections-ab.ts";
import { type TrialOps, trialProcessErrors } from "./evidence.ts";

export const AB_PACK_SCHEMA = "myco.m2.ab-pack/1";

export interface AbPackManifest {
  readonly schema: typeof AB_PACK_SCHEMA;
  readonly row: "AB";
  readonly stage: AbStage;
  readonly evidenceUse: typeof AB_EVIDENCE_USE;
  readonly preregistration?: { readonly file: string; readonly sha256: string };
}

interface AbPackArm {
  readonly arm: readonly unknown[];
  readonly grades: readonly unknown[];
  readonly ops: readonly unknown[];
  readonly runConfig: unknown;
}

export interface AbPackInput {
  readonly manifest: unknown;
  readonly on: AbPackArm;
  readonly off: AbPackArm;
  readonly stage0: { readonly on: readonly unknown[]; readonly off: readonly unknown[] } | null;
  /** sha256 of the committed pre-registration file the manifest names, or null (unread). */
  readonly preregCommittedSha256: string | null;
  readonly readErrors: readonly string[];
}

export interface AbPackResult {
  readonly kind: "ab";
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly manifest: AbPackManifest | null;
  readonly evidenceUse: typeof AB_EVIDENCE_USE;
  /** The analysis, when the manifest is valid (null otherwise). */
  readonly ab: AbResult | null;
}

const ARM_FILES = ["arm.jsonl", "grades.jsonl", "ops.jsonl", "run-config.json"] as const;

function readJsonl(path: string, name: string, errors: string[]): unknown[] {
  if (!existsSync(path)) {
    errors.push(`${name}: missing`);
    return [];
  }
  const out: unknown[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (line.trim() === "") return;
      try {
        out.push(JSON.parse(line));
      } catch {
        errors.push(`${name} line ${i + 1}: not JSON`);
      }
    });
  return out;
}

function readJson(path: string, name: string, errors: string[]): unknown {
  if (!existsSync(path)) {
    errors.push(`${name}: missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    errors.push(`${name}: not JSON`);
    return null;
  }
}

/** Every entry under `dir` must be part of the layout; nothing is skipped silently. */
function layoutErrors(dir: string, stage1: boolean): string[] {
  const allowed = new Map<string, readonly string[] | null>([
    ["pack.json", null],
    ["README.md", null],
    ["on", ARM_FILES],
    ["off", ARM_FILES],
  ]);
  if (stage1) allowed.set("stage0", ["on", "off"]);
  const errors: string[] = [];
  for (const entry of readdirSync(dir)) {
    const kids = allowed.get(entry);
    if (kids === undefined) {
      errors.push(`${entry}: not part of the A/B pack layout (schemas/m2-ab-pack.ts)`);
      continue;
    }
    if (kids === null || !statSync(join(dir, entry)).isDirectory()) continue;
    for (const sub of readdirSync(join(dir, entry))) {
      if (!kids.includes(sub)) {
        errors.push(`${entry}/${sub}: not part of the A/B pack layout`);
        continue;
      }
      if (entry === "stage0")
        for (const leaf of readdirSync(join(dir, entry, sub)))
          if (leaf !== "arm.jsonl")
            errors.push(`stage0/${sub}/${leaf}: not part of the A/B pack layout`);
    }
  }
  return errors;
}

/**
 * The only files a Stage-1 pack may bind as its pre-registration: track E's committed
 * pre-registration (#549), exactly as `src/pilot/ab-prereg.ts` names it. Compared by exact
 * string, so a copy elsewhere, a case variant, a link under another name or the pack's README
 * is refused before it is opened; the location check and the hash below still apply to these.
 */
export const PREREG_FILES: readonly string[] = [PREREG_MD, PREREG_JSON];

/** Where every evidence pack lives; a pre-registration may never be one of its files. */
export const EVIDENCE_TREE = "docs/research/experiments";

/** True when `path` is `dir` itself or inside it (separator-safe: `/a/b-x` is not in `/a/b`). */
const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}${sep}`);

/** A file system object's identity: the same object under any spelling, link or case. */
const identity = (st: Stats) => `${st.dev}:${st.ino}`;

/** The identities of every directory above `path` (`path` has no links: a native realpath). */
function ancestorIdentities(path: string): Set<string> {
  const ids = new Set<string>();
  for (let d = dirname(path); ; ) {
    ids.add(identity(statSync(d)));
    const up = dirname(d);
    if (up === d) return ids;
    d = up;
  }
}

/** Where a declared pre-registration file may not be bound (`error`), or the checked file. */
export type PreregLocation =
  | { readonly error: string; readonly real?: undefined; readonly stat?: undefined }
  | { readonly error: null; readonly real: string; readonly stat: Stats };

/**
 * Why a declared pre-registration file may not be bound, or the checked file (#554 rounds 1-3).
 * The pre-registration states the fixed design BEFORE the run, so it must be a repository file
 * the pack cannot have written: it must exist inside the repository once symlinks are resolved
 * (an in-repo link to a file outside is refused), and it may not be inside the pack directory
 * (its own README, say) or anywhere under the evidence tree.
 *
 * Containment is by identity (device and inode of every directory above the file's native
 * realpath), never by spelling: on a case-insensitive file system (macOS APFS)
 * `Docs/research/experiments/<pack>/README.md` names the pack's own README under a spelling no
 * string comparison matches, and the evidence tree may itself be reached through a link. A
 * regular file with more than one hard link is refused, as `resolveScoped` does
 * (`src/actions/policy.ts`): its other names are invisible to realpath, so its location cannot be
 * checked. The caller reads the returned `real` and verifies it is still `stat` (no re-resolve).
 */
export function preregLocation(packDir: string, repoRoot: string, file: string): PreregLocation {
  const root = realpathSync.native(resolve(repoRoot));
  const declared = resolve(root, file);
  if (!within(declared, root) || declared === root) return { error: "outside the repository" };
  if (!existsSync(declared)) return { error: "not committed" };
  const real = realpathSync.native(declared);
  const stat = statSync(real);
  const above = ancestorIdentities(real);
  const rootId = identity(statSync(root));
  if (!above.has(rootId) || identity(stat) === rootId)
    return { error: "outside the repository (through a link)" };
  if (!stat.isFile()) return { error: "not a file" };
  if (stat.nlink > 1)
    return {
      error: `a file with ${stat.nlink} hard links (its other names are invisible to realpath, so its location cannot be checked)`,
    };
  if (above.has(identity(statSync(packDir))))
    return { error: "inside the pack (a pack cannot certify its own pre-registration)" };
  const tree = join(root, EVIDENCE_TREE);
  if (existsSync(tree) && above.has(identity(statSync(tree))))
    return {
      error: `inside the evidence tree (${EVIDENCE_TREE}); the pre-registration is a design document`,
    };
  return { error: null, real, stat };
}

/** The checked file's sha256, read through one descriptor that must still be the checked file. */
export function preregSha256(where: {
  readonly real: string;
  readonly stat: Stats;
}): string | null {
  const fd = openSync(where.real, "r");
  try {
    if (identity(fstatSync(fd)) !== identity(where.stat)) return null;
    return createHash("sha256").update(readFileSync(fd)).digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** Reads an A/B pack directory. `repoRoot` resolves the pre-registration file the manifest names. */
export function readAbPack(dir: string, repoRoot: string): AbPackInput {
  const readErrors: string[] = [];
  const manifest = readJson(join(dir, "pack.json"), "pack.json", readErrors);
  const stage1 =
    manifest !== null &&
    typeof manifest === "object" &&
    (manifest as { stage?: unknown }).stage === 1;
  readErrors.push(...layoutErrors(dir, stage1));
  const arm = (side: "on" | "off"): AbPackArm => ({
    arm: readJsonl(join(dir, side, "arm.jsonl"), `${side}/arm.jsonl`, readErrors),
    grades: readJsonl(join(dir, side, "grades.jsonl"), `${side}/grades.jsonl`, readErrors),
    ops: readJsonl(join(dir, side, "ops.jsonl"), `${side}/ops.jsonl`, readErrors),
    runConfig: readJson(join(dir, side, "run-config.json"), `${side}/run-config.json`, readErrors),
  });
  const stage0 = stage1
    ? {
        on: readJsonl(join(dir, "stage0", "on", "arm.jsonl"), "stage0/on/arm.jsonl", readErrors),
        off: readJsonl(join(dir, "stage0", "off", "arm.jsonl"), "stage0/off/arm.jsonl", readErrors),
      }
    : null;
  let preregCommittedSha256: string | null = null;
  const file = (manifest as { preregistration?: { file?: unknown } } | null)?.preregistration?.file;
  if (typeof file === "string" && !PREREG_FILES.includes(file))
    // Never opened: only track E's committed pre-registration may be bound (#554 S1).
    readErrors.push(
      `preregistration.file ${file}: not the pre-registration (it must be exactly ${PREREG_FILES.join(" or ")})`,
    );
  else if (typeof file === "string") {
    const where = preregLocation(dir, repoRoot, file);
    if (where.error !== null) readErrors.push(`preregistration.file ${file}: ${where.error}`);
    else {
      preregCommittedSha256 = preregSha256(where);
      if (preregCommittedSha256 === null)
        readErrors.push(`preregistration.file ${file}: replaced while it was checked`);
    }
  }
  return { manifest, on: arm("on"), off: arm("off"), stage0, preregCommittedSha256, readErrors };
}

/** One trial-ops row per arm row, schema-valid, joined by trial key, and the process rules. */
function opsErrors(side: string, a: AbPackArm): string[] {
  const errors: string[] = [];
  const ops = new Map<string, TrialOps>();
  a.ops.forEach((o, i) => {
    const issues = validateSchema(o, m2TrialOpsSchema);
    if (issues.length > 0) {
      errors.push(...issues.map((s) => `${side}/ops.jsonl row ${i}: ${s.path} ${s.message}`));
      return;
    }
    const row = o as TrialOps;
    if (ops.has(row.trialKey)) errors.push(`${side}/ops.jsonl: duplicate row for ${row.trialKey}`);
    ops.set(row.trialKey, row);
  });
  const rows = a.arm as BenchmarkArmRow[];
  const keys = new Set(rows.map((r) => r?.trialKey));
  for (const key of ops.keys())
    if (!keys.has(key)) errors.push(`${side}/ops.jsonl: ${key} has no arm row`);
  const grades = new Map((a.grades as BenchmarkGradeRow[]).map((g) => [g?.trialKey, g] as const));
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const o = ops.get(row.trialKey);
    if (o === undefined) {
      errors.push(
        `${side}: ${row.trialKey} has no trial-ops row (load and harness class unrecorded)`,
      );
      continue;
    }
    const verified = row.accepted === true && grades.get(row.trialKey)?.status === "pass";
    errors.push(...trialProcessErrors(row, o, verified).map((e) => `${side}: ${e}`));
  }
  return errors;
}

export function checkAbPack(input: AbPackInput): AbPackResult {
  const errors: string[] = [...input.readErrors];
  const issues = validateSchema(input.manifest, m2AbPackManifestSchema);
  const base = { kind: "ab" as const, evidenceUse: AB_EVIDENCE_USE };
  if (issues.length > 0) {
    errors.push(...issues.map((s) => `pack.json: ${s.path} ${s.message}`));
    return { ...base, ok: false, errors, manifest: null, ab: null };
  }
  const manifest = input.manifest as AbPackManifest;
  if (manifest.stage === 1 && manifest.preregistration === undefined)
    errors.push("pack.json: a Stage-1 pack names its pre-registration (file and sha256)");
  if (manifest.stage === 0 && manifest.preregistration !== undefined)
    errors.push("pack.json: a Stage-0 pack carries no pre-registration (Stage 0 claims nothing)");
  errors.push(...opsErrors("on", input.on), ...opsErrors("off", input.off));
  const config = (side: "on" | "off", c: unknown): Readonly<Record<string, unknown>> => {
    if (c !== null && typeof c === "object" && !Array.isArray(c))
      return c as Record<string, unknown>;
    errors.push(`${side}/run-config.json: not a JSON object`);
    return {};
  };
  const ab = checkCorrectionsAb(
    {
      on: { arm: input.on.arm, grades: input.on.grades },
      off: { arm: input.off.arm, grades: input.off.grades },
      runConfigs: { on: config("on", input.on.runConfig), off: config("off", input.off.runConfig) },
      ...(input.stage0 === null ? {} : { stage0: input.stage0 }),
      ...(manifest.preregistration === undefined || input.preregCommittedSha256 === null
        ? {}
        : {
            preregistration: {
              committedSha256: input.preregCommittedSha256,
              declaredSha256: manifest.preregistration.sha256,
            },
          }),
    },
    { stage: manifest.stage, evidence: true },
  );
  errors.push(...ab.errors.map((e) => `A/B: ${e}`));
  return { ...base, ok: errors.length === 0 && ab.ok, errors, manifest, ab };
}
