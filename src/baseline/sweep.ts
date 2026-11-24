import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { groundTruth } from "../tasks/intent.ts";
import { type PreparedC1, RESET_SNAPSHOT, runC1Trial, STEP_BUDGET } from "./c1-trial.ts";
import { type BaselineRow, isBaselineRow } from "./index.ts";
import {
  createPlanner,
  MAX_CALL_MICROS,
  MAX_OUTPUT,
  type Planner,
  PlannerFailure,
} from "./planner.ts";
import manifest from "./sweep-v3.json" with { type: "json" };

const COMBINED_LIMIT = 9_000_000;
const DEFAULT_ARM_LIMIT = 4_500_000;
const MAX_TRIAL_MICROS = STEP_BUDGET * MAX_CALL_MICROS;
const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

type Omission =
  | "trial-interrupted"
  | "spend-limit"
  | "driver-unreachable"
  | "planner-failed"
  | "repeated-cause";

type Entry =
  | { status: "reserved"; micros: number }
  | { status: "omitted"; micros: number; reason: Omission; detail?: string }
  | { status: "scored"; micros: number; row: BaselineRow };

/**
 * What a resume must match before it may continue a run.
 *
 * A resume is only sound if it is the SAME experiment: same task set, same model,
 * same starting snapshot. Any difference means the two halves measure different
 * things and the combined 30-row artifact would be a blend that looks like one
 * run. Recording this at run creation is what makes the check possible later -
 * a ledger that does not say which model produced its rows cannot be safely
 * extended by a different one.
 */
interface RunIdentity {
  model: string;
  snapshot: string;
  /** `paid` or `stub`, so a stub arm cannot be resumed with a paid planner. */
  planner: string;
  /**
   * Set only when the identity was ASSERTED at resume time for a ledger written
   * before identity recording existed. Absent means it was captured at run time.
   * Kept because the two are not equally strong evidence.
   */
  adopted?: boolean;
  /**
   * When each scored cause was accepted, in order.
   *
   * A HISTORY rather than a flat list, because an acceptance is not always in
   * force for the whole arm. r6's first rows ran with none; the operator accepted
   * `refuted:step-budget` only when resuming. Recording that as a single list
   * would claim the earlier rows were covered by a decision that had not been
   * made yet - the ledger would rewrite history to make the arm look uniform.
   *
   * `fromTrial` is the first manifest index the acceptance applied to.
   */
  acceptances?: readonly { causes: readonly string[]; fromTrial: number }[];
}
interface Ledger {
  manifestSha256: string;
  identity?: RunIdentity;
  c1: Record<string, Entry>;
  c2: Record<string, Entry>;
}

/** The omissions that a resume MAY re-attempt, and those it must not. */
/**
 * Omissions a resume may RE-ATTEMPT: the ones where the HARNESS lost the trial.
 *
 * `trial-interrupted` means the process or the guest died mid-trial.
 *
 * `planner-failed` means the PROVIDER gave us something unusable - a truncation, a
 * refusal, a rejected call - which TIF-200 classifies as a harness/config fault. r6 is
 * the case that exposed the omission: it stopped with 10 `planner-failed` rows, and a
 * resume could re-attempt only the single `trial-interrupted` one, so the ten trials the
 * arm had already paid to reach were unrecoverable. A fault category that cannot be
 * retried is a fault category the arm cannot recover from.
 *
 * The remaining omissions are DECISIONS and stay non-resumable:
 *   - `spend-limit`         the ceiling was reached; re-running re-buys what it stopped
 *   - `driver-unreachable`  the guest was gone; the run is measuring nothing
 *   - `repeated-cause`      the sweep was measuring the harness; that IS the finding
 * Re-attempting those would silently un-stop a run whose stop reason was the result.
 */
const RESUMABLE_OMISSIONS: readonly Omission[] = ["trial-interrupted", "planner-failed"];

function writeJson(path: string, value: unknown) {
  const temporary = `${path}.tmp`;
  const file = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(join(path, ".."), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function loadLedger(path: string): Ledger {
  if (!existsSync(path)) return { manifestSha256, c1: {}, c2: {} };
  const ledger: Ledger = JSON.parse(readFileSync(path, "utf8"));
  if (ledger.manifestSha256 !== manifestSha256) throw new Error("v3 manifest mismatch");
  for (const arm of ["c1", "c2"] as const) {
    for (const [key, entry] of Object.entries(ledger[arm])) {
      if (
        !manifest.rows.some(({ index }) => String(index) === key) ||
        !Number.isSafeInteger(entry.micros) ||
        entry.micros < 0 ||
        (entry.status !== "reserved" && entry.status !== "omitted" && entry.status !== "scored") ||
        (entry.status === "scored" &&
          (!isBaselineRow(entry.row) ||
            entry.row.subArm !== arm ||
            String(entry.row.index) !== key ||
            Math.round(entry.row.cost * 1_000_000) !== entry.micros))
      )
        throw new Error("invalid spend ledger");
    }
  }
  return ledger;
}

function charged(entries: Ledger["c1"]): number {
  return Object.values(entries).reduce((total, entry) => total + entry.micros, 0);
}

/**
 * The cash this directory has actually COMMITTED, for a resume's prior spend.
 *
 * Deliberately not `charged()`: that sums `reserved` entries too, and a
 * reservation is a hold, not spend. A resume that treated holds as cash would
 * understate the remaining ceiling by however many reservations were in flight
 * when the process died - the same cash-versus-reservation split that made
 * arm-003d's apparent cap read $6.30 against $4.48 of real cash.
 *
 * `reserved` means the process died after booking but before scoring, so the
 * model MAY have been called and usage is unknown. Counting it is therefore the
 * conservative direction, and the spec says fail closed on a partial ledger - but
 * only for the trials a resume will NOT rerun. A reservation that is about to be
 * rerun must not be double-counted, so it is EXCLUDED here and its trial is
 * re-bought with a fresh reservation.
 */
function committedCash(entries: Ledger["c1"]): number {
  return Object.values(entries).reduce(
    (total, entry) => total + (entry.status === "scored" ? entry.micros : 0),
    0,
  );
}

/**
 * Refuse a resume that is not the same experiment, or whose ledger is unusable.
 *
 * Every check here fails CLOSED. A resume that guesses is worse than a resume
 * that refuses: it produces a 30-row artifact that looks uniform while one half
 * measured a different model or snapshot, and nothing downstream can tell.
 */
function assertResumable(
  ledger: Ledger,
  identity: RunIdentity,
  path: string,
  adoptIdentity: boolean,
) {
  if (ledger.manifestSha256 !== manifestSha256)
    throw new Error(
      `refusing to resume ${path}: manifest mismatch (ledger ${ledger.manifestSha256.slice(0, 12)} != current ${manifestSha256.slice(0, 12)})`,
    );
  // A ledger written before identity was recorded cannot be CHECKED, so the
  // default is to refuse it rather than assume compatibility.
  //
  // An explicit adoption path exists because there is one honest use for it: a
  // run that crashed BEFORE identity recording existed, whose rows are real and
  // whose spend is already committed. Refusing those forever would strand paid
  // data and force a fresh 30-trial arm - exactly the waste this feature exists
  // to prevent. The adoption is recorded in the ledger so a later reader can see
  // the identity was asserted at resume time rather than captured at run time,
  // and it never silently upgrades a ledger that already HAS a different identity.
  if (!ledger.identity) {
    if (!adoptIdentity)
      throw new Error(
        `refusing to resume ${path}: ledger records no run identity, so compatibility cannot be checked (pass --adopt-identity to assert the current one, which is recorded as adopted)`,
      );
    ledger.identity = { ...identity, adopted: true };
    writeJson(path, ledger);
  }
  for (const field of ["model", "snapshot", "planner"] as const) {
    if (ledger.identity[field] !== identity[field])
      throw new Error(
        `refusing to resume ${path}: ${field} differs (run "${ledger.identity[field]}" != resume "${identity[field]}")`,
      );
  }
}

/**
 * A summary of what a trial's agent DID, for the repeated-cause rule.
 *
 * The rule exists to catch "the sweep is measuring the harness, not the agent",
 * and it previously keyed on verdict+reason+step count. arm-003d r3 showed that
 * is wrong: trials 0 and 1 BOTH scored `refuted/step-budget` with 30 steps and
 * aborted as a repeated cause, but their action sequences were plainly different
 * - 28 press_keys and 2 type_texts versus 20 press_keys, 5 clicks and 5
 * type_texts. Two trials that tried different things and both ran out of budget
 * is a hard task, not a repeated fault, and aborting it discards real baseline
 * data.
 *
 * The tool histogram is deliberately the key rather than the full sequence: a
 * harness fault reproduces the SAME shape (r2's truncated rows were one call,
 * zero actions), while an agent working a hard problem varies it. Using the
 * exact sequence would be too brittle - two runs of a real task never match
 * byte-for-byte - and using only the step count is too coarse, which is the bug
 * this replaces.
 *
 * WHAT THIS DOES AND DOES NOT FIX, stated because the distinction is easy to
 * overstate: it separates trials whose COMPOSITION differs - r3's press_keyx28 +
 * type_textx2 versus clickx5 + press_keyx20 + type_textx5, which is the case that
 * stopped the arm. It does NOT separate trials with the same composition and a
 * different ORDER, or the same composition and different coordinates. Two
 * `click`-heavy trials that converge on the same tool mix will still be read as a
 * repeated cause even if they acted on different cells.
 *
 * That residual is a deliberate limit, not an oversight: at the resolution this
 * key measures, two trials doing the same KINDS of things at the same RATES are
 * the same shape. If an arm later aborts on a pair that differs only in
 * coordinates, the honest fix is to key on the action sequence, and this comment
 * is the record of why that tradeoff was taken the other way first.
 */
function actionSignature(row: BaselineRow): string {
  const counts: Record<string, number> = {};
  for (const action of row.transcript.actions) counts[action.tool] = (counts[action.tool] ?? 0) + 1;
  // Tools the trial never used are omitted, not printed as `toolx0`: a shape is
  // the set of things that HAPPENED, and padding it with zeroes makes two
  // different shapes look more alike than they are.
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, n]) => `${tool}x${n}`)
    .join(",");
}

/**
 * Take the per-directory run lock, clearing one that a dead process left behind.
 *
 * The lock is a directory, so it is atomic to create - but nothing removed it when a
 * run was killed. arm-003d's r6 was stopped with SIGKILL, left `.run-lock` behind,
 * and every later attempt died with `EEXIST: mkdir .../.run-lock` before a single
 * trial ran. The resume feature could not resume the exact run it was built for, and
 * the only fix was for an operator to know to `rmdir` a hidden directory first.
 *
 * The block now records an owner pid INSIDE the directory. On collision:
 *   - owner alive  -> refuse, naming the pid. Two sweeps in one directory share one
 *                     ledger, so this must stay a hard stop.
 *   - owner dead   -> the run it belonged to is over; clear and take it.
 *   - no owner, or an UNPARSEABLE one -> cleared. A live holder always writes a
 *                     parseable pid, so this is stale in every ordinary case.
 *
 * WHAT THE LAST CASE DOES NOT PROVE, corrected after a verifier measured it: an
 * unreadable owner is UNKNOWN, not confirmed-dead. The genuine window is microseconds
 * (a SIGKILL between mkdir and the write), and it is the trade that lets a killed run
 * be resumed at all - but it is the one path where a lock a live holder owns can be
 * cleared, so the sentence "fail closed on every unsure path" was too strong and is
 * gone. A live owner with a READABLE pid is always refused, including under pid reuse:
 * a recycled pid pointing at an unrelated live process makes the lock refuse forever,
 * which is stuck rather than unsafe.
 */
function acquireRunLock(directory: string): string {
  const lock = join(directory, ".run-lock");
  const ownerPath = join(lock, "owner.pid");
  const create = () => {
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(ownerPath, `${process.pid}\n`, { mode: 0o600 });
  };
  try {
    create();
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Somebody holds it, or somebody left it. Decide which.
  let owner: number | undefined;
  try {
    const raw = readFileSync(ownerPath, "utf8").trim();
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed > 0) owner = parsed;
  } catch {
    // No owner file, or one that did not parse: stale in every ordinary case. A live
    // holder always writes a parseable pid, so an unreadable owner is an UNKNOWN
    // rather than a confirmed death - see the trade documented on acquireRunLock.
  }
  if (owner !== undefined && isProcessAlive(owner))
    throw new Error(
      `refusing to run: ${lock} is held by live pid ${owner}; two sweeps must not share one ledger`,
    );
  // Positively dead, or unparseable/unrecorded - clear the leftover and take the lock.
  rmSync(lock, { recursive: true, force: true });
  create();
  return lock;
}

/** True when a pid exists and is not a zombie. Signal 0 only checks existence. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else - still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Hosts one C1 evaluation. Prepare owns reset and fixture placement, and must
 * be supplied by the Coordinator's live wrapper after approval.
 */

export async function runC1Sweep(options: {
  coordinatorGo: boolean;
  directory: string;
  armLimitMicros?: number;
  /**
   * Spend committed by EARLIER runs, in micros.
   *
   * The ledger in `directory` counts only its own trials, so a run started in a
   * fresh directory sees a zero total and its caps silently measure the run
   * rather than the project. arm-003d hit exactly that: $3.19 was already
   * committed against a $9 ceiling, the new directory started at zero, and the
   * $9 assertion would have been satisfied by a ledger that knew about $4.50 of
   * it. The ceiling has to include what was already spent or it is not a ceiling.
   *
   * Deliberately a SEPARATE number rather than a ledger field: writing prior
   * spend into `c1`/`c2` would fabricate entries for trials this run did not
   * execute, and the row validator would have to learn to accept them.
   */
  priorSpendMicros?: number;
  /**
   * Continue an interrupted run in `directory` instead of starting fresh.
   *
   * Without this, a rerun against an existing directory silently reuses whatever
   * the ledger happens to contain, so an operator cannot tell "I meant to resume"
   * from "I accidentally pointed at an old run". It also gates the checks that
   * make a resume SOUND - identity equality and rerun-eligibility - which are
   * only meaningful when continuing is the stated intent.
   */
  resume?: boolean;
  /**
   * How prior spend is established on a resume.
   *
   * `ledger` derives it from the resumed directory's committed cash, which is
   * what makes the $9 ceiling hold across a resume. `external` trusts
   * `priorSpendMicros` as given. The default is `ledger` when `resume` is set,
   * because a resume that ignores what the directory already spent is the bug
   * this whole feature exists to prevent.
   */
  resumeSpend?: "ledger" | "external";
  /** What the run believes it is, checked against the ledger on a resume. */
  identity?: RunIdentity;
  /**
   * Permit a resume of a ledger that records NO identity, by asserting the
   * current one and recording it as adopted.
   *
   * Only for ledgers written before identity recording existed. A ledger that
   * already carries a DIFFERENT identity is still refused - this cannot launder
   * a mismatch, only fill an absence.
   */
  adoptIdentity?: boolean;
  /**
   * Scored causes the operator has DIAGNOSED as genuine agent failures, as
   * `verdict:reason` strings (e.g. `refuted:step-budget`).
   *
   * A repeated scored cause normally aborts the arm at its second occurrence,
   * because two identical failures mean the sweep is measuring the harness. That
   * inference is wrong once the cause has actually been diagnosed: every row
   * reproducing a known agent limitation is EXPECTED, and aborting at the second
   * one would stop an arm precisely because it is behaving as understood.
   *
   * Accepted causes break the run of failures instead of contributing to it.
   * Anything not listed still aborts at 2, so this narrows the rule rather than
   * disabling it. Recorded in the ledger identity so the acceptance is auditable
   * after the fact.
   */
  acceptScoredCauses?: readonly string[];
  planner?: Planner;
  prepare(
    target: (typeof manifest.rows)[number],
    snapshot: typeof RESET_SNAPSHOT,
  ): Promise<PreparedC1>;
}) {
  if (!options.coordinatorGo) throw new Error("Coordinator GO required");
  const armLimit = options.armLimitMicros ?? DEFAULT_ARM_LIMIT;
  if (!Number.isSafeInteger(armLimit) || armLimit < 0 || armLimit > COMBINED_LIMIT)
    throw new Error("invalid arm spend cap");
  // Fail closed on a bad seed rather than treating it as zero: a caller that
  // cannot state prior spend must not silently get an unbounded ceiling, which
  // is the failure this parameter exists to prevent.
  const priorSpend = options.priorSpendMicros ?? 0;
  if (!Number.isSafeInteger(priorSpend) || priorSpend < 0 || priorSpend > COMBINED_LIMIT)
    throw new Error("invalid prior spend");
  if (priorSpend + armLimit > COMBINED_LIMIT && armLimit === DEFAULT_ARM_LIMIT) {
    // The default arm limit is a per-arm default, not a budget; if prior spend
    // plus it would breach the combined ceiling, the caller must say what is
    // left rather than inherit a limit that cannot be spent.
    throw new Error(
      `prior spend ${priorSpend} + default arm limit ${armLimit} exceeds ${COMBINED_LIMIT}; ` +
        "pass armLimitMicros explicitly so priorSpend + armLimitMicros stays within the combined ceiling",
    );
  }
  const { directory } = options;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = acquireRunLock(directory);
  try {
    const path = join(directory, "accounting.json");
    const ledger = loadLedger(path);
    // A resume must be the same experiment, and must know what this directory
    // already spent. Both checks happen BEFORE any trial runs, so a bad resume
    // costs nothing.
    let priorSpendMicros = priorSpend;
    const runResume = options.resume === true;
    // Validated rather than trusted: a typo'd cause would silently accept nothing
    // (safe) OR, worse, look like it was in force when it was not. Empty strings
    // and entries without a colon are rejected so the flag cannot be half-applied.
    // A blank value is REJECTED, never filtered away.
    //
    // The earlier version trimmed and dropped empties, so `--accept-scored-cause=""`
    // produced an empty set and the arm ran with no acceptance at all - the silent
    // failure this whole mechanism exists to prevent, reachable by one unset shell
    // variable. Discarding a value the operator explicitly supplied is the wrong
    // default in something that guards a hard cap.
    const requestedCauses = options.acceptScoredCauses ?? [];
    const blank = requestedCauses.find((cause) => cause.trim().length === 0);
    if (blank !== undefined)
      throw new Error(
        "accepted scored cause is blank; pass verdict:reason, e.g. refuted:step-budget (an empty value would silently accept nothing)",
      );
    const acceptedScoredCauses = new Set<string>(requestedCauses.map((cause) => cause.trim()));
    for (const cause of acceptedScoredCauses)
      if (!/^[a-z-]+:[a-z-]+$/i.test(cause))
        throw new Error(
          `invalid accepted scored cause "${cause}": expected verdict:reason, e.g. refuted:step-budget`,
        );
    if (runResume) {
      if (options.identity)
        assertResumable(ledger, options.identity, path, options.adoptIdentity === true);
      if ((options.resumeSpend ?? "ledger") === "ledger") {
        // A resume must measure the PROJECT, and the ledger already does.
        //
        // The combined check below is `priorSpendMicros + charged(ledger.c1) +
        // ...`, and `ledger.c1` is the SAME ledger being resumed - so the cash
        // this directory has already committed is counted there, from the rows
        // themselves. Adding it to `priorSpendMicros` as well counts it twice.
        //
        // That is not a theoretical objection. An earlier version computed
        // `priorSpend + committedCash(ledger.c1)` and the duplication shrank the
        // usable budget by exactly the amount already spent: a resume whose prior
        // plus one reservation still fitted would refuse the trial. On a real
        // arm that wastes money already paid for, which is the failure this
        // feature exists to prevent.
        //
        // So prior spend stays the EXTERNAL figure and the ledger supplies the
        // directory's own cash. `assertLedgerCoversCommitted` below keeps the
        // two consistent: it refuses a resume whose ledger cannot account for its
        // own spend, which is the property the "prior + committed" formula was
        // trying to guarantee.
        const committed = committedCash(ledger.c1) + committedCash(ledger.c2);
        if (priorSpend + committed > COMBINED_LIMIT)
          throw new Error(
            `refusing to resume ${path}: prior ${priorSpend} + committed cash ${committed} exceeds ${COMBINED_LIMIT}`,
          );
        priorSpendMicros = priorSpend;
      }
    }
    // Record identity on a fresh run so a later resume can check it. Written
    // before the first trial so a crash during trial 0 still leaves a checkable
    // ledger rather than an unexplained one.
    // Which trials this invocation will actually EXECUTE, which is what an
    // acceptance can honestly claim to cover. Scored rows are skipped, so an
    // acceptance added now cannot apply to them.
    const willExecute = manifest.rows
      .map(({ index }) => index)
      .filter((index) => {
        const entry = ledger.c1[index];
        if (!entry) return true;
        if (entry.status === "reserved") return runResume;
        if (entry.status === "scored") return false;
        return runResume && RESUMABLE_OMISSIONS.includes(entry.reason);
      });
    const firstExecuted: number = willExecute[0] ?? manifest.rows.length;

    // Record identity on a fresh run so a later resume can check it. Written
    // before the first trial so a crash during trial 0 still leaves a checkable
    // ledger rather than an unexplained one.
    if (!ledger.identity) {
      if (!options.identity && acceptedScoredCauses.size > 0)
        throw new Error(
          "cannot accept a scored cause without a run identity to record it against; pass the run identity so the acceptance is auditable",
        );
      if (options.identity)
        ledger.identity = {
          ...options.identity,
          ...(acceptedScoredCauses.size > 0
            ? { acceptances: [{ causes: [...acceptedScoredCauses].sort(), fromTrial: 0 }] }
            : {}),
        };
      if (options.identity) writeJson(path, ledger);
    }

    // Compare BEFORE writing, and record WHEN rather than rewriting history.
    //
    // Two bugs lived here. The first: the write sat above the comparison, so a
    // resume supplying an acceptance against a ledger recording none compared the
    // caller's value with itself and passed. The second: even once ordered
    // correctly, the only safe answer was to refuse - because a flat list cannot
    // say that an acceptance started partway through an arm.
    //
    // It can, now. An acceptance added on a resume is recorded with the first
    // trial it applies to, so r6's ledger says "none for the first rows,
    // `refuted:step-budget` from trial N" instead of claiming the whole arm ran
    // under a decision made later. DROPPING or REPLACING an acceptance is still
    // refused: rows already recorded ran under it, and no start index can undo
    // that.
    // Runs even when the resume passes NO acceptance: dropping every cause is the
    // most complete change of terms there is, and an earlier version only entered
    // this block when something was passed, so dropping them all slipped through.
    if (runResume) {
      const segments = ledger.identity?.acceptances ?? [];
      const latest = segments[segments.length - 1];
      const recorded = new Set(latest?.causes ?? []);
      const added = [...acceptedScoredCauses].filter((cause) => !recorded.has(cause));
      const dropped = [...recorded].filter((cause) => !acceptedScoredCauses.has(cause));
      if (dropped.length > 0)
        throw new Error(
          `refusing to resume ${path}: accepted scored cause(s) ${dropped.map((c) => `"${c}"`).join(", ")} were in force for rows already recorded but are not passed now; the resumed rows would not be comparable`,
        );
      if (added.length > 0) {
        // A superset: the new causes apply from the first trial this resume
        // executes, and the earlier rows keep the terms they actually ran under.
        if (!ledger.identity)
          throw new Error(
            "cannot accept a scored cause without a run identity to record it against; pass the run identity so the acceptance is auditable",
          );
        ledger.identity = {
          ...ledger.identity,
          acceptances: [
            ...segments,
            { causes: [...acceptedScoredCauses].sort(), fromTrial: firstExecuted },
          ],
        };
        writeJson(path, ledger);
      }
    }

    // What is in force for a given trial: the latest segment that starts at or
    // before it.
    //
    // HONEST LIMIT OF THIS MECHANISM, stated so nobody later assumes more: with the
    // counter as written, a segment boundary has NO observable effect on WHEN the
    // arm aborts. An accepted cause resets the run and a changed cause also resets
    // it, so "row 0 counted under the old terms, then reset at row 1" and "row 0
    // reset under the new terms" leave the same counter behind. The boundary is
    // therefore an AUDIT RECORD - it stops the ledger claiming a later decision
    // covered earlier rows - not a behavioural switch. It is still the right thing
    // to write: the alternative is a flat list that rewrites history, and this is
    // what an operator reading the artifact needs to see.
    const acceptanceInForce = (index: number): Set<string> => {
      const segments = ledger.identity?.acceptances ?? [];
      let causes: readonly string[] = [];
      for (const segment of segments) if (segment.fromTrial <= index) causes = segment.causes;
      return new Set(causes);
    };

    const persist = () => writeJson(path, ledger);
    const planner = options.planner ?? createPlanner();
    const rowDirectory = join(directory, "trials", "c1");
    mkdirSync(rowDirectory, { recursive: true });
    let stopReason: Omission | undefined;
    // Abort-early (defensive engineering rule 7): two consecutive identical
    // exclusion causes mean the sweep is measuring the harness, not the agent.
    // Stop and surface it for diagnosis instead of burning the rest of the arm.
    //
    // Nothing is seeded here on purpose. The loop below REPLAYS every entry
    // already in the ledger - scored rows and omissions alike - through
    // `noteCause`, so the counter arrives at the correct value by walking the same
    // history that produced it. Seeding it separately would be a second copy of
    // that state, and the two can disagree; an earlier attempt did exactly that,
    // seeding `trial-interrupted` and then overwriting it as the loop walked past
    // the scored rows that followed the crash.
    let lastCause: string | undefined;
    let consecutive = 0;
    const noteCause = (cause: string) => {
      if (cause === lastCause) consecutive += 1;
      else {
        lastCause = cause;
        consecutive = 1;
      }
      if (consecutive >= 2 && !stopReason) {
        stopReason = "repeated-cause";
      }
    };
    for (const target of manifest.rows) {
      const { index, params } = target;
      const prior = ledger.c1[index];
      if (prior?.status === "scored") {
        writeJson(join(rowDirectory, `${index}.json`), prior.row);
        // REPLAY the scored cause, so the counter is continuous across a resume.
        //
        // The comment below the loop already claimed this ("scored rows and
        // omissions alike"), but only `driver-unreachable` was replayed - so two
        // consecutive identical scored causes straddling a crash never reached
        // `consecutive >= 2` and the rule silently could not see them. Found by a
        // round-1 verifier probing exactly that shape.
        if (prior.row.verdictReason === "driver-unreachable") {
          stopReason ??= "driver-unreachable";
          noteCause("driver-unreachable");
        } else if (
          acceptanceInForce(index).has(`${prior.row.verdict}:${prior.row.verdictReason}`)
        ) {
          // Same rule as a live row: an accepted cause breaks the run rather
          // than extending it, or the replay would abort an arm that is behaving
          // exactly as diagnosed.
          lastCause = undefined;
          consecutive = 0;
        } else {
          noteCause(
            `scored:${prior.row.verdict}:${prior.row.verdictReason}:actions=${actionSignature(prior.row)}`,
          );
        }
        continue;
      }
      if (prior?.status === "omitted") {
        // A resume re-attempts a trial the CRASH cut short, and leaves a
        // deliberate stop alone.
        //
        // The distinction matters: `trial-interrupted` means the harness lost the
        // trial, so re-running it buys data the arm paid for and never got. The
        // other omissions are decisions - `spend-limit` stopped because the ceiling
        // was reached, `driver-unreachable` because the guest was gone,
        // `repeated-cause` because the sweep was measuring the harness. Re-running
        // those on a resume would re-buy exactly what the stop was protecting, and
        // would also silently un-stop a run whose stop reason was the finding.
        const rerunnable = runResume && RESUMABLE_OMISSIONS.includes(prior.reason);
        if (!rerunnable) {
          if (prior.reason !== "trial-interrupted") {
            stopReason ??= prior.reason;
            noteCause(prior.reason);
          } else {
            // An interruption that is NOT being rerun still feeds the rule: two
            // consecutive ones either side of a crash is the same fault the rule
            // exists to catch, and skipping this call would hide it.
            noteCause("trial-interrupted");
          }
          continue;
        }
        // Fall through: the trial is re-attempted below with a fresh reservation.
        // Its cause is replayed FIRST so the counter is continuous across the
        // boundary: if this rerun fails the same way, that is the second
        // consecutive identical cause and the rule fires.
        noteCause("trial-interrupted");
      }
      if (prior?.status === "reserved" && !runResume) {
        // A reservation with no resume intent means THIS run died after booking,
        // so the trial is recorded as interrupted and the counter advanced -
        // behaviour unchanged from before `--resume` existed.
        ledger.c1[index] = { ...prior, status: "omitted", reason: "trial-interrupted" };
        persist();
        continue;
      }
      if (prior?.status === "reserved" && runResume) {
        // On a resume the reservation is re-attempted. Its micros are NOT in
        // priorSpend (committedCash counts only scored rows), so the fresh
        // reservation below does not double-count the dead one.
        delete ledger.c1[index];
        persist();
      }
      const reservation = planner.paid ? MAX_TRIAL_MICROS : 0;
      const c1 = charged(ledger.c1);
      if (
        stopReason ||
        // TWO ceilings, and prior spend belongs in exactly one of them.
        //
        // `armLimit` is the REMAINING budget (MYCO_ARM_LIMIT_MICROS, documented as
        // ceiling - prior), so this check is scoped to THIS RUN: the trials it has
        // scored plus the reservation it is about to hold.
        //
        // TIF-187: this used to read `priorSpend + c1 + reservation > armLimit`,
        // which adds prior spend to a value prior spend was already subtracted
        // from - the subtraction happened twice. A caller who followed the
        // documented rule (arm = 9000000 - prior) then had every trial omitted:
        // with prior 4480732 and a 607200 reservation, 5087932 > 4519268, so r6's
        // first launch produced `completed: 0` and 30 `spend-limit` rows. The
        // configuration the documentation prescribes could not start a trial.
        c1 + reservation > armLimit ||
        // The project ceiling. prior spend belongs HERE, where it is compared
        // against the true combined limit rather than against a budget that has
        // already had it removed. This is the binding ceiling for a real launch.
        //
        // On a resume `priorSpendMicros` stays the EXTERNAL figure; this
        // directory's committed cash arrives through `charged(ledger.c1)` in the
        // same expression. It is deliberately NOT folded into prior spend as
        // well - that counts it twice and shrinks the usable budget by the amount
        // already paid. A round-1 verifier flagged an earlier version of this
        // comment for saying the opposite, which is the sentence someone would
        // cite to reintroduce the double count.
        priorSpendMicros + c1 + charged(ledger.c2) + reservation > COMBINED_LIMIT
      ) {
        stopReason ??= "spend-limit";
        ledger.c1[index] = { status: "omitted", micros: 0, reason: stopReason };
        persist();
        continue;
      }
      ledger.c1[index] = { status: "reserved", micros: reservation };
      persist();
      let row: BaselineRow;
      // `prepare` and the trial are separated so their costs can be told apart.
      //
      // TIF-186: `prepare()` never touches the planner - `createPlanner` is
      // constructed separately and only `runC1Trial` uses it - so a throw from
      // prepare PROVES no model call was made, and the trial should book $0 rather
      // than the full reservation. arm-003d r5 booked 607,200 twice for
      // interruptions that made no call, which shrank the apparent cap from $4.48
      // of cash to $6.30 and would have stopped a run that was affordable.
      //
      // A throw from runC1Trial is different: it may have called the model before
      // failing, and the error carries no usage, so its cost is UNKNOWN. That case
      // keeps the reservation, because under-reporting spend against a hard cap is
      // the dangerous direction.
      let preparedForTrial: Awaited<ReturnType<typeof options.prepare>> | undefined;
      const gt = groundTruth(params);
      try {
        preparedForTrial = await options.prepare(structuredClone(target), RESET_SNAPSHOT);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        noteCause(error instanceof PlannerFailure ? "planner-failed" : "trial-interrupted");
        ledger.c1[index] = {
          status: "omitted",
          micros: 0,
          reason: error instanceof PlannerFailure ? "planner-failed" : "trial-interrupted",
          detail,
        };
        persist();
        continue;
      }
      try {
        row = await runC1Trial(
          {
            index,
            params,
            cellRef: gt.cellRef,
            expected: gt.expectedValue,
            previousValue: gt.previousValue,
          },
          preparedForTrial,
          planner,
        );
      } catch (error) {
        // A throw from the TRIAL itself. TIF-200 split the two cases apart.
        //
        // A PlannerFailure that CARRIES a cost (a truncated reply is billed, and its
        // usage is known) books the ACTUAL charge. Any other throw may have called the
        // model without reporting usage, so the cost is UNKNOWN and the full
        // reservation stays booked - fail closed, because under-reporting spend against
        // a hard cap is the dangerous direction.
        const failed = error instanceof PlannerFailure;
        // VALIDATED, not trusted. `PlannerFailure.costMicros` is a public constructor
        // argument, and the booking feeds a HARD CAP. A round-1 verifier measured what
        // an unvalidated value does to that cap:
        //
        //   negative   -> charged() goes negative, so the guard fires LATER (fail-open)
        //   NaN        -> `NaN > LIMIT` is false, so the cap is silently dead in-run
        //   over-reservation, Infinity -> the ledger totals exceed the ceiling unguarded
        //   fractional -> a non-integer micros value, against the ledger's invariant
        //
        // A non-integer, negative, or over-reservation figure is therefore treated as
        // UNKNOWN and the full reservation is kept. Only a plausible charge is booked:
        // the charge has to be a safe non-negative integer no larger than the hold that
        // stands in for it. `loadLedger` would reject the rest on the next resume, but
        // the run itself must not be corrupted before it gets there.
        const offered = failed ? error.costMicros : undefined;
        const billed =
          offered !== undefined &&
          Number.isSafeInteger(offered) &&
          offered >= 0 &&
          offered <= reservation
            ? offered
            : undefined;
        // ONE FAILURE MUST NOT END A PAID ARM. This used to be
        // `if (failed) stopReason = "planner-failed"` - an ASSIGNMENT, so the first
        // measurable provider fault stopped a 30-trial run. r6 lost trials 21-29 to a
        // single truncation. Every other cause in this file needs TWO consecutive
        // occurrences before it aborts, and a truncation is a harness/config fault of
        // exactly that kind, so it now counts the same way.
        //
        // The abort keys on the FAULT CLASS, never on the message text. The message
        // is not lost - it is persisted as `detail` below, so a run that stops can be
        // diagnosed from its own artifacts rather than from logs.
        //
        // An earlier version carried the message INTO the key
        // (`trial-interrupted:${message}`). That let two omissions of the same class
        // look like two different causes, so abort-early never fired:
        //
        // arm-003d r5 omitted trials 2 and 3 and kept going. The two carried
        // different messages (an SSH banner timeout, then a throw later in the
        // trial), so `consecutive` never reached 2 and each one burned $0.61 of cap
        // for no data. Keying on the message also meant the rule could only see a
        // fault that reproduced its TEXT, which is the wrong resolution for "the
        // sweep is measuring the harness". TIF-186.
        noteCause(failed ? "planner-failed" : "trial-interrupted");
        ledger.c1[index] = {
          status: "omitted",
          micros: billed ?? reservation,
          reason: failed ? "planner-failed" : "trial-interrupted",
          detail: error instanceof Error ? error.message : String(error),
        };
        persist();
        continue;
      }
      const micros = Math.round(row.cost * 1_000_000);
      if (!isBaselineRow(row) || micros > reservation)
        throw new Error("invalid C1 row or reservation overrun");
      if (row.verdictReason === "driver-unreachable") {
        stopReason ??= "driver-unreachable";
        noteCause("driver-unreachable");
      } else {
        // A SCORED failure also feeds the abort-early rule.
        //
        // The rule above is documented as "two consecutive identical exclusion
        // causes mean the sweep is measuring the harness, not the agent", but it
        // was only wired to omissions and driver-unreachable. arm-003d r2 trials
        // 3 and 4 both scored `refuted/persisted-mismatch` with zero steps and a
        // single truncated model call, so nothing incremented the counter and the
        // sweep kept buying trials that were measuring the ceiling, not the
        // agent. A repeated scored failure is the same signal as a repeated
        // omission; it is only quieter.
        //
        // Keyed on verdict AND reason AND step count. The step component is
        // deliberately conservative, and the tradeoff is worth stating: two
        // `refuted/persisted-mismatch` rows that differ in steps are genuinely
        // different failures - one with 0 actions is a harness shape, one with 12
        // is a real agent trajectory - so collapsing them would abort a run that
        // is merely having a hard time.
        //
        // The cost is that harness noise in the step count can delay the abort by
        // one trial: `s0, s1, s2, s2` stops on the third row rather than the
        // second. That is the right direction to err. A delayed abort costs one
        // trial; a false abort discards a healthy arm and misreports it as a
        // harness fault. The identical-pair case - arm-003d r2's actual shape,
        // `s0, s0` - still stops immediately, which is the case this rule exists
        // for.
        //
        // AN ACCEPTED CAUSE IS NOT A FAULT SIGNAL. When the operator has diagnosed
        // a scored cause as a genuine agent failure, every row reproducing it is
        // expected, not suspicious - and the rule as written would stop the arm at
        // the second such row, which is exactly what the r6 resume must not do.
        // Accepting it RESETS the run of failures rather than merely skipping the
        // increment: an accepted row must break the chain, or a genuine fault
        // before it could pair with one after it across an accepted row that says
        // nothing about either.
        //
        // The acceptance is per verdict:reason and recorded in the ledger
        // identity, so a reader can tell an arm that ran with an accepted cause
        // from one that simply never saw the fault. Anything NOT accepted still
        // aborts at the second occurrence.
        const causeKey = `${row.verdict}:${row.verdictReason}`;
        if (acceptanceInForce(index).has(causeKey)) {
          lastCause = undefined;
          consecutive = 0;
        } else {
          noteCause(`scored:${row.verdict}:${row.verdictReason}:actions=${actionSignature(row)}`);
        }
      }
      ledger.c1[index] = { status: "scored", micros, row };
      persist();
      writeJson(join(rowDirectory, `${index}.json`), row);
    }
    const rows = manifest.rows.map(({ index, mycoVerdict }) => {
      const entry = ledger.c1[index];
      return entry?.status === "scored"
        ? {
            index,
            mycoVerdict,
            verdict: entry.row.verdict,
            planner: entry.row.deviations.find((note) => note.startsWith("planner:")),
          }
        : {
            index,
            mycoVerdict,
            omitted: entry?.status === "omitted" ? entry.reason : "trial-interrupted",
            ...(entry?.status === "omitted" && entry.detail ? { detail: entry.detail } : {}),
          };
    });
    const completed = rows.filter((row) => "verdict" in row).length;
    const report = {
      manifestSha256,
      completed,
      partial: completed !== rows.length,
      c1ChargedMicros: charged(ledger.c1),
      combinedChargedMicros: charged(ledger.c1) + charged(ledger.c2),
      // WHY the run stopped, when it stopped early. Without this the artifact
      // records that trials are missing but not that anything was wrong: a run
      // stopped by `repeated-cause` and one that simply ran out of manifest look
      // identical, and `partial: true` is the only hint. It also makes the
      // abort-early rule observable across a resume, where the counter is
      // reconstructed rather than carried in memory - previously the rule could
      // fire with no trace in the output at all.
      ...(stopReason ? { stopReason } : {}),
      // The acceptance the run operated under. In the report as well as the
      // ledger because the report is what a reader scores from, and an arm that
      // ran with a diagnosed cause accepted must not look like one that never
      // needed the exception.
      // The output ceiling these rows ran under. r6 is the reason it is here: rows 0-19
      // ran at 1024 and row 20 truncated at that ceiling, so the ARM reports a
      // configuration change mid-flight. Without this the artifact says nothing about
      // the number that ended a trial, and a later reader would have to find it in the
      // code at the time of the run.
      maxOutputTokens: MAX_OUTPUT,
      acceptedScoredCauses: [...(ledger.identity?.acceptances?.at(-1)?.causes ?? [])].sort(),
      ...(ledger.identity?.acceptances?.at(-1)
        ? { acceptedFromTrial: ledger.identity.acceptances.at(-1)?.fromTrial }
        : {}),
      rows,
    };
    writeJson(join(directory, "report.json"), report);
    return report;
  } finally {
    // `rmSync`, not `rmdirSync`: the lock directory now holds `owner.pid`, so a
    // bare rmdir would throw here and mask the run's own result.
    rmSync(lock, { recursive: true, force: true });
  }
}
