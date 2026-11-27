/**
 * Track J, pre-registration j-v1: the pack writer (non-VM, no model).
 *
 * A j-v1 pack is one directory:
 *
 * - `pack.json`: the header. It records the pre-registration hash and the commit on `main`
 *   that froze it (capability spec §3 item 2), the analysis script's SHA-256, the number of
 *   scheduled trials and the SHA-256 of the schedule itself.
 * - `rows.jsonl`: one `myco.capability.j-v1.trial/1` row per line, in `jV1Schedule` order.
 *   The writer accepts a row only if it is the next scheduled trial (seq, task, arm), so
 *   every scheduled trial is written exactly once and in the seeded order.
 * - `halted.json`: present when the run halted. A trial runner that throws, or a row that does
 *   not fit the schedule, halts the pack; a halted pack takes no more rows, so no trial is
 *   silently re-run (j-v1's retry budget is 0). What happens next is the lead's call.
 * - `analysis.json`: written once by `finalizeJV1Pack`, the frozen `analyzeJV1` result.
 *
 * The frozen analysis script checks only the form of the frozen-in commit; this module has git
 * and checks the rest (`verifyJV1FrozenCommit`): the commit exists, is on the main ref, and its
 * `prereg.json` hashes to the pre-registration hash the pack records.
 *
 * Errors carry codes only (`JV1PackError.code`), never paths or row contents.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  analyzeJV1,
  canonicalJson,
  J_V1_TRIAL_SCHEMA,
  type JScheduledTrial,
  type JTrialRow,
  type JV1Result,
  preregHash,
} from "./j-v1-analysis.ts";
import { J_V1_PREREG_PATH, jV1Schedule, loadJV1Prereg } from "./j-v1-harness.ts";

export const J_V1_PACK_SCHEMA = "myco.capability.j-v1.pack/1" as const;
export const J_V1_HALT_SCHEMA = "myco.capability.j-v1.halt/1" as const;
export const J_V1_PACK_FILES = {
  header: "pack.json",
  rows: "rows.jsonl",
  halted: "halted.json",
  analysis: "analysis.json",
} as const;

/** Codes-only failure. */
export class JV1PackError extends Error {
  constructor(readonly code: string) {
    super(`j-v1 pack: ${code}`);
    this.name = "JV1PackError";
  }
}

export interface JV1PackHeader {
  readonly schema: typeof J_V1_PACK_SCHEMA;
  readonly version: "j-v1";
  readonly preregPath: typeof J_V1_PREREG_PATH;
  readonly preregHash: string;
  readonly preregCommit: string;
  readonly analysisSha256: string;
  readonly trials: number;
  readonly scheduleSha256: string;
}

export type JV1HaltCode = "TRIAL_THREW" | "ROW_REFUSED";

export interface JV1Halt {
  readonly schema: typeof J_V1_HALT_SCHEMA;
  readonly seq: number;
  readonly taskId: string;
  readonly arm: JScheduledTrial["arm"];
  readonly code: JV1HaltCode;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function gitOk(repoRoot: string, args: readonly string[]): boolean {
  try {
    git(repoRoot, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spec §3 item 2, the part that needs git: the commit a pack names really froze this
 * pre-registration. Returns codes; empty means the commit is good.
 */
export function verifyJV1FrozenCommit(
  repoRoot: string,
  commit: string,
  expectedPreregHash: string,
  mainRef = "origin/main",
): string[] {
  if (!COMMIT_SHA.test(commit)) return ["PACK_COMMIT_FORM"];
  if (mainRef.length === 0 || mainRef.startsWith("-")) return ["PACK_MAIN_REF_UNKNOWN"];
  if (!gitOk(repoRoot, ["cat-file", "-e", `${commit}^{commit}`])) return ["PACK_COMMIT_UNKNOWN"];
  if (!gitOk(repoRoot, ["rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`]))
    return ["PACK_MAIN_REF_UNKNOWN"];
  const problems: string[] = [];
  if (!gitOk(repoRoot, ["merge-base", "--is-ancestor", commit, mainRef]))
    problems.push("PACK_COMMIT_NOT_ON_MAIN");
  let frozen: string | null = null;
  try {
    frozen = git(repoRoot, ["show", `${commit}:${J_V1_PREREG_PATH}`]);
  } catch {
    problems.push("PACK_COMMIT_NO_PREREG");
  }
  if (frozen !== null) {
    let hash: string | null = null;
    try {
      hash = preregHash(JSON.parse(frozen));
    } catch {
      hash = null;
    }
    if (hash !== expectedPreregHash) problems.push("PACK_COMMIT_PREREG_DIFFERS");
  }
  return problems;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function readJson(path: string, code: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new JV1PackError(code);
  }
}

/** Parse rows.jsonl. A last line without its newline is a torn write: refused, never repaired. */
function readRows(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) throw new JV1PackError("PACK_TORN_ROW");
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new JV1PackError("PACK_ROW_UNREADABLE");
      }
    });
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Code when `row` is not the trial `t` (or not a j-v1 trial row at all); null when it fits. */
function misfit(row: unknown, t: JScheduledTrial | undefined): string | null {
  if (t === undefined) return "PACK_COMPLETE";
  if (!isObj(row) || row.schema !== J_V1_TRIAL_SCHEMA) return "PACK_ROW_SCHEMA";
  if (row.seq !== t.seq || row.taskId !== t.taskId || row.arm !== t.arm) return "PACK_OUT_OF_ORDER";
  return null;
}

export interface JV1Pack {
  readonly dir: string;
  readonly header: JV1PackHeader;
  readonly schedule: readonly JScheduledTrial[];
  /** Rows written so far. */
  written(): number;
  /** The next scheduled trial, or null when every trial has a row. */
  next(): JScheduledTrial | null;
  /** Why `row` would be refused as the next row; null when it fits. */
  check(row: JTrialRow): string | null;
  /** Append the next row (fsynced). Throws `JV1PackError` if it does not fit or the pack halted. */
  append(row: JTrialRow): void;
  /** Halt at the next scheduled trial. A halted pack takes no more rows. */
  halt(code: JV1HaltCode): JV1Halt;
}

export interface OpenJV1PackOptions {
  readonly repoRoot: string;
  readonly packDir: string;
  /** The 40-hex commit on `main` that froze j-v1. */
  readonly preregCommit: string;
  readonly mainRef?: string;
}

/**
 * Create a pack, or resume one: a resumed pack must have the same header, must not be halted or
 * finalized, and its rows must be a prefix of the schedule.
 */
export function openJV1Pack(opts: OpenJV1PackOptions): JV1Pack {
  const loaded = loadJV1Prereg(opts.repoRoot);
  const commitProblems = verifyJV1FrozenCommit(
    opts.repoRoot,
    opts.preregCommit,
    loaded.hash,
    opts.mainRef,
  );
  if (commitProblems.length > 0) throw new JV1PackError(commitProblems.join(","));
  const schedule = jV1Schedule(loaded.prereg);
  const header: JV1PackHeader = {
    schema: J_V1_PACK_SCHEMA,
    version: "j-v1",
    preregPath: J_V1_PREREG_PATH,
    preregHash: loaded.hash,
    preregCommit: opts.preregCommit,
    // loadJV1Prereg has already checked this against the analysis script's bytes.
    analysisSha256: (loaded.prereg as unknown as { analysis: { sha256: string } }).analysis.sha256,
    trials: schedule.length,
    scheduleSha256: sha256(canonicalJson(schedule)),
  };
  const dir = opts.packDir;
  const headerPath = join(dir, J_V1_PACK_FILES.header);
  const rowsPath = join(dir, J_V1_PACK_FILES.rows);
  const haltPath = join(dir, J_V1_PACK_FILES.halted);
  mkdirSync(dir, { recursive: true });
  if (existsSync(headerPath)) {
    const existing = readJson(headerPath, "PACK_HEADER_UNREADABLE");
    if (canonicalJson(existing) !== canonicalJson(header))
      throw new JV1PackError("PACK_HEADER_MISMATCH");
    if (existsSync(haltPath)) throw new JV1PackError("PACK_HALTED");
    if (existsSync(join(dir, J_V1_PACK_FILES.analysis))) throw new JV1PackError("PACK_FINALIZED");
    if (!existsSync(rowsPath)) throw new JV1PackError("PACK_ROWS_MISSING");
  } else {
    if (readdirSync(dir).length > 0) throw new JV1PackError("PACK_DIR_NOT_EMPTY");
    writeFileSync(headerPath, `${JSON.stringify(header, null, 2)}\n`, { flag: "wx" });
    writeFileSync(rowsPath, "", { flag: "wx" });
  }
  const rows = readRows(rowsPath);
  rows.forEach((row, i) => {
    const problem = misfit(row, schedule[i]);
    if (problem !== null)
      throw new JV1PackError(problem === "PACK_COMPLETE" ? "PACK_OUT_OF_ORDER" : problem);
  });
  let written = rows.length;
  let halted = false;

  const pack: JV1Pack = {
    dir,
    header,
    schedule,
    written: () => written,
    next: () => schedule[written] ?? null,
    check: (row) => (halted ? "PACK_HALTED" : misfit(row, schedule[written])),
    append(row) {
      const problem = pack.check(row);
      if (problem !== null) throw new JV1PackError(problem);
      const fd = openSync(rowsPath, "a");
      try {
        writeSync(fd, `${JSON.stringify(row)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      written += 1;
    },
    halt(code) {
      const t = schedule[written];
      if (t === undefined) throw new JV1PackError("PACK_COMPLETE");
      if (halted) throw new JV1PackError("PACK_HALTED");
      const record: JV1Halt = {
        schema: J_V1_HALT_SCHEMA,
        seq: t.seq,
        taskId: t.taskId,
        arm: t.arm,
        code,
      };
      writeFileSync(haltPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
      halted = true;
      return record;
    },
  };
  return pack;
}

/** Runs one scheduled trial and returns its analysis row. A harness fault is a row, not a throw. */
export type JV1TrialRunner = (trial: JScheduledTrial) => Promise<JTrialRow>;

export type JV1RunOutcome =
  | { readonly status: "complete"; readonly trials: number }
  | { readonly status: "halted"; readonly halt: JV1Halt };

/**
 * The j-v1 loop: next scheduled trial, run it, append its row, until the schedule is done.
 * A runner that throws, or returns a row that does not fit, halts the pack at that trial.
 */
export async function runJV1(pack: JV1Pack, runTrial: JV1TrialRunner): Promise<JV1RunOutcome> {
  for (let t = pack.next(); t !== null; t = pack.next()) {
    let row: JTrialRow;
    try {
      row = await runTrial(t);
    } catch {
      return { status: "halted", halt: pack.halt("TRIAL_THREW") };
    }
    if (pack.check(row) !== null) return { status: "halted", halt: pack.halt("ROW_REFUSED") };
    pack.append(row);
  }
  return { status: "complete", trials: pack.written() };
}

export interface FinalizeJV1PackOptions {
  readonly repoRoot: string;
  readonly packDir: string;
  readonly mainRef?: string;
}

/**
 * Re-check the frozen-in commit against the pack's recorded hash, run the frozen `analyzeJV1`
 * on the pack, and write `analysis.json` once. A halted, torn or already-finalized pack is
 * refused; an incomplete or mis-ordered one is the analysis's to refuse (`not-shown`).
 */
export function finalizeJV1Pack(opts: FinalizeJV1PackOptions): JV1Result {
  const dir = opts.packDir;
  const headerPath = join(dir, J_V1_PACK_FILES.header);
  if (!existsSync(headerPath)) throw new JV1PackError("PACK_HEADER_MISSING");
  if (existsSync(join(dir, J_V1_PACK_FILES.halted))) throw new JV1PackError("PACK_HALTED");
  const analysisPath = join(dir, J_V1_PACK_FILES.analysis);
  if (existsSync(analysisPath)) throw new JV1PackError("PACK_FINALIZED");
  const header = readJson(headerPath, "PACK_HEADER_UNREADABLE");
  if (
    !isObj(header) ||
    header.schema !== J_V1_PACK_SCHEMA ||
    typeof header.preregHash !== "string" ||
    typeof header.preregCommit !== "string"
  )
    throw new JV1PackError("PACK_HEADER_UNREADABLE");
  const commitProblems = verifyJV1FrozenCommit(
    opts.repoRoot,
    header.preregCommit,
    header.preregHash,
    opts.mainRef,
  );
  if (commitProblems.length > 0) throw new JV1PackError(commitProblems.join(","));
  const rows = readRows(join(dir, J_V1_PACK_FILES.rows));
  // loadJV1Prereg refuses a prereg.json whose analysis script no longer hashes as frozen.
  const { prereg } = loadJV1Prereg(opts.repoRoot);
  const result = analyzeJV1({
    prereg,
    packPreregHash: header.preregHash,
    packPreregCommit: header.preregCommit,
    rows,
  });
  writeFileSync(analysisPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}
