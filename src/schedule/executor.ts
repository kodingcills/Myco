/**
 * Track S: executors — how a triggered run is actually run.
 *
 * `gatedRunExecutor` is the production shape: every triggered run goes through
 * `runGatedTrial` (launch audit, sealed vault, gate bound to this one trial, persisted-bytes
 * capture after the agent stopped, the harness's own check). The scheduler supplies the
 * task id (fixed by the schedule) and the run id (derived from the trigger key); the
 * operator's `prepare` supplies the vault, registry, launch plan and transport. Nothing from
 * the trigger reaches the gate.
 *
 * `scriptedFcV1Executor` is the $0 path for tests and the local demo: the real gated path on
 * fc-v1 tasks with a scripted agent (no model, no VM). Its results are always `simulated`.
 * A live executor (an agent on the Windows VM) is out of this PR: it needs the VM lock.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerTask } from "../benchmark/gated-rows.ts";
import { scriptedDocument } from "../benchmark/r1-dryrun.ts";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import { type GatedTrialOptions, runGatedTrial } from "../gate/gated-trial.ts";
import { GATE_TOOL } from "../gate/mcp-server.ts";
import type { AgentLaunchPlan } from "../integrity/launch.ts";
import { newVaultKey, VerdictVault } from "../integrity/vault.ts";
import type { ExecutorResult, RunExecutor, RunRequest } from "./scheduler.ts";

export type GatedRunPlan = Omit<GatedTrialOptions, "runId" | "taskId"> & {
  /** True unless this is a real agent run. Rows from a simulated run are never evidence. */
  readonly simulated: boolean;
};

export function gatedRunExecutor(
  prepare: (req: RunRequest) => GatedRunPlan | Promise<GatedRunPlan>,
): RunExecutor {
  return {
    async run(req): Promise<ExecutorResult> {
      const { simulated, ...opts } = await prepare(req);
      const outcome = await runGatedTrial({ ...opts, runId: req.runId, taskId: req.taskId });
      return { outcome, simulated };
    },
  };
}

export const FC_V1_ORACLE_SOURCES = ["families.ts", "calc-document.ts"].map((f) =>
  resolve(import.meta.dirname, "..", "gate", f),
);

/** A launch plan the audit accepts: the gate tool only, no other tools. */
export function scriptedLaunchPlan(base: string): AgentLaunchPlan {
  return {
    mcpConfigPath: join(base, "mcp.json"),
    argv: [
      "-p",
      "scheduled scripted run",
      "--strict-mcp-config",
      "--tools",
      "",
      "--mcp-config",
      join(base, "mcp.json"),
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      `mcp__myco-gate__${GATE_TOOL}`,
    ],
    mcpServers: { "myco-gate": { command: "myco-gate", args: ["mcp"], env: {} } },
  };
}

export function readFcV1Tasks(tasksFile: string): Map<string, BenchmarkTask> {
  const tasks = new Map<string, BenchmarkTask>();
  for (const line of readFileSync(tasksFile, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const t = JSON.parse(line) as BenchmarkTask;
    tasks.set(t.taskId, t);
  }
  return tasks;
}

/** The scripted agent: given the task, the document it leaves behind (null: nothing saved). */
export type ScriptedAgent = (task: BenchmarkTask, req: RunRequest) => Promise<string | null>;

export function scriptedFcV1Executor(opts: {
  readonly tasks: ReadonlyMap<string, BenchmarkTask>;
  readonly workDir: string;
  readonly agent?: ScriptedAgent;
}): RunExecutor {
  const agent: ScriptedAgent = opts.agent ?? (async (task) => scriptedDocument(task));
  return gatedRunExecutor(async (req) => {
    const task = opts.tasks.get(req.taskId);
    if (!task) throw new Error("scripted executor: task not in the task set");
    const reg = registerTask(task);
    if (!reg.ok) throw new Error("scripted executor: task is unregistrable");
    const base = join(opts.workDir, req.runId);
    mkdirSync(join(base, "agent"), { recursive: true });
    const vault = new VerdictVault({
      root: join(base, "vault"),
      key: newVaultKey(),
      agentRoots: [join(base, "agent")],
    });
    let persisted: string | null = null;
    return {
      simulated: true,
      vault,
      tasks: reg.registry,
      plan: scriptedLaunchPlan(base),
      oracleSources: FC_V1_ORACLE_SOURCES,
      transport: {
        async runAgent() {
          persisted = await agent(task, req);
        },
        async captureAfterStop(): Promise<Record<string, Uint8Array>> {
          return persisted === null
            ? {}
            : { "persisted/doc.csv": new TextEncoder().encode(persisted) };
        },
      },
    };
  });
}
