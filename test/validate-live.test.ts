/**
 * TIF-223: validate-live must walk nested run layouts and must never report
 * ALL OK when it validated nothing. Every case runs the real CLI so the exit
 * code and the summary line are what an operator sees.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLI = resolve("src/integration/validate-live.ts");
const SWEEP2 = resolve("docs/research/experiments/m1-row8-sweep2/runs");

function run(...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The <runId> dirs of committed sweep2 index `index`. */
function sweep2RunDir(index: number): string {
  const indexDir = join(SWEEP2, String(index));
  const [runId] = readdirSync(indexDir);
  return join(indexDir, runId as string);
}

const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "validate-live-"));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Copy sweep2 indices into root/<index>/<runId>/ (the live driver layout). */
function nestedRuns(root: string, indices: number[]): void {
  for (const i of indices) {
    const src = sweep2RunDir(i);
    cpSync(src, join(root, String(i), src.split("/").pop() as string), { recursive: true });
  }
}

describe("validate-live (TIF-223)", () => {
  it("validates every run in the nested runs/<index>/<runId>/ layout", () => {
    const root = tempDir();
    nestedRuns(join(root, "runs"), [0, 1, 2]);
    // Pointed at runs/ and at the OUT root above it: both must find all three.
    for (const target of [join(root, "runs"), root]) {
      const r = run(target);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^validated 3 result\.json \+ \d+ trace events in .*: ALL OK\n$/);
    }
  });

  it("validates a values/<runId>/ tree", () => {
    const root = tempDir();
    const src = sweep2RunDir(3);
    cpSync(src, join(root, "values", "run-a"), { recursive: true });
    const r = run(root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^validated 1 result\.json/);
  });

  it("fails on an empty directory", () => {
    const root = tempDir();
    mkdirSync(join(root, "runs", "0"), { recursive: true });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("ALL OK");
    expect(r.stderr).toContain("NO RUN DIRS");
  });

  it("fails and names the path when a run dir has result.json but no trace.jsonl", () => {
    const root = tempDir();
    nestedRuns(root, [0]);
    const broken = join(root, "1", "run-x");
    mkdirSync(broken, { recursive: true });
    cpSync(join(sweep2RunDir(1), "result.json"), join(broken, "result.json"));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("ALL OK");
    expect(r.stderr).toContain(`INCOMPLETE run dir ${broken}: missing trace.jsonl`);
  });

  it("fails when --expect does not match the run count, passes when it does", () => {
    const root = tempDir();
    nestedRuns(root, [0, 1]);
    const bad = run(root, "--expect", "3");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("EXPECTED 3 run dirs, found 2");
    const good = run(root, "--expect=2");
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toContain("ALL OK");
  });

  it("rejects a malformed --expect value with exit 2", () => {
    const root = tempDir();
    nestedRuns(root, [0]);
    expect(run(root, "--expect", "two").status).toBe(2);
  });

  // Flat runs/<runId>/ layout on purpose: the pre-TIF-223 tool handled it, so
  // this case passes on both versions and pins the unchanged per-file check.
  it("still fails a schema-invalid result.json", () => {
    const root = tempDir();
    cpSync(sweep2RunDir(0), join(root, "run-a"), { recursive: true });
    cpSync(sweep2RunDir(1), join(root, "run-b"), { recursive: true });
    const resultPath = join(root, "run-b", "result.json");
    const record = JSON.parse(readFileSync(resultPath, "utf8"));
    record.verdict = "not-a-verdict";
    writeFileSync(resultPath, JSON.stringify(record));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("INVALID result run-b");
    expect(r.stdout).toContain("1 FAILURES");
  });

  it("committed m1-row8-sweep2 pack: 29 results + 516 trace events", () => {
    const r = run(SWEEP2, "--expect", "29");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`validated 29 result.json + 516 trace events in ${SWEEP2}: ALL OK\n`);
  });
});
