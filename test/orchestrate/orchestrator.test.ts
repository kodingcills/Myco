/**
 * Recursive orchestration (capability track V), end to end at $0: scripted planners spawn
 * scripted mock desktop workers; every worker runs the real gated-trial path (launch audit,
 * seal, sealed gate bound to the worker's run, capture after stop), and a result reaches the
 * planner only as the report the orchestrator builds from the gate's verdict.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GateResult } from "../../src/gate/api.ts";
import type { GatedTrialOutcome } from "../../src/gate/gated-trial.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import type { TrialIsolation } from "../../src/orchestrate/isolation.ts";
import { LimitsError, loadLimitsFile, parseLimits } from "../../src/orchestrate/limits.ts";
import {
  type PlannerHandle,
  type Report,
  statusOfOutcome,
  type WorkerReport,
} from "../../src/orchestrate/orchestrator.ts";
import { type Env, LIMITS, ledgerRows, makeEnv, makeOrchestrator, workerPlan } from "./harness.ts";

let env: Env;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => {
  env.cleanup();
});

const worker = (report: Report): WorkerReport => {
  if (report.kind !== "worker") throw new Error("expected a worker report");
  return report;
};

describe("verified results only: the planner never sees an unverified result as done", () => {
  it("verified → done; refuted, uncertain and failed results are returned as such", async () => {
    const orch = makeOrchestrator(env, {
      transport: {
        script: (a) =>
          a.note === "no-save" ? "no-save" : a.note === "crash" ? "throws" : "honest",
      },
    });
    const seen: Report[] = [];
    const record = await orch.run(async (h) => {
      seen.push(
        ...(await Promise.all([
          h.submit({ taskId: "df-s01" }),
          h.submit({ taskId: "df-s02" }),
          h.submit({ taskId: "df-s01", note: "no-save" }),
          h.submit({ taskId: "df-s01", note: "crash" }),
        ])),
      );
    });
    const [ok, refuted, unsaved, crashed] = seen.map(worker);
    expect(ok).toMatchObject({ status: "done", verdict: "verified", gateCodes: ["ORACLE_PASS"] });
    expect(refuted).toMatchObject({
      status: "refuted",
      verdict: "refuted",
      gateCodes: ["ORACLE_FAIL"],
    });
    expect(unsaved?.status).toBe("uncertain");
    expect(unsaved?.gateCodes).toContain("STATE_MISSING");
    expect(crashed).toMatchObject({
      status: "unverified",
      codes: ["WORKER_FAILED"],
      gateCodes: [],
    });
    // The root is not done: not every child is.
    expect(record.root.status).toBe("uncertain");
    expect(record.root.codes).toEqual(["CHILDREN_INCOMPLETE"]);
    // The worker's own mid-run gate call (before stop and capture) was never verified.
    for (const log of env.logs) if (log.midRun) expect(log.midRun.accepted).toBe(false);
  });

  it("a report carries codes only: no reason text, no evidence bytes, no host path", async () => {
    const orch = makeOrchestrator(env);
    let report: Report | undefined;
    await orch.run(async (h) => {
      report = await h.submit({ taskId: "df-s02" });
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain(env.base);
    expect(Object.keys(report as object).sort()).toEqual(
      ["codes", "gateCodes", "kind", "nodeId", "runId", "status", "taskId", "verdict"].sort(),
    );
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("a launch plan the audit refuses is never launched and never done", async () => {
    const orch = makeOrchestrator(env, {
      transport: {
        plan: (a) => {
          const plan = workerPlan(a);
          const argv = [...plan.argv];
          argv[argv.length - 1] = `${argv.at(-1)},Bash`;
          return { ...plan, argv };
        },
      },
    });
    let report: Report | undefined;
    await orch.run(async (h) => {
      report = await h.submit({ taskId: "df-s01" });
    });
    expect(worker(report as Report)).toMatchObject({
      status: "unverified",
      codes: ["LAUNCH_REFUSED"],
    });
    expect(env.logs).toHaveLength(1);
    expect(env.peak).toBe(0); // runAgent never ran
  });

  it("graded: done needs the gate AND the independent grader; the grader never upgrades", async () => {
    const grader = vi.fn(async ({ taskId }: { taskId: string; runId: string }) =>
      taskId === "df-s01" ? ("fail" as const) : ("pass" as const),
    );
    const orch = makeOrchestrator(env, { grader });
    const reports: Report[] = [];
    await orch.run(async (h) => {
      reports.push(await h.submit({ taskId: "df-s01" }), await h.submit({ taskId: "df-s02" }));
    });
    const [disagreed, refuted] = reports.map(worker);
    expect(disagreed).toMatchObject({
      status: "uncertain",
      verdict: "verified",
      graded: "fail",
      codes: ["GRADER_DISAGREES"],
    });
    // Refuted by the gate: the grader is not asked and cannot make it done.
    expect(refuted?.status).toBe("refuted");
    expect(grader).toHaveBeenCalledTimes(1);
  });

  it("graded: a grader pass makes it done; a throwing or odd grader is uncertain", async () => {
    for (const [grade, status, code] of [
      [async () => "pass" as const, "done", undefined],
      [
        async () => {
          throw new Error("grader down");
        },
        "uncertain",
        "GRADER_UNAVAILABLE",
      ],
      [async () => "maybe" as unknown as "pass", "uncertain", "GRADER_UNAVAILABLE"],
    ] as const) {
      env.cleanup();
      env = makeEnv();
      const orch = makeOrchestrator(env, { grader: grade });
      let report: Report | undefined;
      await orch.run(async (h) => {
        report = await h.submit({ taskId: "df-s01" });
      });
      expect(report?.status).toBe(status);
      if (code) expect(report?.codes).toEqual([code]);
    }
  });

  it("recursion: a sub-planner's workers are verified the same way and the tree is done only when all are", async () => {
    const orch = makeOrchestrator(env, {
      subPlanners: {
        "two todos": async (h) => {
          await Promise.all([h.submit({ taskId: "df-s01" }), h.submit({ taskId: "df-s01" })]);
        },
      },
    });
    const record = await orch.run(async (h) => {
      await h.submit({ kind: "planner", goal: "two todos" });
    });
    expect(record.root.status).toBe("done");
    const sub = record.root.children[0];
    expect(sub?.kind).toBe("planner");
    expect(sub?.status).toBe("done");
    const depths = Object.fromEntries(record.nodes.map((n) => [n.nodeId, [n.parentId, n.depth]]));
    expect(depths).toMatchObject({ p0: [null, 0], p1: ["p0", 1], w2: ["p1", 2], w3: ["p1", 2] });
  });

  it("a sub-planner with no children, or that throws, is not done", async () => {
    const orch = makeOrchestrator(env, {
      subPlanners: {
        idle: async () => {},
        broken: async () => {
          throw new Error("planner crashed");
        },
      },
    });
    const record = await orch.run(async (h) => {
      await h.submit({ kind: "planner", goal: "idle" });
      await h.submit({ kind: "planner", goal: "broken" });
      await h.submit({ kind: "planner", goal: "unknown goal" });
    });
    expect(record.root.children.map((c) => [c.status, c.codes])).toEqual([
      ["uncertain", ["CHILDREN_INCOMPLETE"]],
      ["unverified", ["PLANNER_FAILED"]],
      ["unverified", ["PLANNER_FAILED"]],
    ]);
  });
});

describe("limits are operator config, mandatory and fail closed", () => {
  it("parseLimits refuses missing, zero, fractional, unknown and inconsistent limits", () => {
    const bad: unknown[] = [
      undefined,
      [],
      { ...LIMITS, version: "v0" },
      { ...LIMITS, maxDepth: undefined },
      { ...LIMITS, maxDepth: 0 },
      { ...LIMITS, maxConcurrentDesktops: 1.5 },
      { ...LIMITS, maxTotalSpawns: -1 },
      { ...LIMITS, maxWallMs: Number.POSITIVE_INFINITY },
      { ...LIMITS, maxTotalTokens: "1000" },
      { ...LIMITS, unlimited: true },
      { ...LIMITS, maxTokensPerWorker: LIMITS.maxTotalTokens + 1 },
    ];
    for (const raw of bad) expect(() => parseLimits(raw), JSON.stringify(raw)).toThrow(LimitsError);
    for (const field of Object.keys(LIMITS)) {
      const { [field as keyof typeof LIMITS]: _drop, ...missing } = LIMITS;
      expect(() => parseLimits(missing), field).toThrow(LimitsError);
    }
    const parsed = parseLimits(LIMITS);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("a limits file or ledger or kill-switch file an agent can reach is refused", () => {
    const agentRoot = env.isolation.agentRoots[0] as string;
    const inside = join(agentRoot, "limits.json");
    writeFileSync(inside, JSON.stringify(LIMITS));
    expect(() => loadLimitsFile(inside, { agentRoots: env.isolation.agentRoots })).toThrow(
      /agent-writable/,
    );
    const outside = join(env.base, "operator", "limits.json");
    writeFileSync(outside, JSON.stringify(LIMITS));
    expect(loadLimitsFile(outside, { agentRoots: env.isolation.agentRoots }).maxDepth).toBe(3);
    expect(() =>
      makeOrchestrator(env, { ledger: { path: join(agentRoot, "l.jsonl"), key: env.ledgerKey } }),
    ).toThrow(/agent-reachable/);
    expect(() => makeOrchestrator(env, { killSwitchFile: join(agentRoot, "STOP") })).toThrow(
      /agent-reachable/,
    );
    expect(() => makeOrchestrator(env, { limits: { ...LIMITS, maxDepth: 0 } })).toThrow(
      LimitsError,
    );
  });

  it("a planner cannot raise its own limits", async () => {
    const orch = makeOrchestrator(env, {
      limits: { ...LIMITS, maxDepth: 1 },
      subPlanners: {
        deeper: async (h) => {
          await h.submit({ taskId: "df-s01" });
        },
      },
    });
    const codes: string[] = [];
    let attempts: unknown[] = [];
    const record = await orch.run(async (h) => {
      // Write the handed-over copy: frozen, and it is a copy anyway.
      attempts = [
        () => {
          (h.limits as { maxDepth: number }).maxDepth = 99;
        },
        () => {
          (h as { limits: unknown }).limits = { ...LIMITS, maxDepth: 99 };
        },
        () => {
          (h as { submit: unknown }).submit = () => {};
        },
      ].map((attempt) => {
        try {
          attempt();
          return "wrote";
        } catch (error) {
          return (error as Error).name;
        }
      });
      for (const smuggle of [
        { taskId: "df-s01", maxDepth: 99 },
        { taskId: "df-s01", limits: { maxDepth: 99 } },
        { taskId: "df-s01", budget: 1e9 },
        { taskId: "df-s01", maxConcurrentDesktops: 99 },
        { taskId: "df-s01", killSwitch: false },
        { kind: "planner", goal: "x", maxTotalSpawns: 1e6 },
      ])
        codes.push(...(await h.submit(smuggle)).codes);
      codes.push(...(await h.submit({ taskId: "df-s01", runId: "orch-test-w1" })).codes);
      codes.push(...(await h.submit({ taskId: "df-s01", verdict: "verified" })).codes);
      codes.push(...(await h.submit({ taskId: "no-such-task" })).codes);
      codes.push(...(await h.submit({ kind: "planner", goal: "deeper" })).codes);
    });
    expect(attempts).toEqual(["TypeError", "TypeError", "TypeError"]);
    expect(codes).toEqual([
      ...Array(6).fill("LIMIT_WRITE_REJECTED"),
      "SUBMISSION_FIELD_REJECTED",
      "SUBMISSION_FIELD_REJECTED",
      "UNKNOWN_TASK",
      "CHILDREN_INCOMPLETE",
    ]);
    // maxDepth is still the operator's 1: the sub-planner's worker (depth 2) was refused.
    expect(record.limits.maxDepth).toBe(1);
    expect(record.nodes.find((n) => n.depth === 2)).toMatchObject({
      status: "refused",
      codes: ["DEPTH_CAP"],
    });
    expect(record.totals.spawns).toBe(1); // only the "deeper" sub-planner was admitted
    expect(env.logs).toHaveLength(0);
  });

  it("depth cap: a spawn deeper than maxDepth is refused", async () => {
    const orch = makeOrchestrator(env, {
      limits: { ...LIMITS, maxDepth: 2 },
      subPlanners: {
        a: async (h) => {
          await h.submit({ kind: "planner", goal: "b" });
        },
        b: async (h) => {
          await h.submit({ taskId: "df-s01" });
        },
      },
    });
    const record = await orch.run(async (h) => {
      await h.submit({ kind: "planner", goal: "a" });
    });
    const refused = record.nodes.filter((n) => n.status === "refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ codes: ["DEPTH_CAP"], depth: 3, parentId: "p2" });
    expect(record.limitsHit.map((h) => h.code)).toEqual(["DEPTH_CAP"]);
    expect(env.logs).toHaveLength(0);
  });

  it("max spawns per planner", async () => {
    const orch = makeOrchestrator(env, { limits: { ...LIMITS, maxSpawnsPerPlanner: 2 } });
    const statuses: string[] = [];
    await orch.run(async (h) => {
      for (let i = 0; i < 3; i++) statuses.push((await h.submit({ taskId: "df-s01" })).status);
      // A refused submission does not count, and the cap does not reset.
      statuses.push((await h.submit({ taskId: "df-s01" })).codes.join());
    });
    expect(statuses).toEqual(["done", "done", "refused", "PLANNER_SPAWN_CAP"]);
  });

  it("recursive spawn storm: total spawns stay within maxTotalSpawns and the run ends", async () => {
    const storm = async (h: PlannerHandle) => {
      await Promise.all([
        h.submit({ kind: "planner", goal: "storm" }),
        h.submit({ kind: "planner", goal: "storm" }),
        h.submit({ taskId: "df-s01" }),
      ]);
    };
    const orch = makeOrchestrator(env, {
      limits: {
        ...LIMITS,
        maxDepth: 50,
        maxTotalSpawns: 7,
        maxSpawnsPerPlanner: 50,
        maxConcurrentDesktops: 50,
      },
      subPlanners: { storm },
    });
    const record = await orch.run(storm);
    expect(record.totals.spawns).toBe(7);
    expect(record.nodes.filter((n) => n.status !== "refused" && n.nodeId !== "p0")).toHaveLength(7);
    expect(record.limitsHit.length).toBeGreaterThan(0);
    expect(new Set(record.limitsHit.map((h) => h.code))).toEqual(new Set(["TOTAL_SPAWN_CAP"]));
  });

  it("recursive storm against the depth cap alone terminates", async () => {
    const storm = async (h: PlannerHandle) => {
      await h.submit({ kind: "planner", goal: "storm" });
    };
    const orch = makeOrchestrator(env, {
      limits: { ...LIMITS, maxDepth: 4, maxTotalSpawns: 1000 },
      subPlanners: { storm },
    });
    const record = await orch.run(storm);
    expect(record.totals.planners).toBe(5); // p0 + depths 1..4
    expect(record.limitsHit.map((h) => h.code)).toEqual(["DEPTH_CAP"]);
  });

  it("max concurrent desktops: concurrent spawns beyond the cap are refused, and admitted again later", async () => {
    const orch = makeOrchestrator(env, { limits: { ...LIMITS, maxConcurrentDesktops: 2 } });
    let first: Report[] = [];
    let later: Report | undefined;
    await orch.run(async (h) => {
      first = await Promise.all([1, 2, 3, 4].map(() => h.submit({ taskId: "df-s01" })));
      later = await h.submit({ taskId: "df-s01" });
    });
    expect(first.map((r) => r.status)).toEqual(["done", "done", "refused", "refused"]);
    expect(first.slice(2).map((r) => r.codes)).toEqual([["CONCURRENCY_CAP"], ["CONCURRENCY_CAP"]]);
    expect(env.peak).toBe(2);
    expect(later?.status).toBe("done");
  });

  it("token budget: a spawn whose reservation would exceed the total is refused", async () => {
    const orch = makeOrchestrator(env, {
      limits: { ...LIMITS, maxTotalTokens: 25_000, maxTokensPerWorker: 10_000 },
      transport: { usage: () => ({ inputTokens: 8_000, outputTokens: 2_000 }) },
    });
    const out: string[] = [];
    const record = await orch.run(async (h) => {
      for (let i = 0; i < 3; i++)
        out.push((await h.submit({ taskId: "df-s01" })).codes.join() || "ok");
    });
    expect(out).toEqual(["ok", "ok", "BUDGET_TOKENS"]);
    expect(record.totals.inputTokens + record.totals.outputTokens).toBe(20_000);
  });

  it("token budget holds under concurrency: reservations count before usage is known", async () => {
    const orch = makeOrchestrator(env, {
      limits: { ...LIMITS, maxTotalTokens: 25_000, maxTokensPerWorker: 10_000 },
    });
    let reports: Report[] = [];
    await orch.run(async (h) => {
      reports = await Promise.all([1, 2, 3].map(() => h.submit({ taskId: "df-s01" })));
    });
    expect(reports.map((r) => r.codes.join() || r.status)).toEqual([
      "done",
      "done",
      "BUDGET_TOKENS",
    ]);
  });

  it("estimated-cost budget (micro-USD, an estimate)", async () => {
    // Reservation: 10k tokens at the dearer price 15 USD/Mtok = 150_000 micro-USD.
    const orch = makeOrchestrator(env, {
      limits: { ...LIMITS, maxEstimatedCostMicroUsd: 150_000 },
    });
    const out: string[] = [];
    const record = await orch.run(async (h) => {
      for (let i = 0; i < 2; i++)
        out.push((await h.submit({ taskId: "df-s01" })).codes.join() || "ok");
    });
    expect(out).toEqual(["ok", "BUDGET_COST"]);
    // 1000 in × 3 + 200 out × 15 = 6000 micro-USD.
    expect(record.totals.estimatedCostMicroUsd).toBe(6_000);
  });

  it("unmetered usage: cost is null (never 0) and no further spawn is admitted", async () => {
    const orch = makeOrchestrator(env, { transport: { usage: () => null } });
    const out: string[] = [];
    const record = await orch.run(async (h) => {
      out.push((await h.submit({ taskId: "df-s01" })).status);
      out.push((await h.submit({ taskId: "df-s01" })).codes.join());
    });
    expect(out).toEqual(["done", "BUDGET_UNMETERED"]);
    expect(record.totals.estimatedCostMicroUsd).toBeNull();
    expect(record.totals.unmetered).toBe(1);
  });

  it("a worker that never reached the meter is unmetered, never free", async () => {
    const throwing: (root: string) => TrialIsolation = () => ({
      agentRoots: [join(env.base, "agents")],
      provision: async () => {
        throw new Error("no desktop");
      },
    });
    env.cleanup();
    env = makeEnv(throwing);
    const orch = makeOrchestrator(env);
    let report: Report | undefined;
    const record = await orch.run(async (h) => {
      report = await h.submit({ taskId: "df-s01" });
    });
    expect(report?.codes).toEqual(["ISOLATION_FAILED"]);
    expect(record.totals.estimatedCostMicroUsd).toBeNull();
  });

  it("planner usage counts against the budget (host-metered, operator side)", async () => {
    const orch = makeOrchestrator(env, { limits: { ...LIMITS, maxTotalTokens: 50_000 } });
    let report: Report | undefined;
    await orch.run(async (h) => {
      orch.chargePlanner(h.nodeId, { inputTokens: 45_000, outputTokens: 0 });
      report = await h.submit({ taskId: "df-s01" });
    });
    expect(report?.codes).toEqual(["BUDGET_TOKENS"]);
  });

  it("wall budget (clock): no spawn once the wall budget is spent, and the stop is recorded", async () => {
    let now = 1_000;
    const orch = makeOrchestrator(env, { now: () => now });
    let report: Report | undefined;
    const record = await orch.run(async (h) => {
      now += LIMITS.maxWallMs;
      report = await h.submit({ taskId: "df-s01" });
    });
    expect(report?.codes).toEqual(["BUDGET_WALL"]);
    expect(record.halt?.code).toBe("BUDGET_WALL");
    expect(ledgerRows(env).some((r) => r.type === "halt" && r.code === "BUDGET_WALL")).toBe(true);
  });

  it("wall budget (timer): in-flight workers are stopped and never reported done", async () => {
    const orch = makeOrchestrator(env, {
      limits: { ...LIMITS, maxWallMs: 50 },
      transport: { script: () => "hang" },
    });
    const record = await orch.run(async (h) => {
      await h.submit({ taskId: "df-s01" });
    });
    expect(record.halt?.code).toBe("BUDGET_WALL");
    expect(record.root.status).toBe("killed");
  });
});

describe("kill switch", () => {
  it("kill() stops everything, in-flight workers are not done, and the stop is recorded", async () => {
    const orch = makeOrchestrator(env, { transport: { script: () => "hang" } });
    let inflight: Promise<Report> | undefined;
    let afterKill: Promise<Report> | undefined;
    const record = await orch.run(async (h) => {
      inflight = h.submit({ taskId: "df-s01" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      orch.kill("operator pressed stop");
      afterKill = h.submit({ taskId: "df-s01" });
    });
    expect(record.halt).toMatchObject({ code: "KILLED", detail: "operator pressed stop" });
    expect(record.root.status).toBe("killed");
    const worker1 = await inflight;
    expect(worker1?.status).toBe("killed");
    expect(worker1?.codes).toContain("KILLED");
    expect((await afterKill)?.codes).toEqual(["KILLED"]);
    const halt = ledgerRows(env).find((r) => r.type === "halt");
    expect(halt).toMatchObject({ code: "KILLED", inFlight: ["w1"] });
  });

  it("the kill-switch file halts the run at the next spawn", async () => {
    const stop = join(env.base, "operator", "STOP");
    const orch = makeOrchestrator(env, { killSwitchFile: stop });
    const out: string[] = [];
    const record = await orch.run(async (h) => {
      out.push((await h.submit({ taskId: "df-s01" })).status);
      writeFileSync(stop, "");
      out.push((await h.submit({ taskId: "df-s01" })).codes.join());
    });
    expect(out).toEqual(["done", "KILLED"]);
    expect(record.halt?.code).toBe("KILLED");
  });

  it("after the run ends, a leaked handle spawns nothing", async () => {
    const orch = makeOrchestrator(env);
    let leaked: PlannerHandle | undefined;
    await orch.run(async (h) => {
      leaked = h;
    });
    const late = await (leaked as PlannerHandle).submit({ taskId: "df-s01" });
    expect(late.codes).toEqual(["RUN_NOT_ACTIVE"]);
  });
});

describe("isolation: one trial, one gate per worker", () => {
  it("each worker has its own workspace and run; its gate refuses another worker's run", async () => {
    const orch = makeOrchestrator(env, {
      transport: {
        also: async (a, gate, log) => {
          const other = a.runId.endsWith("-w1") ? "orch-test-w2" : "orch-test-w1";
          log.peek = await gate.check({ taskId: a.taskId, runId: other });
        },
      },
    });
    await orch.run(async (h) => {
      await Promise.all([h.submit({ taskId: "df-s01" }), h.submit({ taskId: "df-s02" })]);
    });
    const [a, b] = env.logs;
    expect(a?.assignment.workspace).not.toBe(b?.assignment.workspace);
    expect(a?.assignment.runId).not.toBe(b?.assignment.runId);
    for (const log of env.logs) {
      const peek = log.peek as GateResult;
      expect(peek.accepted).toBe(false);
      expect(peek.reasonCodes).toContain("ASSIGNMENT_MISMATCH");
      expect(peek.evidenceRefs).toEqual([]);
      expect(Object.keys(log.assignment).sort()).toEqual(
        ["depth", "nodeId", "runId", "signal", "taskId", "workspace"].sort(),
      );
    }
  });

  it("an isolation that hands two trials overlapping workspaces is refused", async () => {
    env.cleanup();
    env = makeEnv((root) => ({
      agentRoots: [root],
      provision: async (runId) => {
        const workspace = join(root, "shared");
        mkdirSync(workspace, { recursive: true });
        return { runId, workspace, release: async () => {} };
      },
    }));
    const orch = makeOrchestrator(env);
    const codes: string[] = [];
    await orch.run(async (h) => {
      codes.push((await h.submit({ taskId: "df-s01" })).status);
      codes.push((await h.submit({ taskId: "df-s01" })).codes.join());
    });
    expect(codes).toEqual(["done", "ISOLATION_OVERLAP"]);
  });
});

describe("run record and ledger", () => {
  it("records the spawn tree, verdicts and limits hit in a MAC-chained ledger", async () => {
    const orch = makeOrchestrator(env, {
      limits: { ...LIMITS, maxSpawnsPerPlanner: 2 },
      subPlanners: {
        sub: async (h) => {
          await h.submit({ taskId: "df-s02" });
        },
      },
    });
    const record = await orch.run(async (h) => {
      await h.submit({ taskId: "df-s01" });
      await h.submit({ kind: "planner", goal: "sub" });
      await h.submit({ taskId: "df-s01" });
    });
    expect(record).toMatchObject({ provenance: "mock", countsAsEvidence: false });
    expect(record.nodes.map((n) => [n.nodeId, n.parentId, n.kind, n.status])).toEqual([
      ["w1", "p0", "worker", "done"],
      ["w3", "p2", "worker", "refuted"],
      ["p2", "p0", "planner", "uncertain"],
      ["r4", "p0", "worker", "refused"],
      ["p0", null, "planner", "uncertain"],
    ]);
    expect(record.nodes[0]?.sealDigest).toMatch(/^[0-9a-f]{64}$/);
    const rows = ledgerRows(env);
    expect(rows.map((r) => r.type)).toEqual([
      "run-start",
      "spawn",
      "verdict",
      "spawn",
      "spawn",
      "verdict",
      "planner-end",
      "refused",
      "planner-end",
      "run-end",
    ]);
    expect(rows.every((r) => r.provenance === "mock")).toBe(true);
    expect(rows.find((r) => r.type === "refused")).toMatchObject({
      code: "PLANNER_SPAWN_CAP",
      limit: true,
    });
    expect(rows[0]).toMatchObject({ limits: { ...LIMITS, maxSpawnsPerPlanner: 2 } });
    expect(record.ledger.head).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ledger write failure on spawn: refused and the run halts (fail closed)", async () => {
    const orch = makeOrchestrator(env);
    let report: Report | undefined;
    const record = await orch.run(async (h) => {
      renameSync(env.ledgerPath, `${env.ledgerPath}.moved`);
      mkdirSync(env.ledgerPath);
      report = await h.submit({ taskId: "df-s01" });
    });
    expect(report?.codes).toEqual(["LEDGER_FAILED"]);
    expect(record.halt?.code).toBe("LEDGER_FAILED");
    expect(env.logs).toHaveLength(0);
  });

  it("ledger write failure on a verdict: a verified result is not handed over as done", async () => {
    const orch = makeOrchestrator(env, {
      transport: {
        also: async () => {
          renameSync(env.ledgerPath, `${env.ledgerPath}.moved`);
          mkdirSync(env.ledgerPath);
        },
      },
    });
    let report: Report | undefined;
    await orch.run(async (h) => {
      report = await h.submit({ taskId: "df-s01" });
    });
    expect(report?.status).toBe("unverified");
    expect(report?.codes).toContain("LEDGER_FAILED");
    expect(report?.status).not.toBe("done");
  });

  it("one ledger per run: an existing ledger is never appended to by a new run", () => {
    writeFileSync(env.ledgerPath, "");
    expect(() => makeOrchestrator(env)).toThrow(/already exists/);
  });

  it("an orchestrator runs once", async () => {
    const orch = makeOrchestrator(env);
    await orch.run(async () => {});
    await expect(orch.run(async () => {})).rejects.toThrow(/runs once/);
  });
});

describe("statusOfOutcome: done only for verified + accepted + ORACLE_PASS", () => {
  const decided = (result: Partial<GateResult>) =>
    ({
      status: "decided",
      audit: {},
      receipt: { runId: "r", sealDigest: "d" },
      corrections: "off",
      result: { verdict: "verified", accepted: true, reasonCodes: ["ORACLE_PASS"], ...result },
    }) as unknown as GatedTrialOutcome;
  it("maps every non-verified shape to not done", () => {
    expect(statusOfOutcome(decided({})).status).toBe("done");
    expect(statusOfOutcome(decided({ accepted: false })).status).toBe("uncertain");
    expect(statusOfOutcome(decided({ reasonCodes: ["ORACLE_UNCERTAIN"] })).status).toBe(
      "uncertain",
    );
    expect(statusOfOutcome(decided({ verdict: "uncertain", accepted: true })).status).toBe(
      "uncertain",
    );
    expect(
      statusOfOutcome(
        decided({ verdict: "refuted", accepted: false, reasonCodes: ["ORACLE_FAIL"] }),
      ).status,
    ).toBe("refuted");
    expect(
      statusOfOutcome({ status: "refused", audit: {} } as unknown as GatedTrialOutcome),
    ).toMatchObject({ status: "unverified", codes: ["LAUNCH_REFUSED"] });
  });
});

/** Resolves to "TIMEOUT" when `promise` has not settled within `ms`. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | "TIMEOUT"> =>
  Promise.race([promise, new Promise<"TIMEOUT">((resolve) => setTimeout(resolve, ms, "TIMEOUT"))]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("round 2: a halt ends the run whenever it lands (D1)", () => {
  it("kill() after the planner returned, while it waits on a child that never settles: run() returns and records the child killed", async () => {
    const orch = makeOrchestrator(env, { transport: { script: () => "stuck" } });
    setTimeout(() => orch.kill("late stop"), 30);
    const record = await within(
      orch.run(async (h) => {
        void h.submit({ taskId: "df-s01" });
      }),
      1_500,
    );
    if (record === "TIMEOUT") throw new Error("run() did not return after kill()");
    expect(record.halt).toMatchObject({ code: "KILLED", detail: "late stop" });
    expect(record.root).toMatchObject({ status: "killed", codes: ["KILLED"] });
    // The unsettled child is in the root's report and in the record, as killed.
    expect(record.root.children.map((c) => [c.nodeId, c.status, c.codes])).toEqual([
      ["w1", "killed", ["KILLED"]],
    ]);
    expect(record.nodes.map((n) => [n.nodeId, n.status])).toEqual([
      ["p0", "killed"],
      ["w1", "killed"],
    ]);
    // Never reached the meter: unmetered, cost null (never 0).
    expect(record.totals.unmetered).toBe(1);
    expect(record.totals.estimatedCostMicroUsd).toBeNull();
    // The halt itself is a limit hit (V4).
    expect(record.limitsHit).toContainEqual(
      expect.objectContaining({ code: "KILLED", parentId: null }),
    );
    expect(ledgerRows(env).map((r) => r.type)).toEqual([
      "run-start",
      "spawn",
      "halt",
      "planner-end",
      "abandoned",
      "run-end",
    ]);
  });

  it("the wall budget fires while the planner waits on a child that never settles: run() returns", async () => {
    const orch = makeOrchestrator(env, {
      limits: { ...LIMITS, maxWallMs: 40 },
      transport: { script: () => "stuck" },
    });
    const record = await within(
      orch.run(async (h) => {
        void h.submit({ taskId: "df-s01" });
      }),
      1_500,
    );
    if (record === "TIMEOUT") throw new Error("run() did not return at the wall budget");
    expect(record.halt?.code).toBe("BUDGET_WALL");
    expect(record.limitsHit).toContainEqual(
      expect.objectContaining({ code: "BUDGET_WALL", parentId: null }),
    );
    expect(record.nodes.find((n) => n.nodeId === "w1")?.status).toBe("killed");
  });

  it("a nested sub-planner waiting on a stuck worker: run() returns and both are recorded killed", async () => {
    const orch = makeOrchestrator(env, {
      transport: { script: () => "stuck" },
      subPlanners: {
        sub: async (h) => {
          void h.submit({ taskId: "df-s01" });
        },
      },
    });
    setTimeout(() => orch.kill(), 30);
    const record = await within(
      orch.run(async (h) => {
        void h.submit({ kind: "planner", goal: "sub" });
      }),
      1_500,
    );
    if (record === "TIMEOUT") throw new Error("run() did not return after kill()");
    const status = Object.fromEntries(record.nodes.map((n) => [n.nodeId, n.status]));
    expect(status).toEqual({ p0: "killed", p1: "killed", w2: "killed" });
    const rows = ledgerRows(env);
    expect(rows.at(-1)?.type).toBe("run-end");
  });
});

describe("round 2: nothing is recorded after run-end", () => {
  it("a worker that settles after a halted run ended comes back killed and writes nothing", async () => {
    const orch = makeOrchestrator(env, { transport: { script: () => "late" } });
    let inflight: Promise<Report> | undefined;
    setTimeout(() => orch.kill(), 30);
    const record = await orch.run(async (h) => {
      inflight = h.submit({ taskId: "df-s01" });
    });
    expect(record.nodes.find((n) => n.nodeId === "w1")?.status).toBe("killed");
    const rows = ledgerRows(env).length;
    const late = await within(inflight as Promise<Report>, 1_500);
    expect(late).toMatchObject({ nodeId: "w1", status: "killed", codes: ["KILLED"] });
    expect(ledgerRows(env)).toHaveLength(rows);
    expect(ledgerRows(env).at(-1)?.type).toBe("run-end");
    expect(env.live).toBe(0);
  });

  it("chargePlanner after run-end writes no ledger row", async () => {
    const orch = makeOrchestrator(env);
    await orch.run(async () => {});
    const rows = ledgerRows(env).length;
    orch.chargePlanner("p0", { inputTokens: 1, outputTokens: 1 });
    expect(ledgerRows(env)).toHaveLength(rows);
  });
});

describe("round 2: a planner's handle spawns nothing once its planner returned (D2)", () => {
  it("a sub-planner's kept handle is refused PLANNER_ENDED; no desktop outlives the run and every worker is recorded", async () => {
    let zombie: PlannerHandle | undefined;
    const orch = makeOrchestrator(env, {
      subPlanners: {
        z: async (h) => {
          zombie = h;
          await h.submit({ taskId: "df-s01" });
        },
      },
    });
    let late: Report | undefined;
    const record = await orch.run(async (h) => {
      await h.submit({ kind: "planner", goal: "z" });
      late = await (zombie as PlannerHandle).submit({ taskId: "df-s01", note: "slow" });
    });
    expect(late).toMatchObject({ status: "refused", codes: ["PLANNER_ENDED"] });
    expect(env.live).toBe(0);
    expect(env.logs).toHaveLength(1);
    expect(record.totals.workers).toBe(1);
    expect(record.nodes.map((n) => [n.nodeId, n.parentId, n.status])).toEqual([
      ["w2", "p1", "done"],
      ["p1", "p0", "done"],
      ["r3", "p1", "refused"],
      ["p0", null, "done"],
    ]);
    const types = ledgerRows(env).map((r) => r.type);
    expect(types).toEqual([
      "run-start",
      "spawn",
      "spawn",
      "verdict",
      "planner-end",
      "refused",
      "planner-end",
      "run-end",
    ]);
  });

  it("after run-end, a leaked handle writes no node and no ledger row", async () => {
    const orch = makeOrchestrator(env);
    let leaked: PlannerHandle | undefined;
    const record = await orch.run(async (h) => {
      leaked = h;
    });
    const before = ledgerRows(env).length;
    const late = await (leaked as PlannerHandle).submit({ taskId: "df-s01" });
    expect(late.codes).toEqual(["RUN_NOT_ACTIVE"]);
    expect(ledgerRows(env)).toHaveLength(before);
    expect(ledgerRows(env).at(-1)?.type).toBe("run-end");
    expect(record.nodes).toHaveLength(1);
  });
});

describe("round 2: agent-authored note and goal are recorded as digest + length (D3)", () => {
  it("the spawn rows carry sha256 and length of the note and the goal, never the text", async () => {
    const note = "please tick item two first";
    const goal = "split the todo work";
    const orch = makeOrchestrator(env, {
      subPlanners: {
        [goal]: async (h) => {
          await h.submit({ taskId: "df-s01" });
        },
      },
    });
    await orch.run(async (h) => {
      await h.submit({ taskId: "df-s01", note });
      await h.submit({ kind: "planner", goal });
    });
    const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    const spawns = ledgerRows(env).filter((r) => r.type === "spawn");
    expect(spawns.map((r) => [r.kind, r.kind === "worker" ? r.note : r.goal])).toEqual([
      ["worker", { sha256: sha(note), length: note.length }],
      ["planner", { sha256: sha(goal), length: goal.length }],
      ["worker", null],
    ]);
    const raw = readFileSync(env.ledgerPath, "utf8");
    expect(raw).not.toContain(note);
    expect(raw).not.toContain(goal);
  });
});

describe("round 2: isolation claims are enforced (D4, V1, V3)", () => {
  it("a vault inside an isolation agent root is refused, even when the vault was built without that root", () => {
    const agentRoot = env.isolation.agentRoots[0] as string;
    const blind = new VerdictVault({
      root: join(agentRoot, "vault"),
      key: newVaultKey(),
      agentRoots: [],
    });
    expect(() => makeOrchestrator(env, { vault: blind })).toThrow(/vault is agent-reachable/);
    const containing = new VerdictVault({ root: env.base, key: newVaultKey(), agentRoots: [] });
    expect(() => makeOrchestrator(env, { vault: containing })).toThrow(/vault is agent-reachable/);
  });

  it("a workspace outside every agent root is refused ISOLATION_UNCONTAINED and never launched", async () => {
    env.cleanup();
    env = makeEnv((root) => ({
      agentRoots: [root],
      provision: async (runId) => {
        const workspace = join(root, "..", "operator", runId);
        mkdirSync(workspace, { recursive: true });
        return { runId, workspace, release: async () => {} };
      },
    }));
    const orch = makeOrchestrator(env);
    let report: Report | undefined;
    await orch.run(async (h) => {
      report = await h.submit({ taskId: "df-s01" });
    });
    expect(report).toMatchObject({ status: "unverified", codes: ["ISOLATION_UNCONTAINED"] });
    expect(env.logs).toHaveLength(0);
  });

  it("a trial that comes back with a different run id is refused ISOLATION_OVERLAP", async () => {
    env.cleanup();
    env = makeEnv((root) => ({
      agentRoots: [root],
      provision: async (runId) => {
        const workspace = join(root, runId);
        mkdirSync(workspace, { recursive: true });
        return { runId: `${runId}x`, workspace, release: async () => {} };
      },
    }));
    const orch = makeOrchestrator(env);
    let report: Report | undefined;
    await orch.run(async (h) => {
      report = await h.submit({ taskId: "df-s01" });
    });
    expect(report).toMatchObject({ status: "unverified", codes: ["ISOLATION_OVERLAP"] });
    expect(env.logs).toHaveLength(0);
  });

  for (const [name, first, second] of [
    ["inside", "a", join("a", "b")],
    ["containing", join("a", "b"), "a"],
  ] as const) {
    it(`a workspace ${name} an earlier trial's workspace is refused ISOLATION_OVERLAP`, async () => {
      env.cleanup();
      let n = 0;
      env = makeEnv((root) => ({
        agentRoots: [root],
        provision: async (runId) => {
          const workspace = join(root, n++ === 0 ? first : second);
          mkdirSync(workspace, { recursive: true });
          return { runId, workspace, release: async () => {} };
        },
      }));
      const orch = makeOrchestrator(env);
      const out: string[] = [];
      await orch.run(async (h) => {
        out.push((await h.submit({ taskId: "df-s01" })).status);
        out.push((await h.submit({ taskId: "df-s01" })).codes.join());
      });
      expect(out).toEqual(["done", "ISOLATION_OVERLAP"]);
    });
  }
});

describe("round 2: negative usage is malformed, never a credit (V2)", () => {
  for (const usage of [
    { inputTokens: -1_000_000, outputTokens: 0 },
    { inputTokens: 0, outputTokens: -1_000_000 },
  ]) {
    it(`worker usage ${JSON.stringify(usage)} is unmetered and refuses later spawns`, async () => {
      const orch = makeOrchestrator(env, { transport: { usage: () => usage } });
      const out: string[] = [];
      const record = await orch.run(async (h) => {
        out.push((await h.submit({ taskId: "df-s01" })).status);
        out.push((await h.submit({ taskId: "df-s01" })).codes.join());
      });
      expect(out).toEqual(["done", "BUDGET_UNMETERED"]);
      expect(record.totals).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        unmetered: 1,
        estimatedCostMicroUsd: null,
      });
    });

    it(`planner usage ${JSON.stringify(usage)} is unmetered, refuses later spawns and is logged`, async () => {
      const orch = makeOrchestrator(env);
      let report: Report | undefined;
      await orch.run(async (h) => {
        orch.chargePlanner(h.nodeId, usage);
        report = await h.submit({ taskId: "df-s01" });
      });
      expect(report?.codes).toEqual(["BUDGET_UNMETERED"]);
      expect(ledgerRows(env).find((r) => r.type === "usage")).toMatchObject({
        nodeId: "p0",
        source: "planner",
        usage,
      });
    });
  }
});

describe("round 2: kill switch and halt details", () => {
  it("the kill-switch file stops an in-flight trial with no further spawn (polled on a timer)", async () => {
    const stop = join(env.base, "operator", "STOP");
    const orch = makeOrchestrator(env, {
      killSwitchFile: stop,
      transport: { script: () => "stuck" },
    });
    setTimeout(() => writeFileSync(stop, ""), 30);
    const record = await within(
      orch.run(async (h) => {
        await h.submit({ taskId: "df-s01" });
      }),
      1_500,
    );
    if (record === "TIMEOUT") throw new Error("the kill-switch file did not stop the run");
    expect(record.halt).toMatchObject({ code: "KILLED", detail: "kill-switch file present" });
    expect(record.nodes.find((n) => n.nodeId === "w1")?.status).toBe("killed");
  });

  it("a halt latches: a later kill or wall budget does not replace it", async () => {
    const orch = makeOrchestrator(env, { limits: { ...LIMITS, maxWallMs: 30 } });
    const record = await orch.run(async () => {
      orch.kill("first");
      orch.kill("second");
      await sleep(60);
    });
    expect(record.halt).toMatchObject({ code: "KILLED", detail: "first" });
    expect(record.limitsHit.filter((h) => h.parentId === null)).toHaveLength(1);
    expect(ledgerRows(env).filter((r) => r.type === "halt")).toHaveLength(1);
  });

  it("kill() before run(): the halt is at 0 ms and its row follows run-start", async () => {
    const orch = makeOrchestrator(env, { now: () => 1_700_000_000_000 });
    orch.kill("before start");
    const record = await orch.run(async (h) => {
      await h.submit({ taskId: "df-s01" });
    });
    expect(record.halt).toMatchObject({ code: "KILLED", atMs: 0 });
    expect(record.limitsHit.filter((h) => h.parentId === null)).toEqual([
      { code: "KILLED", parentId: null, atMs: 0 },
    ]);
    expect(
      ledgerRows(env)
        .map((r) => r.type)
        .slice(0, 2),
    ).toEqual(["run-start", "halt"]);
    expect(env.logs).toHaveLength(0);
  });
});

describe("round 2: written claims executed", () => {
  it("every limit-like word in a submission field name is refused LIMIT_WRITE_REJECTED", async () => {
    const words = [
      "limit",
      "budget",
      "depth",
      "concurrency",
      "max",
      "token",
      "cost",
      "wall",
      "kill",
      "quota",
      "deadline",
      "timeout",
    ];
    const orch = makeOrchestrator(env);
    const codes: string[] = [];
    await orch.run(async (h) => {
      for (const word of words)
        codes.push(...(await h.submit({ taskId: "df-s01", [word]: 1 })).codes);
    });
    expect(codes).toEqual(words.map(() => "LIMIT_WRITE_REJECTED"));
    expect(env.logs).toHaveLength(0);
  });

  it("src/orchestrate imports nothing from src/benchmark (grader independence)", () => {
    const dir = join(import.meta.dirname, "..", "..", "src", "orchestrate");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(dir, file), "utf8");
      const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      expect(
        imports.filter((i) => i?.includes("benchmark")),
        file,
      ).toEqual([]);
    }
  });
});
