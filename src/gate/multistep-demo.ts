/**
 * Multi-step Calc with one retry, end to end on the mock transport (TIF-270 / M2-07).
 * No VM, no model, no network. Every row is labelled `mock`; none of it is evidence.
 *
 * Roles, as in `demo.ts`:
 *  - the operator writes the task (`calc-multi-step`: a host-generated fixture and three
 *    edits) into a tasks file and starts one gate MCP process per trial, bound to it;
 *  - the harness (`runMultiStepTrial`) restores the guest document to a checkpoint
 *    (pristine + the first k steps, generated on the host), runs the agent, captures the
 *    saved document into the evidence root after the agent stopped, and asks the gate;
 *  - a scripted fake agent drives the fake Calc app (`FakeSpreadsheetApp`, CSV on the mock
 *    guest's disk): it finds each record and column by looking at the sheet, sets the
 *    cell, and saves. Its script decides where it slips.
 *
 * Scenarios, each run twice: with one retry (R6's arm) and without (the paired arm):
 *  - `slip-then-repair`: step 2 gets a typo. Checkpoint 1 holds, 2 and 3 are refuted; the
 *    retry restores checkpoint 1 and the agent redoes steps 2-3: verified on the retry.
 *  - `collateral-twice`: every step is right, but the agent also overwrites a cell no step
 *    targets, both times. The whole-document check refutes every checkpoint
 *    (DOCUMENT_COLLATERAL); the retry restarts from the pristine fixture and fails again:
 *    refuted.
 *  - `clean`: verified on the first attempt; no retry is used.
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeSpreadsheetApp } from "../fake/app.ts";
import { dataRowsForSeed, FIXTURE_COLUMNS } from "../tasks/fixture.ts";
import type { GateResult } from "./api.ts";
import { type CellEdit, documentCsv } from "./calc-document.ts";
import { openBoundGate } from "./demo.ts";
import type { CalcMultiStepSpec } from "./families.ts";
import { type MultiStepTrialRecord, runMultiStepTrial } from "./multistep.ts";

export const MS_TASK_ID = "calc-ms-demo";
export const MS_STATE_FILE = "sheet.csv";

/** The operator's task: host-generated fixture, three edits in three typed columns. */
export const MS_SPEC: CalcMultiStepSpec = {
  fixtureSeed: "ms-demo-seed",
  steps: [
    { rowKey: "EMP-0002", column: "name", newValue: "Ops Lead" },
    { rowKey: "EMP-0003", column: "qty", newValue: "4242" },
    { rowKey: "EMP-0004", column: "salary", newValue: "$61234.50" },
  ],
};

/** A cell no step targets, which the `collateral-twice` agent clobbers. */
const COLLATERAL_EDIT: CellEdit = { rowKey: "EMP-0001", column: "name", newValue: "Scratch Note" };

export interface MsScenario {
  readonly name: string;
  /** What the agent types on an attempt that starts from `fromCheckpoint`. */
  readonly script: (attempt: 1 | 2, fromCheckpoint: number) => readonly CellEdit[];
  readonly expect: { readonly retry: ExpectedTrial; readonly noRetry: ExpectedTrial };
}

export interface ExpectedTrial {
  readonly accepted: boolean;
  readonly attempts: number;
  /** Checkpoint the retry restored (when there is a retry). */
  readonly retryFrom?: number;
  /** A reason code the last gate result must carry. */
  readonly code: string;
}

const remaining = (from: number) => MS_SPEC.steps.slice(from);

export const MS_SCENARIOS: readonly MsScenario[] = [
  {
    name: "slip-then-repair",
    script: (attempt, from) =>
      attempt === 1
        ? remaining(from).map((step) =>
            step.column === "qty" ? { ...step, newValue: "4224" } : step,
          )
        : remaining(from),
    expect: {
      retry: { accepted: true, attempts: 2, retryFrom: 1, code: "ORACLE_PASS" },
      noRetry: { accepted: false, attempts: 1, code: "TARGET_MISMATCH" },
    },
  },
  {
    name: "collateral-twice",
    script: (_attempt, from) => [...remaining(from), COLLATERAL_EDIT],
    expect: {
      retry: { accepted: false, attempts: 2, retryFrom: 0, code: "DOCUMENT_COLLATERAL" },
      noRetry: { accepted: false, attempts: 1, code: "DOCUMENT_COLLATERAL" },
    },
  },
  {
    name: "clean",
    script: (_attempt, from) => remaining(from),
    expect: {
      retry: { accepted: true, attempts: 1, code: "ORACLE_PASS" },
      noRetry: { accepted: true, attempts: 1, code: "ORACLE_PASS" },
    },
  },
];

export interface MsRow {
  readonly scenario: string;
  readonly arm: "retry" | "no-retry";
  readonly runId: string;
  readonly provenance: "mock";
  readonly trial: MultiStepTrialRecord;
  readonly asExpected: boolean;
}

export interface MsReport {
  readonly ok: boolean;
  readonly evidenceRoot: string;
  readonly auditLog: string;
  readonly rows: readonly MsRow[];
  /** Verified trials per arm, with the denominator. Mock counts: not evidence. */
  readonly summary: {
    readonly retry: { readonly verified: number; readonly trials: number };
    readonly noRetry: { readonly verified: number; readonly trials: number };
  };
}

/** The scripted agent: open the guest sheet in the fake app, make its edits, save, stop. */
export async function scriptedAgent(guestFile: string, edits: readonly CellEdit[]): Promise<void> {
  const app = new FakeSpreadsheetApp({
    filePath: guestFile,
    rows: dataRowsForSeed(MS_SPEC.fixtureSeed) + 1,
    cols: FIXTURE_COLUMNS.length,
  });
  const state = await app.observe();
  const cells = state.nodes.filter((node) => node.role === "cell");
  const header = cells.filter((node) => /^[A-Z]+1$/.test(node.id));
  for (const edit of edits) {
    // Find the column by its header and the row by its key in column A, as an agent would.
    const column = header.find((node) => node.value === edit.column)?.id.replace(/\d+$/, "");
    const row = cells.find((node) => /^A\d+$/.test(node.id) && node.value === edit.rowKey)?.id;
    if (column === undefined || row === undefined) {
      throw new Error(`scripted agent cannot find ${edit.rowKey}/${edit.column}`);
    }
    const cell = `${column}${row.slice(1)}`;
    // A ref is valid for one state version, so the agent takes a fresh one per action.
    const refFor = (): string => {
      const ref = app.issueRef(cell);
      if (ref === null) throw new Error(`scripted agent cannot address ${cell}`);
      return ref;
    };
    await app.act({ kind: "click", ref: refFor() });
    await app.act({ kind: "setValue", ref: refFor(), value: edit.newValue });
  }
  await app.act({ kind: "keyPress", keys: "ctrl+s" });
}

function asExpected(trial: MultiStepTrialRecord, want: ExpectedTrial): boolean {
  const last = trial.attempts[trial.attempts.length - 1];
  return (
    trial.accepted === want.accepted &&
    trial.attempts.length === want.attempts &&
    (want.retryFrom === undefined || trial.attempts[1]?.fromCheckpoint === want.retryFrom) &&
    last?.reasonCodes.includes(want.code) === true
  );
}

export async function runMultiStepMockDemo(
  options: { readonly outDir?: string } = {},
): Promise<MsReport> {
  const outDir = options.outDir ?? mkdtempSync(join(tmpdir(), "myco-gate-ms-demo-"));
  const evidenceRoot = join(outDir, "evidence");
  const guestRoot = join(outDir, "guest");
  const auditLog = join(outDir, "gate-decisions.jsonl");
  const tasksFile = join(outDir, "tasks.json");
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(
    tasksFile,
    JSON.stringify({
      tasks: [
        { id: MS_TASK_ID, family: "calc-multi-step", stateFile: MS_STATE_FILE, spec: MS_SPEC },
      ],
    }),
  );

  const rows: MsRow[] = [];
  for (const scenario of MS_SCENARIOS) {
    for (const arm of ["retry", "no-retry"] as const) {
      const runId = `ms-${scenario.name}-${arm}`;
      const guestFile = join(guestRoot, runId, MS_STATE_FILE);
      const captured = join(evidenceRoot, runId, MS_STATE_FILE);
      mkdirSync(dirname(guestFile), { recursive: true });
      const gate = await openBoundGate(evidenceRoot, auditLog, { taskId: MS_TASK_ID, runId }, [
        "--tasks",
        tasksFile,
        "--no-builtin",
      ]);
      try {
        const trial = await runMultiStepTrial(
          {
            async restore(checkpoint) {
              // Harness: the checkpoint document is generated on the host from the spec.
              writeFileSync(
                guestFile,
                documentCsv(MS_SPEC.fixtureSeed, MS_SPEC.steps.slice(0, checkpoint)),
              );
            },
            async runAgent({ attempt, fromCheckpoint }) {
              await scriptedAgent(guestFile, scenario.script(attempt, fromCheckpoint));
              return { claim: `All ${MS_SPEC.steps.length} steps done and saved.` };
            },
            async capture() {
              // Harness, after the agent stopped: copy the saved file to the evidence root.
              mkdirSync(dirname(captured), { recursive: true });
              copyFileSync(guestFile, captured);
            },
            checkGate: (claim): Promise<GateResult> =>
              gate.call({ taskId: MS_TASK_ID, runId, claim }),
          },
          { retryBudget: arm === "retry" ? 1 : 0 },
        );
        rows.push({
          scenario: scenario.name,
          arm,
          runId,
          provenance: "mock",
          trial,
          asExpected: asExpected(
            trial,
            arm === "retry" ? scenario.expect.retry : scenario.expect.noRetry,
          ),
        });
      } finally {
        await gate.close();
      }
    }
  }
  const count = (arm: MsRow["arm"]) => {
    const armRows = rows.filter((row) => row.arm === arm);
    return { verified: armRows.filter((row) => row.trial.accepted).length, trials: armRows.length };
  };
  return {
    ok: rows.length === MS_SCENARIOS.length * 2 && rows.every((row) => row.asExpected),
    evidenceRoot,
    auditLog,
    rows,
    summary: { retry: count("retry"), noRetry: count("no-retry") },
  };
}

function checkpointText(trial: MultiStepTrialRecord["attempts"][number]): string {
  const cps = trial.checkpoints;
  if (!cps) return "-";
  return `${cps.verdicts.map((cp) => (cp.verdict === "verified" ? "V" : "R")).join("")} (last verified ${cps.lastVerified})`;
}

export function renderMultiStepDemo(report: MsReport): string {
  const lines = [
    "# myco-gate multi-step Calc, one retry (provenance: mock, no VM, no model)",
    "",
    "| Scenario | Arm | Attempt | From checkpoint | Checkpoints | Gate verdict | Reason codes | Final | As expected |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of report.rows) {
    for (const attempt of row.trial.attempts) {
      const last = attempt.attempt === row.trial.attempts.length;
      lines.push(
        `| ${row.scenario} | ${row.arm} | ${attempt.attempt} | ${attempt.fromCheckpoint} | ${checkpointText(attempt)} | ${attempt.verdict} | ${attempt.reasonCodes.join(", ")} | ${last ? (row.trial.accepted ? "DONE accepted" : "DONE rejected") : "retry"} | ${last ? (row.asExpected ? "yes" : "NO") : ""} |`,
      );
    }
  }
  const { retry, noRetry } = report.summary;
  lines.push(
    "",
    `verified (mock, not evidence): retry ${retry.verified}/${retry.trials}, no retry ${noRetry.verified}/${noRetry.trials}`,
    `evidence root: ${report.evidenceRoot}`,
    `decision log: ${report.auditLog}`,
    report.ok ? "DEMO: PASS" : "DEMO: FAIL",
  );
  return `${lines.join("\n")}\n`;
}
