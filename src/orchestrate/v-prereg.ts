/**
 * Capability track V (tier 2): load the committed v-v1 pre-registration and everything it pins,
 * failing closed (Part 1 §3 of `docs/product/capability-spec.md`).
 *
 * - The pre-registration hash is SHA-256 over canonical JSON (sorted keys) of
 *   `docs/product/capability-prereg/v-v1/prereg.json`. The hash is not stored in the file
 *   (it could not be); packs record it and the analysis refuses a pack whose hash differs.
 * - Every analysis file the pre-registration names must hash to its pinned SHA-256, so the
 *   code that judges a pack is the code that was frozen.
 * - The task set's `manifest.json` must hash to the pinned manifest SHA-256, and `tasks.jsonl`
 *   to the manifest's entry, before any task id is read.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "../integrity/vault.ts";
import type { VPrereg } from "./v-bar.ts";

export const V_PREREG_PATH = "docs/product/capability-prereg/v-v1/prereg.json";
export const V_PREREG_SCHEMA = "myco.capability.prereg/1";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export const V_BAR_HEADING = "### V. Recursive orchestration";

/**
 * The bar as written: spec-2's V section, from its heading up to (not including) the next
 * `---` rule line. Null when the heading or the rule is missing.
 */
export function barSectionOf(specText: string): string | null {
  const lines = specText.split("\n");
  const start = lines.indexOf(V_BAR_HEADING);
  if (start < 0) return null;
  const end = lines.indexOf("---", start + 1);
  if (end < 0) return null;
  return `${lines.slice(start, end).join("\n")}\n`;
}

export interface VPreregFile extends VPrereg {
  readonly bar: { readonly spec: string; readonly section: string; readonly sectionSha256: string };
  readonly taskSet: VPrereg["taskSet"] & {
    readonly path: string;
    readonly manifestSha256: string;
  };
  readonly analysis: readonly { readonly path: string; readonly sha256: string }[];
}

export interface LoadedVPrereg {
  readonly prereg: VPreregFile;
  readonly preregHash: string;
  readonly tasks: ReadonlyMap<string, readonly string[]>;
}

/** The pre-registration hash of a parsed pre-registration object. */
export function preregHashOf(prereg: unknown): string {
  return sha256(canonical(prereg));
}

/** Load and check the pre-registration; throws with every problem found. */
export function loadVPrereg(repoRoot: string, preregPath = V_PREREG_PATH): LoadedVPrereg {
  const problems: string[] = [];
  const prereg = JSON.parse(readFileSync(join(repoRoot, preregPath), "utf8")) as VPreregFile;
  if (prereg.schema !== V_PREREG_SCHEMA) problems.push(`schema is not ${V_PREREG_SCHEMA}`);

  const specPath = join(repoRoot, prereg.bar?.spec ?? "");
  const section = existsSync(specPath) ? barSectionOf(readFileSync(specPath, "utf8")) : null;
  if (section === null) problems.push("bar section not found");
  else if (sha256(section) !== prereg.bar.sectionSha256)
    problems.push("bar section differs from the pre-registration (a change is a new version)");

  if (!Array.isArray(prereg.analysis) || prereg.analysis.length === 0)
    problems.push("no analysis files pinned");
  for (const entry of Array.isArray(prereg.analysis) ? prereg.analysis : []) {
    const full = join(repoRoot, entry.path);
    if (!existsSync(full)) problems.push(`analysis file missing: ${entry.path}`);
    else if (sha256(readFileSync(full)) !== entry.sha256)
      problems.push(`analysis file differs from the pre-registration: ${entry.path}`);
  }

  const tasks = new Map<string, readonly string[]>();
  const bundle = join(repoRoot, prereg.taskSet?.path ?? "");
  const manifestPath = join(bundle, "manifest.json");
  if (!existsSync(manifestPath)) problems.push("task set manifest missing");
  else {
    const manifestBytes = readFileSync(manifestPath);
    if (sha256(manifestBytes) !== prereg.taskSet.manifestSha256)
      problems.push("task set manifest differs from the pre-registration");
    else {
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
        files: Record<string, string>;
      };
      const tasksBytes = readFileSync(join(bundle, "tasks.jsonl"));
      if (sha256(tasksBytes) !== manifest.files["tasks.jsonl"])
        problems.push("tasks.jsonl differs from the manifest");
      else
        for (const line of tasksBytes.toString("utf8").split("\n")) {
          if (line.trim() === "") continue;
          const t = JSON.parse(line) as { taskId: string; parts: { partId: string }[] };
          tasks.set(
            t.taskId,
            t.parts.map((p) => p.partId),
          );
        }
    }
  }
  if (problems.length > 0) throw new Error(`v-v1 pre-registration refused: ${problems.join("; ")}`);
  return { prereg, preregHash: preregHashOf(prereg), tasks };
}
