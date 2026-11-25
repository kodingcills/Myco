/**
 * Validate live run artifacts against the schemas (same validator CI uses).
 *
 * Usage: tsx src/integration/validate-live.ts [runsDir] [--expect N]
 *
 * The argument may be any root: a single run dir, `runs/`, a sweep OUT,
 * `$OUT/runs/<index>`, or a `--mode values` tree. The tool walks it
 * recursively; a "run directory" is any directory containing `result.json`
 * or `trace.jsonl` (it does not descend further into a run directory).
 * Layouts covered: `runs/<runId>/`, `runs/<index>/<runId>/`,
 * `values/<runId>/`, and an OUT root above any of those.
 *
 * Output (unchanged on success):
 *   `validated N result.json + M trace events in <dir>: ALL OK` and exit 0.
 *
 * Behaviour changes (TIF-223). Each case exits 1 and the summary line
 * reports it as a failure instead of `ALL OK`:
 *   - zero run directories found. Before, this printed `ALL OK` and exited 0.
 *   - a run directory holding only one of `result.json` / `trace.jsonl`
 *     (`INCOMPLETE run dir <path>: missing <file>` on stderr). Before, a
 *     directory without `trace.jsonl` was skipped silently.
 *   - `--expect N` given and the number of run directories found is not N
 *     (`EXPECTED N run dirs, found M` on stderr).
 * A malformed `--expect` value or an unreadable root exits 2.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** Every run directory under root (root included), sorted for stable output. */
function findRunDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (existsSync(join(dir, "result.json")) || existsSync(join(dir, "trace.jsonl"))) {
      found.push(dir);
      return;
    }
    const children = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
    for (const name of children) walk(join(dir, name));
  };
  walk(root);
  return found;
}

const runDirs = findRunDirs(runsDir);
let failures = 0;
let traces = 0;
let results = 0;
for (const runDir of runDirs) {
  const label = relative(runsDir, runDir) || ".";
  const tracePath = join(runDir, "trace.jsonl");
  const resultPath = join(runDir, "result.json");
  const missing = [tracePath, resultPath].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    failures++;
    for (const p of missing)
      process.stderr.write(`INCOMPLETE run dir ${runDir}: missing ${relative(runDir, p)}\n`);
    continue;
  }
  for (const [i, line] of readFileSync(tracePath, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .entries()) {
    const issues = validateSchema(JSON.parse(line), traceEventSchema);
    traces++;
    if (issues.length > 0) {
      failures++;
      process.stderr.write(`INVALID trace ${label}[${i}]: ${JSON.stringify(issues)}\n`);
    }
  }
  const issues = validateSchema(JSON.parse(readFileSync(resultPath, "utf8")), resultRecordSchema);
  results++;
  if (issues.length > 0) {
    failures++;
    process.stderr.write(`INVALID result ${label}: ${JSON.stringify(issues)}\n`);
  }
}
if (runDirs.length === 0) {
  failures++;
  process.stderr.write(
    `NO RUN DIRS under ${runsDir}: no directory contains result.json or trace.jsonl\n`,
  );
}
if (expect !== undefined && runDirs.length !== expect) {
  failures++;
  process.stderr.write(`EXPECTED ${expect} run dirs, found ${runDirs.length} under ${runsDir}\n`);
}
process.stdout.write(
  `validated ${results} result.json + ${traces} trace events in ${runsDir}: ${failures === 0 ? "ALL OK" : `${failures} FAILURES`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
