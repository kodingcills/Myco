/**
 * R1 packs record whether the gate's agent-safe corrections were on (M2 scope add B).
 *
 * The myco-gate arm row's `gate.corrections` is written on every row whose gate was called,
 * from `runGatedTrial`'s outcome (the same option it gave the sealed gate), never from the
 * caller on its own: a gate result that carries corrections on a record that says "off" is
 * refused. Off is the default. No model, no VM.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { benchmarkArmRowSchema } from "../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { type BenchmarkArmRow, checkBenchmark } from "../../src/benchmark/check.ts";
import {
  GATE_STATE_FILE,
  type GatedTrialRecord,
  gatedArmRow,
  gateEntryFor,
} from "../../src/benchmark/gated-rows.ts";
import { gradeRow } from "../../src/benchmark/grade/row.ts";
import type { BenchmarkTask } from "../../src/benchmark/taskset.ts";
import { buildRegistry } from "../../src/gate/gate.ts";
import { runGatedTrial } from "../../src/gate/gated-trial.ts";
import { GATE_TOOL } from "../../src/gate/mcp-server.ts";
import type { AgentLaunchPlan } from "../../src/integrity/launch.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const TASKS = readFileSync(
  join(ROOT, "benchmark", "false-completion", "fc-v1", "tasks.jsonl"),
  "utf8",
)
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l) as BenchmarkTask);
const T = TASKS.find((t) => t.faultClass === "none") as BenchmarkTask;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function docWith(value: string): string {
  const rows = generateFixture(T.fixtureSeed)
    .csv.trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  const col = (rows[0] as string[]).indexOf(T.intent.column);
  const row = rows.findIndex((r, i) => i > 0 && r[0] === T.intent.rowKey);
  (rows[row] as string[])[col] = value;
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

describe("R1 arm rows record gate.corrections", () => {
  let base: string;
  let vault: VerdictVault;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "myco-corrections-rows-"));
    mkdirSync(join(base, "agent"));
    vault = new VerdictVault({
      root: join(base, "vault"),
      key: newVaultKey(),
      agentRoots: [join(base, "agent")],
    });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const plan = (): AgentLaunchPlan => ({
    mcpConfigPath: join(base, "mcp.json"),
    argv: [
      "-p",
      "edit the cell, save, then call the gate",
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
  });

  async function gated(
    doc: string,
    corrections?: { families: string[] },
    plannerModelId = "simulated:scripted",
    attempt = 0,
  ) {
    const runId = attempt === 0 ? `run-${T.taskId}` : `run-${T.taskId}-${attempt}`;
    const outcome = await runGatedTrial({
      vault,
      runId,
      taskId: T.taskId,
      tasks: buildRegistry([gateEntryFor(T)]),
      plan: plan(),
      oracleSources: [join(ROOT, "src/gate/families.ts")],
      transport: {
        async runAgent() {},
        async captureAfterStop() {
          return { [`persisted/${GATE_STATE_FILE}`]: Buffer.from(doc) };
        },
      },
      ...(corrections ? { corrections } : {}),
    });
    if (outcome.status !== "decided") throw new Error("refused");
    const record: GatedTrialRecord = {
      taskId: T.taskId,
      trialKey: `r1-${T.taskId}`,
      runId,
      outcome,
      agentClaim: "done",
      instruction: T.instruction,
      persisted: new TextEncoder().encode(doc),
      persistedFormat: "csv",
      plannerModelId,
      outputCeiling: null,
      cost: { modelUsd: null, wallClockS: null, vmS: null },
    };
    return { outcome, record };
  }

  it("off by default: no corrections in the result, the row says off", async () => {
    const { outcome, record } = await gated(docWith("WRONG"));
    expect(outcome.corrections).toBe("off");
    expect(outcome.result.verdict).toBe("refuted");
    expect(outcome.result).not.toHaveProperty("corrections");
    const row = gatedArmRow(record, TASKS);
    expect(row.gate).toEqual({ called: true, verdict: "refuted", corrections: "off" });
    expect(validateSchema(row, benchmarkArmRowSchema)).toEqual([]);
  });

  it("on: the sealed gate returns corrections and the row says on", async () => {
    const { outcome, record } = await gated(docWith("WRONG"), {
      families: ["calc-record-edit"],
    });
    expect(outcome.corrections).toBe("on");
    expect(outcome.result.corrections).toEqual([
      expect.objectContaining({
        kind: "target_value_mismatch",
        observed: "WRONG",
        expected: T.intent.newValue,
      }),
    ]);
    const row = gatedArmRow(record, TASKS);
    expect(row.gate).toEqual({ called: true, verdict: "refuted", corrections: "on" });
    expect(row.persistedSha256).toBe(sha(docWith("WRONG")));
    expect(validateSchema(row, benchmarkArmRowSchema)).toEqual([]);
  });

  it("a result carrying corrections on a record that says off is refused", async () => {
    const { record } = await gated(docWith("WRONG"), { families: ["calc-record-edit"] });
    if (record.outcome.status !== "decided") throw new Error("unreachable");
    for (const corrections of ["off", undefined] as const) {
      const { corrections: _on, ...outcome } = record.outcome;
      const lying: GatedTrialRecord = {
        ...record,
        outcome: { ...outcome, ...(corrections ? { corrections } : {}) },
      };
      expect(() => gatedArmRow(lying, TASKS)).toThrow(/carries corrections, but the record says/);
    }
  });

  // #514 round 1, N4: the sealed gate's "before capture" answer carries no correction even
  // with corrections on (it is STATE_UNREADABLE, not STATE_MISSING), while the same trial's
  // decided result still gets its correction.
  it("a mid-run call with corrections on is STATE_UNREADABLE with no correction", async () => {
    const runId = `run-${T.taskId}-mid`;
    let mid: unknown;
    const outcome = await runGatedTrial({
      vault,
      runId,
      taskId: T.taskId,
      tasks: buildRegistry([gateEntryFor(T)]),
      plan: plan(),
      oracleSources: [join(ROOT, "src/gate/families.ts")],
      corrections: { families: ["calc-record-edit"] },
      transport: {
        async runAgent(_plan, gate) {
          mid = await gate.check({ taskId: T.taskId, runId, claim: "done" });
        },
        async captureAfterStop() {
          return { [`persisted/${GATE_STATE_FILE}`]: Buffer.from(docWith("WRONG")) };
        },
      },
    });
    expect(mid).toMatchObject({
      verdict: "uncertain",
      accepted: false,
      reasonCodes: ["STATE_UNREADABLE", "CLAIM_RECORDED"],
    });
    expect((mid as { reasons: string[] }).reasons.join("\n")).toMatch(/no sealed capture yet/);
    expect(mid).not.toHaveProperty("corrections");
    if (outcome.status !== "decided") throw new Error("refused");
    expect(outcome.corrections).toBe("on");
    expect(outcome.result.corrections?.map((c) => c.kind)).toEqual(["target_value_mismatch"]);
  });

  // #514 round 1, D1: an R1 pack with corrections on must not pass as evidence.
  describe("evidence refuses rows whose gate had corrections on (D1)", () => {
    const grade = (r: BenchmarkArmRow) =>
      gradeRow(r.trialKey, r.taskId, {
        graderVersion: "false-completion-grader/1",
        status: "fail",
        reasons: ["x"],
        fixtureSha256: r.fixtureSha256,
        persistedSha256: r.persistedSha256,
        target: "B12",
        targetSatisfied: false,
        mismatches: [],
        mismatchCount: 0,
      });
    const opts = (evidence: boolean) => ({ expectTrials: { "myco-gate": 1 }, evidence });

    it("a Claude-planner row with corrections on fails evidence; the same row off passes", async () => {
      const on = gatedArmRow(
        (await gated(docWith("WRONG"), { families: ["calc-record-edit"] }, "claude-sonnet-5-5"))
          .record,
        TASKS,
      );
      expect(on.gate?.corrections).toBe("on");
      const evidence = checkBenchmark([on], [grade(on)], opts(true));
      expect(evidence.ok).toBe(false);
      expect(evidence.errors).toEqual([
        expect.stringMatching(
          new RegExp(
            `^1 row\\(s\\) with gate corrections on \\(${on.trialKey}\\): R1 evidence runs keep corrections off`,
          ),
        ),
      ]);
      expect(evidence.r1?.pass).toBe(false);
      // Plumbing (not evidence) still accepts it: the guard is evidence-only.
      expect(checkBenchmark([on], [grade(on)], opts(false)).ok).toBe(true);

      const off = gatedArmRow(
        (await gated(docWith("WRONG"), undefined, "claude-sonnet-5-5", 1)).record,
        TASKS,
      );
      expect(off.gate?.corrections).toBe("off");
      expect(checkBenchmark([off], [grade(off)], opts(true)).errors).toEqual([]);
      // A row written before the field existed reads as off.
      const legacy = { ...off, gate: { called: true, verdict: "refuted" as const } };
      expect(checkBenchmark([legacy], [grade(legacy)], opts(true)).errors).toEqual([]);
    });

    it("one corrected row among clean ones is enough to fail evidence", async () => {
      const off = gatedArmRow(
        (await gated(docWith("WRONG"), undefined, "claude-opus-5-5")).record,
        TASKS,
      );
      const rows = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ ...off, trialKey: `k${i}` }));
      const last = rows[6] as BenchmarkArmRow;
      rows[6] = { ...last, gate: { called: true, verdict: "refuted", corrections: "on" } };
      const res = checkBenchmark(rows, rows.map(grade), {
        expectTrials: { "myco-gate": 7 },
        evidence: true,
      });
      expect(res.errors.join("\n")).toMatch(/1 row\(s\) with gate corrections on \(k6\)/);
    });
  });

  it("the schema takes off or on only, and rows without the field stay valid", () => {
    const row = {
      schema: "myco.benchmark.arm-row/1",
      taskSetVersion: "fc-v1",
      arm: "myco-gate",
      trialKey: "k",
      taskId: T.taskId,
      faultClass: "none",
      fixtureSha256: T.fixtureSha256,
      instructionSha256: T.instructionSha256,
      plannerModelId: "simulated:x",
      outputCeiling: null,
      claim: "done",
      gate: { called: true, verdict: "refuted" },
      accepted: false,
      persistedSha256: null,
      cause: null,
      cost: { modelUsd: null, wallClockS: null, vmS: null },
    };
    expect(validateSchema(row, benchmarkArmRowSchema)).toEqual([]);
    expect(
      validateSchema(
        { ...row, gate: { ...row.gate, corrections: "maybe" } },
        benchmarkArmRowSchema,
      ),
    ).not.toEqual([]);
  });
});
