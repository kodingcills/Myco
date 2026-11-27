/**
 * The track I analysis CLI (`npx tsx scripts/capability-i-analysis.ts <pack.json>`).
 *
 * Loads the committed pre-registration (refusing if it or any frozen analysis file changed),
 * reads the frozen fc-v1 task facts, reads the pre-registration as committed at the pack's
 * `preregCommit` with `git show`, runs `analyzeIPack`, and prints the analysis as JSON.
 *
 * Exit codes: 0 the bar is shown; 1 not shown (the JSON says why, with the numbers);
 * 2 the analysis could not run (bad pre-registration, unreadable pack, usage).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeIPack, type IPack, type ITaskFact } from "./i-analysis.ts";
import { I_PREREG_JSON, loadIPrereg, preregHash } from "./prereg.ts";

export interface CliIo {
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
}

/** The pre-registration's hash as committed at `commit`, or null if git does not have it. */
export function gitPreregHashAt(repoRoot: string, commit: string): string | null {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) return null;
  const r = spawnSync("git", ["show", `${commit}:${I_PREREG_JSON}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  try {
    return preregHash(JSON.parse(r.stdout));
  } catch {
    return null;
  }
}

export function readTaskFacts(repoRoot: string, tasksFile: string): ITaskFact[] {
  return readFileSync(join(repoRoot, tasksFile), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const t = JSON.parse(l) as { taskId: string; satisfiable: boolean; faultClass: string };
      return { taskId: t.taskId, satisfiable: t.satisfiable, faultClass: t.faultClass };
    });
}

export function main(argv: readonly string[], repoRoot: string, io: CliIo): number {
  if (argv.length !== 1 || argv[0]?.startsWith("-")) {
    io.stderr("usage: npx tsx scripts/capability-i-analysis.ts <pack.json>\n");
    return 2;
  }
  try {
    const { prereg, hash } = loadIPrereg(repoRoot);
    const pack = JSON.parse(readFileSync(argv[0] as string, "utf8")) as IPack;
    const result = analyzeIPack(pack, {
      prereg,
      preregSha256: hash,
      tasks: readTaskFacts(repoRoot, prereg.taskSet.tasksFile),
      preregHashAtCommit: (c) => gitPreregHashAt(repoRoot, c),
    });
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.barShown ? 0 : 1;
  } catch (e) {
    io.stderr(`capability-i-analysis: ${(e as Error).message}\n`);
    return 2;
  }
}
