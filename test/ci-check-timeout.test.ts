/**
 * #747 step 1: the required `check` matrix job gets 25 minutes on macOS and keeps 15 on
 * ubuntu. On plain main the macOS job took 11-14 min and was cancelled at the old 15-min
 * limit, which blocked the merge queue. This pins the per-OS value, the matrix (so the
 * required names `check (macos-latest)` and `check (ubuntu-latest)` stay), and the exact
 * expression shape, which is evaluated here for each OS.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "..");
const CI = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");

/** The lines of top-level job `key` under `jobs:`, up to the next job key. */
function jobByKey(workflow: string, key: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`  ${key}:`);
  if (start === -1) throw new Error(`no job with key "${key}"`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end] as string)) end++;
  return lines.slice(start, end).join("\n");
}

/** The job-level `timeout-minutes` value (4-space indent), or throws if absent or repeated. */
function jobTimeout(job: string): string {
  const hits = [...job.matchAll(/^ {4}timeout-minutes: (.+)$/gm)].map((m) =>
    (m[1] as string).trim(),
  );
  if (hits.length !== 1)
    throw new Error(`expected one job-level timeout-minutes, found ${hits.length}`);
  return hits[0] as string;
}

/**
 * Evaluate a timeout value for one `matrix.os`. Accepts a plain integer, or exactly
 * `${{ matrix.os == '<os>' && <n> || <m> }}` with positive integers (so `&&`/`||` act as
 * a ternary). Anything else throws: an unrecognised shape must fail, not guess.
 */
function timeoutFor(value: string, os: string): number {
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  const m = value.match(
    /^\$\{\{ matrix\.os == '([a-z0-9.-]+)' && ([1-9]\d*) \|\| ([1-9]\d*) \}\}$/,
  );
  if (!m) throw new Error(`unrecognised timeout-minutes: ${value}`);
  return Number(os === m[1] ? m[2] : m[3]);
}

describe("check job timeout (#747)", () => {
  const job = jobByKey(CI, "check");

  it("keeps the matrix that names the two required checks", () => {
    expect(job).toMatch(/^ {8}os: \[macos-latest, ubuntu-latest\]$/m);
    expect(job).toMatch(/^ {4}runs-on: \$\{\{ matrix\.os \}\}$/m);
    expect(job).not.toMatch(/^ {4}name:/m);
  });

  it("gives macOS 25 minutes and leaves ubuntu at 15", () => {
    const value = jobTimeout(job);
    expect(timeoutFor(value, "macos-latest")).toBe(25);
    expect(timeoutFor(value, "ubuntu-latest")).toBe(15);
  });

  it("documents the reason next to the timeout, pointing at #747", () => {
    const at = job.split("\n").findIndex((l) => /^ {4}timeout-minutes:/.test(l));
    const above = job
      .split("\n")
      .slice(Math.max(0, at - 6), at)
      .join("\n");
    expect(above).toContain("#747");
  });
});

/** A GitHub Actions expression `${{ body }}`, built so the source has no `${` in a plain string. */
const gha = (body: string) => `\${{ ${body} }}`;

describe("check job timeout helpers", () => {
  it("evaluates the per-OS expression and plain integers", () => {
    const expr = gha("matrix.os == 'macos-latest' && 25 || 15");
    expect(timeoutFor(expr, "macos-latest")).toBe(25);
    expect(timeoutFor(expr, "ubuntu-latest")).toBe(15);
    expect(timeoutFor("15", "macos-latest")).toBe(15);
  });

  it("rejects shapes it cannot evaluate exactly", () => {
    for (const bad of [
      gha("matrix.os == 'macos-latest' && 0 || 15"),
      gha("matrix.os != 'macos-latest' && 25 || 15"),
      gha("matrix.timeout"),
      "15.5",
      "",
    ]) {
      expect(() => timeoutFor(bad, "macos-latest"), bad).toThrow(/unrecognised/);
    }
  });

  it("finds the job by key and its single job-level timeout", () => {
    const wf =
      "jobs:\n  a:\n    timeout-minutes: 5\n    steps:\n      - run: x\n        timeout-minutes: 9\n  b:\n    run: y\n";
    expect(jobTimeout(jobByKey(wf, "a"))).toBe("5");
    expect(() => jobTimeout(jobByKey(wf, "b"))).toThrow(/found 0/);
    expect(() => jobByKey(wf, "c")).toThrow(/no job/);
  });
});
