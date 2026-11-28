/**
 * Task set byoa-ledger-v1 (capability track T, bring your own app; #673): the frozen reader
 * experiment task set named by `docs/product/capability-t-byoa.md` ("Task set") and
 * `docs/product/capability-spec-2.md` §T. Built deterministically from one seed; committed
 * under `benchmark/byoa-ledger/byoa-ledger-v1/` and checked byte for byte
 * (`scripts/byoa-ledger-taskset.ts --check`, `test/benchmark/byoa-ledger-taskset.test.ts`).
 *
 * 72 tasks over the example ledger app's format (the format restated here from
 * `examples/plugins/csv-ledger/README.md`, not imported): 12 fixtures of 5 to 40 rows; per
 * fixture, 5 satisfiable edits "set column C of the row whose id is K to V" on 5 distinct
 * rows, and 1 invalid-target task whose id is not in the fixture (the false-done guardrail).
 * The four editable columns take 15 satisfiable tasks each. V always differs from the field's
 * pristine text, so the untouched document never passes. Every instruction comes from one
 * template: an invalid-target task reads exactly like a satisfiable one, and `kind` is never
 * shown to the agent.
 *
 * Independence: this module imports no plugin code (`src/plugins/`, `examples/plugins/`), no
 * grader code (`src/benchmark/grade/`) and no gate code; the test pins it. The grader and the
 * plugin are run over the built set only in tests, as cross-checks.
 *
 * Each task pins the fixture (`fixtures/<sha256>.csv`, the exact bytes a harness hands the
 * guest as `ledger.csv`) and the instruction text by SHA-256. `manifest.json` pins every
 * other file, so the set is pre-registered by one digest: `sha256(manifest.json)`.
 * byoa-ledger-v1 never changes once published; a change is a new version.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const BYOA_TASK_SET_VERSION = "byoa-ledger-v1";
export const BYOA_TASK_SCHEMA = "myco.byoa-ledger.task/1";
export const BYOA_BUNDLE_SCHEMA = "myco.byoa-ledger.bundle/1";
export const BYOA_BUNDLE_DIR = "benchmark/byoa-ledger/byoa-ledger-v1";
/** The seed every random draw of the build derives from (pre-registered as the build seed). */
export const BYOA_BUILD_SEED = "byoa-ledger-v1/build";
/** The grader entry that grades this set (`src/benchmark/grade/ledger.ts`), by name only. */
export const BYOA_GRADER_VERSION = "ledger-csv/1";
export const BYOA_APP = "ledger-csv";
/** The file name the guest sees. */
export const BYOA_DOCUMENT_FILE = "ledger.csv";

/** Rows per fixture, 5 to 40, one fixture each. */
export const BYOA_FIXTURE_ROWS: readonly number[] = [5, 8, 11, 14, 17, 20, 24, 27, 30, 33, 36, 40];
export const BYOA_SATISFIABLE_PER_FIXTURE = 5;
export const BYOA_HEADER = ["id", "date", "payee", "amount", "category"] as const;
export const BYOA_EDITABLE_COLUMNS = ["date", "payee", "amount", "category"] as const;
export type ByoaColumn = (typeof BYOA_EDITABLE_COLUMNS)[number];

export type ByoaTaskKind = "satisfiable" | "invalid-target";

export interface ByoaTask {
  readonly schema: typeof BYOA_TASK_SCHEMA;
  readonly taskSetVersion: typeof BYOA_TASK_SET_VERSION;
  readonly taskId: string;
  /** Not shown to the agent. */
  readonly kind: ByoaTaskKind;
  readonly app: typeof BYOA_APP;
  readonly graderVersion: typeof BYOA_GRADER_VERSION;
  readonly documentFile: typeof BYOA_DOCUMENT_FILE;
  readonly persistedFormat: "csv";
  readonly intent: { readonly id: string; readonly column: ByoaColumn; readonly value: string };
  readonly instruction: string;
  readonly instructionSha256: string;
  readonly fixtureIndex: number;
  readonly fixtureRows: number;
  readonly fixtureFile: string;
  readonly fixtureSha256: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Deterministic draws: SHA-256 over (seed, label, counter). No Math.random, no clock. */
class Draw {
  private n = 0;
  constructor(private readonly seed: string) {}
  /** Uniform integer in [0, bound). */
  int(bound: number): number {
    const h = createHash("sha256")
      .update(`${this.seed}#${this.n++}`, "utf8")
      .digest();
    return h.readUInt32BE(0) % bound;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
}

const PAYEES = [
  "Acme Rent",
  "Corner Grocer",
  "City Utility",
  "Metro Transit",
  "Hill Pharmacy",
  "Book Nook",
  "River Cafe",
  "Spark Telecom",
  "Oak Hardware",
  "Bright Dental",
  "Lake Gym",
  "North Bakery",
  "Pine Insurance",
  "Star Cinema",
  "Wave Internet",
  "Elm Florist",
] as const;
const CATEGORIES = [
  "home",
  "food",
  "bills",
  "travel",
  "health",
  "leisure",
  "office",
  "gifts",
] as const;

const pad = (n: number, w: number) => String(n).padStart(w, "0");

function drawValue(d: Draw, column: ByoaColumn): string {
  switch (column) {
    case "date":
      return `2026-${pad(1 + d.int(12), 2)}-${pad(1 + d.int(28), 2)}`;
    case "payee":
      return d.pick(PAYEES);
    case "amount":
      return `${1 + d.int(1999)}.${pad(d.int(100), 2)}`;
    case "category":
      return d.pick(CATEGORIES);
  }
}

/** A value for `column` whose text differs from `current`. */
function drawNewValue(d: Draw, column: ByoaColumn, current: string): string {
  for (;;) {
    const v = drawValue(d, column);
    if (v !== current) return v;
  }
}

/** The single instruction template, for both kinds. */
export function byoaInstruction(intent: ByoaTask["intent"]): string {
  return `In ${BYOA_DOCUMENT_FILE}, set the ${intent.column} field of the row whose id is ${intent.id} to "${intent.value}", and save the file.`;
}

interface Fixture {
  readonly rows: readonly (readonly string[])[];
  readonly text: string;
}

function buildFixture(d: Draw, rowCount: number): Fixture {
  const ids = new Set<number>();
  while (ids.size < rowCount) ids.add(100 + d.int(9900));
  const rows = [...ids]
    .sort((a, b) => a - b)
    .map((id) => [String(id), ...BYOA_EDITABLE_COLUMNS.map((c) => drawValue(d, c))]);
  const text = `${[BYOA_HEADER.join(","), ...rows.map((r) => r.join(",")), `#rows,${rows.length}`].join("\n")}\n`;
  return { rows, text };
}

/** Tasks (in id order) and fixture files (bundle-relative path -> content). */
export function buildByoaTaskSet(): { tasks: ByoaTask[]; files: Map<string, string> } {
  const d = new Draw(BYOA_BUILD_SEED);
  const files = new Map<string, string>();
  type Draft = Omit<ByoaTask, "taskId">;
  const drafts: Draft[] = [];
  for (const [f, rowCount] of BYOA_FIXTURE_ROWS.entries()) {
    const fixture = buildFixture(d, rowCount);
    const fixtureSha256 = sha256(fixture.text);
    const fixtureFile = `fixtures/${fixtureSha256}.csv`;
    files.set(fixtureFile, fixture.text);
    const base = {
      schema: BYOA_TASK_SCHEMA,
      taskSetVersion: BYOA_TASK_SET_VERSION,
      app: BYOA_APP,
      graderVersion: BYOA_GRADER_VERSION,
      documentFile: BYOA_DOCUMENT_FILE,
      persistedFormat: "csv",
      fixtureIndex: f,
      fixtureRows: rowCount,
      fixtureFile,
      fixtureSha256,
    } as const;
    const add = (kind: ByoaTaskKind, intent: ByoaTask["intent"]) => {
      const instruction = byoaInstruction(intent);
      drafts.push({
        ...base,
        kind,
        intent,
        instruction,
        instructionSha256: sha256(instruction),
      });
    };
    // Five distinct target rows, columns spread over the whole set.
    const used = new Set<number>();
    for (let j = 0; j < BYOA_SATISFIABLE_PER_FIXTURE; j++) {
      let r = d.int(rowCount);
      while (used.has(r)) r = d.int(rowCount);
      used.add(r);
      const row = fixture.rows[r] as readonly string[];
      const column = BYOA_EDITABLE_COLUMNS[
        (f * BYOA_SATISFIABLE_PER_FIXTURE + j) % BYOA_EDITABLE_COLUMNS.length
      ] as ByoaColumn;
      const current = row[BYOA_HEADER.indexOf(column)] as string;
      add("satisfiable", {
        id: row[0] as string,
        column,
        value: drawNewValue(d, column, current),
      });
    }
    // One invalid target: an id of the same shape that the fixture does not have.
    const present = new Set(fixture.rows.map((r) => r[0]));
    let missing = String(100 + d.int(9900));
    while (present.has(missing)) missing = String(100 + d.int(9900));
    const column = BYOA_EDITABLE_COLUMNS[f % BYOA_EDITABLE_COLUMNS.length] as ByoaColumn;
    add("invalid-target", { id: missing, column, value: drawValue(d, column) });
  }
  // Seeded shuffle (Fisher-Yates), so neither kind nor fixture follows from the task id.
  for (let i = drafts.length - 1; i > 0; i--) {
    const j = d.int(i + 1);
    [drafts[i], drafts[j]] = [drafts[j] as Draft, drafts[i] as Draft];
  }
  const tasks = drafts.map((t, i) => ({
    schema: t.schema,
    taskSetVersion: t.taskSetVersion,
    taskId: `${BYOA_TASK_SET_VERSION}-${pad(i + 1, 3)}`,
    kind: t.kind,
    app: t.app,
    graderVersion: t.graderVersion,
    documentFile: t.documentFile,
    persistedFormat: t.persistedFormat,
    intent: t.intent,
    instruction: t.instruction,
    instructionSha256: t.instructionSha256,
    fixtureIndex: t.fixtureIndex,
    fixtureRows: t.fixtureRows,
    fixtureFile: t.fixtureFile,
    fixtureSha256: t.fixtureSha256,
  }));
  return { tasks, files };
}

export const BYOA_README = `# Task set ${BYOA_TASK_SET_VERSION}

Frozen reader-experiment task set for capability track T (bring your own app):
\`docs/product/capability-t-byoa.md\`, \`docs/product/capability-spec-2.md\` §T. Graded by the
independent grader entry \`${BYOA_GRADER_VERSION}\` (\`src/benchmark/grade/ledger.ts\`).

- \`tasks.jsonl\`: one task per line. \`intent\` is "set \`column\` of the row whose id is \`id\`
  to \`value\`"; \`instruction\` is the exact text the agent receives, from one template for both
  kinds. \`kind\` (\`satisfiable\` or \`invalid-target\`) is never shown to the agent.
- \`fixtures/<sha256>.csv\`: the pristine ledger each task hands the guest as
  \`${BYOA_DOCUMENT_FILE}\`, named by its SHA-256.
- \`manifest.json\`: SHA-256 of every other file. Pre-register the set by the digest of this
  manifest.

72 tasks: 12 fixtures of 5 to 40 rows; 60 satisfiable edits (5 per fixture, on distinct rows;
the columns date, payee, amount and category 15 each) and 12 invalid-target tasks (1 per
fixture; the id is not in the fixture). Build seed: \`${BYOA_BUILD_SEED}\`.

Regenerate or check with \`npx tsx scripts/byoa-ledger-taskset.ts [--check]\`. Published sets
never change; a change is a new version. No trial has run on this set; nothing here is
evidence.
`;

/** Every bundle file (path -> content), `manifest.json` last. */
export function renderByoaBundle(): Map<string, string> {
  const { tasks, files: fixtures } = buildByoaTaskSet();
  const files = new Map<string, string>();
  files.set("README.md", BYOA_README);
  files.set("tasks.jsonl", `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`);
  for (const [path, content] of [...fixtures].sort(([a], [b]) => (a < b ? -1 : 1)))
    files.set(path, content);
  const manifest = {
    schema: BYOA_BUNDLE_SCHEMA,
    taskSetVersion: BYOA_TASK_SET_VERSION,
    license: "Apache-2.0",
    app: BYOA_APP,
    graderVersion: BYOA_GRADER_VERSION,
    buildSeed: BYOA_BUILD_SEED,
    tasks: tasks.length,
    files: Object.fromEntries([...files].map(([p, c]) => [p, sha256(c)])),
  };
  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/**
 * Differences between the built bundle and the directory `dir`: every file missing,
 * differing (byte for byte) or extra. Empty means the committed bundle is the build.
 */
export function checkByoaBundle(dir: string, files = renderByoaBundle()): string[] {
  const problems: string[] = [];
  for (const [path, content] of files) {
    const full = join(dir, path);
    if (!existsSync(full)) problems.push(`missing ${path}`);
    else if (!readFileSync(full).equals(Buffer.from(content, "utf8")))
      problems.push(`differs ${path}`);
  }
  for (const full of listFiles(dir)) {
    const path = relative(dir, full).split("\\").join("/");
    if (!files.has(path)) problems.push(`extra ${path}`);
  }
  return problems;
}
