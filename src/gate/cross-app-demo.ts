/**
 * Cross-app task, end to end, with a checkpoint per step and one retry (capability track
 * P, tier 2). No VM, no model, no network: a scripted agent drives an actuator, and every
 * row is `scripted` provenance, never evidence.
 *
 * Roles (as in `multistep-demo.ts`):
 *  - the operator registers the task (`cross-app-steps`) and builds one gate per trial,
 *    bound to it;
 *  - the harness (`runMultiStepTrial`, the existing one-retry loop, reused as is) restores
 *    the guest documents to a checkpoint (pristine + the first k steps, generated on the
 *    host), runs the agent step by step, and after the agent stops each step copies BOTH task
 *    documents into the trial's evidence (`step-<k>/`); after the last stop it copies them
 *    again (`end/`) and asks the gate. On a retry it first deletes the captures of the
 *    steps it is about to redo, so a stale capture can never stand in for one;
 *  - the scripted agent reads the source notice (PDF), observes the sheet, and acts only
 *    through the actuator: `fakeCrossAppActuator` (in-process file edits, hermetic) or the
 *    real headless LibreOffice Calc and Writer (`src/linux/cross-app-actuator.ts`). Its
 *    script decides where it slips.
 *
 * The agent's only input to the gate is `{ taskId, runId, claim }`; the checkpoint a retry
 * restores is the gate's own `checkpoints.lastVerified`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CROSS_APP_FAMILY,
  CROSS_APP_STATE_FILE,
  type CrossAppSpec,
  END_DIR,
  fieldLabel,
  noticePdf,
  REPORT_FILE,
  reportAt,
  SHEET_FILE,
  SOURCE_FILE,
  sheetAt,
  sourceLines,
  stepDir,
} from "../tasks/cross-app.ts";
import type { GateResult } from "./api.ts";
import { type MultiStepTrialRecord, runMultiStepTrial } from "./multistep.ts";

/** What the scripted agent can do to the apps. Each call saves the document it changed. */
export interface CrossAppActuator {
  readonly name: string;
  /** Calc: type `value` into cell `ref` (A1) of the sheet at `sheetPath`, then save. */
  calcSet(sheetPath: string, ref: string, value: string): void;
  /** Writer: type `text` at the end of the line that starts with `label`, then save. */
  writerAppend(reportPath: string, label: string, text: string): void;
}

/** A1 ref of a 0-based (row, col). */
export function a1(row: number, col: number): string {
  let n = col + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `${letters}${row + 1}`;
}

/** In-process stand-in for Calc and Writer: edits the saved files the way the apps save them. */
export const fakeCrossAppActuator: CrossAppActuator = {
  name: "fake",
  calcSet(sheetPath, ref, value) {
    const match = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!match) throw new Error(`bad ref ${ref}`);
    const col = [...(match[1] as string)].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const row = Number(match[2]) - 1;
    const lines = readFileSync(sheetPath, "utf8").replace(/\n$/, "").split("\n");
    const cells = (lines[row] ?? "").split(",");
    while (cells.length <= col) cells.push("");
    cells[col] = value;
    lines[row] = cells.join(",");
    writeFileSync(sheetPath, `${lines.join("\n")}\n`);
  },
  writerAppend(reportPath, label, text) {
    const lines = readFileSync(reportPath, "utf8").split("\n");
    const index = lines.findIndex((line) => line.startsWith(label));
    if (index === -1) throw new Error(`no line starts with ${label}`);
    lines[index] = `${lines[index]}${text}`;
    writeFileSync(reportPath, lines.join("\n"));
  },
};

// ---------------------------------------------------------------------------
// The scripted agent
// ---------------------------------------------------------------------------

/** What the agent reads off the notice: the text lines of a simple PDF's content stream. */
export function readNotice(pdf: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const m of pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)) {
    const line = (m[1] as string).replace(/\\(.)/g, "$1");
    const entry = /^Record (\S+), column (\S+): (.+)$/.exec(line);
    if (entry) values.set(`${entry[1]} ${entry[2]}`, entry[3] as string);
  }
  return values;
}

/** Where record `rowKey`, column `column` is in the sheet, as the agent sees it. */
export function locateCell(sheetCsv: string, rowKey: string, column: string): string {
  const rows = sheetCsv.split(/\r?\n/).map((line) => line.split(","));
  const col = (rows[0] ?? []).indexOf(column);
  const row = rows.findIndex((cells, i) => i > 0 && cells[0] === rowKey);
  if (col < 1 || row < 1) throw new Error(`agent cannot find ${rowKey}/${column}`);
  return a1(row, col);
}

/** A deliberate slip the script makes. */
export interface Slip {
  readonly step: number;
  /**
   * `wrong-value`: the step's first edit gets a near-miss value (last digit changed).
   * `collateral`: the step's edits are right, and the agent also changes something no step
   *   targets (a sheet cell on a calc step, the report's `Sheet:` line on a writer step).
   * `repair-earlier`: during this step the agent also re-enters every earlier calc value
   *   correctly (it notices and fixes an earlier slip, after that step's capture).
   */
  readonly kind: "wrong-value" | "collateral" | "repair-earlier";
}

export function nearMiss(value: string): string {
  const i = value.search(/\d(?=\D*$)/);
  if (i === -1) return `${value}X`;
  return `${value.slice(0, i)}${(Number(value[i]) + 1) % 10}${value.slice(i + 1)}`;
}

/** Do step `k` of `spec` in the guest directory, with the slips that apply to it. */
export function scriptedStep(
  spec: CrossAppSpec,
  guest: string,
  k: number,
  actuator: CrossAppActuator,
  slips: readonly Slip[],
): void {
  const step = spec.steps[k - 1];
  if (!step) throw new Error(`no step ${k}`);
  const sheetPath = join(guest, SHEET_FILE);
  const reportPath = join(guest, REPORT_FILE);
  const notice = readNotice(readFileSync(join(guest, SOURCE_FILE), "latin1"));
  const slip = (kind: Slip["kind"]) => slips.some((s) => s.step === k && s.kind === kind);
  const value = (i: number, source: string) =>
    i === 0 && slip("wrong-value") ? nearMiss(source) : source;
  if (step.app === "calc") {
    step.edits.forEach((edit, i) => {
      const read = notice.get(fieldLabel(edit));
      if (read === undefined)
        throw new Error(`agent cannot find ${fieldLabel(edit)} in the notice`);
      const ref = locateCell(readFileSync(sheetPath, "utf8"), edit.rowKey, edit.column);
      actuator.calcSet(sheetPath, ref, value(i, read));
    });
    if (slip("collateral")) {
      const targeted = new Set(
        spec.steps.flatMap((s) => (s.app === "calc" ? s.edits.map((e) => e.rowKey) : [])),
      );
      const rows = readFileSync(sheetPath, "utf8").split("\n");
      const victim = rows.findIndex((line, i) => i > 0 && !targeted.has(line.split(",")[0] ?? ""));
      actuator.calcSet(sheetPath, a1(victim, 1), "Scratch Note");
    }
  } else {
    step.edits.forEach((edit, i) => {
      // Calc -> Writer: the agent reports the value it now sees in the sheet.
      const sheet = readFileSync(sheetPath, "utf8");
      const ref = locateCell(sheet, edit.rowKey, edit.column);
      const m = /^([A-Z]+)(\d+)$/.exec(ref) as RegExpExecArray;
      const col = [...(m[1] as string)].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const seen = sheet.split(/\r?\n/)[Number(m[2]) - 1]?.split(",")[col] ?? "";
      actuator.writerAppend(reportPath, `${fieldLabel(edit)}:`, ` ${value(i, seen)}`);
    });
    if (slip("collateral")) actuator.writerAppend(reportPath, "Sheet:", " (draft)");
  }
  if (slip("repair-earlier")) {
    for (const earlier of spec.steps.slice(0, k - 1)) {
      if (earlier.app !== "calc") continue;
      for (const edit of earlier.edits) {
        const read = notice.get(fieldLabel(edit)) as string;
        const ref = locateCell(readFileSync(sheetPath, "utf8"), edit.rowKey, edit.column);
        actuator.calcSet(sheetPath, ref, read);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export interface CrossAppTrialOptions {
  readonly spec: CrossAppSpec;
  /** The guest's working directory (the agent's documents). */
  readonly guestDir: string;
  /** The trial's evidence location: `<evidenceRoot>/<runId>`. The agent never writes here. */
  readonly evidenceDir: string;
  readonly actuator: CrossAppActuator;
  /** Slips per attempt. */
  readonly slips: (attempt: 1 | 2) => readonly Slip[];
  readonly retryBudget: 0 | 1;
  /** The gate bound to this trial: the agent's request is `{ taskId, runId, claim }` only. */
  readonly checkGate: (claim: string) => Promise<GateResult>;
}

function snapshotTo(guestDir: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const file of [SHEET_FILE, REPORT_FILE]) {
    if (existsSync(join(guestDir, file))) copyFileSync(join(guestDir, file), join(dir, file));
  }
}

export async function runCrossAppTrial(opts: CrossAppTrialOptions): Promise<MultiStepTrialRecord> {
  const { spec, guestDir, evidenceDir, actuator } = opts;
  const n = spec.steps.length;
  const pdf = noticePdf(sourceLines(spec));
  return runMultiStepTrial(
    {
      async restore(checkpoint) {
        // Host-generated checkpoint documents; the notice is the registered (sealed) bytes,
        // given to the guest and placed in the evidence beside the captures.
        mkdirSync(guestDir, { recursive: true });
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(join(guestDir, SHEET_FILE), sheetAt(spec, checkpoint));
        writeFileSync(join(guestDir, REPORT_FILE), reportAt(spec, checkpoint));
        writeFileSync(join(guestDir, SOURCE_FILE), pdf, "latin1");
        writeFileSync(join(evidenceDir, SOURCE_FILE), pdf, "latin1");
        // The steps about to be redone, and the end state, are captured afresh.
        for (let k = checkpoint + 1; k <= n; k++)
          rmSync(join(evidenceDir, stepDir(k)), { recursive: true, force: true });
        rmSync(join(evidenceDir, END_DIR), { recursive: true, force: true });
      },
      async runAgent({ attempt, fromCheckpoint }) {
        for (let k = fromCheckpoint + 1; k <= n; k++) {
          scriptedStep(spec, guestDir, k, actuator, opts.slips(attempt));
          // Harness, after the agent stopped this step: snapshot both documents.
          snapshotTo(guestDir, join(evidenceDir, stepDir(k)));
        }
        return { claim: `All ${n} steps done and saved.` };
      },
      async capture() {
        snapshotTo(guestDir, join(evidenceDir, END_DIR));
      },
      checkGate: opts.checkGate,
    },
    { retryBudget: opts.retryBudget },
  );
}

/** The operator's task entry for a spec. */
export function crossAppTaskEntry(id: string, spec: CrossAppSpec) {
  return { id, family: CROSS_APP_FAMILY, stateFile: CROSS_APP_STATE_FILE, spec };
}

// ---------------------------------------------------------------------------
// Scenarios (acceptance bar items 2 and 5)
// ---------------------------------------------------------------------------

export interface CrossAppScenario {
  readonly name: string;
  readonly slips: (attempt: 1 | 2) => readonly Slip[];
  readonly retryBudget: 0 | 1;
  readonly expect: {
    readonly accepted: boolean;
    readonly attempts: 1 | 2;
    /** The gate's `lastVerified` on the last attempt (= the failing step - 1 when refuted). */
    readonly lastVerified: number;
    /** A reason code the last result carries. */
    readonly code: string;
    /** The step named first in the last result's reasons (refuted only). */
    readonly firstReason?: string;
    readonly retryFrom?: number;
  };
}

const always =
  (...slips: Slip[]) =>
  () =>
    slips;

export const CROSS_APP_SCENARIOS: readonly CrossAppScenario[] = [
  {
    name: "clean",
    slips: always(),
    retryBudget: 0,
    expect: { accepted: true, attempts: 1, lastVerified: 3, code: "ORACLE_PASS" },
  },
  {
    name: "wrong-value-step-1",
    slips: always({ step: 1, kind: "wrong-value" }),
    retryBudget: 0,
    expect: {
      accepted: false,
      attempts: 1,
      lastVerified: 0,
      code: "TARGET_MISMATCH",
      firstReason: "step 1 (sheet.csv): TARGET_MISMATCH",
    },
  },
  {
    name: "wrong-value-step-2",
    slips: always({ step: 2, kind: "wrong-value" }),
    retryBudget: 0,
    expect: {
      accepted: false,
      attempts: 1,
      lastVerified: 1,
      code: "TARGET_MISMATCH",
      firstReason: "step 2 (sheet.csv): TARGET_MISMATCH",
    },
  },
  {
    name: "wrong-value-step-3",
    slips: always({ step: 3, kind: "wrong-value" }),
    retryBudget: 0,
    expect: {
      accepted: false,
      attempts: 1,
      lastVerified: 2,
      code: "TARGET_MISMATCH",
      firstReason: "step 3 (report.txt): TARGET_MISMATCH",
    },
  },
  {
    name: "collateral-step-2",
    slips: always({ step: 2, kind: "collateral" }),
    retryBudget: 0,
    expect: {
      accepted: false,
      attempts: 1,
      lastVerified: 1,
      code: "DOCUMENT_COLLATERAL",
      firstReason: "step 2 (sheet.csv): DOCUMENT_COLLATERAL",
    },
  },
  {
    name: "collateral-step-3",
    slips: always({ step: 3, kind: "collateral" }),
    retryBudget: 0,
    expect: {
      accepted: false,
      attempts: 1,
      lastVerified: 2,
      code: "DOCUMENT_COLLATERAL",
      firstReason: "step 3 (report.txt): DOCUMENT_COLLATERAL",
    },
  },
  {
    // A later step never masks an earlier failure: step 1 is wrong in its own capture, the
    // agent fixes it during step 2, and the end state is correct. Still refuted at step 1.
    name: "masked-step-1",
    slips: always({ step: 1, kind: "wrong-value" }, { step: 2, kind: "repair-earlier" }),
    retryBudget: 0,
    expect: {
      accepted: false,
      attempts: 1,
      lastVerified: 0,
      code: "TARGET_MISMATCH",
      firstReason: "step 1 (sheet.csv): TARGET_MISMATCH",
    },
  },
  {
    // One retry from the last verified checkpoint: step 2 slips, checkpoint 1 holds, the
    // retry restores checkpoint 1 and redoes steps 2-3: verified on the retry.
    name: "slip-step-2-then-repair",
    slips: (attempt) => (attempt === 1 ? [{ step: 2, kind: "wrong-value" }] : []),
    retryBudget: 1,
    expect: { accepted: true, attempts: 2, lastVerified: 3, code: "ORACLE_PASS", retryFrom: 1 },
  },
  {
    // The budget is one retry: step 3 slips on both attempts, refuted after two.
    name: "slip-step-3-twice",
    slips: always({ step: 3, kind: "wrong-value" }),
    retryBudget: 1,
    expect: {
      accepted: false,
      attempts: 2,
      lastVerified: 2,
      code: "TARGET_MISMATCH",
      firstReason: "step 3 (report.txt): TARGET_MISMATCH",
      retryFrom: 2,
    },
  },
];

/** Does a trial match its scenario's expectation? Returns the mismatches (empty when it does). */
export function scenarioMismatches(
  trial: MultiStepTrialRecord,
  scenario: CrossAppScenario,
  lastResult?: GateResult,
): string[] {
  const want = scenario.expect;
  const last = trial.attempts[trial.attempts.length - 1];
  const out: string[] = [];
  if (trial.accepted !== want.accepted) out.push(`accepted ${trial.accepted}`);
  if (trial.attempts.length !== want.attempts) out.push(`attempts ${trial.attempts.length}`);
  if (last?.checkpoints?.lastVerified !== want.lastVerified)
    out.push(`lastVerified ${String(last?.checkpoints?.lastVerified)}`);
  if (!last?.reasonCodes.includes(want.code)) out.push(`codes ${last?.reasonCodes.join(",")}`);
  if (want.retryFrom !== undefined && trial.attempts[1]?.fromCheckpoint !== want.retryFrom)
    out.push(`retryFrom ${String(trial.attempts[1]?.fromCheckpoint)}`);
  if (want.firstReason !== undefined && !lastResult?.reasons[0]?.startsWith(want.firstReason))
    out.push(`first reason ${JSON.stringify(lastResult?.reasons[0])}`);
  return out;
}

export interface CrossAppScenarioRun {
  readonly scenario: string;
  readonly runId: string;
  readonly provenance: "scripted";
  readonly actuator: string;
  readonly trial: MultiStepTrialRecord;
  readonly results: readonly GateResult[];
  readonly mismatches: readonly string[];
}

/**
 * Run one scenario as one trial: `openGate` builds the gate bound to `{ taskId, runId }`
 * (in-process `createGate` or the MCP gate process); the harness does the rest.
 */
export async function runCrossAppScenario(opts: {
  readonly scenario: CrossAppScenario;
  readonly spec: CrossAppSpec;
  readonly taskId: string;
  readonly root: string;
  readonly actuator: CrossAppActuator;
  readonly openGate: (runId: string) => Promise<{
    check(request: { taskId: string; runId: string; claim: string }): Promise<GateResult>;
    close?(): Promise<void>;
  }>;
}): Promise<CrossAppScenarioRun> {
  const { scenario, spec, taskId, root, actuator } = opts;
  const runId = `xa-${scenario.name}`;
  const gate = await opts.openGate(runId);
  const results: GateResult[] = [];
  try {
    const trial = await runCrossAppTrial({
      spec,
      guestDir: join(root, "guest", runId),
      evidenceDir: join(root, "evidence", runId),
      actuator,
      slips: scenario.slips,
      retryBudget: scenario.retryBudget,
      async checkGate(claim) {
        const result = await gate.check({ taskId, runId, claim });
        results.push(result);
        return result;
      },
    });
    return {
      scenario: scenario.name,
      runId,
      provenance: "scripted",
      actuator: actuator.name,
      trial,
      results,
      mismatches: scenarioMismatches(trial, scenario, results[results.length - 1]),
    };
  } finally {
    await gate.close?.();
  }
}
