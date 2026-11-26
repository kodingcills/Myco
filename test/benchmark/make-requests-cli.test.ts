/**
 * TIF-267 part 2: `benchmark-make-requests.ts` treats the arm file as untrusted input.
 *
 *  - every arm row is validated against the closed arm-row schema before a path is built,
 *    so a `trialKey` cannot carry `..`, an absolute path or a separator (D1, round 1);
 *  - a row whose taskSetVersion / faultClass / instructionSha256 is not its task's is
 *    refused (D2, round 1);
 *  - on any refusal it exits 1 and writes nothing, inside or outside --out;
 *  - a trial with no saved document reaches the grader as `persistedFile: null` and grades
 *    `ungradable` (N1, round 1).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import type { BenchmarkTask } from "../../src/benchmark/taskset.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, "benchmark", "false-completion", "fc-v1");
const tasks = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l) as BenchmarkTask);
const [t1, t2] = tasks as [BenchmarkTask, BenchmarkTask];
const invalidTarget = tasks.find((t) => t.faultClass === "invalid-target") as BenchmarkTask;

function tsx(script: string, args: string[]) {
  const r = spawnSync("npx", ["tsx", join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function armRow(task: BenchmarkTask, trialKey: string, over: Partial<BenchmarkArmRow> = {}) {
  const row: BenchmarkArmRow = {
    schema: "myco.benchmark.arm-row/1",
    taskSetVersion: task.taskSetVersion,
    arm: "hcu+shell",
    trialKey,
    taskId: task.taskId,
    faultClass: task.faultClass,
    fixtureSha256: task.fixtureSha256,
    instructionSha256: task.instructionSha256,
    plannerModelId: "fake-credulous",
    outputCeiling: null,
    claim: "done",
    gate: null,
    accepted: true,
    persistedSha256: null,
    cause: null,
    cost: { modelUsd: null, wallClockS: null, vmS: null },
  };
  return { ...row, ...over };
}

function tree(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? [`${e.name}/`, ...tree(join(dir, e.name)).map((f) => `${e.name}/${f}`)]
        : [e.name],
    )
    .sort();
}

/**
 * A work dir W with W/a/b/docs and --out W/a/b/out, plus decoy documents where a
 * `../../escape` trialKey would read from (W/a/escape.csv) and next to where it would write.
 */
function workspace() {
  const w = mkdtempSync(join(tmpdir(), "myco-make-req-"));
  const base = join(w, "a", "b");
  const docs = join(base, "docs");
  mkdirSync(docs, { recursive: true });
  const fixture = join(BUNDLE, t1.fixtureFile);
  copyFileSync(fixture, join(w, "a", "escape.csv"));
  copyFileSync(fixture, join(w, "escape.csv"));
  copyFileSync(fixture, join(docs, "ok-1.csv"));
  mkdirSync(join(docs, "sub"));
  copyFileSync(fixture, join(docs, "sub", "escape.csv"));
  return { w, docs, out: join(base, "out"), arm: join(w, "arm.jsonl") };
}

function run(ws: ReturnType<typeof workspace>, rows: object[]) {
  writeFileSync(ws.arm, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return tsx("benchmark-make-requests.ts", [
    "--bundle",
    BUNDLE,
    "--arm",
    ws.arm,
    "--docs",
    ws.docs,
    "--out",
    ws.out,
  ]);
}

describe("make-requests refuses an untrusted arm file and writes nothing", () => {
  const hostile: [string, () => string][] = [
    ["a ../ trialKey", () => "../../escape"],
    ["an absolute-path trialKey", () => join(tmpdir(), "escape")],
    ["a trialKey with a path separator", () => "sub/escape"],
  ];
  for (const [label, key] of hostile) {
    it(`refuses ${label}`, { timeout: 30_000 }, () => {
      const ws = workspace();
      const before = tree(ws.w);
      // a valid row first, so a refusal cannot hide behind "nothing to do"
      const r = run(ws, [armRow(t1, "ok-1"), armRow(t2, key())]);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stderr).toMatch(/arm line 2: \$\.trialKey .*pattern/);
      expect(r.stdout).not.toMatch(/wrote/);
      expect(existsSync(ws.out)).toBe(false);
      // no file created anywhere under W (in particular W/a/b/escape.csv, outside --out)
      expect(tree(ws.w)).toEqual([...before, "arm.jsonl"].sort());
    });
  }

  it("refuses a row that is not a closed arm row (extra field)", { timeout: 30_000 }, () => {
    const ws = workspace();
    const r = run(ws, [{ ...armRow(t1, "ok-1"), path: "../x" }]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/arm line 1: /);
    expect(existsSync(ws.out)).toBe(false);
  });

  const relabels: [string, () => object, RegExp][] = [
    [
      "an fc-v1 row labelled fc-v2",
      () => armRow(t1, "ok-1", { taskSetVersion: "fc-v2" }),
      /taskSetVersion "fc-v2" does not match/,
    ],
    [
      "invalid-target relabelled none",
      () => armRow(invalidTarget, "ok-1", { faultClass: "none" }),
      /faultClass "none" does not match task fc-v1-091/,
    ],
    [
      "another task's instruction hash",
      () => armRow(t1, "ok-1", { instructionSha256: t2.instructionSha256 }),
      /instructionSha256 .* does not match/,
    ],
  ];
  for (const [label, row, msg] of relabels) {
    it(`refuses ${label}`, { timeout: 30_000 }, () => {
      const ws = workspace();
      const r = run(ws, [armRow(t2, "ok-2"), row()]);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stderr).toMatch(/RequestBuildError: ok-1: arm row /);
      expect(r.stderr).toMatch(msg);
      expect(existsSync(ws.out)).toBe(false);
    });
  }
});

describe("make-requests with a missing saved document", () => {
  it("emits persistedFile null, which the grader grades ungradable", { timeout: 60_000 }, () => {
    const ws = workspace();
    const r = run(ws, [armRow(t1, "ok-1"), armRow(t2, "missing-1")]);
    expect(r.status, r.stderr).toBe(0);
    const reqPath = join(ws.out, "requests.jsonl");
    const reqs = readFileSync(reqPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as { trialKey: string; persistedFile: string | null });
    expect(reqs.map((q) => [q.trialKey, q.persistedFile])).toEqual([
      ["ok-1", "docs/ok-1.csv"],
      ["missing-1", null],
    ]);
    // the present document was copied byte for byte; nothing was invented for the missing one
    expect(
      createHash("sha256")
        .update(readFileSync(join(ws.out, "docs", "ok-1.csv")))
        .digest("hex"),
    ).toBe(t1.fixtureSha256);
    expect(tree(join(ws.out, "docs"))).toEqual(["ok-1.csv"]);
    expect(relative(ws.out, reqPath)).toBe("requests.jsonl");

    const graded = tsx("benchmark-grade.ts", [reqPath]);
    expect(graded.status, graded.stderr).toBe(0);
    const grades = graded.stdout
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as { trialKey: string; status: string; reasons: string[] });
    const missing = grades.find((g) => g.trialKey === "missing-1");
    expect(missing).toMatchObject({
      status: "ungradable",
      reasons: ["persisted document was not captured"],
    });
    // the unedited fixture, saved as the document, is graded (and fails), not ungradable
    expect(grades.find((g) => g.trialKey === "ok-1")?.status).toBe("fail");
  });
});
