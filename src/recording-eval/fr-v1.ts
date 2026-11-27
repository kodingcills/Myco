/**
 * Track R task set `fr-v1` (capability-spec-2 §R, "Task set (new)"): 30 single-edit Calc
 * record-edit tasks on fresh fixtures, built deterministically and pinned by a SHA-256
 * manifest that the r-v1 pre-registration records.
 *
 * This is a task DEFINITION, like `src/benchmark/taskset.ts` for fc-v1, so it reuses the M1
 * generators (`src/tasks/*`). It lives outside `src/recording/` on purpose: the recorder,
 * compiler and derived oracle must never see `groundTruth`, the fixture generator or a
 * manifest (capability-spec Part 1 §1.2 rule 4; `test/recording-eval/boundary.test.ts`).
 *
 * Shape (proposed; the "family" reading is a lead ruling pending, see the r-v1 prereg):
 *  - **Families.** A compiled workflow fixes its column and binds only the record and the
 *    value (`src/recording/compile.ts`), so one demonstration can serve tasks of one column
 *    only. fr-v1 therefore has four demonstration families, one per data column
 *    (`record-edit:name|qty|joined|salary`: text, integer, date, currency), each with its own
 *    demonstration fixture seed. The operator demonstrates once per family.
 *  - **Fresh fixtures.** Task fixture seeds `fr-v1-{a,b}-NN` and demonstration seeds
 *    `fr-v1-demo-<column>` are disjoint from each other and from fc-v1's; a test pins that no
 *    task fixture equals a demonstration fixture or an fc-v1 fixture.
 *  - **Single edit, CSV.** Every task is one keyed cell edit, because the independent grader
 *    takes one intent; the persisted format is CSV, because the derived family and the Linux
 *    recorder are CSV-only until the xlsx replacement lands for them.
 *  - **Never changes.** A change is a new task-set version (`fr-v2`) and a new prereg.
 */
import { FIXTURE_COLUMNS, generateFixture } from "../tasks/fixture.ts";
import { generateParameterSets } from "../tasks/intent.ts";
import { taskText } from "../tasks/task-text.ts";
import { canonicalSha256, sha256Hex } from "./canonical.ts";

export const FR_V1_VERSION = "fr-v1";
export const FR_V1_SCHEMA = "myco.capability.r-taskset/1";
export const FR_V1_TASK_COUNT = 30;

/**
 * Task fixture seed lists (the prereg's "task build" seeds). Like fc-v1's pool, the tasks are
 * the first 30 distinct (fixture, record, column) parameter sets over list `a` then list `b`:
 * list `a` alone repeats one cell, so `b` fills the gap.
 */
export const FR_V1_TASK_SEEDS: readonly string[] = ["a", "b"].flatMap((list) =>
  Array.from({ length: 10 }, (_, i) => `fr-v1-${list}-${String(i + 1).padStart(2, "0")}`),
);

function parameterPool(): ReturnType<typeof generateParameterSets> {
  const out: ReturnType<typeof generateParameterSets> = [];
  const seen = new Set<string>();
  for (const list of ["a", "b"]) {
    const seeds = FR_V1_TASK_SEEDS.filter((s) => s.startsWith(`fr-v1-${list}-`));
    for (const p of generateParameterSets(seeds)) {
      const key = `${p.fixtureSeed}|${p.rowKey}|${p.column}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
  }
  return out.slice(0, FR_V1_TASK_COUNT);
}

export type FrColumnType = "key" | "text" | "integer" | "date" | "currency";

export interface FrDemonstrationFamily {
  readonly family: string;
  readonly column: string;
  readonly kind: FrColumnType;
  /** Fixture the operator demonstrates on; never a task fixture. */
  readonly fixtureSeed: string;
  readonly fixtureSha256: string;
}

export interface FrTask {
  readonly taskId: string;
  readonly demonstrationFamily: string;
  readonly fixtureSeed: string;
  readonly fixtureSha256: string;
  readonly intent: { readonly rowKey: string; readonly column: string; readonly newValue: string };
  readonly columnTypes: Readonly<Record<string, FrColumnType>>;
  readonly instruction: string;
  readonly instructionSha256: string;
  readonly persistedFormat: "csv";
}

export interface FrManifest {
  readonly schema: typeof FR_V1_SCHEMA;
  readonly taskSetVersion: typeof FR_V1_VERSION;
  readonly track: "R";
  readonly appFamily: "calc-record-edit";
  readonly taskSeeds: readonly string[];
  readonly demonstrationFamilies: readonly FrDemonstrationFamily[];
  readonly tasks: readonly FrTask[];
}

const COLUMN_TYPES: Readonly<Record<string, FrColumnType>> = Object.fromEntries(
  FIXTURE_COLUMNS.map((c) => [c.name, c.type]),
);

const familyOf = (column: string) => `record-edit:${column}`;

/** Build the fr-v1 manifest. Deterministic: same code, same bytes. */
export function buildFrV1(): FrManifest {
  const demonstrationFamilies: FrDemonstrationFamily[] = FIXTURE_COLUMNS.filter(
    (c) => c.type !== "key",
  ).map((c) => {
    const fixtureSeed = `fr-v1-demo-${c.name}`;
    return {
      family: familyOf(c.name),
      column: c.name,
      kind: c.type,
      fixtureSeed,
      fixtureSha256: sha256Hex(generateFixture(fixtureSeed).csv),
    };
  });
  const params = parameterPool();
  if (params.length !== FR_V1_TASK_COUNT) throw new Error("fr-v1: expected 30 parameter sets");
  const tasks: FrTask[] = params.map((p, i) => {
    const instruction = taskText(p);
    return {
      taskId: `${FR_V1_VERSION}-${String(i + 1).padStart(3, "0")}`,
      demonstrationFamily: familyOf(p.column),
      fixtureSeed: p.fixtureSeed,
      fixtureSha256: sha256Hex(generateFixture(p.fixtureSeed).csv),
      intent: { rowKey: p.rowKey, column: p.column, newValue: p.newValue },
      columnTypes: COLUMN_TYPES,
      instruction,
      instructionSha256: sha256Hex(instruction),
      persistedFormat: "csv",
    };
  });
  return {
    schema: FR_V1_SCHEMA,
    taskSetVersion: FR_V1_VERSION,
    track: "R",
    appFamily: "calc-record-edit",
    taskSeeds: FR_V1_TASK_SEEDS,
    demonstrationFamilies,
    tasks,
  };
}

/** The manifest's SHA-256 over canonical JSON: the value the prereg pins. */
export const manifestSha256 = (manifest: FrManifest): string => canonicalSha256(manifest);

/** The committed manifest file's text (pretty JSON; its hash is over canonical JSON). */
export const manifestText = (manifest: FrManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;
