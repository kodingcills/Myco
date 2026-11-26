/**
 * Test harness for recursive orchestration (track V): scripted planners and scripted mock
 * workers on the mock desktop, a real vault and the real sealed gate. No VM, no model, no
 * network, $0.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockDesktop } from "../../src/discovery/mock-desktop.ts";
import { runTask } from "../../src/discovery/run-tasks.ts";
import type { GateResult } from "../../src/gate/api.ts";
import { buildRegistry, type Gate, type TaskRegistry } from "../../src/gate/gate.ts";
import { GATE_TOOL } from "../../src/gate/mcp-server.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import type { AgentLaunchPlan } from "../../src/integrity/launch.ts";
import { checkChainedLedger } from "../../src/integrity/ledger.ts";
import { rtSessionIdFor } from "../../src/integrity/surface.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { type TrialIsolation, tempDirIsolation } from "../../src/orchestrate/isolation.ts";
import { ORCHESTRATOR_LIMITS_VERSION } from "../../src/orchestrate/limits.ts";
import {
  Orchestrator,
  type OrchestratorConfig,
  type Planner,
  type TokenUsage,
  type WorkerAssignment,
  type WorkerTransport,
} from "../../src/orchestrate/orchestrator.ts";

const ROOT = join(import.meta.dirname, "..", "..");
export const ORACLE_SOURCES = ["src/gate/families.ts", "src/discovery/s0-sequence.ts"].map((rel) =>
  join(ROOT, rel),
);

export const LIMITS = {
  version: ORCHESTRATOR_LIMITS_VERSION,
  maxTotalTokens: 1_000_000,
  maxTokensPerWorker: 10_000,
  maxEstimatedCostMicroUsd: 100_000_000,
  estimateMicroUsdPerMInputTokens: 3_000_000,
  estimateMicroUsdPerMOutputTokens: 15_000_000,
  maxWallMs: 600_000,
  maxDepth: 3,
  maxConcurrentDesktops: 4,
  maxSpawnsPerPlanner: 8,
  maxTotalSpawns: 32,
} as const;

/** What a scripted worker does. */
export type WorkerScript =
  | "honest" // does the task, saves; the app's own bugs are what the gate sees
  | "no-save" // claims done but never does the task: nothing saved (STATE_MISSING → uncertain)
  | "throws" // transport rejects (no verdict)
  | "hang" // runs until aborted (the kill switch)
  | "stuck" // never settles, even when aborted (a transport that ignores its signal)
  | "late"; // stops 150 ms after it is aborted (settles after a halted run has ended)

export interface WorkerLog {
  readonly assignment: WorkerAssignment;
  midRun?: GateResult;
  peek?: GateResult;
}

export interface Env {
  readonly base: string;
  readonly vault: VerdictVault;
  readonly tasks: TaskRegistry;
  readonly isolation: TrialIsolation;
  readonly ledgerPath: string;
  readonly ledgerKey: Uint8Array;
  readonly logs: WorkerLog[];
  /** Live desktops right now, as the transports see them (max observed in `peak`). */
  live: number;
  peak: number;
  cleanup(): void;
}

export function makeEnv(isolation?: (root: string) => TrialIsolation): Env {
  const base = mkdtempSync(join(tmpdir(), "myco-orch-"));
  const agentRoot = join(base, "agents");
  mkdirSync(agentRoot);
  const iso = isolation ? isolation(agentRoot) : tempDirIsolation(agentRoot);
  const operator = join(base, "operator");
  mkdirSync(operator);
  const vault = new VerdictVault({
    root: join(operator, "vault"),
    key: newVaultKey(),
    agentRoots: iso.agentRoots,
  });
  const env: Env = {
    base,
    vault,
    tasks: buildRegistry(builtinTasks()),
    isolation: iso,
    ledgerPath: join(operator, "orchestrate.ledger.jsonl"),
    ledgerKey: newVaultKey(),
    logs: [],
    live: 0,
    peak: 0,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
  return env;
}

export function workerPlan(a: WorkerAssignment): AgentLaunchPlan {
  return {
    argv: [
      "-p",
      `do task ${a.taskId}, save, then call the gate`,
      "--strict-mcp-config",
      "--tools",
      "",
      "--mcp-config",
      join(a.workspace, "mcp.json"),
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      ["mcp__myco-rt__observe", "mcp__myco-rt__act", `mcp__myco-gate__${GATE_TOOL}`].join(","),
    ],
    mcpServers: {
      "myco-rt": {
        command: "myco-rt-mcp",
        args: [],
        env: { MYCO_RT_SESSION_ID: rtSessionIdFor(a.runId) },
      },
      "myco-gate": { command: "myco-gate", args: ["mcp"], env: {} },
    },
    mcpConfigPath: join(a.workspace, "mcp.json"),
  };
}

export interface TransportOptions {
  readonly script?: (a: WorkerAssignment) => WorkerScript;
  readonly usage?: (a: WorkerAssignment) => TokenUsage | null;
  /** Extra things the (hostile) worker does with its gate while running. */
  readonly also?: (a: WorkerAssignment, gate: Gate, log: WorkerLog) => Promise<void>;
  /** Plan override (to make the launch audit refuse). */
  readonly plan?: (a: WorkerAssignment) => AgentLaunchPlan;
}

/** Scripted mock worker: drives the mock desktop through the todo task, like a real agent. */
export function scriptedTransport(
  env: Env,
  a: WorkerAssignment,
  opts: TransportOptions,
): WorkerTransport {
  const script = opts.script?.(a) ?? "honest";
  const task = runTask(a.taskId);
  const desktop = new MockDesktop();
  const log: WorkerLog = { assignment: a };
  env.logs.push(log);
  let session: Awaited<ReturnType<MockDesktop["create"]>> | undefined;
  return {
    async runAgent(_plan, gate) {
      env.live += 1;
      env.peak = Math.max(env.peak, env.live);
      try {
        if (script === "throws") throw new Error("worker crashed");
        if (script === "stuck") {
          await new Promise<void>(() => {});
          return;
        }
        if (script === "late") {
          await new Promise<void>((_resolve, reject) => {
            a.signal.addEventListener(
              "abort",
              () => setTimeout(() => reject(new Error("aborted late")), 150),
              { once: true },
            );
          });
          return;
        }
        if (script === "hang") {
          await new Promise<void>((_resolve, reject) => {
            a.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          return;
        }
        if (script === "no-save") {
          log.midRun = await gate.check({ taskId: a.taskId, runId: a.runId, claim: "done" });
          return;
        }
        session = await desktop.create();
        await desktop.act(session, {
          kind: "launch",
          command: task.launch.command,
          args: task.launch.args,
        });
        for (const item of task.items) {
          await desktop.act(session, { kind: "typeTextGlobal", text: item });
          await desktop.act(session, { kind: "keyPress", keys: "Return" });
        }
        await desktop.act(session, { kind: "clickAt", x: 210, y: 284 });
        // Yield so concurrent workers overlap (the concurrency tests count overlap).
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.midRun = await gate.check({ taskId: a.taskId, runId: a.runId, claim: task.agentClaim });
        await opts.also?.(a, gate, log);
      } finally {
        env.live -= 1;
      }
    },
    async captureAfterStop() {
      if (!session) return {};
      const files: Record<string, Uint8Array> = {};
      try {
        files[`persisted/${task.storePath}`] = Buffer.from(
          await desktop.readFile(session, task.storePath),
        );
      } catch {
        // Not saved: nothing to capture.
      }
      await desktop.destroy();
      return files;
    },
    usage() {
      return opts.usage ? opts.usage(a) : { inputTokens: 1000, outputTokens: 200 };
    },
  };
}

export function makeOrchestrator(
  env: Env,
  over: Partial<OrchestratorConfig> & {
    transport?: TransportOptions;
    subPlanners?: Record<string, Planner>;
  } = {},
): Orchestrator {
  const { transport = {}, subPlanners = {}, ...rest } = over;
  return new Orchestrator({
    limits: LIMITS,
    tasks: env.tasks,
    vault: env.vault,
    isolation: env.isolation,
    worker: {
      oracleSources: ORACLE_SOURCES,
      plan: (a) => (transport.plan ?? workerPlan)(a),
      transport: (a) => scriptedTransport(env, a, transport),
    },
    planners: (goal) => {
      const planner = subPlanners[goal];
      if (!planner) throw new Error(`no scripted planner for goal ${goal}`);
      return planner;
    },
    runId: "orch-test",
    provenance: "mock",
    ledger: { path: env.ledgerPath, key: env.ledgerKey },
    ...rest,
  });
}

export function ledgerRows(env: Env): Record<string, unknown>[] {
  const check = checkChainedLedger(env.ledgerPath, env.ledgerKey, "orch-test");
  if (!check.ok) throw new Error(`ledger chain broken: ${JSON.stringify(check.violations)}`);
  return check.rows;
}
