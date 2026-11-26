/**
 * Track S: the shipped executors honour the run's abort signal (round-1 B2). $0: the real
 * gated path on an fc-v1 task with a scripted agent; no model, no VM.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readFcV1Tasks, scriptedFcV1Executor } from "../../src/schedule/executor.ts";
import type { RunRequest } from "../../src/schedule/scheduler.ts";
import { flush, StubExecutor, setup, spec, tmp } from "./helpers.ts";

const BUNDLE = resolve(import.meta.dirname, "..", "..", "benchmark", "false-completion", "fc-v1");
const TASKS = readFcV1Tasks(join(BUNDLE, "tasks.jsonl"));
const TASK_ID = [...TASKS.keys()][0] as string;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("scripted executor stops on the abort signal", () => {
  it("a scripted agent that ignores the signal cannot outlive a timeout: the executor settles and frees the slot", async () => {
    const workDir = tmp();
    let agentCalls = 0;
    const scripted = scriptedFcV1Executor({
      tasks: TASKS,
      workDir,
      agent: () => {
        agentCalls++;
        return new Promise<string | null>(() => {}); // never finishes, ignores the signal
      },
    });
    let settled: Promise<unknown> = Promise.resolve();
    const ex = new StubExecutor((req) => {
      const p = scripted.run(req);
      settled = p.then(
        () => "resolved",
        () => "rejected",
      );
      return p;
    });
    const s = setup({
      executor: ex,
      schedules: [
        spec({ taskId: TASK_ID, budget: { runsPerDay: 9, wallTimeS: 30, concurrency: 1 } }),
      ],
    });
    const sub = s.scheduler.submit({ scheduleId: "nightly", source: "manual", key: "a" });
    for (let i = 0; i < 5 && agentCalls === 0; i++) await flush();
    expect(agentCalls).toBe(1);
    s.clock.advance(30_000);
    expect(await sub.done).toMatchObject({ status: "timeout", accepted: false });
    expect(await settled).toBe("rejected");
    await flush();
    expect(s.scheduler.running("nightly")).toBe(0);
  });

  it("aborted while preparing: the gated trial is never started (no vault seal, no agent)", async () => {
    const workDir = tmp();
    let agentCalls = 0;
    const scripted = scriptedFcV1Executor({
      tasks: TASKS,
      workDir,
      agent: async () => {
        agentCalls++;
        return null;
      },
    });
    const ctl = new AbortController();
    const req: RunRequest = {
      scheduleId: "nightly",
      taskId: TASK_ID,
      runId: "sched-nightly-0123456789abcdef",
      source: "manual",
      signal: ctl.signal,
    };
    const p = scripted.run(req);
    ctl.abort(new Error("killed"));
    await expect(p).rejects.toThrow("killed");
    expect(agentCalls).toBe(0);
    expect(walk(join(workDir, req.runId, "vault"))).toEqual([]);
  });

  it("already aborted: run refuses before preparing anything", async () => {
    const workDir = tmp();
    const scripted = scriptedFcV1Executor({ tasks: TASKS, workDir });
    const ctl = new AbortController();
    ctl.abort(new Error("killed"));
    await expect(
      scripted.run({
        scheduleId: "nightly",
        taskId: TASK_ID,
        runId: "sched-nightly-0123456789abcdef",
        source: "manual",
        signal: ctl.signal,
      }),
    ).rejects.toThrow("killed");
    expect(existsSync(join(workDir, "sched-nightly-0123456789abcdef"))).toBe(false);
  });
});
