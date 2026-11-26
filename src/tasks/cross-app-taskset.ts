/**
 * Cross-app task set, version xa-v1 (capability track P, tier 2): the frozen, pre-registrable
 * task set for the `cross-app-steps` family. Built deterministically; committed under
 * `benchmark/cross-app/xa-v1/` and checked byte for byte (`scripts/cross-app-taskset.ts
 * --check`, `test/cross-app/taskset.test.ts`).
 *
 * Every task carries what the gate and the independent grader need, each pinned by SHA-256:
 *  - the pristine sheet (CSV), the report template (text) and the source notice (PDF), as
 *    committed files under `fixtures/<sha256>.<ext>` (sealed: a harness hands the guest
 *    exactly these bytes, and the gate checks the notice's digest on every decision);
 *  - the operator spec and its digest (the gate's `specSha256`, canonical JSON), the family
 *    and its version, the state file and every evidence file the gate reads;
 *  - the exact instruction text an agent receives, and its digest (arm parity);
 *  - each column's type, for the grader.
 * `manifest.json` pins every file of the bundle, so the task set can be pre-registered by
 * one digest: `sha256(manifest.json)`.
 *
 * xa-v1 never changes once published; a change is a new version.
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

export const XA_TASK_SET_VERSION = "xa-v1";
export const XA_TASK_SCHEMA = "myco.cross-app.task/1";
export const XA_TASK_COUNT = 12;

export interface XaTask {
  readonly schema: typeof XA_TASK_SCHEMA;
  readonly taskSetVersion: typeof XA_TASK_SET_VERSION;
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

export function xaSeeds(): string[] {
  return Array.from(
    { length: XA_TASK_COUNT },
    (_, i) => `${XA_TASK_SET_VERSION}-${String(i + 1).padStart(2, "0")}`,
  );
}

/** Tasks and their fixture files (path relative to the bundle root -> content, ASCII/UTF-8). */
export function buildXaTaskSet(): { tasks: XaTask[]; files: Map<string, string> } {
  const tasks: XaTask[] = [];
  const files = new Map<string, string>();
  for (const [i, seed] of xaSeeds().entries()) {
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
      taskSetVersion: XA_TASK_SET_VERSION,
      taskId: `${XA_TASK_SET_VERSION}-${String(i + 1).padStart(3, "0")}`,
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

export const XA_README = `# Cross-app task set ${XA_TASK_SET_VERSION}

Frozen task set for the \`${CROSS_APP_FAMILY}\` gate family (capability track P): PDF -> Calc ->
Writer, three steps, a checkpoint per step. See \`docs/gate/cross-app.md\`.

- \`tasks.jsonl\`: one task per line (spec, digests, instruction, evidence layout).
- \`fixtures/<sha256>.csv|.txt|.pdf\`: the pristine sheet, the report template and the source
  notice each task hands the guest, named by their SHA-256.
- \`manifest.json\`: SHA-256 of every other file. Pre-register the set by the digest of this
  manifest.

Regenerate or check with \`npx tsx scripts/cross-app-taskset.ts [--check]\`. Published sets never
change; a change is a new version.
`;

/** Every bundle file (path -> content), \`manifest.json\` last. */
export function renderXaBundle(): Map<string, string> {
  const { tasks, files: fixtures } = buildXaTaskSet();
  const files = new Map<string, string>();
  files.set("README.md", XA_README);
  files.set("tasks.jsonl", `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`);
  for (const [path, content] of [...fixtures].sort(([a], [b]) => (a < b ? -1 : 1)))
    files.set(path, content);
  const manifest = {
    schema: "myco.cross-app.bundle/1",
    taskSetVersion: XA_TASK_SET_VERSION,
    license: "Apache-2.0",
    family: CROSS_APP_FAMILY,
    familyVersion: crossAppFamily.version,
    tasks: tasks.length,
    files: Object.fromEntries([...files].map(([p, c]) => [p, sha256(c)])),
  };
  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}
