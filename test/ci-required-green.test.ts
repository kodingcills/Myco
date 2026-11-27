/**
 * The R1 pilot launch gate (CI speed, #678): scripts/ci-required-green.sh <sha> exits 0 only
 * when the five REQUIRED checks of that commit's main push run all succeeded, ignoring every
 * other job, and fails closed on anything it cannot read.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXIT,
  type GhApi,
  judgeJobs,
  main,
  parseArgs,
  pickMainRun,
  REQUIRED_CHECKS,
} from "../scripts/ci-required-green.ts";

const ROOT = join(import.meta.dirname, "..");
const SHA = "8fb1237aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "1111111111111111111111111111111111111111";

const NON_REQUIRED = [
  "ci plan (path classes)",
  "ci hygiene (workflows)",
  "myco-agent tests (macos-latest)",
  "m2 evidence and scorecard",
  "strict isolation (ubuntu-latest)",
  "linux path (ubuntu-latest)",
  "newcomer path (ubuntu-latest)",
  "safe parallelism (ubuntu-latest)",
  "viewer verdict budget (macos-latest)",
  "viewer verdict budget (ubuntu-latest)",
];

function run(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    head_sha: SHA,
    event: "push",
    head_branch: "main",
    path: ".github/workflows/ci.yml",
    ...over,
  };
}

function runs(...rows: unknown[]) {
  return { total_count: rows.length, workflow_runs: rows };
}

type Job = { name: string; status: string; conclusion: string | null };

function jobs(over: Record<string, Partial<Job>> = {}, drop: string[] = []) {
  const all: Job[] = [...REQUIRED_CHECKS, ...NON_REQUIRED]
    .filter((name) => !drop.includes(name))
    .map((name) => ({ name, status: "completed", conclusion: "success", ...over[name] }));
  return { total_count: all.length, jobs: all };
}

/** A fake `gh api`: answers by path, records the calls. */
function fakeGh(runsPage: unknown, jobsByRun: Record<number, unknown>) {
  const calls: { path: string; fields: Record<string, string> }[] = [];
  const gh: GhApi = async (path, fields) => {
    calls.push({ path, fields });
    if (path.endsWith("/runs")) return runsPage;
    const m = /\/runs\/(\d+)\/jobs$/.exec(path);
    if (m) return jobsByRun[Number(m[1])];
    throw new Error("GH_FAILED");
  };
  return { gh, calls };
}

async function gate(argv: string[], gh: GhApi) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, gh);
  return { code, out, err };
}

describe("ci-required-green: the required set", () => {
  it("is exactly the five required checks docs/ci.md and branch protection name", () => {
    expect([...REQUIRED_CHECKS].sort()).toEqual(
      [
        "check (macos-latest)",
        "check (ubuntu-latest)",
        "myco-agent tests (ubuntu-latest)",
        "runtime guest agent tests (ubuntu-latest)",
        "secret scan (gitleaks)",
      ].sort(),
    );
    const doc = readFileSync(join(ROOT, "docs", "ci.md"), "utf8");
    for (const name of REQUIRED_CHECKS) expect(doc).toContain(`\`${name}\``);
  });
});

describe("ci-required-green: decisions", () => {
  it("is green when every required check succeeded, whatever the other jobs did", async () => {
    const failingOthers = Object.fromEntries(
      NON_REQUIRED.map((n) => [n, { conclusion: n.startsWith("viewer") ? "failure" : "skipped" }]),
    );
    const { gh, calls } = fakeGh(runs(run(7)), { 7: jobs(failingOthers) });
    const r = await gate([SHA], gh);
    expect(r.code).toBe(EXIT.green);
    expect(r.out.at(-1)).toBe(`REQUIRED_GREEN ${SHA} run 7`);
    expect(r.out.slice(0, 5)).toEqual(REQUIRED_CHECKS.map((n) => `${n}: success`));
    // It asks for the commit's push runs on main of ci.yml, then that run's latest jobs.
    expect(calls[0]).toEqual({
      path: "repos/kodingcills/Myco/actions/workflows/ci.yml/runs",
      fields: { head_sha: SHA, event: "push", branch: "main", per_page: "100" },
    });
    expect(calls[1]).toEqual({
      path: "repos/kodingcills/Myco/actions/runs/7/jobs",
      fields: { filter: "latest", per_page: "100" },
    });
  });

  it("is not green when any one required check failed, was skipped, cancelled or is unfinished", async () => {
    for (const name of REQUIRED_CHECKS) {
      for (const state of [
        { conclusion: "failure" },
        { conclusion: "skipped" },
        { conclusion: "cancelled" },
        { conclusion: "timed_out" },
        { conclusion: null },
        { status: "in_progress", conclusion: null },
        { status: "queued", conclusion: null },
      ]) {
        const { gh } = fakeGh(runs(run(7)), { 7: jobs({ [name]: state }) });
        const r = await gate([SHA], gh);
        expect(r.code, `${name} ${JSON.stringify(state)}`).toBe(EXIT.notGreen);
        expect(r.out.at(-1)).toContain(`NOT_SUCCESS ${name}=`);
      }
    }
  });

  it("is not green when a required check is missing (a skipped matrix job reports another name)", async () => {
    for (const name of REQUIRED_CHECKS) {
      const page = jobs({}, [name]);
      if (name.startsWith("check (")) {
        page.jobs.push({
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's literal unexpanded job name
          name: "check (${{ matrix.os }})",
          status: "completed",
          conclusion: "skipped",
        });
        page.total_count += 1;
      }
      const { gh } = fakeGh(runs(run(7)), { 7: page });
      const r = await gate([SHA], gh);
      expect(r.code, name).toBe(EXIT.notGreen);
      expect(r.out.at(-1)).toContain(`MISSING ${name}`);
    }
    // `check affected (ubuntu-latest)` (a draft's affected run) never stands in for `check`.
    const page = jobs({}, ["check (ubuntu-latest)"]);
    page.jobs.push({
      name: "check affected (ubuntu-latest)",
      status: "completed",
      conclusion: "success",
    });
    page.total_count += 1;
    expect((await gate([SHA], fakeGh(runs(run(7)), { 7: page }).gh)).code).toBe(EXIT.notGreen);
  });

  it("is not green when one of two same-named jobs failed", () => {
    const page = jobs();
    page.jobs.push({ name: "check (macos-latest)", status: "completed", conclusion: "failure" });
    page.total_count += 1;
    expect(judgeJobs(page).codes).toEqual(["NOT_SUCCESS check (macos-latest)=failure"]);
  });

  it("reads only this commit's CI run from a push to main", async () => {
    for (const wrong of [
      { head_sha: OTHER },
      { event: "pull_request" },
      { event: "workflow_dispatch" },
      { head_branch: "claude/x" },
      { head_branch: null },
      { path: ".github/workflows/tif-170-race-diagnostics.yml" },
    ]) {
      const { gh, calls } = fakeGh(runs(run(7, wrong)), { 7: jobs() });
      const r = await gate([SHA], gh);
      expect(r.code, JSON.stringify(wrong)).toBe(EXIT.notGreen);
      expect(r.out.at(-1)).toBe(`NOT_GREEN ${SHA}: RUN_NOT_FOUND`);
      expect(calls).toHaveLength(1);
    }
    // The API's `path@ref` form is the same workflow.
    const { gh } = fakeGh(runs(run(7, { path: ".github/workflows/ci.yml@refs/heads/main" })), {
      7: jobs(),
    });
    expect((await gate([SHA], gh)).code).toBe(EXIT.green);
  });

  it("uses the newest main run of the commit (a re-run or a second push)", async () => {
    const red = jobs({ "check (macos-latest)": { conclusion: "failure" } });
    // Newest green, older red: green.
    let r = await gate(
      [SHA],
      fakeGh(runs(run(5), run(9), run(7)), { 5: red, 7: red, 9: jobs() }).gh,
    );
    expect(r.code).toBe(EXIT.green);
    expect(r.out.at(-1)).toContain("run 9");
    // Newest red, older green: not green.
    r = await gate([SHA], fakeGh(runs(run(9), run(5)), { 5: jobs(), 9: red }).gh);
    expect(r.code).toBe(EXIT.notGreen);
    expect(pickMainRun(SHA, runs(run(3), run(11, { head_sha: OTHER }))).run?.id).toBe(3);
  });

  it("fails closed on a truncated or unreadable answer, or a failed gh call", async () => {
    const short = jobs();
    short.total_count += 1;
    let r = await gate([SHA], fakeGh(runs(run(7)), { 7: short }).gh);
    expect([r.code, r.out.at(-1)]).toEqual([EXIT.lookup, `NOT_GREEN ${SHA} run 7: JOBS_TRUNCATED`]);
    r = await gate([SHA], fakeGh({ total_count: 101, workflow_runs: [run(7)] }, { 7: jobs() }).gh);
    expect([r.code, r.out.at(-1)]).toEqual([EXIT.lookup, `NOT_GREEN ${SHA}: RUNS_TRUNCATED`]);
    for (const bad of [null, "x", [], { jobs: "x" }, { jobs: [] }]) {
      r = await gate([SHA], fakeGh(runs(run(7)), { 7: bad }).gh);
      expect(r.code, JSON.stringify(bad)).not.toBe(EXIT.green);
    }
    r = await gate([SHA], fakeGh({ nope: 1 }, {}).gh);
    expect(r.code).toBe(EXIT.lookup);
    r = await gate([SHA], async () => {
      throw new Error("GH_FAILED");
    });
    expect([r.code, r.err]).toEqual([EXIT.lookup, ["LOOKUP_FAILED GH_FAILED"]]);
    r = await gate([SHA], async () => {
      throw new Error("secret-looking text that must not be echoed");
    });
    expect([r.code, r.err]).toEqual([EXIT.lookup, ["LOOKUP_FAILED LOOKUP_FAILED"]]);
  });

  it("takes exactly one full sha and an optional owner/name repo", async () => {
    expect(parseArgs([SHA])).toEqual({ sha: SHA, repo: "kodingcills/Myco" });
    expect(parseArgs([SHA.toUpperCase(), "--repo", "a/b"])).toEqual({ sha: SHA, repo: "a/b" });
    for (const argv of [
      [],
      [SHA, SHA],
      ["8fb1237"],
      [`${SHA}0`],
      ["main"],
      [SHA, "--repo"],
      [SHA, "--repo", "x"],
    ]) {
      expect(parseArgs(argv), JSON.stringify(argv)).toHaveProperty("error");
      const r = await gate(argv, fakeGh(runs(run(7)), { 7: jobs() }).gh);
      expect(r.code, JSON.stringify(argv)).toBe(EXIT.usage);
    }
  });
});

describe("ci-required-green.sh end to end (a fake gh on PATH)", () => {
  function fakeGhBin(runsPage: unknown, jobsPage: unknown, exitCode = 0): string {
    const dir = mkdtempSync(join(tmpdir(), "myco-fake-gh-"));
    writeFileSync(join(dir, "runs.json"), JSON.stringify(runsPage));
    writeFileSync(join(dir, "jobs.json"), JSON.stringify(jobsPage));
    const bin = join(dir, "gh");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `[ ${exitCode} -eq 0 ] || exit ${exitCode}`,
        'case "$*" in',
        `  *"/jobs"*) cat "${join(dir, "jobs.json")}" ;;`,
        `  *"/runs"*) cat "${join(dir, "runs.json")}" ;;`,
        "  *) exit 9 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return dir;
  }

  function sh(dir: string, ...argv: string[]) {
    return spawnSync(join(ROOT, "scripts", "ci-required-green.sh"), argv, {
      cwd: tmpdir(),
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "" },
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("exits 0, 1, 2 and 3 as documented", { timeout: 120_000 }, () => {
    const green = sh(
      fakeGhBin(
        runs(run(7)),
        jobs({ "viewer verdict budget (macos-latest)": { conclusion: "failure" } }),
      ),
      SHA,
    );
    expect([green.status, green.stdout.trim().split("\n").at(-1)]).toEqual([
      0,
      `REQUIRED_GREEN ${SHA} run 7`,
    ]);
    const red = sh(
      fakeGhBin(runs(run(7)), jobs({ "secret scan (gitleaks)": { conclusion: "failure" } })),
      SHA,
    );
    expect(red.status).toBe(1);
    expect(red.stdout).toContain("NOT_SUCCESS secret scan (gitleaks)=failure");
    expect(sh(fakeGhBin(runs(), jobs()), "8fb1237").status).toBe(2);
    expect(sh(fakeGhBin(runs(run(7)), jobs(), 4), SHA).status).toBe(3);
  });
});
