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
