// Attribution guard (#685): fixture-driven tests of .github/scripts/attribution-guard.ts.
// The scan is tested on the fixture texts directly, then the CLI end to end against a
// throwaway git repository under the OS temp directory (never this checkout).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FindingCode, scanText } from "../../.github/scripts/attribution-guard.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const SCRIPT = join(import.meta.dirname, "..", "..", ".github", "scripts", "attribution-guard.ts");
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.txt`), "utf8");

const CLEAN = [
  "clean-title",
  "clean-body",
  "clean-commit",
  "human-coauthor",
  "prose-claude",
] as const;

const DIRTY: ReadonlyArray<[string, FindingCode, number]> = [
  ["dirty-trailer-claude", "co-author-trailer", 3],
  ["dirty-trailer-anthropic", "co-author-trailer", 3],
  ["dirty-trailer-mixed-case", "co-author-trailer", 3],
  ["dirty-trailer-middle", "co-author-trailer", 4],
  ["dirty-generated-plain", "generated-with-line", 5],
  ["dirty-generated-link", "generated-with-line", 5],
];

describe("scanText on fixtures", () => {
  it.each(CLEAN)("%s passes", (name) => {
    expect(scanText(name, fixture(name))).toEqual([]);
  });

  it.each(DIRTY)("%s fails with %s on line %i", (name, code, line) => {
    expect(scanText(name, fixture(name))).toEqual([{ source: name, line, code }]);
  });

  it("a trailer in the title or body is caught as well as in a commit", () => {
    const text = fixture("dirty-trailer-claude");
    expect(scanText("PR title", text)[0]?.source).toBe("PR title");
    expect(scanText("PR body", text)[0]?.code).toBe("co-author-trailer");
  });

  it("the name must be on the trailer line itself", () => {
    expect(scanText("x", "Co-authored-by: Jane <j@example.com>\nClaude reviewed it")).toEqual([]);
  });

  it("CRLF line endings are split like LF", () => {
    expect(scanText("x", "Fix\r\n\r\nCo-authored-by: Claude <c@example.com>\r\n")).toEqual([
      { source: "x", line: 3, code: "co-author-trailer" },
    ]);
  });
});

// --- CLI end to end -------------------------------------------------------------------

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Isolated from any user or system git configuration and hooks.
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "author@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** A repo with one base commit and then one commit per fixture; returns the range. */
function repoWith(commitFixtures: readonly string[]): { cwd: string; base: string; head: string } {
  const cwd = mkdtempSync(join(tmpdir(), "attribution-guard-"));
  tmpDirs.push(cwd);
  git(cwd, "init", "-q");
  git(cwd, "commit", "-q", "--allow-empty", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  for (const name of commitFixtures) {
    git(
      cwd,
      "commit",
      "-q",
      "--allow-empty",
      "--cleanup=verbatim",
      "-F",
      join(FIXTURES, `${name}.txt`),
    );
  }
  return { cwd, base, head: git(cwd, "rev-parse", "HEAD") };
}

function runGuard(
  cwd: string,
  env: Record<string, string>,
): { status: number | null; out: string } {
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    env: { PATH: GIT_ENV.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const CLEAN_COMMITS = ["clean-commit", "human-coauthor", "prose-claude"];
const cleanPr = (base: string, head: string) => ({
  BASE_SHA: base,
  HEAD_SHA: head,
  PR_TITLE: fixture("clean-title"),
  PR_BODY: fixture("clean-body"),
});

describe("attribution-guard CLI", () => {
  it("clean title, body and commits: exit 0", () => {
    const { cwd, base, head } = repoWith(CLEAN_COMMITS);
    const r = runGuard(cwd, cleanPr(base, head));
    expect(r.out).toContain("ATTRIBUTION GUARD OK");
    expect(r.out).toContain("3 commit message(s)");
    expect(r.status).toBe(0);
  });

  it.each(DIRTY.map(([name]) => name))("dirty commit %s among clean ones: exit 1", (name) => {
    const { cwd, base, head } = repoWith([...CLEAN_COMMITS.slice(0, 1), name, "prose-claude"]);
    const r = runGuard(cwd, cleanPr(base, head));
    expect(r.out).toMatch(/FOUND commit [0-9a-f]{8} line \d+:/);
    expect(r.out).toContain("ATTRIBUTION GUARD FAILED: 1 finding(s)");
    expect(r.status).toBe(1);
  });

  it("dirty PR title: exit 1", () => {
    const { cwd, base, head } = repoWith(CLEAN_COMMITS);
    const r = runGuard(cwd, {
      ...cleanPr(base, head),
      PR_TITLE: "Add guard Co-authored-by: Claude",
    });
    expect(r.out).toContain("FOUND PR title line 1:");
    expect(r.status).toBe(1);
  });

  it.each(["dirty-generated-plain", "dirty-generated-link", "dirty-trailer-middle"])(
    "dirty PR body %s: exit 1",
    (name) => {
      const { cwd, base, head } = repoWith(CLEAN_COMMITS);
      const r = runGuard(cwd, { ...cleanPr(base, head), PR_BODY: fixture(name) });
      expect(r.out).toContain("FOUND PR body line");
      expect(r.status).toBe(1);
    },
  );

  it("commits outside base..head are not scanned", () => {
    const { cwd, base: dirtyBase } = repoWith(["dirty-trailer-claude"]);
    const mid = git(cwd, "rev-parse", "HEAD");
    git(cwd, "commit", "-q", "--allow-empty", "-F", join(FIXTURES, "clean-commit.txt"));
    const head = git(cwd, "rev-parse", "HEAD");
    expect(runGuard(cwd, cleanPr(mid, head)).status).toBe(0);
    expect(runGuard(cwd, cleanPr(dirtyBase, head)).status).toBe(1);
  });

  it("a sync merge of main after a stale BASE_SHA is excluded via BASE_REF", () => {
    // base -> clean feature commit; main gets a dirty commit; feature merges main.
    const { cwd, base, head: feature } = repoWith(["clean-commit"]);
    git(cwd, "checkout", "-q", "-b", "mainline", base);
    git(cwd, "commit", "-q", "--allow-empty", "-F", join(FIXTURES, "dirty-trailer-claude.txt"));
    const mainTip = git(cwd, "rev-parse", "HEAD");
    git(cwd, "update-ref", "refs/remotes/origin/main", mainTip);
    git(cwd, "checkout", "-q", feature);
    git(cwd, "merge", "-q", "--no-ff", "-m", "Merge origin/main", mainTip);
    const head = git(cwd, "rev-parse", "HEAD");

    expect(runGuard(cwd, cleanPr(base, head)).status).toBe(1);
    const r = runGuard(cwd, { ...cleanPr(base, head), BASE_REF: "main" });
    expect(r.out).toContain("2 commit message(s)");
    expect(r.status).toBe(0);
    // A dirty commit on the PR side is still caught with BASE_REF set.
    git(cwd, "commit", "-q", "--allow-empty", "-F", join(FIXTURES, "dirty-trailer-middle.txt"));
    const dirtyHead = git(cwd, "rev-parse", "HEAD");
    expect(runGuard(cwd, { ...cleanPr(base, dirtyHead), BASE_REF: "main" }).status).toBe(1);
  });

  it("a malformed or unknown BASE_REF fails closed: exit 2", () => {
    const { cwd, base, head } = repoWith(CLEAN_COMMITS);
    git(cwd, "update-ref", "refs/remotes/origin/main", base);
    expect(runGuard(cwd, { ...cleanPr(base, head), BASE_REF: "main" }).status).toBe(0);
    // `main~0` and `main@{0}` are revisions git would resolve; only plain names pass.
    for (const ref of ["main~0", "main@{0}", "../main", "-main", "main branch", "nosuchbranch"]) {
      const r = runGuard(cwd, { ...cleanPr(base, head), BASE_REF: ref });
      expect(r.out).toContain("ATTRIBUTION GUARD ERROR");
      expect(r.status).toBe(2);
    }
  });

  it("missing or malformed range fails closed: exit 2", () => {
    const { cwd, head } = repoWith(CLEAN_COMMITS);
    const noBase = runGuard(cwd, { HEAD_SHA: head, PR_TITLE: "t", PR_BODY: "b" });
    expect(noBase.out).toContain("ATTRIBUTION GUARD ERROR");
    expect(noBase.status).toBe(2);
    expect(runGuard(cwd, { ...cleanPr("HEAD~1", head) }).status).toBe(2);
  });

  it("a range git cannot resolve fails closed: exit 2", () => {
    const { cwd, head } = repoWith(CLEAN_COMMITS);
    const r = runGuard(cwd, cleanPr("0".repeat(40), head));
    expect(r.out).toContain("ATTRIBUTION GUARD ERROR");
    expect(r.status).toBe(2);
  });
});
