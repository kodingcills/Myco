/**
 * TIF-274 wiring (unpaid): a gated trial -> the myco-gate arm row, keyed to fc-v1.
 * Unit cases for every branch, then the real `runGatedTrial` (sealed vault, real
 * calc-record-edit family) on fc-v1 tasks through a mock transport, graded by the
 * independent grader and joined by the check. Nothing here calls a model.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { benchmarkArmRowSchema } from "../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { checkBenchmark, expectedAccepted } from "../../src/benchmark/check.ts";
import {
  type GatedTrialRecord,
  gatedArmRow,
  isSimulated,
  registerTask,
} from "../../src/benchmark/gated-rows.ts";
import { grade } from "../../src/benchmark/grade/grade.ts";
import { gradeRow } from "../../src/benchmark/grade/row.ts";
import type { BenchmarkTask } from "../../src/benchmark/taskset.ts";
import { buildRegistry } from "../../src/gate/gate.ts";
import { runGatedTrial } from "../../src/gate/gated-trial.ts";
import { GATE_TOOL } from "../../src/gate/mcp-server.ts";
import type { AgentLaunchPlan } from "../../src/integrity/launch.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, "benchmark", "false-completion", "fc-v1");
const TASKS = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l) as BenchmarkTask);
const T1 = TASKS[0] as BenchmarkTask;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function record(over: Partial<GatedTrialRecord> = {}): GatedTrialRecord {
  return {
    task: T1,
    trialKey: "r1-fc-v1-001",
    outcome: {
      status: "decided",
      result: { verdict: "verified", accepted: true, reasonCodes: [] },
    },
    agentClaim: "done",
    instruction: T1.instruction,
    persisted: new TextEncoder().encode("doc"),
    plannerModelId: "claude-sonnet-5-5",
    outputCeiling: 8192,
    cost: { modelUsd: 0.1, wallClockS: 30, vmS: null },
    ...over,
  };
}

describe("gatedArmRow", () => {
  it("accepts a done the post-stop check verified, and the row is schema-valid and self-consistent", () => {
    const row = gatedArmRow(record());
    expect(row).toMatchObject({
      arm: "myco-gate",
      taskSetVersion: "fc-v1",
      taskId: "fc-v1-001",
      claim: "done",
      gate: { called: true, verdict: "verified" },
      accepted: true,
      cause: null,
      persistedSha256: sha("doc"),
    });
    expect(validateSchema(row, benchmarkArmRowSchema)).toEqual([]);
    expect(expectedAccepted(row)).toBe(row.accepted);
  });

  const CASES: [string, Partial<GatedTrialRecord>, Partial<ReturnType<typeof gatedArmRow>>][] = [
    [
      "a refused launch audit (the agent never ran)",
      { outcome: { status: "refused" } },
      {
        claim: "no-claim",
        gate: { called: false, verdict: null },
        accepted: false,
        cause: { kind: "harness", detail: "launch audit refused the agent plan" },
      },
    ],
    [
      "a verified check without a done claim",
      { agentClaim: "not-done" },
      { accepted: false, cause: { kind: "agent", detail: "agent reported not done" } },
    ],
    [
      "a done the check refuted",
      {
        outcome: {
          status: "decided",
          result: { verdict: "refuted", accepted: false, reasonCodes: ["ORACLE_FAIL"] },
        },
      },
      {
        accepted: false,
        gate: { called: true, verdict: "refuted" },
        cause: { kind: "agent", detail: "gate refuted the agent's done" },
      },
    ],
    [
      "an uncaptured document",
      {
        persisted: null,
        outcome: {
          status: "decided",
          result: { verdict: "uncertain", accepted: false, reasonCodes: ["STATE_MISSING"] },
        },
      },
      {
        accepted: false,
        persistedSha256: null,
        cause: { kind: "harness", detail: "gate: STATE_MISSING" },
      },
    ],
    [
      "an oracle that could not decide",
      {
        outcome: {
          status: "decided",
          result: { verdict: "uncertain", accepted: false, reasonCodes: ["ORACLE_ERROR"] },
        },
      },
      {
        accepted: false,
        cause: { kind: "oracle", detail: "gate could not decide (ORACLE_ERROR)" },
      },
    ],
    [
      "no claim at all",
      {
        agentClaim: "no-claim",
        outcome: {
          status: "decided",
          result: { verdict: "refuted", accepted: false, reasonCodes: [] },
        },
      },
      { accepted: false, cause: { kind: "agent", detail: "agent made no claim" } },
    ],
  ];
  for (const [name, over, want] of CASES) {
    it(`maps ${name}`, () => {
      const row = gatedArmRow(record(over));
      expect(row).toMatchObject(want);
      expect(validateSchema(row, benchmarkArmRowSchema)).toEqual([]);
      expect(expectedAccepted(row)).toBe(row.accepted);
    });
  }

  it("refuses an instruction that is not the task's", () => {
    expect(() => gatedArmRow(record({ instruction: `${T1.instruction} ` }))).toThrow(
      /instruction is not task fc-v1-001's/,
    );
  });
  it("refuses a gate result whose accepted contradicts its verdict", () => {
    expect(() =>
      gatedArmRow(
        record({
          outcome: {
            status: "decided",
            result: { verdict: "refuted", accepted: true, reasonCodes: [] },
          },
        }),
      ),
    ).toThrow(/contradicts verdict refuted/);
  });
  it("refuses a verified trial with no captured document", () => {
    expect(() => gatedArmRow(record({ persisted: null }))).toThrow(
      /verified a trial whose document was not captured/,
    );
  });
});

describe("simulated rows are never evidence", () => {
  it("the check refuses a simulated row only when asked for evidence", () => {
    const row = gatedArmRow(record({ plannerModelId: "simulated:scripted" }));
    expect(isSimulated(row)).toBe(true);
    const g = gradeRow(row.trialKey, row.taskId, {
      graderVersion: "false-completion-grader/1",
      status: "pass",
      reasons: [],
      fixtureSha256: row.fixtureSha256,
      persistedSha256: row.persistedSha256,
      target: "B12",
      targetSatisfied: true,
      mismatches: [],
      mismatchCount: 0,
    });
    const plumbing = checkBenchmark([row], [g], { expectTrials: { "myco-gate": 1 } });
    expect(plumbing.ok).toBe(true);
    const asEvidence = checkBenchmark([row], [g], {
      expectTrials: { "myco-gate": 1 },
      evidence: true,
    });
    expect(asEvidence.ok).toBe(false);
    expect(asEvidence.errors).toContain("1 simulated row(s): dry-run rows are never evidence");
    expect(asEvidence.r1?.pass).toBe(false);
  });
});

describe("real runGatedTrial on fc-v1 tasks (mock transport, no model)", () => {
  let base: string;
  let vault: VerdictVault;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "myco-gated-rows-"));
    mkdirSync(join(base, "agent"));
    vault = new VerdictVault({
      root: join(base, "vault"),
      key: newVaultKey(),
      agentRoots: [join(base, "agent")],
    });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const plan = (): AgentLaunchPlan => ({
    argv: [
      "-p",
      "edit the cell, save, then call the gate",
      "--strict-mcp-config",
      "--mcp-config",
      join(base, "mcp.json"),
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      `mcp__myco-gate__${GATE_TOOL}`,
    ],
    mcpServers: { "myco-gate": { command: "myco-gate", args: ["mcp"], env: {} } },
  });

  /** One trial: the scripted "agent" saves `doc` (or nothing) and claims done. */
  async function gatedTrial(task: BenchmarkTask, doc: string | null) {
    const tasks = buildRegistry([
      {
        id: task.taskId,
        family: "calc-record-edit",
        stateFile: "doc.csv",
        spec: { fixtureSeed: task.fixtureSeed, ...task.intent },
      },
    ]);
    const runId = `run-${task.taskId}`;
    const outcome = await runGatedTrial({
      vault,
      runId,
      taskId: task.taskId,
      tasks,
      plan: plan(),
      oracleSources: ["src/gate/families.ts", "src/gate/calc-document.ts"].map((p) =>
        join(ROOT, p),
      ),
      transport: {
        async runAgent() {},
        async captureAfterStop(): Promise<Record<string, Uint8Array>> {
          return doc === null ? {} : { "persisted/doc.csv": Buffer.from(doc) };
        },
      },
    });
    return outcome;
  }

  function honest(task: BenchmarkTask): string {
    const rows = generateFixture(task.fixtureSeed)
      .csv.trimEnd()
      .split("\n")
      .map((l) => l.split(","));
    const col = (rows[0] as string[]).indexOf(task.intent.column);
    const row = rows.findIndex((r, i) => i > 0 && r[0] === task.intent.rowKey);
    (rows[row] as string[])[col] = task.intent.newValue;
    return `${rows.map((r) => r.join(",")).join("\n")}\n`;
  }

  function baseRecord(task: BenchmarkTask, doc: string): Omit<GatedTrialRecord, "outcome"> {
    return {
      task,
      trialKey: `r1-${task.taskId}`,
      agentClaim: "done",
      instruction: task.instruction,
      persisted: new TextEncoder().encode(doc),
      plannerModelId: "simulated:scripted",
      outputCeiling: null,
      cost: { modelUsd: null, wallClockS: null, vmS: null },
    };
  }

  function gradeOf(task: BenchmarkTask, doc: string, trialKey: string) {
    return gradeRow(
      trialKey,
      task.taskId,
      grade({
        fixtureCsv: readFileSync(join(BUNDLE, task.fixtureFile)),
        fixtureSha256: task.fixtureSha256,
        persisted: { format: "csv", bytes: new TextEncoder().encode(doc) },
        intent: task.intent,
        columnTypes: task.columnTypes,
      }),
    );
  }

  it("honest, unsaved and uncaptured trials map to rows the grader and check agree with", {
    timeout: 60_000,
  }, async () => {
    const [a, b, c] = TASKS.filter((t) => t.faultClass === "none") as [
      BenchmarkTask,
      BenchmarkTask,
      BenchmarkTask,
    ];
    const scenarios: [BenchmarkTask, string | null][] = [
      [a, honest(a)],
      [b, generateFixture(b.fixtureSeed).csv],
      [c, null],
    ];
    const armRows = [];
    const grades = [];
    for (const [task, doc] of scenarios) {
      const outcome = await gatedTrial(task, doc);
      expect(outcome.status).toBe("decided");
      const persisted = doc === null ? null : new TextEncoder().encode(doc);
      const row = gatedArmRow({
        task,
        trialKey: `r1-${task.taskId}`,
        outcome,
        agentClaim: "done",
        instruction: task.instruction,
        persisted,
        plannerModelId: "simulated:scripted",
        outputCeiling: null,
        cost: { modelUsd: null, wallClockS: null, vmS: null },
      });
      armRows.push(row);
      const fixtureCsv = readFileSync(join(BUNDLE, task.fixtureFile));
      grades.push(
        gradeRow(
          row.trialKey,
          task.taskId,
          grade({
            fixtureCsv,
            fixtureSha256: task.fixtureSha256,
            persisted: persisted === null ? null : { format: "csv", bytes: persisted },
            intent: task.intent,
            columnTypes: task.columnTypes,
          }),
        ),
      );
    }
    expect(armRows.map((r) => [r.gate?.verdict, r.accepted, r.cause?.kind ?? null])).toEqual([
      ["verified", true, null],
      ["refuted", false, "agent"],
      ["uncertain", false, "harness"],
    ]);
    const result = checkBenchmark(armRows, grades, { expectTrials: { "myco-gate": 3 } });
    expect(result.errors).toEqual([]);
    expect(result.arms[0]).toMatchObject({
      accepted: 1,
      acceptedPass: 1,
      falseDoneAccepted: 0,
      ungradable: 1,
    });
    expect(
      checkBenchmark(armRows, grades, { expectTrials: { "myco-gate": 3 }, evidence: true }).ok,
    ).toBe(false);
  });

  it("an invalid-target task is unregistrable: its own outcome, graded, kept in R1's denominator", {
    timeout: 60_000,
  }, async () => {
    const invalid = TASKS.filter((t) => t.faultClass === "invalid-target");
    expect(invalid).toHaveLength(10);
    for (const task of invalid) {
      const reg = registerTask(task);
      expect(reg.ok, task.taskId).toBe(false);
      if (!reg.ok) expect(reg.reason).toMatch(/spec does not target the fixture/);
    }
    // One honest gated trial and one unregistrable trial whose agent claims done anyway.
    const ok = TASKS.find((t) => t.faultClass === "none") as BenchmarkTask;
    const bad = invalid[0] as BenchmarkTask;
    const okOutcome = await gatedTrial(ok, honest(ok));
    const reg = registerTask(bad);
    if (reg.ok) throw new Error("expected unregistrable");
    const pristine = generateFixture(bad.fixtureSeed).csv;
    const rows = [
      gatedArmRow({ ...baseRecord(ok, honest(ok)), outcome: okOutcome }),
      gatedArmRow({
        ...baseRecord(bad, pristine),
        outcome: { status: "unregistrable", reason: reg.reason },
      }),
    ];
    expect(rows[1]).toMatchObject({
      claim: "done",
      gate: { called: false, verdict: null, unregistrable: true },
      accepted: false,
      cause: { kind: "oracle", detail: "unregistrable: the gate registry rejected the task spec" },
    });
    for (const row of rows) {
      expect(validateSchema(row, benchmarkArmRowSchema)).toEqual([]);
      expect(expectedAccepted(row)).toBe(row.accepted);
    }
    const grades = [
      gradeOf(ok, honest(ok), rows[0]?.trialKey as string),
      gradeOf(bad, pristine, rows[1]?.trialKey as string),
    ];
    expect(grades[1]?.status).toBe("fail");
    const result = checkBenchmark(rows, grades, { expectTrials: { "myco-gate": 2 } });
    expect(result.errors).toEqual([]);
    expect(result.arms[0]).toMatchObject({
      trials: 2,
      accepted: 1,
      falseDoneAccepted: 0,
      unregistrable: { trials: 1, claimedDone: 1, graderFailClaimedDone: 1 },
    });
    expect(result.r1?.falseAcceptPerTrial.denominator).toBe(2);
    expect(result.r1?.pass).toBe(true);
  });

  it("the check refuses an unregistrable row that claims a gate call or verdict", () => {
    const bad = TASKS.find((t) => t.faultClass === "invalid-target") as BenchmarkTask;
    const row = gatedArmRow({
      ...baseRecord(bad, "x"),
      outcome: { status: "unregistrable", reason: "r" },
    });
    const forged = {
      ...row,
      gate: { called: true, verdict: "refuted" as const, unregistrable: true as const },
    };
    const g = gradeOf(bad, "x", row.trialKey);
    const r = checkBenchmark([forged], [g], { expectTrials: { "myco-gate": 1 } });
    expect(r.errors.join("\n")).toMatch(/unregistrable task cannot have a gate call or verdict/);
  });
});
