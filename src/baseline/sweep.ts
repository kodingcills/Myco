import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { groundTruth } from "../tasks/intent.ts";
import { type PreparedC1, RESET_SNAPSHOT, runC1Trial, STEP_BUDGET } from "./c1-trial.ts";
import { type BaselineRow, isBaselineRow } from "./index.ts";
import { createPlanner, MAX_CALL_MICROS, type Planner, PlannerFailure } from "./planner.ts";
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
interface Ledger {
  manifestSha256: string;
  c1: Record<string, Entry>;
  c2: Record<string, Entry>;
}

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
 * Hosts one C1 evaluation. Prepare owns reset and fixture placement, and must
 * be supplied by the Coordinator's live wrapper after approval.
 */

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
      `prior spend ${priorSpend} + default arm limit ${armLimit} exceeds ${COMBINED_LIMIT}; pass armLimitMicros as the REMAINING budget`,
    );
  }
  const { directory } = options;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, ".run-lock");
  mkdirSync(lock, { mode: 0o700 });
  try {
    const path = join(directory, "accounting.json");
    const ledger = loadLedger(path);
    const persist = () => writeJson(path, ledger);
    const planner = options.planner ?? createPlanner();
    const rowDirectory = join(directory, "trials", "c1");
    mkdirSync(rowDirectory, { recursive: true });
    let stopReason: Omission | undefined;
    // Abort-early (defensive engineering rule 7): two consecutive identical
    // exclusion causes mean the sweep is measuring the harness, not the agent.
    // Stop and surface it for diagnosis instead of burning the rest of the arm.
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
        if (prior.row.verdictReason === "driver-unreachable") {
          stopReason ??= "driver-unreachable";
          noteCause("driver-unreachable");
        }
        continue;
      }
      if (prior?.status === "reserved") {
        ledger.c1[index] = { ...prior, status: "omitted", reason: "trial-interrupted" };
        persist();
        continue;
      }
      if (prior?.status === "omitted") {
        if (prior.reason !== "trial-interrupted") {
          stopReason ??= prior.reason;
          noteCause(prior.reason);
        }
        continue;
      }
      const reservation = planner.paid ? MAX_TRIAL_MICROS : 0;
      const c1 = charged(ledger.c1);
      if (
        stopReason ||
        // `priorSpend` is added to BOTH ceilings. Without it the combined limit
        // is enforced against this run's ledger alone and a fresh directory gets
        // a $9 allowance it has already spent part of.
        priorSpend + c1 + reservation > armLimit ||
        priorSpend + c1 + charged(ledger.c2) + reservation > COMBINED_LIMIT
      ) {
        stopReason ??= "spend-limit";
        ledger.c1[index] = { status: "omitted", micros: 0, reason: stopReason };
        persist();
        continue;
      }
      ledger.c1[index] = { status: "reserved", micros: reservation };
      persist();
      let row: BaselineRow;
      try {
        const gt = groundTruth(params);
        const prepared = await options.prepare(structuredClone(target), RESET_SNAPSHOT);
        row = await runC1Trial(
          {
            index,
            params,
            cellRef: gt.cellRef,
            expected: gt.expectedValue,
            previousValue: gt.previousValue,
          },
          prepared,
          planner,
        );
      } catch (error) {
        const failed = error instanceof PlannerFailure;
        if (failed) stopReason = "planner-failed";
        // Carry the message into the cause for BOTH branches: a bare
        // `trial-interrupted` made every distinct prepare failure look like the
        // same cause, so abort-early fired on two *different* faults and the
        // ledger could not say which. The cause string is the diagnosis.
        // `trial-interrupted` remains the recorded reason for an unexpected
        // throw (runC1Trial swallows PlannerFailure inside its own try, so in
        // practice only prepare() throws here), but the cause carries detail.
        noteCause(
          failed
            ? `planner-failed:${error.message}`
            : `trial-interrupted:${(error as Error)?.message ?? String(error)}`,
        );
        ledger.c1[index] = {
          status: "omitted",
          micros: reservation,
          reason: failed ? "planner-failed" : "trial-interrupted",
          ...(failed ? { detail: error.message } : {}),
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
        noteCause(`scored:${row.verdict}:${row.verdictReason}:actions=${actionSignature(row)}`);
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
      rows,
    };
    writeJson(join(directory, "report.json"), report);
    return report;
  } finally {
    rmdirSync(lock);
  }
}
