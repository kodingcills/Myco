/**
 * Cross-app task sets xa-v1 and xa-v2 (capability track P, tier 2): the frozen,
 * pre-registrable task sets for the `cross-app-steps` family. Built deterministically;
 * committed under `benchmark/cross-app/<version>/` and checked byte for byte
 * (`scripts/cross-app-taskset.ts --check [--set <version>]`, `test/cross-app/taskset.test.ts`,
 * `test/cross-app/taskset-v2.test.ts`).
 *
 * - xa-v1 (12 tasks, #535) is the plumbing and conformance set.
 * - xa-v2 (40 tasks) is the set track P's bar runs on (`docs/product/capability-spec-2.md`
 *   §P, "Task set"; pre-registered in `docs/product/capability-prereg/p-v1/prereg.json`).
 *   Same builder, same family, same rules; only the version (and so every seed) and the
 *   count differ.
 *
 * Every task carries what the gate and the independent grader need, each pinned by SHA-256:
 *  - the pristine sheet (CSV), the report template (text) and the source notice (PDF), as
 *    committed files under `fixtures/<sha256>.<ext>` (sealed: a harness hands the guest
 *    exactly these bytes, and the gate checks the notice's digest on every decision);
 *  - the operator spec and its digest (the gate's `specSha256`, canonical JSON), the family
 *    and its version, the state file and every evidence file the gate reads;
 *  - the exact instruction text an agent receives, and its digest (arm parity);
 *  - each column's type, for the grader.
 * `manifest.json` pins every file of the bundle, so a task set can be pre-registered by one
 * digest: `sha256(manifest.json)`.
 *
 * A published set never changes; a change is a new version.
 */
import { createHash } from "node:crypto";
import { crossAppFamily } from "../gate/cross-app.ts";
import { specDigest } from "../gate/gate.ts";
import {
  CROSS_APP_FAMILY,
  CROSS_APP_STATE_FILE,
  crossAppEvidenceFiles,
  crossAppInstruction,
  crossAppSpecFor,
  noticePdf,
  reportAt,
  sheetAt,
  sourceLines,
} from "./cross-app.ts";
import { FIXTURE_COLUMNS } from "./fixture.ts";

/** A published cross-app task set: its version (the seed prefix) and its task count. */
export interface XaSetConfig {
  readonly version: string;
  readonly count: number;
}

export const XA_V1: XaSetConfig = Object.freeze({ version: "xa-v1", count: 12 });
export const XA_V2: XaSetConfig = Object.freeze({ version: "xa-v2", count: 40 });
/** Every published set, by version. */
export const XA_SETS: Readonly<Record<string, XaSetConfig>> = Object.freeze({
  [XA_V1.version]: XA_V1,
  [XA_V2.version]: XA_V2,
});

export const XA_TASK_SET_VERSION = XA_V1.version;
export const XA_TASK_SCHEMA = "myco.cross-app.task/1";
export const XA_TASK_COUNT = XA_V1.count;

export interface XaTask {
  readonly schema: typeof XA_TASK_SCHEMA;
  readonly taskSetVersion: string;
  readonly taskId: string;
  readonly family: typeof CROSS_APP_FAMILY;
  readonly familyVersion: string;
  readonly stateFile: string;
  readonly evidenceFiles: readonly string[];
  readonly spec: ReturnType<typeof crossAppSpecFor>;
  readonly specSha256: string;
  readonly instruction: string;
  readonly instructionSha256: string;
  readonly fixtureFile: string;
  readonly fixtureSha256: string;
  readonly reportTemplateFile: string;
  readonly reportTemplateSha256: string;
  readonly sourceFile: string;
  readonly sourceSha256: string;
  readonly columnTypes: Readonly<Record<string, string>>;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const XA_COLUMN_TYPES: Readonly<Record<string, string>> = Object.fromEntries(
  FIXTURE_COLUMNS.map((c) => [c.name, c.type]),
);

/** The task-build seeds of a set: `<version>-01` .. `<version>-<count>`. */
export function xaSeeds(set: XaSetConfig = XA_V1): string[] {
  return Array.from(
    { length: set.count },
    (_, i) => `${set.version}-${String(i + 1).padStart(2, "0")}`,
  );
}

/** The task ids of a set: `<version>-001` .. `<version>-<count>`. */
export function xaTaskIds(set: XaSetConfig = XA_V1): string[] {
  return Array.from(
    { length: set.count },
    (_, i) => `${set.version}-${String(i + 1).padStart(3, "0")}`,
  );
}

/** Tasks and their fixture files (path relative to the bundle root -> content, ASCII/UTF-8). */
export function buildXaTaskSet(set: XaSetConfig = XA_V1): {
  tasks: XaTask[];
  files: Map<string, string>;
} {
  const tasks: XaTask[] = [];
  const files = new Map<string, string>();
  const ids = xaTaskIds(set);
  for (const [i, seed] of xaSeeds(set).entries()) {
    const spec = crossAppSpecFor(seed);
    const problem = crossAppFamily.checkSpec(spec);
    if (problem) throw new Error(`task ${seed}: ${problem}`);
    const sheet = sheetAt(spec, 0);
    const template = reportAt(spec, 0);
    const pdf = noticePdf(sourceLines(spec));
    if (sha256(pdf) !== spec.source.sha256) throw new Error(`task ${seed}: notice digest drift`);
    const put = (content: string, ext: string) => {
      const path = `fixtures/${sha256(content)}.${ext}`;
      files.set(path, content);
      return path;
    };
    const instruction = crossAppInstruction(spec);
    tasks.push({
      schema: XA_TASK_SCHEMA,
      taskSetVersion: set.version,
      taskId: ids[i] as string,
      family: CROSS_APP_FAMILY,
      familyVersion: crossAppFamily.version,
      stateFile: CROSS_APP_STATE_FILE,
      evidenceFiles: crossAppEvidenceFiles(spec.steps.length),
      spec,
      specSha256: specDigest(spec),
      instruction,
      instructionSha256: sha256(instruction),
      fixtureFile: put(sheet, "csv"),
      fixtureSha256: sha256(sheet),
      reportTemplateFile: put(template, "txt"),
      reportTemplateSha256: sha256(template),
      sourceFile: put(pdf, "pdf"),
      sourceSha256: spec.source.sha256,
      columnTypes: XA_COLUMN_TYPES,
    });
  }
  return { tasks, files };
}

/** The bundle README of a set. */
export function xaReadme(set: XaSetConfig = XA_V1): string {
  return `# Cross-app task set ${set.version}

Frozen task set for the \`${CROSS_APP_FAMILY}\` gate family (capability track P): PDF -> Calc ->
Writer, three steps, a checkpoint per step. See \`docs/gate/cross-app.md\`.

- \`tasks.jsonl\`: one task per line (spec, digests, instruction, evidence layout).
- \`fixtures/<sha256>.csv|.txt|.pdf\`: the pristine sheet, the report template and the source
  notice each task hands the guest, named by their SHA-256.
- \`manifest.json\`: SHA-256 of every other file. Pre-register the set by the digest of this
  manifest.

Regenerate or check with \`npx tsx scripts/cross-app-taskset.ts${set === XA_V1 ? "" : ` --set ${set.version}`} [--check]\`. Published sets never
change; a change is a new version.
`;
}

export const XA_README = xaReadme(XA_V1);

/** Every bundle file of a set (path -> content), \`manifest.json\` last. */
export function renderXaBundle(set: XaSetConfig = XA_V1): Map<string, string> {
  const { tasks, files: fixtures } = buildXaTaskSet(set);
  const files = new Map<string, string>();
  files.set("README.md", xaReadme(set));
  files.set("tasks.jsonl", `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`);
  for (const [path, content] of [...fixtures].sort(([a], [b]) => (a < b ? -1 : 1)))
    files.set(path, content);
  const manifest = {
    schema: "myco.cross-app.bundle/1",
    taskSetVersion: set.version,
    license: "Apache-2.0",
    family: CROSS_APP_FAMILY,
    familyVersion: crossAppFamily.version,
    tasks: tasks.length,
    files: Object.fromEntries([...files].map(([p, c]) => [p, sha256(c)])),
  };
  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}
