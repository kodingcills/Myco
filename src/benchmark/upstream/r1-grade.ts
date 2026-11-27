/**
 * R1 ground truth for the public OSWorld subset: OSWorld's OWN evaluation path, unmodified
 * (lead ruling 2026-11-27 ~13:55Z, gap item 2).
 *
 * The path at OSWORLD_HARNESS.commit: the standard Claude runner
 * (`scripts/python/run_multienv_claude.py`) calls `lib_run_single.run_single_example`, which
 * after the agent loop calls `env.evaluate()` (`DesktopEnv.evaluate`: its postconfig through
 * the setup controller, its own getters through the in-VM controller, its own metrics, the
 * FAIL-action rule) and writes that return value to `<example_result_dir>/result.txt`.
 *
 * This module does not evaluate anything. It:
 *  - refuses a run whose recorded harness (repo, commit, SHA-256 of each pinned harness
 *    file) is not exactly OSWORLD_HARNESS, so a score from a modified or other evaluator is
 *    `ungradable`, never a pass;
 *  - reads the score upstream wrote to `result.txt` and maps it: `pass` iff exactly 1.0
 *    (pending ruling `pass-threshold`), `fail` for any other finite score, `ungradable` when
 *    the file is missing or is not one number (an errored task writes no result.txt);
 *  - reads the last action upstream logged to `traj.jsonl`, for the record.
 *
 * It never runs a getter, a postconfig step or a metric itself, never imports the MOCK metric
 * runner (`./evaluate.ts`), and launches no process (test/benchmark/upstream-r1-grade.test.ts).
 * Independence: it imports nothing from src/gate or src/gate-hooks; neither imports it
 * (test/benchmark/independence.test.ts). Reasons are codes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./import.ts";
import { OSWORLD_HARNESS } from "./pins.ts";

/** The grader version every R1 row must carry: the upstream evaluate path at the pin. */
export const OSWORLD_EVALUATE_GRADER = `osworld-desktopenv-evaluate@${OSWORLD_HARNESS.commit}`;
export const R1_PASS_SCORE = 1.0;

/** What the run recorded about the OSWorld checkout it ran in (written by the operator). */
export interface HarnessStamp {
  readonly repo: string;
  readonly commit: string;
  /** Path relative to the checkout root -> SHA-256 of the bytes the run used. */
  readonly files: Readonly<Record<string, string>>;
}

export interface R1ExampleGrade {
  readonly graderVersion: typeof OSWORLD_EVALUATE_GRADER;
  readonly taskId: string;
  readonly status: "pass" | "fail" | "ungradable";
  /** The score `DesktopEnv.evaluate()` returned, or null when none was read. */
  readonly upstreamScore: number | null;
  /** The last action upstream logged (`DONE`, `FAIL`, `WAIT` or a command), or null. */
  readonly lastAction: string | null;
  readonly codes: readonly string[];
}

/** Stamp a checkout: the commit plus the SHA-256 of every pinned harness file (null if absent). */
export function stampHarness(
  commit: string,
  readFile: (rel: string) => Uint8Array | null,
): HarnessStamp {
  const files: Record<string, string> = {};
  for (const rel of Object.keys(OSWORLD_HARNESS.files)) {
    const bytes = readFile(rel);
    if (bytes !== null) files[rel] = sha256Hex(bytes);
  }
  return { repo: OSWORLD_HARNESS.repo, commit, files };
}

/** Codes for every way a stamp differs from the pinned harness; empty when it matches. */
export function harnessStampProblems(stamp: HarnessStamp): string[] {
  const out: string[] = [];
  if (stamp.repo !== OSWORLD_HARNESS.repo) out.push("HARNESS_REPO_MISMATCH");
  if (stamp.commit !== OSWORLD_HARNESS.commit) out.push("HARNESS_COMMIT_MISMATCH");
  for (const [rel, upstreamDigest] of Object.entries(OSWORLD_HARNESS.files)) {
    // Every arm runs the runner with the documented gate-hook patch applied, nothing else.
    const digest =
      rel === OSWORLD_HARNESS.agentRunner
        ? OSWORLD_HARNESS.patchedAgentRunnerSha256
        : upstreamDigest;
    const got = stamp.files[rel];
    if (got === undefined) out.push(`HARNESS_FILE_MISSING:${rel}`);
    else if (got !== digest) out.push(`HARNESS_FILE_MODIFIED:${rel}`);
  }
  return out;
}

const SCORE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

function lastActionOf(trajJsonl: string | null): string | null {
  if (trajJsonl === null) return null;
  const lines = trajJsonl.split("\n").filter((l) => l.trim().length > 0);
  const last = lines.at(-1);
  if (last === undefined) return null;
  try {
    const action = (JSON.parse(last) as { action?: unknown }).action;
    if (typeof action === "string") return action.split("\n")[0] ?? "";
    if (action && typeof action === "object") {
      const type = (action as { action_type?: unknown }).action_type;
      if (typeof type === "string") return type;
      const command = (action as { command?: unknown }).command;
      if (typeof command === "string") return command.split("\n")[0] ?? "";
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Grade one example from what OSWorld's runner wrote into its example result directory.
 * `files` holds the raw text of `result.txt` and `traj.jsonl` (null when absent).
 */
export function gradeR1Example(input: {
  readonly taskId: string;
  readonly stamp: HarnessStamp;
  readonly files: { readonly resultTxt: string | null; readonly trajJsonl: string | null };
}): R1ExampleGrade {
  const base = {
    graderVersion: OSWORLD_EVALUATE_GRADER,
    taskId: input.taskId,
    lastAction: lastActionOf(input.files.trajJsonl),
  } as const;
  const harness = harnessStampProblems(input.stamp);
  if (harness.length > 0)
    return { ...base, status: "ungradable", upstreamScore: null, codes: harness };
  const raw = input.files.resultTxt;
  if (raw === null)
    return { ...base, status: "ungradable", upstreamScore: null, codes: ["RESULT_MISSING"] };
  const text = raw.trim();
  const score = SCORE.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(score))
    return { ...base, status: "ungradable", upstreamScore: null, codes: ["RESULT_UNPARSEABLE"] };
  return score === R1_PASS_SCORE
    ? { ...base, status: "pass", upstreamScore: score, codes: ["UPSTREAM_EVALUATE_PASS"] }
    : { ...base, status: "fail", upstreamScore: score, codes: ["UPSTREAM_EVALUATE_FAIL"] };
}

/** The same, reading `result.txt` and `traj.jsonl` from an example result directory. */
export function gradeR1ExampleDir(
  dir: string,
  taskId: string,
  stamp: HarnessStamp,
): R1ExampleGrade {
  const read = (name: string) => {
    const p = join(dir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  return gradeR1Example({
    taskId,
    stamp,
    files: { resultTxt: read("result.txt"), trajJsonl: read("traj.jsonl") },
  });
}
