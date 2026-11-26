/**
 * Capability track P (tier 2), acceptance items 2 and 5 on the hermetic path: a scripted
 * agent runs the frozen xa-v1 tasks end to end through the real harness
 * (`runCrossAppTrial` on the existing one-retry loop) and the real gate, with an in-process
 * actuator standing in for Calc and Writer. The same scenarios run on real headless
 * LibreOffice in `test/linux/cross-app-libreoffice.test.ts`.
 *
 * Each scenario's final evidence is also graded by the independent grader, which must agree
 * with the gate (pass iff accepted; its first failing step is the gate's first refuted
 * checkpoint).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CROSS_APP_SCENARIOS,
  crossAppTaskEntry,
  fakeCrossAppActuator,
  runCrossAppScenario,
  runCrossAppTrial,
} from "../../src/gate/cross-app-demo.ts";
import { openBoundGate } from "../../src/gate/demo.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { buildXaTaskSet, type XaTask } from "../../src/tasks/cross-app-taskset.ts";
import { tempRoot } from "../gate/helpers.ts";
import { gradeTrial, runAll } from "./helpers.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const { tasks } = buildXaTaskSet();

describe("scripted cross-app trials on every xa-v1 task (fake actuator)", () => {
  for (const task of tasks) {
    it(`${task.taskId}: every scenario gets its expected verdict, checkpoint and code; the grader agrees`, async () => {
      const root = tempRoot();
      roots.push(root);
      const runs = await runAll(task, fakeCrossAppActuator, root);
      for (const run of runs) {
        expect(run.mismatches, `${task.taskId} ${run.scenario}`).toEqual([]);
        const last = run.results[run.results.length - 1];
        const grade = gradeTrial(task, join(root, "evidence", run.runId));
        expect(grade.status, `${run.scenario}: ${grade.reasons.join("; ")}`).toBe(
          run.trial.accepted ? "pass" : "fail",
        );
        if (!run.trial.accepted)
          expect(grade.firstFailure, run.scenario).toBe(
            (last?.checkpoints?.lastVerified ?? -1) + 1,
          );
      }
    });
  }
});

describe("the retry follows the existing budget", () => {
  const task = tasks[0] as XaTask;
  it("never a third attempt; the retry starts from the gate's lastVerified; corrections stay off", async () => {
    const root = tempRoot();
    roots.push(root);
    const runs = await runAll(task, fakeCrossAppActuator, root);
    for (const run of runs) {
      expect(run.trial.attempts.length).toBeLessThanOrEqual(2);
      if (run.trial.attempts.length === 2)
        expect(run.trial.attempts[1]?.fromCheckpoint).toBe(
          run.trial.attempts[0]?.checkpoints?.lastVerified,
        );
      for (const result of run.results) expect(result.corrections).toBeUndefined();
    }
    const repaired = runs.find((r) => r.scenario === "slip-step-2-then-repair");
    expect(repaired?.trial.repaired).toBe(true);
  });

  it("before a retry the harness deletes the captures of the steps it redoes and the end state, and keeps the verified ones", async () => {
    // A stale marker planted in every capture dir after the first gate call must be gone
    // from step-2, step-3 and end/ (redone from checkpoint 1) and still in step-1.
    const root = tempRoot();
    roots.push(root);
    const scenario = CROSS_APP_SCENARIOS.find((s) => s.name === "slip-step-2-then-repair");
    if (!scenario) throw new Error("scenario missing");
    const evidenceDir = join(root, "evidence", "xa-stale");
    const dirs = ["step-1", "step-2", "step-3", "end"];
    const seen: Record<string, boolean>[] = [];
    let calls = 0;
    const trial = await runCrossAppTrial({
      spec: task.spec,
      guestDir: join(root, "guest", "xa-stale"),
      evidenceDir,
      actuator: fakeCrossAppActuator,
      slips: scenario.slips,
      retryBudget: 1,
      async checkGate(claim) {
        calls++;
        if (calls === 2)
          seen.push(
            Object.fromEntries(dirs.map((d) => [d, existsSync(join(evidenceDir, d, "stale"))])),
          );
        const gate = createGate({
          tasks: buildRegistry([crossAppTaskEntry(task.taskId, task.spec)]),
          reader: fileEvidenceReader(join(root, "evidence")),
          assignment: { taskId: task.taskId, runId: "xa-stale" },
        });
        const result = await gate.check({ taskId: task.taskId, runId: "xa-stale", claim });
        if (calls === 1)
          for (const d of dirs) {
            mkdirSync(join(evidenceDir, d), { recursive: true });
            writeFileSync(join(evidenceDir, d, "stale"), "from attempt 1");
          }
        return result;
      },
    });
    expect(trial.attempts).toHaveLength(2);
    expect(trial.attempts[1]?.fromCheckpoint).toBe(1);
    expect(seen).toEqual([{ "step-1": true, "step-2": false, "step-3": false, end: false }]);
  });

  it("the agent's request is { taskId, runId, claim } only", async () => {
    const root = tempRoot();
    roots.push(root);
    const run = await runCrossAppScenario({
      scenario: CROSS_APP_SCENARIOS[0] as (typeof CROSS_APP_SCENARIOS)[number],
      spec: task.spec,
      taskId: task.taskId,
      root,
      actuator: fakeCrossAppActuator,
      openGate: async (runId) => ({
        async check(request) {
          expect(Object.keys(request).sort()).toEqual(["claim", "runId", "taskId"]);
          const gate = createGate({
            tasks: buildRegistry([crossAppTaskEntry(task.taskId, task.spec)]),
            reader: fileEvidenceReader(join(root, "evidence")),
            assignment: { taskId: task.taskId, runId },
          });
          return gate.check(request);
        },
      }),
    });
    expect(run.trial.accepted).toBe(true);
  });
});

describe("through the gate's MCP process (myco.gate/v1 over stdio)", () => {
  it("an operator tasks file registers the family; clean verifies, a step-2 slip is refuted at checkpoint 2", {
    timeout: 60_000,
  }, async () => {
    const task = tasks[1] as XaTask;
    const root = tempRoot();
    roots.push(root);
    const tasksFile = join(root, "tasks.json");
    mkdirSync(join(root, "evidence"), { recursive: true });
    writeFileSync(
      tasksFile,
      JSON.stringify({ tasks: [crossAppTaskEntry(task.taskId, task.spec)] }),
    );
    const audit = join(root, "gate-decisions.jsonl");
    for (const name of ["clean", "wrong-value-step-2"]) {
      const scenario = CROSS_APP_SCENARIOS.find((s) => s.name === name);
      if (!scenario) throw new Error(name);
      const run = await runCrossAppScenario({
        scenario,
        spec: task.spec,
        taskId: task.taskId,
        root,
        actuator: fakeCrossAppActuator,
        openGate: async (runId) => {
          const gate = await openBoundGate(
            join(root, "evidence"),
            audit,
            { taskId: task.taskId, runId },
            ["--tasks", tasksFile, "--no-builtin"],
          );
          return { check: (request) => gate.call(request), close: () => gate.close() };
        },
      });
      expect(run.mismatches, name).toEqual([]);
    }
    const decisions = readFileSync(audit, "utf8").trim().split("\n");
    expect(decisions).toHaveLength(2);
  });
});
