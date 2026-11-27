/**
 * Track Q (replayable proof): a bundle's input (`ProofRunInput`) from an R1 pilot run directory
 * (#674). The first writer of `RUN.json` that reads what a real run leaves on disk, so the Q1
 * integrity bar ("100% of bundles from the measurement run verify") can be measured on real
 * runs once they exist. This module only READS the run directory; it changes no runner file,
 * and `writePilotBundle` refuses an output path inside the run directory or its external
 * anchor directory (`assertPilotOutside`), so `export-pilot` has no write path into either.
 * `trials/`, `trials/<trialKey>/`, the progress ledger and #518's ledger must not be symlinks.
 *
 * The run directory is the R1 pilot's `--out`, or one corrections A/B arm directory (the same
 * runner writes both). Read, for one trial key:
 *
 *  - `pilot-progress.jsonl` (`src/pilot/ledger.ts`, read with its own `loadLedger`): the
 *    header's `simulated` flag, the trial's start line (task id, run id) and its end line with
 *    the arm row (arm, `persistedSha256`). An open attempt (no end), an end without an arm row
 *    (a crash closure) or an arm row for another trial or task is refused.
 *  - the `SIMULATED` marker file: if present, the run is simulated whatever the header says
 *    (fail toward "never evidence").
 *  - `trials/<trialKey>/gate-tasks.json` (the gate registry the harness wrote for the trial)
 *    and `trials/<trialKey>/doc.csv` (the document captured after stop, the bytes the grader
 *    reads): evidence records, by digest only, with their paths relative to the trial
 *    directory, so `verify --evidence-dir <run>/trials/<trialKey>` re-checks the files.
 *    `doc.csv` must hash to the arm row's `persistedSha256`, and must be absent when that is
 *    null. Each must be a regular file (a symlink is refused).
 *  - `attempts.jsonl` (#518), when present: the ledger, with the head taken from its EXTERNAL
 *    anchor (`anchorPathFor`, outside the run directory), checked by #518's own `verifyAnchor`.
 *    A ledger with no anchor, or one that disagrees with it, is refused. The R1 pilot alone
 *    does not write #518's ledger (only the A/B arm directories do), so its bundles carry none.
 *
 * NOT carried: a verdict record. The runner records the gate's verdict on the arm row but not
 * the reason codes, evidence refs or oracle of its post-stop check, and a Q verdict record needs
 * them (`verified` requires `ORACLE_PASS`). Codes are never inferred or invented, so a bundle
 * from a pilot directory has no verdict record until the runner persists the gate result per
 * trial (a change to `src/pilot/runner.ts`, the critical path: #674's follow-up for its owner).
 * `pilotProofInput` reports this as `verdictCarried: false`.
 *
 * Every refusal is a `ProofExportError` with a code and a structural message: never a path, a
 * key or a value from the directory (the loader's own errors, which quote the path, are
 * replaced).
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { anchorPathFor, type LedgerHead, verifyAnchor } from "../m2/attempt-ledger.ts";
import {
  type AttemptRecord,
  type LedgerState,
  loadLedger,
  PROGRESS_FILE,
} from "../pilot/ledger.ts";
import { SIMULATED_FILE } from "../pilot/runner.ts";
import { ProofExportError, type ProofRunInput, type ProofStep } from "./bundle.ts";
import { CLOSED_ID } from "./closed.ts";
import { parseLedgerJsonl, sha256Hex, verifyLedgerChain } from "./ledger.ts";

/** The #518 ledger file of an arm directory (`R1AttemptSink`, `src/pilot/ab.ts`). */
export const PILOT_ATTEMPTS_FILE = "attempts.jsonl";
/** The gate registry the runner writes into each trial directory. */
export const PILOT_GATE_TASKS_FILE = "gate-tasks.json";
/** The captured document the runner writes into each trial directory (`GATE_STATE_FILE`). */
export const PILOT_DOC_FILE = "doc.csv";

/** Closed evidence ids and kinds of a pilot bundle (constants of this code, not run values). */
export const PILOT_EVIDENCE = {
  gateTasks: { evidenceId: "gate-tasks", evidenceKind: "gate-registry" },
  doc: { evidenceId: "persisted-doc", evidenceKind: "persisted-document" },
} as const;

export interface PilotProofInput {
  readonly input: ProofRunInput;
  /** Where `verify --evidence-dir` re-checks this bundle's evidence: the trial directory. */
  readonly evidenceDir: string;
  /** Always false today: the runner does not persist the gate's reason codes (see header). */
  readonly verdictCarried: false;
}

const fail = (code: string, message: string): never => {
  throw new ProofExportError(code, message);
};

/** Whether a directory entry exists at `path` (a symlink counts, even a dangling one). */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Refuse `path` when it is a symlink (dangling or not); absent is allowed. */
function refuseSymlink(path: string, code: string, what: string): void {
  if (entryExists(path) && lstatSync(path).isSymbolicLink()) fail(code, `${what} is a symlink`);
}

/**
 * The real path of `p`: symlinks followed on its longest existing prefix, the rest (the parts
 * that do not exist yet, which a write would create) appended as given.
 */
function realOf(p: string): string {
  let at = resolve(p);
  const rest: string[] = [];
  while (!existsSync(at) && dirname(at) !== at) {
    rest.unshift(basename(at));
    at = dirname(at);
  }
  return join(existsSync(at) ? realpathSync.native(at) : at, ...rest);
}

function isInside(target: string, root: string): boolean {
  const rel = relative(realOf(root), realOf(target));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Refuse an output path that would write into the run: inside `runDir` or inside the directory
 * of its external #518 anchor (both as given and as resolved), symlinks followed on the path's
 * existing prefix. A symlink at the output path itself is refused outright (a dangling one
 * would otherwise create its target). `export-pilot` never writes into what it reads.
 */
export function assertPilotOutside(runDir: string, out: string): void {
  refuseSymlink(out, "PROOF_PILOT_OUT", "the output path");
  const roots = [runDir, dirname(anchorPathFor(runDir)), dirname(anchorPathFor(realOf(runDir)))];
  for (const root of roots)
    if (isInside(out, root)) fail("PROOF_PILOT_OUT", "the output path is inside the run");
}

/**
 * Write a pilot bundle to `out` after `assertPilotOutside`, through a temporary file in the
 * same directory and a rename: the rename replaces the directory entry, so an existing `out`
 * that is a hard link to a run file is unlinked, never written through.
 */
export function writePilotBundle(runDir: string, out: string, text: string): void {
  assertPilotOutside(runDir, out);
  const temp = join(dirname(resolve(out)), `.${basename(out)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, text, { flag: "wx" });
    renameSync(temp, out);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The bytes of a regular file under the trial directory, or null when it is absent. */
function regularFile(path: string, name: string): Uint8Array | null {
  if (!existsSync(path)) {
    // `existsSync` follows links: a dangling symlink reads as absent, so look at the link too.
    try {
      lstatSync(path);
    } catch {
      return null;
    }
    return fail("PROOF_PILOT_EVIDENCE", `${name} is not a regular file`);
  }
  if (!lstatSync(path).isFile()) fail("PROOF_PILOT_EVIDENCE", `${name} is not a regular file`);
  return new Uint8Array(readFileSync(path));
}

function loadProgress(runDir: string): LedgerState {
  const path = join(runDir, PROGRESS_FILE);
  refuseSymlink(path, "PROOF_PILOT_PROGRESS", "the progress ledger");
  if (!existsSync(path)) return fail("PROOF_PILOT_PROGRESS", "the run has no progress ledger");
  try {
    return loadLedger(path);
  } catch {
    // The loader's message quotes the path and line: never passed on.
    return fail("PROOF_PILOT_PROGRESS", "the progress ledger does not load");
  }
}

function findAttempt(state: LedgerState, trialKey: string): AttemptRecord {
  const found: AttemptRecord[] = [];
  for (const list of state.byTask.values())
    for (const r of list) if (r.start.trialKey === trialKey) found.push(r);
  if (found.length !== 1)
    fail("PROOF_PILOT_TRIAL", `the trial key is in the progress ledger ${found.length} times`);
  return found[0] as AttemptRecord;
}

function readJsonlLines(path: string, code: string, what: string): unknown[] {
  const parsed = parseLedgerJsonl(readFileSync(path, "utf8"));
  if (parsed.errors.length > 0) fail(code, `${what} has a line that is not JSON`);
  return parsed.lines;
}

/** #518's ledger and its external anchor's last head, or undefined when there is no ledger. */
function loadAttemptLedger(
  runDir: string,
  trialKey: string,
): { lines: unknown[]; head: LedgerHead; trialKey: string } | undefined {
  const path = join(runDir, PILOT_ATTEMPTS_FILE);
  if (!entryExists(path)) return undefined;
  // A symlink (even a dangling one, which `existsSync` would read as "no ledger") is refused.
  if (!lstatSync(path).isFile())
    fail("PROOF_LEDGER_CHAIN", "the attempt ledger is not a regular file");
  const lines = readJsonlLines(path, "PROOF_LEDGER_CHAIN", "the attempt ledger");
  const anchorPath = anchorPathFor(runDir);
  if (!existsSync(anchorPath))
    return fail("PROOF_LEDGER_ANCHOR", "the attempt ledger has no external anchor");
  const anchor = readJsonlLines(anchorPath, "PROOF_LEDGER_ANCHOR", "the external anchor");
  const { events, errors } = verifyLedgerChain(lines);
  if (errors.length > 0) fail("PROOF_LEDGER_CHAIN", errors.join("; "));
  // #518's messages may quote a value: only their count is passed on.
  const anchorErrors = verifyAnchor(anchor, events, undefined);
  if (anchorErrors.length > 0)
    fail(
      "PROOF_LEDGER_ANCHOR",
      `the attempt ledger disagrees with its external anchor (${anchorErrors.length} issues)`,
    );
  const last = anchor.at(-1) as LedgerHead;
  return { lines, head: { events: last.events, headSha256: last.headSha256 }, trialKey };
}

/**
 * Build the `ProofRunInput` of one trial of a pilot run directory (see the header). The result
 * goes through `exportProofBundle` like any `RUN.json`: the allowlist, the identity guard and
 * the self-verify all still apply.
 */
export function pilotProofInput(runDir: string, trialKey: string): PilotProofInput {
  // The trial key names a directory: only a closed id (no separator, no `..`) is joined.
  if (!CLOSED_ID.test(trialKey)) fail("PROOF_PILOT_TRIAL", "the trial key is not a closed id");
  const state = loadProgress(runDir);
  if (state.header === null) fail("PROOF_PILOT_PROGRESS", "the progress ledger has no header");
  const record = findAttempt(state, trialKey);
  const end = record.end;
  if (end === null) return fail("PROOF_PILOT_OPEN", "the trial has no end (still open)");
  const row = end.armRow;
  if (row === null) return fail("PROOF_PILOT_OPEN", "the trial's end has no arm row");
  if (row.trialKey !== trialKey || row.taskId !== record.start.taskId)
    fail("PROOF_PILOT_MISMATCH", "the arm row is not this trial's");

  const trialDir = join(runDir, "trials", trialKey);
  // The evidence files are read through these directories: neither may be a symlink.
  refuseSymlink(join(runDir, "trials"), "PROOF_PILOT_EVIDENCE", "the trials directory");
  refuseSymlink(trialDir, "PROOF_PILOT_EVIDENCE", "the trial directory");
  const steps: ProofStep[] = [];
  const gateTasks = regularFile(join(trialDir, PILOT_GATE_TASKS_FILE), PILOT_GATE_TASKS_FILE);
  if (gateTasks !== null)
    steps.push({
      kind: "evidence",
      ...PILOT_EVIDENCE.gateTasks,
      mediaType: "application/json",
      path: PILOT_GATE_TASKS_FILE,
      content: gateTasks,
    });
  const doc = regularFile(join(trialDir, PILOT_DOC_FILE), PILOT_DOC_FILE);
  if (row.persistedSha256 === null) {
    if (doc !== null)
      fail("PROOF_PILOT_EVIDENCE", "a document is on disk but the arm row recorded none");
  } else {
    if (doc === null)
      return fail("PROOF_PILOT_EVIDENCE", "the arm row recorded a document that is not on disk");
    // Hash here (not only in the bundle), so a swapped file is refused before export.
    if (sha256Hex(doc) !== row.persistedSha256)
      fail("PROOF_PILOT_EVIDENCE", "the document on disk is not the one the arm row recorded");
    steps.push({
      kind: "evidence",
      ...PILOT_EVIDENCE.doc,
      mediaType: "text/csv",
      path: PILOT_DOC_FILE,
      content: doc,
    });
  }
  if (steps.length === 0) fail("PROOF_PILOT_EVIDENCE", "the trial directory holds no evidence");

  const simulated =
    // Any entry counts as the marker, even a dangling symlink (fail toward "never evidence").
    (state.header as { simulated: boolean }).simulated || entryExists(join(runDir, SIMULATED_FILE));
  const ledger = loadAttemptLedger(runDir, trialKey);
  return {
    input: {
      runId: record.start.runId,
      taskId: record.start.taskId,
      arm: row.arm,
      simulated,
      steps,
      ...(ledger === undefined ? {} : { ledger }),
    },
    evidenceDir: trialDir,
    verdictCarried: false,
  };
}
