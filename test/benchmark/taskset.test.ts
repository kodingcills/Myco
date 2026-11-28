import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkTaskSchema } from "../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { BUNDLE_README } from "../../src/benchmark/bundle-readme.ts";
import { GRADER_VERSION, grade } from "../../src/benchmark/grade/grade.ts";
import {
  type ArmRowRef,
  buildRequests,
  pathInside,
  RequestBuildError,
} from "../../src/benchmark/requests.ts";
import {
  type BenchmarkTask,
  buildTaskSet,
  FAULT_CLASS_HARNESS_NOTE,
  FC_V1_COMPOSITION,
  FC_V1_FAULT_CLASSES,
  renderBundle,
  TASK_SET_VERSION,
} from "../../src/benchmark/taskset.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, "benchmark", "false-completion", "fc-v1");
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

function committedFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? committedFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const committedTasks = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l) as BenchmarkTask);

/** Apply the intent to the pristine CSV, by plain text: the honest document. */
function honestCsv(task: BenchmarkTask): Buffer {
  const rows = readFileSync(join(BUNDLE, task.fixtureFile), "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  const col = (rows[0] as string[]).indexOf(task.intent.column);
  const row = rows.findIndex((r, i) => i > 0 && r[0] === task.intent.rowKey);
  (rows[row] as string[])[col] = task.intent.newValue;
  return Buffer.from(`${rows.map((r) => r.join(",")).join("\n")}\n`);
}

describe("fc-v1 task set", () => {
  it("has the declared composition, unique ids and a stratified demo subset", () => {
    expect(committedTasks).toHaveLength(100);
    expect(new Set(committedTasks.map((t) => t.taskId)).size).toBe(100);
    for (const cls of FC_V1_FAULT_CLASSES) {
      const ofClass = committedTasks.filter((t) => t.faultClass === cls);
      expect(ofClass, cls).toHaveLength(FC_V1_COMPOSITION[cls].r1);
      expect(
        ofClass.filter((t) => t.inDemo),
        cls,
      ).toHaveLength(FC_V1_COMPOSITION[cls].demo);
    }
    expect(committedTasks.filter((t) => t.inDemo)).toHaveLength(30);
    expect(committedTasks.every((t) => t.taskSetVersion === TASK_SET_VERSION)).toBe(true);
    expect(committedTasks.map((t) => t.taskId)).toEqual(
      Array.from({ length: 100 }, (_, i) => `fc-v1-${String(i + 1).padStart(3, "0")}`),
    );
  });

  it("validates every task against the closed schema", () => {
    for (const t of committedTasks)
      expect(validateSchema(t, benchmarkTaskSchema), t.taskId).toEqual([]);
  });

  it("uses distinct (fixture, record, column) targets", () => {
    const targets = committedTasks.map(
      (t) => `${t.fixtureSeed}|${t.intent.rowKey}|${t.intent.column}`,
    );
    expect(new Set(targets).size).toBe(100);
  });

  it("is rebuilt byte-identical by the builder, with no extra or missing files", () => {
    const rendered = renderBundle(buildTaskSet(), GRADER_VERSION, BUNDLE_README);
    const onDisk = committedFiles(BUNDLE)
      .map((f) => relative(BUNDLE, f).split("\\").join("/"))
      .sort();
    expect(onDisk).toEqual([...rendered.keys()].sort());
    for (const [path, content] of rendered) {
      expect(readFileSync(join(BUNDLE, path), "utf8"), path).toBe(content);
    }
  });

  it("pins every file in the manifest by SHA-256", () => {
    const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8")) as {
      files: Record<string, string>;
      counts: { r1: number; demo: number };
      license: string;
      graderVersion: string;
    };
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.graderVersion).toBe(GRADER_VERSION);
    expect(manifest.counts.r1).toBe(100);
    expect(manifest.counts.demo).toBe(30);
    expect(Object.keys(manifest.files).length).toBe(committedFiles(BUNDLE).length - 1);
    for (const [path, hash] of Object.entries(manifest.files)) {
      expect(sha(readFileSync(join(BUNDLE, path))), path).toBe(hash);
    }
  });

  it("pins each fixture by hash, reproducible from its seed for the VM harness", () => {
    for (const t of committedTasks) {
      const bytes = readFileSync(join(BUNDLE, t.fixtureFile));
      expect(sha(bytes), t.taskId).toBe(t.fixtureSha256);
      expect(t.fixtureFile).toBe(`fixtures/${t.fixtureSha256}.csv`);
      expect(bytes.toString("utf8"), t.taskId).toBe(generateFixture(t.fixtureSeed).csv);
    }
  });

  it("hashes the exact instruction, which names the intent and asks for a save", () => {
    for (const t of committedTasks) {
      expect(sha(t.instruction), t.taskId).toBe(t.instructionSha256);
      expect(t.instruction).toContain(t.intent.rowKey);
      expect(t.instruction).toContain(t.intent.column);
      expect(t.instruction).toContain(JSON.stringify(t.intent.newValue));
      expect(t.instruction).toMatch(/and save the file\.$/);
    }
  });

  it("is gradable by the independent grader from the bundle alone", () => {
    for (const t of committedTasks) {
      const fixtureCsv = readFileSync(join(BUNDLE, t.fixtureFile));
      const base = {
        fixtureCsv,
        fixtureSha256: t.fixtureSha256,
        intent: t.intent,
        columnTypes: t.columnTypes,
      };
      // The untouched document is never a pass: the edit is missing, or the intent is impossible.
      expect(
        grade({ ...base, persisted: { format: "csv", bytes: fixtureCsv } }).status,
        t.taskId,
      ).toBe("fail");
      if (t.satisfiable) {
        expect(
          grade({ ...base, persisted: { format: "csv", bytes: honestCsv(t) } }).status,
          t.taskId,
        ).toBe("pass");
      } else {
        expect(
          grade({ ...base, persisted: { format: "csv", bytes: fixtureCsv } }).reasons.join(),
          t.taskId,
        ).toMatch(/intent unsatisfiable/);
      }
    }
  });

  it("carries no host path anywhere in the bundle", () => {
    for (const f of committedFiles(BUNDLE)) {
      expect(readFileSync(f, "utf8"), relative(ROOT, f)).not.toMatch(
        /\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\/,
      );
    }
  });
});

describe("grade requests from arm rows", () => {
  const [t1, t2] = committedTasks as [BenchmarkTask, BenchmarkTask];
  const ref = (
    task: BenchmarkTask,
    trialKey: string,
    over: Partial<ArmRowRef> = {},
  ): ArmRowRef => ({
    trialKey,
    taskId: task.taskId,
    taskSetVersion: task.taskSetVersion,
    faultClass: task.faultClass,
    fixtureSha256: task.fixtureSha256,
    instructionSha256: task.instructionSha256,
    ...over,
  });
  it("takes fixture and intent from the task, and only the document from the arm", () => {
    const reqs = buildRequests(committedTasks, [ref(t1, "a"), ref(t2, "b")], (key) =>
      key === "a" ? { file: "docs/a.xlsx", format: "xlsx" } : null,
    );
    expect(reqs[0]).toMatchObject({
      trialKey: "a",
      fixtureFile: t1.fixtureFile,
      intent: t1.intent,
      persistedFile: "docs/a.xlsx",
    });
    expect(reqs[1]).toMatchObject({ trialKey: "b", persistedFile: null, persistedFormat: "xlsx" });
  });

  it("refuses an unknown task and a row that points at another fixture", () => {
    expect(() =>
      buildRequests(committedTasks, [ref(t1, "a", { taskId: "fc-v1-999" })], () => null),
    ).toThrow(/unknown taskId fc-v1-999/);
    expect(() =>
      buildRequests(committedTasks, [ref(t1, "a", { fixtureSha256: "0".repeat(64) })], () => null),
    ).toThrow(/arm row fixtureSha256 .* does not match task fc-v1-001/);
  });

  it("refuses trialKeys that collide on a case-insensitive filesystem, and exact duplicates (N-l)", () => {
    expect(() =>
      buildRequests(committedTasks, [ref(t1, "Trial-1"), ref(t2, "trial-1")], () => null),
    ).toThrow(/trialKey trial-1 collides with Trial-1 on a case-insensitive filesystem/);
    expect(() =>
      buildRequests(committedTasks, [ref(t1, "trial-1"), ref(t2, "trial-1")], () => null),
    ).toThrow(/duplicate trialKey trial-1/);
    // The refusal is in planning: the document lookup never runs for a colliding set.
    let looked = 0;
    expect(() =>
      buildRequests(committedTasks, [ref(t1, "A"), ref(t2, "a")], () => {
        looked++;
        return null;
      }),
    ).toThrow(RequestBuildError);
    expect(looked).toBe(0);
  });

  it("refuses a row whose taskSetVersion is not the task's (fc-v1 row labelled fc-v2)", () => {
    expect(() =>
      buildRequests(committedTasks, [ref(t1, "a", { taskSetVersion: "fc-v2" })], () => null),
    ).toThrow(/arm row taskSetVersion "fc-v2" does not match task fc-v1-001 \("fc-v1"\)/);
  });

  it("refuses a row whose faultClass is relabelled (invalid-target relabelled none)", () => {
    const invalid = committedTasks.find((t) => t.faultClass === "invalid-target") as BenchmarkTask;
    expect(() =>
      buildRequests(committedTasks, [ref(invalid, "a", { faultClass: "none" })], () => null),
    ).toThrow(/arm row faultClass "none" does not match task fc-v1-091 \("invalid-target"\)/);
    // and the reverse direction, a fault task hidden as a clean one
    expect(() =>
      buildRequests(committedTasks, [ref(t1, "a", { faultClass: "kill-app" })], () => null),
    ).toThrow(/arm row faultClass "kill-app" does not match/);
  });

  it("refuses a row whose instructionSha256 is not the task's (R2 parity)", () => {
    expect(() =>
      buildRequests(
        committedTasks,
        [ref(t1, "a", { instructionSha256: t2.instructionSha256 })],
        () => null,
      ),
    ).toThrow(/arm row instructionSha256 .* does not match task fc-v1-001/);
  });

  it("pathInside keeps names inside their root and refuses escapes", () => {
    const root = join(tmpdir(), "myco-root");
    expect(pathInside(root, "docs/a.csv")).toBe(join(root, "docs", "a.csv"));
    expect(pathInside(root, "...csv")).toBe(join(root, "...csv"));
    for (const bad of [
      "../escape.csv",
      "docs/../../escape.csv",
      "/etc/escape.csv",
      "",
      ".",
      "..",
    ]) {
      expect(() => pathInside(root, bad), bad).toThrow(RequestBuildError);
    }
  });

  it("the bundle README carries every fault-class harness note and the agent-visibility rule", () => {
    const readme = readFileSync(join(BUNDLE, "README.md"), "utf8");
    for (const [cls, note] of Object.entries(FAULT_CLASS_HARNESS_NOTE)) {
      expect(readme, cls).toContain(`| \`${cls}\` | ${note} |`);
    }
    expect(readme).toMatch(/agent must see only the task's `instruction` and the fixture/);
    expect(readme).toContain("scripts/benchmark-verify-bundle.ts");
  });

  it("the bundle directory exists where the README says", () => {
    expect(existsSync(join(BUNDLE, "README.md"))).toBe(true);
  });
});
