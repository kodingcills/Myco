/**
 * TIF-268: the hcu+shell runner over fake trial environments (the arm library's fake Calc
 * guest) and scripted planners. No VM, no model, no network: a trap `claude` is first on PATH
 * and fetch is trapped.
 *
 * Proves: rows key to fc-v1 (#491) and the published grader and check accept the pack; the
 * ledger resumes; two identical failures abort; a planner halt (auth / quota) and a non-cold
 * boot halt at once with no retry; the progress file tracks the run; the pack re-checks every
 * row and captured document from disk; unpriced cost is null, never 0.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkArmRowSchema } from "../../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../../schemas/validate.ts";
import type { HcuShellPlanner } from "../../../src/baseline/hcu-shell/trial.ts";
import {
  HCU_PLANNER_MODEL,
  PlannerHalt,
  SubscriptionPlannerFailure,
} from "../../../src/baseline/hcu-shell-live/planner.ts";
import {
  DEMO_TRIALS,
  demoTasks,
  exportHcuPack,
  type FcTask,
  hcuRunPlan,
  hcuStatus,
  LEDGER_FILE,
  loadFcV1,
  PROGRESS_FILE,
  planSha256,
  readLedger,
  runHcuShell,
  SIMULATED_PLANNER,
  TASK_BUNDLE,
  type TrialEnvironment,
} from "../../../src/baseline/hcu-shell-live/runner.ts";
import { groundTruth } from "../../../src/tasks/intent.ts";
import { fakeCalc } from "../hcu-shell/fake-calc.ts";
import { honest, type ScriptedPlanner } from "../hcu-shell/planners.ts";
import { useClaudeTrap, useFetchTrap } from "./helpers.ts";

useClaudeTrap();
useFetchTrap();

const ROOT = resolve(".");
const TASKS = demoTasks(loadFcV1(ROOT));
const PLAN = hcuRunPlan(TASKS, { hcuGuestCommand: "hcu mcp", guestShellSha256: "0".repeat(64) });
const tmp = () => mkdtempSync(join(tmpdir(), "hcu-run-"));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

interface Fake {
  env: TrialEnvironment;
  planner: HcuShellPlanner;
  prepared: string[];
  released: string[];
}

/**
 * A fake environment over the fake Calc guest. Each trial gets an honest scripted agent; the
 * outer planner relabels its calls with the run's model id. `fail` and `boot` inject faults.
 */
function fakeRun(
  opts: {
    simulated?: boolean;
    fail?: (task: FcTask, n: number) => Error | undefined;
    boot?: "cold" | "fast" | null;
    halt?: (task: FcTask) => PlannerHalt | undefined;
    priced?: boolean;
  } = {},
): Fake {
  const simulated = opts.simulated ?? true;
  const model = simulated ? SIMULATED_PLANNER : HCU_PLANNER_MODEL;
  let current: ScriptedPlanner | null = null;
  let haltNow: PlannerHalt | undefined;
  const prepared: string[] = [];
  const released: string[] = [];
  let n = 0;
  const env: TrialEnvironment = {
    simulated,
    async prepare(task) {
      prepared.push(task.taskId);
      const failure = opts.fail?.(task, n++);
      if (failure !== undefined) throw failure;
      haltNow = opts.halt?.(task);
      const csv = readFileSync(join(ROOT, TASK_BUNDLE, task.fixtureFile), "utf8");
      const params = { fixtureSeed: task.fixtureSeed, ...task.intent };
      const t = task.satisfiable
        ? (() => {
            const g = groundTruth(params);
            return {
              cellRef: g.cellRef,
              previousValue: g.previousValue,
              expected: g.expectedValue,
            };
          })()
        : {
            cellRef: "B2",
            previousValue: csv.split("\n")[1]?.split(",")[1] ?? "",
            expected: task.intent.newValue,
          };
      const fake = fakeCalc({ ...t, fixtureCsv: csv });
      current = honest(t.cellRef, task.intent.newValue);
      return {
        prepared: { ...fake.prepared, fixtureSha256: sha(csv) },
        params,
        target: t,
        bootClass: opts.boot === undefined ? "cold" : opts.boot,
        async release() {
          released.push(task.taskId);
        },
      };
    },
  };
  const planner: HcuShellPlanner = {
    paid: true,
    async act(turn) {
      if (haltNow !== undefined) throw haltNow;
      if (current === null) throw new Error("no trial");
      const r = await current.act(turn);
      return {
        ...r,
        calls: r.calls.map((c) => ({
          model,
          usage:
            opts.priced === false ? { prompt: 1 } : { prompt: 1000, completion: 20, cost: 0.0022 },
        })),
      };
    },
  };
  return { env, planner, prepared, released };
}

const run = (dir: string, fake: Fake, extra: Partial<Parameters<typeof runHcuShell>[0]> = {}) =>
  runHcuShell({
    outDir: dir,
    repoRoot: ROOT,
    tasks: TASKS,
    plan: PLAN,
    env: fake.env,
    planner: fake.planner,
    plannerModelId: fake.env.simulated ? SIMULATED_PLANNER : HCU_PLANNER_MODEL,
    ...extra,
  });

const progress = (dir: string) => JSON.parse(readFileSync(join(dir, PROGRESS_FILE), "utf8"));

describe("a full run keyed to fc-v1", () => {
  it("decides all 30 demo tasks and the published grader and check accept the pack", async () => {
    const dir = tmp();
    const r = await run(dir, fakeRun({ simulated: false }));
    expect(r).toEqual({
      status: "complete",
      code: null,
      decided: 30,
      failed: 0,
      total: DEMO_TRIALS,
    });
    const pack = exportHcuPack(dir, ROOT, TASKS);
    expect(pack).toMatchObject({ armRows: 30, requests: 30, simulated: false, unmeasuredCost: 0 });
    const arm = readFileSync(join(dir, "arm.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(arm.map((a) => a.taskId)).toEqual(TASKS.map((t) => t.taskId));
    for (const [i, row] of arm.entries()) {
      expect(validateSchema(benchmarkArmRowSchema, row), row.trialKey).toEqual([]);
      expect(row.taskSetVersion).toBe("fc-v1");
      expect(row.arm).toBe("hcu+shell");
      expect(row.faultClass).toBe(TASKS[i]?.faultClass);
      expect(row.instructionSha256).toBe(TASKS[i]?.instructionSha256);
      expect(row.fixtureSha256).toBe(TASKS[i]?.fixtureSha256);
      expect(row.plannerModelId).toBe(HCU_PLANNER_MODEL);
      expect(row.gate).toBeNull();
      expect(row.cost.modelUsd).toBeGreaterThan(0);
    }
    const grade = spawnSync(
      "npx",
      ["tsx", "scripts/benchmark-grade.ts", join(dir, "requests.jsonl")],
      {
        encoding: "utf8",
      },
    );
    expect(grade.status, grade.stderr).toBe(0);
    writeFileSync(join(dir, "grades.jsonl"), grade.stdout);
    const check = spawnSync(
      "npx",
      [
        "tsx",
        "scripts/benchmark-check.ts",
        "--arm",
        join(dir, "arm.jsonl"),
        "--grades",
        join(dir, "grades.jsonl"),
        "--expect",
        "hcu+shell=30",
        "--evidence",
      ],
      { encoding: "utf8" },
    );
    expect(check.status, check.stdout + check.stderr).toBe(0);
    const summary = JSON.parse(check.stdout);
    // Ground truth is the grader's: honest agents pass the 21 satisfiable tasks they edited
    // and fail the 3 invalid-target ones; the other 6 faulted tasks run unfaulted here.
    expect(summary.arms[0].graderPass).toBe(TASKS.filter((t) => t.satisfiable).length);
    // R1 is the myco-gate arm's rule; hcu+shell rows never feed it (rules unchanged).
    expect(summary.r1).toBeNull();
  }, 120_000);

  it("simulated rows never pass --evidence", async () => {
    const dir = tmp();
    await run(dir, fakeRun({ simulated: true }));
    exportHcuPack(dir, ROOT, TASKS);
    const grade = spawnSync(
      "npx",
      ["tsx", "scripts/benchmark-grade.ts", join(dir, "requests.jsonl")],
      { encoding: "utf8" },
    );
    writeFileSync(join(dir, "grades.jsonl"), grade.stdout);
    const check = spawnSync(
      "npx",
      [
        "tsx",
        "scripts/benchmark-check.ts",
        "--arm",
        join(dir, "arm.jsonl"),
        "--grades",
        join(dir, "grades.jsonl"),
        "--expect",
        "hcu+shell=30",
        "--evidence",
      ],
      { encoding: "utf8" },
    );
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("dry-run rows are never evidence");
  }, 120_000);

  it("status reports counts and a labelled cost estimate, never a verdict", async () => {
    const dir = tmp();
    await run(dir, fakeRun({ simulated: false }), { maxTrials: 2 });
    const s = hcuStatus(dir);
    expect(s.decided).toBe(2);
    expect(s.cost).toEqual({
      basis: "token-derived estimate at frozen rates; not billed USD",
      estimatedModelUsd: expect.any(Number),
    });
    expect(JSON.stringify(s)).not.toMatch(/verified|falseDone|pass/i);
  });
});

describe("resume", () => {
  it("continues where it stopped and decides each trial once", async () => {
    const dir = tmp();
    const a = fakeRun();
    expect((await run(dir, a, { maxTrials: 7 })).status).toBe("incomplete");
    expect(progress(dir)).toMatchObject({ status: "incomplete", decided: 7, current: null });
    const b = fakeRun();
    const r = await run(dir, b, { resume: true });
    expect(r).toMatchObject({ status: "complete", decided: 30 });
    expect(b.prepared).toEqual(TASKS.slice(7).map((t) => t.taskId));
    const decided = readLedger(dir).filter((l) => l.type === "decided");
    expect(decided).toHaveLength(30);
    expect(exportHcuPack(dir, ROOT, TASKS).armRows).toBe(30);
  });
  it("refuses an existing run without --resume, and --resume without a run", async () => {
    const dir = tmp();
    await run(dir, fakeRun(), { maxTrials: 1 });
    await expect(run(dir, fakeRun())).rejects.toMatchObject({ code: "run-exists" });
    await expect(run(tmp(), fakeRun(), { resume: true })).rejects.toMatchObject({
      code: "nothing-to-resume",
    });
  });
  it("refuses to resume under another plan, or across simulated and live", async () => {
    const dir = tmp();
    await run(dir, fakeRun(), { maxTrials: 1 });
    const other = hcuRunPlan(TASKS, {
      hcuGuestCommand: "other mcp",
      guestShellSha256: "0".repeat(64),
    });
    expect(planSha256(other)).not.toBe(planSha256(PLAN));
    await expect(run(dir, fakeRun(), { resume: true, plan: other })).rejects.toMatchObject({
      code: "resume-plan-mismatch",
    });
    await expect(run(dir, fakeRun({ simulated: false }), { resume: true })).rejects.toMatchObject({
      code: "resume-mode-mismatch",
    });
  });
  it("a failed trial is retried on resume", async () => {
    const dir = tmp();
    const r = await run(dir, fakeRun({ fail: (_t, n) => (n === 0 ? new Error("x") : undefined) }), {
      maxTrials: 2,
    });
    expect(r).toMatchObject({ decided: 1, failed: 1 });
    const b = fakeRun();
    await run(dir, b, { resume: true, maxTrials: 1 });
    expect(b.prepared).toEqual([TASKS[0]?.taskId]);
  });
  it("drops a torn final ledger line but refuses corruption earlier", async () => {
    const dir = tmp();
    await run(dir, fakeRun(), { maxTrials: 2 });
    const path = join(dir, LEDGER_FILE);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"type":"sta`);
    expect((await run(dir, fakeRun(), { resume: true, maxTrials: 1 })).decided).toBe(3);
    const lines = readFileSync(path, "utf8").split("\n");
    lines.splice(1, 0, "garbage");
    writeFileSync(path, lines.join("\n"));
    await expect(run(dir, fakeRun(), { resume: true })).rejects.toMatchObject({
      code: "ledger-corrupt",
    });
  });
});

describe("stop rules", () => {
  it("aborts after two identical failures in a row, with no retry", async () => {
    const dir = tmp();
    const err = () => Object.assign(new Error("guest down"), { code: "reset-failed" });
    const fake = fakeRun({ fail: () => err() });
    const r = await run(dir, fake);
    expect(r).toEqual({
      status: "aborted",
      code: "reset-failed",
      decided: 0,
      failed: 2,
      total: 30,
    });
    expect(fake.prepared).toHaveLength(2);
    expect(progress(dir)).toMatchObject({
      status: "aborted",
      code: "reset-failed",
      lastFailure: "reset-failed",
    });
    expect(readLedger(dir).at(-1)).toMatchObject({ type: "abort", code: "reset-failed" });
  });
  it("two different failures in a row do not abort; a success in between resets the count", async () => {
    const codes = ["a-code", "b-code", undefined, "b-code", undefined];
    const fake = fakeRun({
      fail: (_t, n) => {
        const c = codes[n];
        return c === undefined ? undefined : Object.assign(new Error(c), { code: c });
      },
    });
    const r = await run(tmp(), fake, { maxTrials: 5 });
    expect(r).toMatchObject({ status: "incomplete", failed: 3, decided: 2 });
  });
  it("a planner failure code counts toward the rule like any other", async () => {
    const fake = fakeRun();
    const planner: HcuShellPlanner = {
      paid: true,
      act: async () => {
        throw new SubscriptionPlannerFailure("planner-timeout", "deadline");
      },
    };
    const r = await run(tmp(), { ...fake, planner });
    expect(r).toMatchObject({ status: "aborted", code: "planner-timeout", failed: 2 });
  });
  it.each(["planner-auth", "planner-quota", "planner-api-key-path"] as const)(
    "a planner halt (%s) stops the run on the first trial, with no retry",
    async (code) => {
      const dir = tmp();
      const fake = fakeRun({ halt: () => new PlannerHalt(code, "x") });
      const r = await run(dir, fake);
      expect(r).toMatchObject({ status: "halted", code, decided: 0, failed: 0 });
      expect(fake.prepared).toHaveLength(1);
      expect(fake.released).toHaveLength(1);
      expect(progress(dir)).toMatchObject({ status: "halted", code });
      expect(readLedger(dir).at(-1)).toMatchObject({ type: "halt", code });
    },
  );
  it.each(["fast", null] as const)(
    "a live trial on a %s boot halts before the agent runs (#546)",
    async (boot) => {
      const dir = tmp();
      const fake = fakeRun({ simulated: false, boot });
      let acted = 0;
      const planner: HcuShellPlanner = { paid: true, act: async () => (acted++, { calls: [] }) };
      const r = await run(dir, { ...fake, planner });
      expect(r).toMatchObject({ status: "halted", code: "boot-class-not-cold", decided: 0 });
      expect(acted).toBe(0);
      expect(existsSync(join(dir, "rows", `hcu-shell-${TASKS[0]?.taskId}.json`))).toBe(false);
    },
  );
});

describe("refusals inside the runner", () => {
  it("never mixes simulated and live labels", async () => {
    await expect(
      run(tmp(), fakeRun({ simulated: true }), { plannerModelId: HCU_PLANNER_MODEL }),
    ).rejects.toMatchObject({
      code: "simulated-mismatch",
    });
    await expect(
      run(tmp(), fakeRun({ simulated: false }), { plannerModelId: "claude-opus-5-5" }),
    ).rejects.toMatchObject({
      code: "planner-model-mismatch",
    });
  });
  it("refuses tasks that are not the plan's", async () => {
    await expect(run(tmp(), fakeRun(), { tasks: TASKS.slice(1) })).rejects.toMatchObject({
      code: "plan-tasks-mismatch",
    });
  });
  it("demoTasks is exactly fc-v1's 30-task demo subset", () => {
    expect(TASKS).toHaveLength(30);
    expect(TASKS.every((t) => t.inDemo && t.taskSetVersion === "fc-v1")).toBe(true);
  });
});

describe("task parity (#491)", () => {
  it("a trial that did not run the published fixture fails and writes no row", async () => {
    const dir = tmp();
    const fake = fakeRun();
    const env: TrialEnvironment = {
      simulated: true,
      async prepare(task, key) {
        const t = await fake.env.prepare(task, key);
        return { ...t, prepared: { ...t.prepared, fixtureSha256: "e".repeat(64) } };
      },
    };
    const r = await run(dir, { ...fake, env }, { maxTrials: 1 });
    expect(r).toMatchObject({ decided: 0, failed: 1 });
    expect(readLedger(dir).at(-1)).toMatchObject({ type: "failed", code: "trial-error" });
    expect(existsSync(join(dir, "rows", `sim-hcu-shell-${TASKS[0]?.taskId}.json`))).toBe(false);
  });
});

describe("the pack re-checks evidence from disk", () => {
  it("refuses a row edited after it was decided", async () => {
    const dir = tmp();
    await run(dir, fakeRun(), { maxTrials: 1 });
    const file = join(dir, "rows", `sim-hcu-shell-${TASKS[0]?.taskId}.json`);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('"claimedDone":true', '"claimedDone":false'),
    );
    expect(() => exportHcuPack(dir, ROOT, TASKS)).toThrow(/row-tampered/);
  });
  it("refuses captured bytes changed after capture", async () => {
    const dir = tmp();
    await run(dir, fakeRun(), { maxTrials: 1 });
    writeFileSync(join(dir, "docs", `sim-hcu-shell-${TASKS[0]?.taskId}.xlsx`), "forged");
    expect(() => exportHcuPack(dir, ROOT, TASKS)).toThrow(/document-tampered/);
  });
  it("unpriced calls make the row's cost null, never 0", async () => {
    const dir = tmp();
    await run(dir, fakeRun({ priced: false }), { maxTrials: 1 });
    expect(exportHcuPack(dir, ROOT, TASKS).unmeasuredCost).toBe(1);
    const row = JSON.parse(readFileSync(join(dir, "arm.jsonl"), "utf8"));
    expect(row.cost.modelUsd).toBeNull();
  });
});
