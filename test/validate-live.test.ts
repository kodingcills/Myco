/**
 * TIF-223: validate-live must walk nested run layouts and must never report
 * ALL OK when it validated nothing. TIF-226: it walks the whole tree with no
 * silent skips (AMBIGUOUS run dirs, REFUSED symlinks, hidden dirs, FIFOs) and
 * names every bad path. Every case runs the real CLI so the exit code and the
 * summary line are what an operator sees.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const CLI = resolve("src/integration/validate-live.ts");
const SWEEP2 = resolve("docs/research/experiments/m1-row8-sweep2/runs");

function run(...args: string[]) {
  // The timeout turns a hang (e.g. a blocking read of a FIFO) into a failure.
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
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
const locked: string[] = [];
afterEach(() => {
  for (const d of locked.splice(0)) chmodSync(d, 0o755);
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

  it("validates a single run dir passed as the root", () => {
    const r = run(sweep2RunDir(0), "--expect", "1");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^validated 1 result\.json \+ \d+ trace events in .*: ALL OK\n$/);
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

/** Copy sweep2 index `index` to dest as a flat run dir. */
function runAt(dest: string, index: number): void {
  cpSync(sweep2RunDir(index), dest, { recursive: true });
}

/** A run whose result.json fails the schema. */
function invalidRunAt(dest: string, index: number): void {
  runAt(dest, index);
  const resultPath = join(dest, "result.json");
  const record = JSON.parse(readFileSync(resultPath, "utf8"));
  record.verdict = "not-a-verdict";
  writeFileSync(resultPath, JSON.stringify(record));
}

/** Every failure must still end in the summary line and exit 1, never a crash. */
function expectFailedSummary(r: ReturnType<typeof run>, failures?: number): void {
  expect(r.status, r.stderr).toBe(1);
  if (failures !== undefined)
    expect(r.stdout, r.stderr).toMatch(new RegExp(`: ${failures} FAILURES\\n$`));
  expect(r.stdout).toMatch(
    /^validated \d+ result\.json \+ \d+ trace events in .*: \d+ FAILURES\n$/,
  );
  expect(r.stdout).not.toContain("ALL OK");
  expect(r.stderr).not.toMatch(/\n\s+at /); // no stack trace
}

describe("validate-live walk (TIF-226)", () => {
  // D1: a stray run file at the top of $OUT must not mask the nested runs.
  it("D1: a stray top-level result.json is AMBIGUOUS and the nested runs are still validated", () => {
    const root = tempDir();
    nestedRuns(join(root, "runs"), [0, 1]);
    invalidRunAt(join(root, "runs", "2", "run-bad"), 2);
    cpSync(join(sweep2RunDir(3), "result.json"), join(root, "result.json"));
    const r = run(root);
    expectFailedSummary(r, 2); // AMBIGUOUS + INVALID
    expect(r.stderr).toContain(`AMBIGUOUS run dir ${root}: holds result.json`);
    expect(r.stderr).toContain("INVALID result runs/2/run-bad");
    expect(r.stdout).toMatch(/^validated 3 result\.json/);
  });

  it("D1: an invalid child run under a valid parent run is found and fails", () => {
    const root = tempDir();
    const parent = join(root, "runs", "0", "run-parent");
    runAt(parent, 0);
    invalidRunAt(join(parent, "child"), 1);
    const r = run(root);
    expectFailedSummary(r, 2); // AMBIGUOUS + INVALID
    expect(r.stderr).toContain("INVALID result runs/0/run-parent/child");
    expect(r.stderr).toContain(`AMBIGUOUS run dir ${parent}`);
  });

  // AMBIGUOUS alone must fail: every run here is schema-valid.
  it("D1: a valid run nested in a valid run fails as AMBIGUOUS alone (1 FAILURES)", () => {
    const root = tempDir();
    const parent = join(root, "run-parent");
    runAt(parent, 0);
    runAt(join(parent, "child"), 1);
    const r = run(root);
    expectFailedSummary(r, 1);
    expect(r.stderr).toBe(
      `AMBIGUOUS run dir ${parent}: holds result.json + trace.jsonl and run files below it (child);` +
        " the nested run dirs are validated, the files at this level are not counted\n",
    );
    expect(r.stdout).toMatch(/^validated 1 result\.json/);
  });

  it("D1: a stray top-level result.json over valid runs fails as AMBIGUOUS alone (1 FAILURES)", () => {
    const root = tempDir();
    nestedRuns(join(root, "runs"), [0, 1]);
    cpSync(join(sweep2RunDir(3), "result.json"), join(root, "result.json"));
    const r = run(root, "--expect", "2");
    expectFailedSummary(r, 1);
    expect(r.stderr).toMatch(
      new RegExp(
        `^AMBIGUOUS run dir ${root}: holds result\\.json and run files below it \\(runs/0/[^,]+, runs/1/[^)]+\\);`,
      ),
    );
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toMatch(/^validated 2 result\.json/);
  });

  it("D1: runs inside a directory named result.json are found and named", () => {
    const root = tempDir();
    const outer = join(root, "run-a");
    mkdirSync(outer);
    cpSync(join(sweep2RunDir(0), "trace.jsonl"), join(outer, "trace.jsonl"));
    runAt(join(outer, "result.json", "run-inner"), 1);
    const r = run(root);
    expectFailedSummary(r, 1);
    expect(r.stderr).toContain(`AMBIGUOUS run dir ${outer}: holds result.json + trace.jsonl`);
    expect(r.stderr).toContain("(result.json/run-inner)");
    expect(r.stdout).toMatch(/^validated 1 result\.json/);
  });

  it("D1: nested AMBIGUOUS lines print outermost first", () => {
    const root = tempDir();
    const outer = join(root, "a");
    const inner = join(outer, "result.json", "b");
    mkdirSync(outer);
    cpSync(join(sweep2RunDir(0), "trace.jsonl"), join(outer, "trace.jsonl"));
    mkdirSync(inner, { recursive: true });
    cpSync(join(sweep2RunDir(1), "trace.jsonl"), join(inner, "trace.jsonl"));
    runAt(join(inner, "result.json", "c"), 2);
    const r = run(root, "--expect", "1");
    expectFailedSummary(r, 2);
    const lines = r.stderr.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      new RegExp(`^AMBIGUOUS run dir ${outer}: .* \\(result\\.json/b/result\\.json/c\\);`),
    );
    expect(lines[1]).toMatch(new RegExp(`^AMBIGUOUS run dir ${inner}: .* \\(result\\.json/c\\);`));
    expect(r.stdout).toMatch(/^validated 1 result\.json/);
  });

  it("D1: a FIFO named result.json is reported once", () => {
    const root = tempDir();
    runAt(join(root, "run-a"), 0);
    const fifo = join(root, "run-a", "result.json");
    rmSync(fifo);
    const mk = spawnSync("mkfifo", [fifo]);
    expect(mk.status, String(mk.stderr)).toBe(0);
    const r = run(root);
    expectFailedSummary(r, 1);
    expect(r.stderr).toBe(`UNREADABLE ${fifo}: not a regular file\n`);
  });

  it("a schema-invalid trace event is INVALID and counts as one failure", () => {
    const root = tempDir();
    runAt(join(root, "run-a"), 0);
    const tracePath = join(root, "run-a", "trace.jsonl");
    const lines = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const event = JSON.parse(lines[0] as string);
    event.type = "not-an-event-type";
    lines[0] = JSON.stringify(event);
    writeFileSync(tracePath, `${lines.join("\n")}\n`);
    const r = run(root);
    expectFailedSummary(r, 1);
    expect(r.stderr).toMatch(/^INVALID trace run-a\[0\]: /);
  });

  it("a root that is not a directory exits 2", () => {
    const root = tempDir();
    const file = join(root, "file.txt");
    writeFileSync(file, "x");
    for (const target of [file, join(root, "missing")]) {
      const r = run(target);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`validate-live: not a directory: ${target}`);
      expect(r.stdout).toBe("");
    }
  });

  // D2: never skip silently.
  it("D2: a symlinked run dir is refused and reported, not skipped silently", () => {
    const root = tempDir();
    const outside = tempDir();
    nestedRuns(root, [0]);
    invalidRunAt(join(outside, "run-linked"), 1);
    symlinkSync(join(outside, "run-linked"), join(root, "1"));
    const r = run(root);
    expectFailedSummary(r);
    expect(r.stderr).toContain(`REFUSED symlink ${join(root, "1")}`);
  });

  it("D2: a hidden dir holding an invalid run is validated", () => {
    const root = tempDir();
    nestedRuns(root, [0]);
    invalidRunAt(join(root, ".old", "run-hidden"), 1);
    const r = run(root);
    expectFailedSummary(r);
    expect(r.stderr).toContain("INVALID result .old/run-hidden");
    expect(r.stdout).toMatch(/^validated 2 result\.json/);
  });

  // D3: per-path errors, always a summary line, exit 1.
  it.skipIf(IS_ROOT)(
    "D3: an unreadable (chmod 000) dir is reported with a summary line (skipped as root: root reads mode-000 dirs)",
    () => {
      const root = tempDir();
      nestedRuns(root, [0]);
      const lockedDir = join(root, "1");
      runAt(join(lockedDir, "run-x"), 1);
      chmodSync(lockedDir, 0o000);
      locked.push(lockedDir);
      const r = run(root);
      expectFailedSummary(r);
      expect(r.stderr).toContain(`UNREADABLE dir ${lockedDir}: EACCES`);
    },
  );

  it("D3: malformed JSON in result.json and trace.jsonl is reported per path", () => {
    const root = tempDir();
    runAt(join(root, "run-a"), 0);
    runAt(join(root, "run-b"), 1);
    writeFileSync(join(root, "run-a", "result.json"), "{not json");
    writeFileSync(join(root, "run-b", "trace.jsonl"), "{not json\n");
    const r = run(root);
    expectFailedSummary(r);
    expect(r.stderr).toContain("MALFORMED result run-a");
    expect(r.stderr).toContain("MALFORMED trace run-b[0]");
  });

  it("D3: a result.json that is a directory is reported per path", () => {
    const root = tempDir();
    runAt(join(root, "run-a"), 0);
    rmSync(join(root, "run-a", "result.json"));
    mkdirSync(join(root, "run-a", "result.json"));
    const r = run(root);
    // Reported once: as a broken run file, not also by the walk.
    expectFailedSummary(r, 1);
    expect(r.stderr).toContain(
      `UNREADABLE ${join(root, "run-a", "result.json")}: not a regular file`,
    );
  });

  it("an empty trace.jsonl is INVALID, same rule as run-artifacts", () => {
    const root = tempDir();
    runAt(join(root, "run-a"), 0);
    runAt(join(root, "run-b"), 1);
    writeFileSync(join(root, "run-b", "trace.jsonl"), "");
    const r = run(root);
    expectFailedSummary(r);
    expect(r.stderr).toContain("INVALID trace run-b: empty trace: a run must record events");
  });

  it.skipIf(IS_ROOT)(
    "a chmod 000 result.json is UNREADABLE with a summary line (skipped as root: root reads mode-000 files)",
    () => {
      const root = tempDir();
      runAt(join(root, "run-a"), 0);
      const resultPath = join(root, "run-a", "result.json");
      chmodSync(resultPath, 0o000);
      locked.push(resultPath);
      const r = run(root);
      expectFailedSummary(r);
      expect(r.stderr).toContain(`UNREADABLE ${resultPath}: EACCES`);
    },
  );

  it("a FIFO is reported as SKIPPED and is not a failure", () => {
    const root = tempDir();
    runAt(join(root, "run-a"), 0);
    const fifo = join(root, "pipe");
    const mk = spawnSync("mkfifo", [fifo]);
    expect(mk.status, String(mk.stderr)).toBe(0);
    const r = run(root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^validated 1 result\.json .*: ALL OK\n$/);
    expect(r.stderr).toContain(`SKIPPED ${fifo}: not a regular file or directory`);
  });

  it("a root argument that is a symlink is followed", () => {
    const root = tempDir();
    const links = tempDir();
    nestedRuns(root, [0, 1]);
    const link = join(links, "out");
    symlinkSync(root, link);
    const r = run(link, "--expect", "2");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^validated 2 result\.json .*: ALL OK\n$/);
  });

  it("a symlink loop is REFUSED, not followed", () => {
    const root = tempDir();
    nestedRuns(root, [0]);
    symlinkSync(root, join(root, "loop"));
    symlinkSync("self", join(root, "self"));
    const r = run(root);
    expectFailedSummary(r);
    expect(r.stderr).toContain(`REFUSED symlink ${join(root, "loop")}`);
    expect(r.stderr).toContain(`REFUSED symlink ${join(root, "self")}`);
    expect(r.stdout).toMatch(/^validated 1 result\.json/);
  });

  it("committed m1-row8-corrupt pack: 18 results + 321 trace events", () => {
    const corrupt = resolve("docs/research/experiments/m1-row8-corrupt/runs");
    const r = run(corrupt, "--expect", "18");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`validated 18 result.json + 321 trace events in ${corrupt}: ALL OK\n`);
  });
});
