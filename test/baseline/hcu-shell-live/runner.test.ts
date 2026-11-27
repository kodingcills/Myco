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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkArmRowSchema } from "../../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../../schemas/validate.ts";
import type { HcuShellPlanner } from "../../../src/baseline/hcu-shell/trial.ts";
import {
  HCU_PLANNER_MODEL,
  PlannerHalt,
  PlannerTransient,
  SubscriptionPlannerFailure,
} from "../../../src/baseline/hcu-shell-live/planner.ts";
import {
  attemptsSpent,
  DEMO_TRIALS,
  demoTasks,
  EXIT,
  exitCodeFor,
  exportHcuPack,
  type FcTask,
  HCU_PACING,
  hcuRunPlan,
  hcuStatus,
  LEDGER_FILE,
  LIVE_STATUS_FILE,
  LOAD_GATE,
  loadFcV1,
  PAUSE_FILE,
  PROGRESS_FILE,
  planSha256,
  readLedger,
  resumeFaultSignature,
  runHcuShell,
  SIMULATED_PLANNER,
  TASK_BUNDLE,
  type TrialEnvironment,
} from "../../../src/baseline/hcu-shell-live/runner.ts";
import { LOAD_GATE as M2_LOAD_GATE } from "../../../src/m2/evidence.ts";
import { DEFAULT_PACING } from "../../../src/pilot/config.ts";
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
        calls: r.calls.map(() => ({
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
    sleep: async () => undefined,
    load1m: () => 0.5,
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
      exhausted: [],
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
  it("a failed attempt re-runs the trial in place (as #598), and the trial is decided once", async () => {
    const dir = tmp();
    const fake = fakeRun({ fail: (_t, n) => (n === 0 ? new Error("x") : undefined) });
    const r = await run(dir, fake, { maxTrials: 2 });
    expect(r).toMatchObject({ decided: 2, failed: 1, exhausted: [] });
    expect(fake.prepared).toEqual([TASKS[0]?.taskId, TASKS[0]?.taskId, TASKS[1]?.taskId]);
    const starts = readLedger(dir).filter((l) => l.type === "start");
    expect(starts.map((s) => (s as { attempt?: number }).attempt)).toEqual([1, 2, 1]);
  });
  it("a trial that spends its 3 attempts is exhausted, and stays closed on resume", async () => {
    const dir = tmp();
    const codes = ["a-code", "b-code", "c-code"];
    const fake = fakeRun({
      fail: (t, n) =>
        t.taskId === TASKS[0]?.taskId
          ? Object.assign(new Error("x"), { code: codes[n] ?? "z-code" })
          : undefined,
    });
    const r = await run(dir, fake, { maxTrials: 2 });
    expect(r).toMatchObject({ status: "incomplete", decided: 1, failed: 3 });
    expect(r.exhausted).toEqual([TASKS[0]?.taskId]);
    const b = fakeRun();
    const r2 = await run(dir, b, { resume: true, maxTrials: 1 });
    expect(b.prepared).toEqual([TASKS[2]?.taskId]);
    expect(r2.exhausted).toEqual([TASKS[0]?.taskId]);
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
      exhausted: [],
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
    // fc-v1-001: a, b, decided; fc-v1-002: b (the decided trial cleared the signature), decided.
    expect(r).toMatchObject({ status: "incomplete", failed: 3, decided: 5 });
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
  it.each([
    "planner-auth",
    "planner-billing",
    "planner-usage-limit",
    "planner-api-key-path",
    "planner-auth-source-unknown",
    "planner-model-mismatch",
  ] as const)(
    "a planner halt (%s) stops the run on the first trial: no retry, no attempt spent",
    async (code) => {
      const dir = tmp();
      const fake = fakeRun({ halt: () => new PlannerHalt(code, "x") });
      const r = await run(dir, fake);
      expect(r).toMatchObject({ status: "halted", code, decided: 0, failed: 0 });
      expect(fake.prepared).toHaveLength(1);
      expect(fake.released).toHaveLength(1);
      expect(progress(dir)).toMatchObject({ status: "halted", code });
      expect(readLedger(dir).at(-1)).toMatchObject({ type: "halt", code });
      expect(readLedger(dir).filter((l) => l.type === "failed")).toEqual([]);
      // A resume after the operator fixed the cause re-runs the trial (attempt not spent).
      const b = fakeRun();
      await run(dir, b, { resume: true, maxTrials: 1 });
      expect(b.prepared).toEqual([TASKS[0]?.taskId]);
    },
  );
  it.each(["fast", null] as const)(
    "a live trial on a %s boot halts before the agent runs (#546)",
    async (boot) => {
      const dir = tmp();
      const fake = fakeRun({ simulated: false, boot });
      let acted = 0;
      const planner: HcuShellPlanner = {
        paid: true,
        act: async () => {
          acted++;
          return { calls: [] };
        },
      };
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
    expect(r).toMatchObject({ status: "aborted", code: "trial-error", decided: 0, failed: 2 });
    expect(readLedger(dir).at(-2)).toMatchObject({ type: "failed", code: "trial-error" });
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

// ---------------------------------------------------------------------------------------------
// Round 2 (verifier D2, D5, D6; lead ruling 02:18Z).
// ---------------------------------------------------------------------------------------------

const failWith = (code: string) => Object.assign(new Error(code), { code });

describe("the repeat rule survives --resume (round 2, D2)", () => {
  it("a failure, a pause, then the identical failure after --resume aborts at once", async () => {
    const dir = tmp();
    // Run 1: one reset-failed, then the operator pauses before the in-place re-run.
    const a = fakeRun({
      fail: () => {
        writeFileSync(join(dir, PAUSE_FILE), "");
        return failWith("reset-failed");
      },
    });
    expect(await run(dir, a)).toMatchObject({ status: "paused", code: "pause-file", failed: 1 });
    expect(readLedger(dir).find((l) => l.type === "failed")).toMatchObject({
      code: "reset-failed",
      signature: "reset-failed",
    });
    rmSync(join(dir, PAUSE_FILE));
    // Run 2: the same failure. The signature was restored from the ledger: abort after ONE.
    const b = fakeRun({ fail: () => failWith("reset-failed") });
    const r = await run(dir, b, { resume: true });
    expect(r).toMatchObject({ status: "aborted", code: "reset-failed", failed: 1 });
    expect(b.prepared).toHaveLength(1);
  });
  it("after an abort, a resume with the same failure aborts after one more attempt", async () => {
    const dir = tmp();
    await run(dir, fakeRun({ fail: () => failWith("agent-unreachable") }));
    const b = fakeRun({ fail: () => failWith("agent-unreachable") });
    expect(await run(dir, b, { resume: true })).toMatchObject({ status: "aborted", failed: 1 });
    expect(b.prepared).toHaveLength(1);
  });
  it("a decided trial after the failure clears the restored signature", async () => {
    const dir = tmp();
    const a = fakeRun({ fail: (_t, n) => (n === 0 ? failWith("reset-failed") : undefined) });
    await run(dir, a, { maxTrials: 1 });
    expect(resumeFaultSignature(readLedger(dir))).toBeNull();
    const b = fakeRun({ fail: (_t, n) => (n === 0 ? failWith("reset-failed") : undefined) });
    expect(await run(dir, b, { resume: true, maxTrials: 1 })).toMatchObject({ decided: 2 });
  });
  it("transient limits, halts and pauses neither set nor clear the restored signature", () => {
    const base = { trialKey: "k", taskId: "t", at: 0 };
    expect(
      resumeFaultSignature([
        { ...base, type: "failed", code: "x", signature: "x" },
        { ...base, type: "failed", code: "planner-rate-limit", transient: true },
        { type: "halt", code: "planner-auth", trialKey: "k", at: 0 },
        { type: "pause", code: "pause-file", trialKey: null, at: 0 },
      ]),
    ).toBe("x");
  });
});

describe("transient limits back off, bounded (lead ruling 02:18Z)", () => {
  const transientOnce = (fake: Fake, times: number): HcuShellPlanner => {
    let left = times;
    return {
      paid: true,
      act: async (turn) => {
        if (left > 0) {
          left--;
          throw new PlannerTransient("429");
        }
        return fake.planner.act(turn);
      },
    };
  };
  it("one transient limit backs off 300 s, re-runs the trial once and spends no attempt", async () => {
    const dir = tmp();
    const fake = fakeRun({ simulated: false });
    const sleeps: number[] = [];
    let t = 0;
    const r = await run(
      dir,
      { ...fake, planner: transientOnce(fake, 1) },
      {
        maxTrials: 1,
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
      },
    );
    expect(r).toMatchObject({ status: "incomplete", decided: 1, failed: 0 });
    expect(fake.prepared).toHaveLength(2);
    expect(sleeps).toContain(300_000);
    expect(attemptsSpent(readLedger(dir)).size).toBe(0);
  });
  it("a second transient limit on the same trial pauses: at most one extra cold reset", async () => {
    const dir = tmp();
    const fake = fakeRun({ simulated: false });
    const r = await run(dir, { ...fake, planner: transientOnce(fake, 5) });
    expect(r).toMatchObject({ status: "paused", code: "rate-limit-repeat", failed: 0 });
    expect(fake.prepared).toHaveLength(2);
    expect(exitCodeFor(r)).toBe(EXIT.paused);
  });
});

describe("pacing, deadline, load gate and heartbeat match #598 (round 2, D5)", () => {
  it("the pacing is the myco-gate arm's DEFAULT_PACING and the load gate the M2 one", () => {
    expect(HCU_PACING).toEqual(DEFAULT_PACING);
    expect(PLAN.pacing).toEqual(DEFAULT_PACING);
    expect(PLAN.maxTransientRetriesPerTrial).toBe(1);
    expect(LOAD_GATE).toBe(M2_LOAD_GATE);
  });
  it("live trial starts are 90 s apart", async () => {
    const fake = fakeRun({ simulated: false });
    const starts: number[] = [];
    let t = 0;
    const env: TrialEnvironment = {
      simulated: false,
      prepare: (task, key) => {
        starts.push(t);
        return fake.env.prepare(task, key);
      },
    };
    await run(
      tmp(),
      { ...fake, env },
      {
        maxTrials: 3,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );
    expect(starts).toEqual([0, 90_000, 180_000]);
  });
  it("no live attempt starts at host load >= 10; a load that stays high pauses the run", async () => {
    const fake = fakeRun({ simulated: false });
    const loads = [12, 11, 3];
    let t = 0;
    const sleeps: number[] = [];
    const clock = {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    };
    await run(tmp(), fake, { maxTrials: 1, load1m: () => loads.shift() ?? 3, ...clock });
    expect(sleeps.slice(0, 2)).toEqual([30_000, 30_000]);
    const stuck = fakeRun({ simulated: false });
    const r = await run(tmp(), stuck, { load1m: () => 10, ...clock });
    expect(r).toMatchObject({ status: "paused", code: "host-load-high" });
    expect(stuck.prepared).toHaveLength(0);
  });
  it("an attempt past its deadline fails trial-timeout, cancels the planner and writes no row", async () => {
    const dir = tmp();
    const fast = hcuRunPlan(
      TASKS,
      { hcuGuestCommand: "hcu mcp", guestShellSha256: "0".repeat(64) },
      { ...HCU_PACING, trialTimeoutS: 1 },
    );
    const fake = fakeRun();
    let cancelled = 0;
    const planner = {
      paid: true,
      act: () => new Promise<never>(() => undefined),
      cancel: () => {
        cancelled++;
      },
    };
    const r = await run(dir, { ...fake, planner }, { plan: fast });
    expect(r).toMatchObject({ status: "aborted", code: "trial-timeout", failed: 2, decided: 0 });
    expect(cancelled).toBe(2);
    expect(fake.released).toHaveLength(2);
    expect(existsSync(join(dir, "rows", `sim-hcu-shell-${TASKS[0]?.taskId}.json`))).toBe(false);
  }, 10_000);
  it("a trial whose planner answers after the deadline never writes a row or a decided line", async () => {
    const dir = tmp();
    const fast = hcuRunPlan(
      TASKS,
      { hcuGuestCommand: "hcu mcp", guestShellSha256: "0".repeat(64) },
      { ...HCU_PACING, trialTimeoutS: 1 },
    );
    const fake = fakeRun();
    // Each attempt's one call answers "done" 1.2 s in, after the 1 s deadline: the late trial
    // would complete and produce a row if the runner let it.
    const planner: HcuShellPlanner = {
      paid: true,
      act: async () => {
        await new Promise((r) => setTimeout(r, 1200));
        return {
          calls: [{ model: SIMULATED_PLANNER, usage: { prompt: 1, completion: 1, cost: 0.001 } }],
          decision: "done",
        };
      },
    };
    const r = await run(dir, { ...fake, planner }, { plan: fast, maxTrials: 1 });
    expect(r).toMatchObject({ status: "aborted", code: "trial-timeout", decided: 0 });
    // Let both late attempts finish unwinding, then check nothing was recorded for them.
    await new Promise((res) => setTimeout(res, 1500));
    expect(existsSync(join(dir, "rows", `sim-hcu-shell-${TASKS[0]?.taskId}.json`))).toBe(false);
    expect(readLedger(dir).filter((l) => l.type === "decided")).toEqual([]);
  }, 15_000);
  it("a reset that returns after the deadline never starts the agent, and its guest is released", async () => {
    const fast = hcuRunPlan(
      TASKS,
      { hcuGuestCommand: "hcu mcp", guestShellSha256: "0".repeat(64) },
      { ...HCU_PACING, trialTimeoutS: 1 },
    );
    const fake = fakeRun();
    let acted = 0;
    let guiOpened = 0;
    const env: TrialEnvironment = {
      simulated: true,
      async prepare(task, key) {
        await new Promise((r) => setTimeout(r, 1200));
        const t = await fake.env.prepare(task, key);
        const inner = t.prepared;
        return {
          ...t,
          prepared: {
            ...inner,
            connectGui: () => {
              guiOpened++;
              return inner.connectGui();
            },
          },
        };
      },
    };
    const planner: HcuShellPlanner = {
      paid: true,
      act: async (turn) => {
        acted++;
        return fake.planner.act(turn);
      },
    };
    const r = await run(tmp(), { ...fake, env, planner }, { plan: fast, maxTrials: 1 });
    expect(r).toMatchObject({ status: "aborted", code: "trial-timeout" });
    await new Promise((res) => setTimeout(res, 1500));
    expect(acted).toBe(0);
    expect(guiOpened).toBe(0);
    expect(fake.released).toHaveLength(2);
  }, 15_000);
  it("live-status.json and progress.json are refreshed by a timer during a long trial", async () => {
    const dir = tmp();
    const fake = fakeRun();
    const seen: string[] = [];
    const env: TrialEnvironment = {
      simulated: true,
      async prepare(task, key) {
        const read = () =>
          `${JSON.parse(readFileSync(join(dir, LIVE_STATUS_FILE), "utf8")).updatedAt}|${progress(dir).updatedAt}`;
        seen.push(read());
        await new Promise((r) => setTimeout(r, 120));
        seen.push(read());
        return fake.env.prepare(task, key);
      },
    };
    await run(dir, { ...fake, env }, { maxTrials: 1, heartbeatMs: 20 });
    expect(seen[1]).not.toBe(seen[0]);
    const status = JSON.parse(readFileSync(join(dir, LIVE_STATUS_FILE), "utf8"));
    expect(status).toMatchObject({
      schema: "myco.hcu-shell.live-status/1",
      runner: "hcu-shell",
      state: "finished",
      costBasis: "token-derived estimate at frozen rates; not billed USD",
    });
  });
});

describe("exit codes match #598's", () => {
  it.each([
    [{ status: "complete", code: null }, 0],
    [{ status: "incomplete", code: null }, 4],
    [{ status: "paused", code: "rate-limit-repeat" }, 4],
    [{ status: "halted", code: "boot-class-not-cold" }, 4],
    [{ status: "halted", code: "planner-auth" }, 5],
    [{ status: "halted", code: "planner-billing" }, 5],
    [{ status: "halted", code: "planner-api-key-path" }, 5],
    [{ status: "aborted", code: "reset-failed" }, 6],
    [{ status: "halted", code: "planner-usage-limit" }, 7],
  ] as const)("%j exits %d", (r, code) => {
    expect(exitCodeFor(r)).toBe(code);
  });
});

describe("host-capture provenance (round 2, D6)", () => {
  it("every captured document has a provenance record the pack re-checks", async () => {
    const dir = tmp();
    await run(dir, fakeRun(), { maxTrials: 1 });
    const key = `sim-hcu-shell-${TASKS[0]?.taskId}`;
    const cap = JSON.parse(readFileSync(join(dir, "captures", `${key}.json`), "utf8"));
    const doc = readFileSync(join(dir, "docs", `${key}.xlsx`));
    expect(cap).toMatchObject({
      schema: "myco.hcu-shell.host-capture/1",
      trialKey: key,
      persistedSha256: sha(doc),
      persistedBytes: doc.length,
      resetBootClass: "cold",
    });
    expect(exportHcuPack(dir, ROOT, TASKS).armRows).toBe(1);
    writeFileSync(join(dir, "captures", `${key}.json`), JSON.stringify({ ...cap, guestPath: "x" }));
    expect(() => exportHcuPack(dir, ROOT, TASKS)).toThrow(/capture-provenance-mismatch/);
    rmSync(join(dir, "captures", `${key}.json`));
    expect(() => exportHcuPack(dir, ROOT, TASKS)).toThrow(/capture-provenance-mismatch/);
  });
  it("a duplicated decided line never duplicates a pack row", async () => {
    const dir = tmp();
    await run(dir, fakeRun(), { maxTrials: 2 });
    const path = join(dir, LEDGER_FILE);
    const decided = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.includes('"decided"'));
    writeFileSync(path, `${readFileSync(path, "utf8")}${decided}\n`);
    expect(exportHcuPack(dir, ROOT, TASKS).armRows).toBe(2);
  });
});
