/**
 * Validate live run artifacts against the schemas (same validator CI uses).
 *
 * Usage: tsx src/integration/validate-live.ts [runsDir] [--expect N]
 *
 * The argument may be any root: a single run dir, `runs/`, a sweep OUT,
 * `$OUT/runs/<index>`, or a `--mode values` tree. The tool walks the WHOLE
 * tree. A directory holding an entry named `result.json` or `trace.jsonl`
 * holds run files. Layouts covered: `runs/<runId>/`, `runs/<index>/<runId>/`,
 * `values/<runId>/`, and an OUT root above any of those.
 *
 * What counts as a run directory (TIF-226):
 *   - A directory holding run files with no run files anywhere below it is a
 *     run directory. Each one is validated and counted (`--expect` compares
 *     against this count).
 *   - Run files at several levels are ambiguous: a directory holding run files
 *     that also has run files below it (a stray `result.json` at the top of
 *     `$OUT`, or a run nested inside a run) is reported as
 *     `AMBIGUOUS run dir <path>: ...` and is a failure. Its own files are not
 *     counted; every run directory below it is still found and validated.
 *   - Symlinks are refused, never followed (a link can point outside the tree
 *     or loop). Each one is reported as `REFUSED symlink <path>: ...` and is a
 *     failure; pass the link target directly to validate it. The root argument
 *     itself may be a symlink.
 *   - Hidden directories are walked like any other, so a run under `.old/` is
 *     validated (and counted) instead of skipped.
 *   - Any other entry type (socket, FIFO, device) is reported as
 *     `SKIPPED <path>: ...` on stderr. Nothing is skipped silently.
 *
 * Output (unchanged on success):
 *   `validated N result.json + M trace events in <dir>: ALL OK` and exit 0.
 * The summary line is always printed; on any failure it ends `K FAILURES` and
 * the exit code is 1. Failures, each named per path on stderr:
 *   - zero run directories found (`NO RUN DIRS ...`).
 *   - a run directory holding only one of `result.json` / `trace.jsonl`
 *     (`INCOMPLETE run dir <path>: missing <file>`).
 *   - `--expect N` given and the run directory count is not N
 *     (`EXPECTED N run dirs, found M`).
 *   - AMBIGUOUS run dirs and REFUSED symlinks (above).
 *   - an unreadable directory or file, or a run file that is not a regular
 *     file, e.g. a `result.json` directory (`UNREADABLE <path>: <reason>`).
 *   - malformed JSON (`MALFORMED result <run>` / `MALFORMED trace <run>[i]`).
 *   - a schema-invalid record (`INVALID result ...` / `INVALID trace ...`).
 * A malformed `--expect` value or a root that is not a directory exits 2.
 */
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { validateSchema } from "../../schemas/validate.ts";

function usage(message: string): never {
  process.stderr.write(`validate-live: ${message}\n`);
  process.stderr.write("usage: tsx src/integration/validate-live.ts [runsDir] [--expect N]\n");
  process.exit(2);
}

let runsDir: string | undefined;
let expect: number | undefined;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i] as string;
  if (arg === "--expect" || arg.startsWith("--expect=")) {
    const raw = arg === "--expect" ? argv[++i] : arg.slice("--expect=".length);
    if (raw === undefined || !/^\d+$/.test(raw))
      usage(`--expect needs a non-negative integer, got ${raw ?? "nothing"}`);
    expect = Number(raw);
  } else if (arg.startsWith("--")) {
    usage(`unknown option ${arg}`);
  } else if (runsDir === undefined) {
    runsDir = arg;
  } else {
    usage(`unexpected extra argument ${arg}`);
  }
}
runsDir ??= "runs/live-m1-013";
if (!existsSync(runsDir) || !statSync(runsDir).isDirectory()) usage(`not a directory: ${runsDir}`);

const RUN_FILES = ["trace.jsonl", "result.json"] as const;
let failures = 0;
function fail(message: string): void {
  failures++;
  process.stderr.write(`${message}\n`);
}
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every run directory under root (root included), sorted for stable output.
 * Walks the whole tree; reports AMBIGUOUS, REFUSED, UNREADABLE and SKIPPED
 * paths as it goes.
 */
function findRunDirs(root: string): string[] {
  const found: string[] = [];
  /** Returns true when dir or anything below it holds run files. */
  const walk = (dir: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      fail(`UNREADABLE dir ${dir}: ${reason(err)}`);
      return false;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const here = entries.filter((e) => (RUN_FILES as readonly string[]).includes(e.name));
    const foundBefore = found.length;
    let below = false;
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isSymbolicLink()) {
        fail(`REFUSED symlink ${path}: symlinks are not followed; pass the target directly`);
      } else if (e.isDirectory()) {
        // A directory named result.json / trace.jsonl is a broken run file,
        // reported when the run is validated; do not walk into it.
        if (!here.includes(e)) below = walk(path) || below;
      } else if (!e.isFile()) {
        process.stderr.write(`SKIPPED ${path}: not a regular file or directory\n`);
      }
    }
    if (here.length > 0) {
      if (below) {
        const nested = found.slice(foundBefore).map((d) => relative(dir, d));
        fail(
          `AMBIGUOUS run dir ${dir}: holds ${here.map((e) => e.name).join(" + ")} and run files below it` +
            ` (${nested.length > 0 ? nested.join(", ") : "see errors above"});` +
            " the nested run dirs are validated, the files at this level are not counted",
        );
      } else {
        found.splice(foundBefore, 0, dir);
      }
    }
    return here.length > 0 || below;
  };
  walk(root);
  return found;
}

/** A run file's text, or undefined after reporting why it cannot be read. */
function readRunFile(path: string): string | undefined {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return undefined; // already REFUSED by the walk
    if (!st.isFile()) {
      fail(`UNREADABLE ${path}: not a regular file`);
      return undefined;
    }
    return readFileSync(path, "utf8");
  } catch (err) {
    fail(`UNREADABLE ${path}: ${reason(err)}`);
    return undefined;
  }
}

const runDirs = findRunDirs(runsDir);
let traces = 0;
let results = 0;
for (const runDir of runDirs) {
  const label = relative(runsDir, runDir) || ".";
  const tracePath = join(runDir, "trace.jsonl");
  const resultPath = join(runDir, "result.json");
  const missing = [tracePath, resultPath].filter((p) => {
    try {
      lstatSync(p);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    for (const p of missing) fail(`INCOMPLETE run dir ${runDir}: missing ${relative(runDir, p)}`);
    continue;
  }
  const traceText = readRunFile(tracePath);
  if (traceText !== undefined) {
    for (const [i, line] of traceText
      .split("\n")
      .filter((l) => l !== "")
      .entries()) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (err) {
        fail(`MALFORMED trace ${label}[${i}]: ${reason(err)}`);
        continue;
      }
      const issues = validateSchema(event, traceEventSchema);
      traces++;
      if (issues.length > 0) fail(`INVALID trace ${label}[${i}]: ${JSON.stringify(issues)}`);
    }
  }
  const resultText = readRunFile(resultPath);
  if (resultText !== undefined) {
    let record: unknown;
    try {
      record = JSON.parse(resultText);
    } catch (err) {
      fail(`MALFORMED result ${label}: ${reason(err)}`);
      continue;
    }
    const issues = validateSchema(record, resultRecordSchema);
    results++;
    if (issues.length > 0) fail(`INVALID result ${label}: ${JSON.stringify(issues)}`);
  }
}
if (runDirs.length === 0)
  fail(`NO RUN DIRS under ${runsDir}: no directory contains result.json or trace.jsonl`);
if (expect !== undefined && runDirs.length !== expect)
  fail(`EXPECTED ${expect} run dirs, found ${runDirs.length} under ${runsDir}`);
process.stdout.write(
  `validated ${results} result.json + ${traces} trace events in ${runsDir}: ${failures === 0 ? "ALL OK" : `${failures} FAILURES`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
