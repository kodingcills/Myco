/**
 * TIF-241 (OSS readiness): no tracked file may carry an absolute macOS home
 * path (a `Users` directory, then an account name, then a slash). Such paths
 * leak the maintainer's account name and never resolve on anyone else's
 * machine: use a repo-relative path, or `~/` / `$HOME/` for the home dir.
 *
 * The pattern is generic (any account name), so this also catches new ones.
 * ALLOWED lists the only files that may match, each with the reason it is not
 * a maintainer home path. Do not add to it to get a red test green: fix the path.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");

// Written with escaped slashes so this file never matches itself.
const HOME_PATH = /\/Users\/[^/\s]+\//;

const ALLOWED: Record<string, string> = {
  // `C:` drive path for the Windows trial VM's own `myco` user, not a Mac home dir.
  "agent/bootstrap/deploy-to-vm.sh": "Windows guest path (C: drive, VM user)",
  // Uses the literal `<you>` placeholder; the file is owned by another open PR.
  "docs/eval-runbook.md": "placeholder account name `<you>`",
  // Quoted error output whose account part was already elided to `...`.
  "docs/research/experiments/df-s01-preflight-deadlock/BLOCKER.md":
    "account already elided as `...`",
};

/** Returns `line:text` for each line of `text` holding a home path. */
function findHomePaths(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line, i) => (HOME_PATH.test(line) ? [`${i + 1}:${line.trim().slice(0, 160)}`] : []));
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

describe("no absolute home paths in tracked files (TIF-241)", () => {
  it("the matcher flags a home path and leaves home-relative and generic paths alone", () => {
    const sample = ["/", "Users", "/", "someone", "/", "Projects/x"].join("");
    expect(findHomePaths(`cd ${sample}`)).toHaveLength(1);
    expect(findHomePaths("cd ~/Projects/x && ls $HOME/VMs /private/tmp/run")).toEqual([]);
  });

  it("no tracked file outside the allow-list contains one", () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      if (file in ALLOWED) continue;
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, file), "latin1");
      } catch {
        continue; // deleted in the working tree but still in the index
      }
      for (const hit of findHomePaths(text)) offenders.push(`${file}:${hit}`);
    }
    expect(offenders, "replace with a repo-relative path, ~/ or $HOME/").toEqual([]);
  });
});
