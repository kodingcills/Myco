/**
 * Recursive orchestration task set, version orch-v1 (capability track V, tier 2): the frozen,
 * pre-registrable task set that `docs/product/capability-spec-2.md` §2 V names. Built
 * deterministically; committed under `benchmark/orchestration/orch-v1/` and checked byte for
 * byte (`scripts/orch-taskset.ts --check`, `test/orchestrate/orch-taskset.test.ts`).
 *
 * Shape (spec §2 V, "Task set"): 60 multi-part tasks, 2-4 gated Calc-CSV subtasks each
 * (tasks 1-20 have 2 parts, 21-40 have 3, 41-60 have 4). Every part is one `calc-record-edit`
 * gate task on its **own** CSV fixture and its own state file (`part-<k>.csv`), so parts never
 * share a document and a planner may hand each to a separate worker desktop. The decomposition
 * is left to the planner: the task's `instruction` is the only text any arm's agent receives.
 *
 * Every part carries what the gate and the independent grader need, each pinned:
 *  - the gate entry: family, `stateFile`, the operator spec (`persistedFormat: "csv"`, so the
 *    gate stays CSV-only for Calc) and its digest (`specDigest`, canonical JSON);
 *  - the pristine fixture as a committed file `fixtures/<sha256>.csv`;
 *  - the intent (row key, column, new value) and each column's type, for the grader, which
 *    derives the expected document from the committed bytes and the intent (never from this
 *    module: `src/benchmark/grade/` imports nothing outside itself).
 * `manifest.json` pins every file of the bundle, so the task set is pre-registered by one
 * digest: `sha256(manifest.json)`.
 *
 * orch-v1 never changes once published; a change is a new version.
 */
import { createHash } from "node:crypto";
import { calcRecordEditFamily } from "../gate/families.ts";
import { specDigest } from "../gate/gate.ts";
import { FIXTURE_COLUMNS, generateFixture } from "../tasks/fixture.ts";
import { generateParameterSets } from "../tasks/intent.ts";
import { taskText } from "../tasks/task-text.ts";

export const ORCH_TASK_SET_VERSION = "orch-v1";
export const ORCH_TASK_SCHEMA = "myco.orchestrate.task/1";
export const ORCH_BUNDLE_SCHEMA = "myco.orchestrate.bundle/1";
export const ORCH_TASK_COUNT = 60;
/** Parts per task, by block of 20: [2, 3, 4]. */
export const ORCH_PARTS_BY_BLOCK = [2, 3, 4] as const;
export const ORCH_PART_FAMILY = "calc-record-edit";

export interface OrchPart {
  /** `<taskId>-p<k>`: the id a worker is assigned and the gate registry entry's id. */
  readonly partId: string;
  readonly family: typeof ORCH_PART_FAMILY;
  readonly familyVersion: string;
  readonly stateFile: string;
  readonly spec: {
    readonly fixtureSeed: string;
    readonly rowKey: string;
    readonly column: string;
    readonly newValue: string;
    readonly persistedFormat: "csv";
  };
  readonly specSha256: string;
  readonly intent: { readonly rowKey: string; readonly column: string; readonly newValue: string };
  readonly instruction: string;
  readonly instructionSha256: string;
  readonly fixtureFile: string;
  readonly fixtureSha256: string;
}

export interface OrchTask {
  readonly schema: typeof ORCH_TASK_SCHEMA;
  readonly taskSetVersion: typeof ORCH_TASK_SET_VERSION;
  readonly taskId: string;
  readonly parts: readonly OrchPart[];
  /** The exact text every arm's agent receives (arm parity). */
  readonly instruction: string;
  readonly instructionSha256: string;
  readonly columnTypes: Readonly<Record<string, string>>;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const ORCH_COLUMN_TYPES: Readonly<Record<string, string>> = Object.fromEntries(
  FIXTURE_COLUMNS.map((c) => [c.name, c.type]),
);

export const orchTaskId = (index: number) =>
  `${ORCH_TASK_SET_VERSION}-${String(index + 1).padStart(3, "0")}`;

/** Parts for the task at 0-based `index`. */
export function orchPartCount(index: number): number {
  const block = Math.floor(index / 20);
  const n = ORCH_PARTS_BY_BLOCK[block];
  if (n === undefined) throw new Error(`task index out of range: ${index}`);
  return n;
}

/** The fixture seed of part `k` (1-based) of the task at 0-based `index`. */
export const orchPartSeed = (index: number, k: number) => `${orchTaskId(index)}-${k}`;

export const orchStateFile = (k: number) => `part-${k}.csv`;

function partInstruction(stateFile: string, edit: OrchPart["intent"]): string {
  // The single-part sentence every calc arm uses (`taskText`), naming the part's file.
  return `In the file ${stateFile}: ${taskText(edit)}`;
}

function taskInstruction(parts: readonly OrchPart[]): string {
  const lines = [
    `This task has ${parts.length} parts, each in its own spreadsheet file. Do every part, then report done only if every part is done.`,
    ...parts.map((p, i) => `Part ${i + 1}. ${p.instruction}`),
  ];
  return lines.join("\n");
}

/** Tasks and their fixture files (path relative to the bundle root -> CSV text). */
export function buildOrchTaskSet(): { tasks: OrchTask[]; files: Map<string, string> } {
  const tasks: OrchTask[] = [];
  const files = new Map<string, string>();
  for (let index = 0; index < ORCH_TASK_COUNT; index++) {
    const taskId = orchTaskId(index);
    const parts: OrchPart[] = [];
    for (let k = 1; k <= orchPartCount(index); k++) {
      const fixtureSeed = orchPartSeed(index, k);
      // generateParameterSets cycles the data column by its index; offsetting by task and part
      // spreads the four data columns across parts and tasks.
      const sets = generateParameterSets([fixtureSeed]);
      const p = sets[(index * 4 + k) % sets.length];
      if (p === undefined) throw new Error(`no parameter set for ${fixtureSeed}`);
      const csv = generateFixture(fixtureSeed).csv;
      const fixtureSha256 = sha256(csv);
      const fixtureFile = `fixtures/${fixtureSha256}.csv`;
      if (files.has(fixtureFile)) throw new Error(`duplicate fixture for ${fixtureSeed}`);
      files.set(fixtureFile, csv);
      const stateFile = orchStateFile(k);
      const spec = {
        fixtureSeed,
        rowKey: p.rowKey,
        column: p.column,
        newValue: String(p.newValue),
        persistedFormat: "csv" as const,
      };
      const problem =
        calcRecordEditFamily.checkSpec(spec) ??
        calcRecordEditFamily.checkStateFile?.(stateFile, spec);
      if (problem) throw new Error(`part ${fixtureSeed}: ${problem}`);
      const intent = { rowKey: spec.rowKey, column: spec.column, newValue: spec.newValue };
      const instruction = partInstruction(stateFile, intent);
      parts.push({
        partId: `${taskId}-p${k}`,
        family: ORCH_PART_FAMILY,
        familyVersion: calcRecordEditFamily.version,
        stateFile,
        spec,
        specSha256: specDigest(spec),
        intent,
        instruction,
        instructionSha256: sha256(instruction),
        fixtureFile,
        fixtureSha256,
      });
    }
    const instruction = taskInstruction(parts);
    tasks.push({
      schema: ORCH_TASK_SCHEMA,
      taskSetVersion: ORCH_TASK_SET_VERSION,
      taskId,
      parts,
      instruction,
      instructionSha256: sha256(instruction),
      columnTypes: ORCH_COLUMN_TYPES,
    });
  }
  return { tasks, files };
}

export const ORCH_README = `# Recursive orchestration task set ${ORCH_TASK_SET_VERSION}

Frozen task set for capability track V (recursive orchestration;
\`docs/product/capability-spec-2.md\` §2 V, \`docs/orchestrate/recursive-orchestration.md\`).
Licensed Apache-2.0, like the rest of this repository.

${ORCH_TASK_COUNT} multi-part tasks: tasks 1-20 have 2 parts, 21-40 have 3, 41-60 have 4. Each part is
one \`${ORCH_PART_FAMILY}\` edit on its own CSV file (\`part-<k>.csv\`), gated per part
(\`persistedFormat: "csv"\`). An agent receives only the task's \`instruction\`; the
decomposition into workers is the planner's job.

- \`tasks.jsonl\`: one task per line (schema \`${ORCH_TASK_SCHEMA}\`): the instruction, and per
  part the gate entry (family, state file, spec and its digest), the intent, the column types
  and the fixture.
- \`fixtures/<sha256>.csv\`: the pristine sheet each part hands the guest, named by its SHA-256.
- \`manifest.json\`: SHA-256 of every other file. The task set is pre-registered by the digest
  of this manifest (\`docs/product/capability-prereg/v-v1/prereg.json\`).

A task is verified only when every part is: in the \`V\` arm, every part's gate verdict is
\`verified\` and the independent grader passes every part; in \`H\` and \`C1\`, the grader passes
every part. Regenerate or check with \`npx tsx scripts/orch-taskset.ts [--check]\`. Published
sets never change; a change is a new version.
`;

/** Every bundle file (path -> content), \`manifest.json\` last. */
export function renderOrchBundle(): Map<string, string> {
  const { tasks, files: fixtures } = buildOrchTaskSet();
  const files = new Map<string, string>();
  files.set("README.md", ORCH_README);
  files.set("tasks.jsonl", `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`);
  for (const [path, content] of [...fixtures].sort(([a], [b]) => (a < b ? -1 : 1)))
    files.set(path, content);
  const manifest = {
    schema: ORCH_BUNDLE_SCHEMA,
    taskSetVersion: ORCH_TASK_SET_VERSION,
    license: "Apache-2.0",
    partFamily: ORCH_PART_FAMILY,
    partFamilyVersion: calcRecordEditFamily.version,
    tasks: tasks.length,
    parts: tasks.reduce((n, t) => n + t.parts.length, 0),
    files: Object.fromEntries([...files].map(([p, c]) => [p, sha256(c)])),
  };
  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}
