/**
 * TIF-268 - the `hcu+shell` head-to-head RUNNER: R2's other arm, over fc-v1's 30-task demo
 * subset, on the Claude subscription. CLI: `scripts/m2-hcu-shell-run.ts`. Runbook:
 * `docs/benchmark/hcu-shell-runbook.md`.
 *
 * What this module owns (the live VM wiring is `./live-vm.ts`, behind `TrialEnvironment`):
 *  - **The plan and its hash.** Everything that defines the arm (task ids, model, planner
 *    argv and environment, step budget, ceiling, snapshot, the guest helper's hash) is one
 *    canonical JSON object; `planSha256` is what the operator passes back, what the lead's GO
 *    names, and what a resume must match.
 *  - **A durable ledger** (`ledger.jsonl`, fsync'd appends): a header (plan hash, simulated or
 *    live), then per trial `start` and `decided` / `failed`, and a final `halt` or `abort`.
 *    Resume (`resume: true`) skips decided trials and refuses a ledger written for another
 *    plan or the other mode (simulated rows never enter a live run, or the reverse).
 *  - **Stop rules.** A `PlannerHalt` (auth, credit/billing/quota, API-key path, model
 *    mismatch) or a non-cold reset boot (#546) halts the run at once with its code; two
 *    failed trials in a row with the same failure code abort it. Neither retries anything.
 *  - **A watchdog-friendly progress file** (`progress.json`, replaced atomically on every
 *    event): status, pid, counts, the current trial, the last failure and the stop code.
 *  - **The pack** (`exportHcuPack`): `arm.jsonl` and `requests.jsonl` for TIF-267's grader,
 *    keyed to fc-v1 by `armRowForTask` / `gradeRequestForTask` (#491), with the host-captured
 *    document bytes under `docs/` and the published fixtures under `fixtures/`. The runner
 *    computes NO verdict: ground truth is `scripts/benchmark-grade.ts` over `requests.jsonl`.
 *    Cost is the planner's token-derived estimate, null (never 0) when any call is unpriced.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "../../pilot/config.ts";
import type { CalcRecordEditParams } from "../../tasks/intent.ts";
import { OUTPUT_CEILING } from "../hcu-shell/decision.ts";
import {
  armRowForTask,
  gradeRequestForTask,
  type HcuShellArmRow,
  type PublishedTask,
} from "../hcu-shell/ledger.ts";
import {
  type HcuShellPlanner,
  type HcuShellRow,
  isHcuShellRow,
  type PreparedHcuShell,
  runHcuShellTrial,
  STEP_BUDGET,
} from "../hcu-shell/trial.ts";
import type { BaselineRow } from "../index.ts";
import {
  HCU_PLANNER_MODEL,
  PLANNER_ARGV,
  PLANNER_DIFFERENCES,
  PLANNER_FIXED_ENV,
  PlannerHalt,
} from "./planner.ts";

export const RUN_PLAN_SCHEMA = "myco.hcu-shell.run-plan/1" as const;
export const LEDGER_FILE = "ledger.jsonl";
export const PROGRESS_FILE = "progress.json";
export const TASK_BUNDLE = "benchmark/false-completion/fc-v1";
export const DEMO_TRIALS = 30;
/** The snapshot every trial resets to (`scripts/reset-trial-vm.sh` default, TIF-98). */
export const TRIAL_SNAPSHOT = "trial-base-v3";
/** The planner id on simulated rows: never a Claude model id, so `--evidence` refuses it. */
export const SIMULATED_PLANNER = "simulated:hcu-shell-dry-run";

/** One published fc-v1 task row (`myco.benchmark.task/1`), as the runner reads it. */
export interface FcTask extends PublishedTask {
  readonly family: string;
  readonly instruction: string;
  readonly fixtureSeed: string;
  readonly inDemo: boolean;
  readonly satisfiable: boolean;
  readonly persistedFormat: string;
}

export function loadFcV1(repoRoot: string): FcTask[] {
  return readFileSync(join(repoRoot, TASK_BUNDLE, "tasks.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l) as FcTask);
}

/** R2's paired set: fc-v1's demo subset, by task id. Exactly 30 or it throws. */
export function demoTasks(tasks: readonly FcTask[]): FcTask[] {
  const demo = tasks
    .filter((t) => t.taskSetVersion === "fc-v1" && t.inDemo)
    .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  if (demo.length !== DEMO_TRIALS)
    throw new Error(`fc-v1 has ${demo.length} demo tasks; R2 needs ${DEMO_TRIALS}`);
  return demo;
}

export interface HcuRunPlan {
  readonly schema: typeof RUN_PLAN_SCHEMA;
  readonly arm: "hcu+shell";
  readonly taskSetVersion: "fc-v1";
  readonly taskIds: readonly string[];
  readonly plannerModel: string;
  readonly plannerCommand: "claude";
  readonly plannerArgv: readonly string[];
  readonly plannerFixedEnv: Readonly<Record<string, string>>;
  readonly plannerDifferences: readonly string[];
  readonly billing: "claude-subscription; no API key path";
  readonly stepBudget: number;
  readonly outputCeiling: number;
  readonly snapshot: string;
  readonly hcuGuestCommand: string;
  readonly guestShellSha256: string;
  readonly faults: "recorded, not injected (as the myco-gate pilot runner)";
  readonly cost: "token-derived estimate at frozen rates; not billed USD";
}

export function hcuRunPlan(
  tasks: readonly FcTask[],
  guest: { readonly hcuGuestCommand: string; readonly guestShellSha256: string },
): HcuRunPlan {
  return {
    schema: RUN_PLAN_SCHEMA,
    arm: "hcu+shell",
    taskSetVersion: "fc-v1",
    taskIds: tasks.map((t) => t.taskId),
    plannerModel: HCU_PLANNER_MODEL,
    plannerCommand: "claude",
    plannerArgv: PLANNER_ARGV,
    plannerFixedEnv: PLANNER_FIXED_ENV,
    plannerDifferences: PLANNER_DIFFERENCES,
    billing: "claude-subscription; no API key path",
    stepBudget: STEP_BUDGET,
    outputCeiling: OUTPUT_CEILING,
    snapshot: TRIAL_SNAPSHOT,
    hcuGuestCommand: guest.hcuGuestCommand,
    guestShellSha256: guest.guestShellSha256,
    faults: "recorded, not injected (as the myco-gate pilot runner)",
    cost: "token-derived estimate at frozen rates; not billed USD",
  };
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const planSha256 = (plan: HcuRunPlan) => sha256(canonicalJson(plan));

/** What one trial's environment hands the loop. */
export interface PreparedTrial {
  readonly prepared: PreparedHcuShell;
  /** The params the instruction is rendered from: the task's intent and fixture seed. */
  readonly params: CalcRecordEditParams;
  /** The arm's internal judge target (a stand-in cell for an unsatisfiable task). */
  readonly target: Pick<BaselineRow, "cellRef" | "expected" | "previousValue">;
  /** #546's boot class of this trial's reset; null when not measured. */
  readonly bootClass: "cold" | "fast" | null;
  /** Reap the guest after the trial (best effort). */
  release(): Promise<void>;
}

export interface TrialEnvironment {
  /** A simulated environment may only write simulated runs; a live one only live runs. */
  readonly simulated: boolean;
  prepare(task: FcTask, trialKey: string): Promise<PreparedTrial>;
}

export class HcuRunRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "HcuRunRefusal";
  }
}

export type HcuRunStatus = "running" | "complete" | "incomplete" | "halted" | "aborted";

export interface HcuRunOptions {
  readonly outDir: string;
  readonly repoRoot: string;
  readonly tasks: readonly FcTask[];
  readonly plan: HcuRunPlan;
  readonly env: TrialEnvironment;
  readonly planner: HcuShellPlanner;
  /** The model id the arm row records: `HCU_PLANNER_MODEL` live, `SIMULATED_PLANNER` simulated. */
  readonly plannerModelId: string;
  /** Continue an existing run directory (`--resume`); without it an existing ledger refuses. */
  readonly resume?: boolean;
  /** Stop after this many trials in this invocation (practice pause/resume). */
  readonly maxTrials?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface HcuRunResult {
  readonly status: Exclude<HcuRunStatus, "running">;
  readonly code: string | null;
  readonly decided: number;
  readonly failed: number;
  readonly total: number;
}

export const trialKeyFor = (task: FcTask, simulated: boolean) =>
  `${simulated ? "sim-" : ""}hcu-shell-${task.taskId}`;

type LedgerRecord =
  | { type: "header"; schema: typeof RUN_PLAN_SCHEMA; planSha256: string; simulated: boolean }
  | { type: "start"; trialKey: string; taskId: string; at: number }
  | {
      type: "decided";
      trialKey: string;
      taskId: string;
      rowSha256: string;
      persistedSha256: string | null;
      bootClass: "cold" | "fast" | null;
      at: number;
    }
  | { type: "failed"; trialKey: string; taskId: string; code: string; at: number }
  | { type: "halt"; code: string; trialKey: string | null; at: number }
  | { type: "abort"; code: string; trialKey: string; at: number };

/** Append one ledger line and fsync it: a decided trial survives a crash right after. */
function appendDurable(path: string, record: LedgerRecord): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readLedger(outDir: string): LedgerRecord[] {
  const path = join(outDir, LEDGER_FILE);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const out: LedgerRecord[] = [];
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as LedgerRecord);
    } catch {
      // A torn final line (crash mid-append) is dropped; anything earlier is corruption.
      if (i === lines.length - 1 || lines.slice(i + 1).every((l) => l.trim() === "")) continue;
      throw new HcuRunRefusal("ledger-corrupt", `${path} line ${i + 1} is not JSON`);
    }
  }
  return out;
}

export interface Progress {
  readonly schema: "myco.hcu-shell.progress/1";
  readonly status: HcuRunStatus;
  readonly code: string | null;
  readonly planSha256: string;
  readonly simulated: boolean;
  readonly pid: number;
  readonly updatedAt: string;
  readonly total: number;
  readonly decided: number;
  readonly failed: number;
  readonly current: string | null;
  readonly lastFailure: string | null;
}

/** Replace `progress.json` atomically (write a sibling, then rename). */
export function writeProgress(outDir: string, progress: Progress): void {
  const path = join(outDir, PROGRESS_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(progress, null, 2)}\n`);
  renameSync(tmp, path);
}

const CODE = /^[a-z][a-z0-9-]{0,63}$/;
/** The failure code of a trial-level error: its own `code` when it carries one, else generic. */
export function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODE.test(code) ? code : "trial-error";
}

export async function runHcuShell(opts: HcuRunOptions): Promise<HcuRunResult> {
  const outDir = resolve(opts.outDir);
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => undefined);
  const simulated = opts.env.simulated;
  if (simulated !== opts.plannerModelId.startsWith("simulated:"))
    throw new HcuRunRefusal(
      "simulated-mismatch",
      "a simulated environment needs a simulated planner id, and a live one a real model id",
    );
  if (!simulated && opts.plannerModelId !== HCU_PLANNER_MODEL)
    throw new HcuRunRefusal("planner-model-mismatch", `live rows must use ${HCU_PLANNER_MODEL}`);
  const ids = opts.tasks.map((t) => t.taskId);
  if (canonicalJson(ids) !== canonicalJson(opts.plan.taskIds))
    throw new HcuRunRefusal("plan-tasks-mismatch", "the tasks are not the plan's tasks");
  const plan = planSha256(opts.plan);
  mkdirSync(join(outDir, "rows"), { recursive: true });
  mkdirSync(join(outDir, "docs"), { recursive: true });
  const ledgerPath = join(outDir, LEDGER_FILE);
  const existing = readLedger(outDir);
  if (existing.length > 0 && opts.resume !== true)
    throw new HcuRunRefusal(
      "run-exists",
      `${ledgerPath} exists; pass --resume to continue it, or use a new --out`,
    );
  if (existing.length === 0 && opts.resume === true)
    throw new HcuRunRefusal("nothing-to-resume", `${ledgerPath} does not exist`);
  if (existing.length > 0) {
    const header = existing[0];
    if (header?.type !== "header")
      throw new HcuRunRefusal("ledger-corrupt", "the ledger has no header");
    if (header.planSha256 !== plan)
      throw new HcuRunRefusal("resume-plan-mismatch", "the ledger was written for another plan");
    if (header.simulated !== simulated)
      throw new HcuRunRefusal(
        "resume-mode-mismatch",
        "simulated and live trials never share a run directory",
      );
  } else
    appendDurable(ledgerPath, {
      type: "header",
      schema: RUN_PLAN_SCHEMA,
      planSha256: plan,
      simulated,
    });

  const decidedKeys = new Set(
    existing.filter((r) => r.type === "decided").map((r) => (r as { trialKey: string }).trialKey),
  );
  let failed = 0;
  let lastFailure: string | null = null;
  let current: string | null = null;
  const progress = (status: HcuRunStatus, code: string | null) =>
    writeProgress(outDir, {
      schema: "myco.hcu-shell.progress/1",
      status,
      code,
      planSha256: plan,
      simulated,
      pid: process.pid,
      updatedAt: new Date(now()).toISOString(),
      total: opts.tasks.length,
      decided: decidedKeys.size,
      failed,
      current,
      lastFailure,
    });
  const finish = (status: HcuRunResult["status"], code: string | null): HcuRunResult => {
    current = null;
    progress(status, code);
    return { status, code, decided: decidedKeys.size, failed, total: opts.tasks.length };
  };
  progress("running", null);

  let ran = 0;
  for (const task of opts.tasks) {
    const trialKey = trialKeyFor(task, simulated);
    if (decidedKeys.has(trialKey)) continue;
    if (opts.maxTrials !== undefined && ran >= opts.maxTrials) break;
    ran++;
    current = trialKey;
    progress("running", null);
    appendDurable(ledgerPath, { type: "start", trialKey, taskId: task.taskId, at: now() });
    log(`trial ${trialKey}: start`);
    let trial: PreparedTrial | undefined;
    try {
      trial = await opts.env.prepare(task, trialKey);
      // #546's cold-boot guard: a live trial on anything but a recorded cold boot stops the run.
      if (!simulated && trial.bootClass !== "cold") {
        appendDurable(ledgerPath, {
          type: "halt",
          code: "boot-class-not-cold",
          trialKey,
          at: now(),
        });
        log(`HALTED: ${trialKey} reset boot class is ${String(trial.bootClass)}, not cold (#546)`);
        return finish("halted", "boot-class-not-cold");
      }
      let captured: Uint8Array | null = null;
      const inner = trial.prepared;
      const prepared: PreparedHcuShell = {
        ...inner,
        async capturePersisted() {
          const doc = await inner.capturePersisted();
          captured = doc?.bytes ?? null;
          return doc;
        },
      };
      const row = await runHcuShellTrial(
        { index: opts.tasks.indexOf(task), params: trial.params, ...trial.target },
        prepared,
        opts.planner,
      );
      if (!isHcuShellRow(row))
        throw new HcuRunRefusal("row-invalid", "the trial row did not validate");
      // Refuses a trial that did not run the published task (fixture, instruction, intent).
      armRowForTask(row, task, { trialKey, plannerModelId: opts.plannerModelId });
      const rowJson = `${JSON.stringify(row)}\n`;
      writeFileSync(join(outDir, "rows", `${trialKey}.json`), rowJson);
      if (captured !== null && row.persistedSha256 !== null)
        writeFileSync(
          join(outDir, "docs", `${trialKey}.${row.persistedFormat ?? "xlsx"}`),
          captured,
        );
      appendDurable(ledgerPath, {
        type: "decided",
        trialKey,
        taskId: task.taskId,
        rowSha256: sha256(rowJson),
        persistedSha256: row.persistedSha256,
        bootClass: trial.bootClass,
        at: now(),
      });
      decidedKeys.add(trialKey);
      lastFailure = null;
      log(`trial ${trialKey}: decided (claim ${row.claimedDone ? "done" : "not done"})`);
    } catch (error) {
      if (error instanceof PlannerHalt) {
        appendDurable(ledgerPath, { type: "halt", code: error.code, trialKey, at: now() });
        log(`HALTED: ${error.code} on ${trialKey}; no retry. Fix the cause, then --resume.`);
        return finish("halted", error.code);
      }
      const code = failureCode(error);
      failed++;
      appendDurable(ledgerPath, { type: "failed", trialKey, taskId: task.taskId, code, at: now() });
      log(`trial ${trialKey}: failed (${code})`);
      if (code === lastFailure) {
        appendDurable(ledgerPath, { type: "abort", code, trialKey, at: now() });
        log(`ABORTED: two failures in a row with ${code}; no retry. Fix the cause, then --resume.`);
        return finish("aborted", code);
      }
      lastFailure = code;
    } finally {
      try {
        await trial?.release();
      } catch {
        log(`trial ${trialKey}: guest release failed (the next reset clears it)`);
      }
    }
  }
  const complete = opts.tasks.every((t) => decidedKeys.has(trialKeyFor(t, simulated)));
  return finish(complete ? "complete" : "incomplete", null);
}

export interface HcuPack {
  readonly armRows: number;
  readonly requests: number;
  readonly simulated: boolean;
  readonly unmeasuredCost: number;
}

/** A row's cost is measured only when every planner call priced its tokens (R7: never 0). */
export function rowCostMeasured(row: HcuShellRow): boolean {
  return row.usage.length > 0 && row.usage.every((u) => typeof u.cost === "number");
}

/**
 * Build the grader's input from the decided trials: `arm.jsonl` + `requests.jsonl` (sorted by
 * task id), `fixtures/` copied from the published bundle. Every row is re-checked from disk:
 * its hash against the ledger, `isHcuShellRow`, the captured bytes against the row's hash,
 * and task parity (`armRowForTask`). Any mismatch throws; nothing partial is written.
 */
export function exportHcuPack(outDir: string, repoRoot: string, tasks: readonly FcTask[]): HcuPack {
  const dir = resolve(outDir);
  const ledger = readLedger(dir);
  const header = ledger[0];
  if (header?.type !== "header") throw new HcuRunRefusal("ledger-corrupt", "no ledger header");
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const decided = new Map<string, Extract<LedgerRecord, { type: "decided" }>>();
  for (const r of ledger) if (r.type === "decided") decided.set(r.trialKey, r);
  const armRows: HcuShellArmRow[] = [];
  const requests: ReturnType<typeof gradeRequestForTask>[] = [];
  const fixtures = new Set<string>();
  let unmeasured = 0;
  for (const rec of [...decided.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1))) {
    const task = byId.get(rec.taskId);
    if (task === undefined) throw new HcuRunRefusal("unknown-task", rec.taskId);
    const text = readFileSync(join(dir, "rows", `${rec.trialKey}.json`), "utf8");
    if (sha256(text) !== rec.rowSha256)
      throw new HcuRunRefusal("row-tampered", `${rec.trialKey}: row differs from the ledger`);
    const row = JSON.parse(text) as unknown;
    if (!isHcuShellRow(row)) throw new HcuRunRefusal("row-invalid", rec.trialKey);
    let persistedFile: string | null = null;
    if (row.persistedSha256 !== null) {
      persistedFile = `docs/${rec.trialKey}.${row.persistedFormat ?? "xlsx"}`;
      if (sha256(readFileSync(join(dir, persistedFile))) !== row.persistedSha256)
        throw new HcuRunRefusal("document-tampered", `${rec.trialKey}: captured bytes changed`);
    }
    const plannerModelId = header.simulated ? SIMULATED_PLANNER : HCU_PLANNER_MODEL;
    const arm = armRowForTask(row, task, { trialKey: rec.trialKey, plannerModelId });
    const measured = rowCostMeasured(row);
    if (!measured) unmeasured++;
    armRows.push(measured ? arm : { ...arm, cost: { ...arm.cost, modelUsd: null } });
    requests.push(gradeRequestForTask(row, task, { trialKey: rec.trialKey, persistedFile }));
    fixtures.add(task.fixtureFile);
  }
  for (const f of fixtures) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(repoRoot, TASK_BUNDLE, f), join(dir, f));
  }
  const jsonl = (rows: readonly unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");
  writeFileSync(join(dir, "arm.jsonl"), jsonl(armRows));
  writeFileSync(join(dir, "requests.jsonl"), jsonl(requests));
  return {
    armRows: armRows.length,
    requests: requests.length,
    simulated: header.simulated,
    unmeasuredCost: unmeasured,
  };
}

/**
 * Summary for `status`. Counts and the cost ESTIMATE only: no success or false-done rate,
 * because ground truth comes only from the independent grader over the exported pack.
 */
export function hcuStatus(outDir: string): Record<string, unknown> {
  const dir = resolve(outDir);
  const ledger = readLedger(dir);
  const progressPath = join(dir, PROGRESS_FILE);
  const progress = existsSync(progressPath)
    ? (JSON.parse(readFileSync(progressPath, "utf8")) as unknown)
    : null;
  const decided = ledger.filter((r) => r.type === "decided") as Extract<
    LedgerRecord,
    { type: "decided" }
  >[];
  let total: number | null = 0;
  for (const d of decided) {
    const row = JSON.parse(
      readFileSync(join(dir, "rows", `${d.trialKey}.json`), "utf8"),
    ) as HcuShellRow;
    total = total === null || !rowCostMeasured(row) ? null : total + row.cost;
  }
  return {
    progress,
    decided: decided.length,
    failedAttempts: ledger.filter((r) => r.type === "failed").length,
    stop: ledger.filter((r) => r.type === "halt" || r.type === "abort").at(-1) ?? null,
    cost: {
      basis: "token-derived estimate at frozen rates; not billed USD",
      estimatedModelUsd: decided.length === 0 ? null : total,
    },
    groundTruth:
      "not computed here: run scripts/benchmark-grade.ts on the exported requests.jsonl, then scripts/benchmark-check.ts",
  };
}
