/**
 * TIF-274 wiring (unpaid): a gated trial -> the myco-gate arm row, keyed to fc-v1.
 * Unit cases for every branch, then the real `runGatedTrial` (sealed vault, real
 * calc-record-edit family) on fc-v1 tasks through a mock transport, graded by the
 * independent grader and joined by the check. Nothing here calls a model.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { benchmarkArmRowSchema } from "../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  type BenchmarkArmRow,
  type CheckResult,
  checkBenchmark,
  EVIDENCE_PLANNERS,
  expectedAccepted,
  UNBOUND_R1,
} from "../../src/benchmark/check.ts";
import {
  GATE_STATE_FILE,
  type GatedTrialRecord,
  gatedArmRow,
  gateEntryFor,
  registerTask,
} from "../../src/benchmark/gated-rows.ts";
import { grade } from "../../src/benchmark/grade/grade.ts";
import { type BenchmarkGradeRow, gradeRow } from "../../src/benchmark/grade/row.ts";
import type { BenchmarkTask } from "../../src/benchmark/taskset.ts";
import type { GateResult, ReasonCode } from "../../src/gate/api.ts";
import { buildRegistry, specDigest } from "../../src/gate/gate.ts";
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
const T2 = TASKS[1] as BenchmarkTask;
const INVALID = TASKS.find((t) => t.faultClass === "invalid-target") as BenchmarkTask;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const DOC = new TextEncoder().encode("doc");
const RUN = "run-1";

/** A decided outcome that is internally consistent for `task`, run `RUN`, bytes `doc`. */
function decided(
  verdict: GateResult["verdict"],
  reasonCodes: ReasonCode[] = [],
  doc: Uint8Array | null = DOC,
  task: BenchmarkTask = T1,
): Extract<GatedTrialRecord["outcome"], { status: "decided" }> {
  return {
    status: "decided",
    receipt: { runId: RUN },
    result: {
      verdict,
      accepted: verdict === "verified",
      reasonCodes,
      request: { taskId: task.taskId, runId: RUN },
      evidenceRefs:
        doc === null
          ? []
          : [
              {
                kind: "persisted-state",
                runId: RUN,
                path: GATE_STATE_FILE,
                sha256: sha(doc),
                bytes: doc.length,
              },
            ],
      ...(verdict === "uncertain"
        ? {}
        : {
            oracle: {
              family: "calc-record-edit",
              version: "x",
              specSha256: specDigest(gateEntryFor(task).spec),
            },
          }),
    },
  };
}

function record(over: Partial<GatedTrialRecord> = {}): GatedTrialRecord {
  return {
    taskId: T1.taskId,
    trialKey: "r1-fc-v1-001",
    runId: RUN,
    outcome: decided("verified"),
    agentClaim: "done",
    instruction: T1.instruction,
    persisted: DOC,
    persistedFormat: "csv",
    plannerModelId: "claude-sonnet-5-5",
    outputCeiling: 8192,
    cost: { modelUsd: 0.1, wallClockS: 30, vmS: null },
    ...over,
  };
}

const row = (over: Partial<GatedTrialRecord> = {}) => gatedArmRow(record(over), TASKS);

/** A grade row for `r` with the given status (fields consistent with the arm row). */
function gradeFor(r: BenchmarkArmRow, status: "pass" | "fail" | "ungradable"): BenchmarkGradeRow {
  return gradeRow(r.trialKey, r.taskId, {
    graderVersion: "false-completion-grader/1",
    status,
    reasons: status === "pass" ? [] : ["x"],
    fixtureSha256: r.fixtureSha256,
    persistedSha256: r.persistedSha256,
    target: status === "ungradable" ? null : "B12",
    targetSatisfied: status === "ungradable" ? null : status === "pass",
    mismatches: [],
    mismatchCount: 0,
  });
}

describe("gatedArmRow", () => {
  it("accepts a done the post-stop check verified, and the row is schema-valid and self-consistent", () => {
    const r = row();
    expect(r).toMatchObject({
      arm: "myco-gate",
      taskSetVersion: "fc-v1",
      taskId: "fc-v1-001",
      faultClass: T1.faultClass,
      fixtureSha256: T1.fixtureSha256,
      claim: "done",
      gate: { called: true, verdict: "verified" },
      accepted: true,
      cause: null,
      persistedSha256: sha("doc"),
    });
    expect(validateSchema(r, benchmarkArmRowSchema)).toEqual([]);
    expect(expectedAccepted(r)).toBe(r.accepted);
  });

  const CASES: [string, Partial<GatedTrialRecord>, Partial<BenchmarkArmRow>][] = [
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
      { outcome: decided("refuted", ["ORACLE_FAIL"]) },
      {
        accepted: false,
        gate: { called: true, verdict: "refuted" },
        cause: { kind: "agent", detail: "gate refuted the agent's done" },
      },
    ],
    [
      "an uncaptured document",
      { persisted: null, outcome: decided("uncertain", ["STATE_MISSING"], null) },
      {
        accepted: false,
        persistedSha256: null,
        cause: { kind: "harness", detail: "gate: STATE_MISSING" },
      },
    ],
    ...(
      ["STATE_UNREADABLE", "AUDIT_FAILED", "FIXTURE_UNREADABLE", "FIXTURE_MISMATCH"] as const
    ).map((code): [string, Partial<GatedTrialRecord>, Partial<BenchmarkArmRow>] => [
      `a harness fault ${code}`,
      { outcome: decided("uncertain", [code]) },
      { accepted: false, cause: { kind: "harness", detail: `gate: ${code}` } },
    ]),
    [
      "an oracle that could not decide",
      { outcome: decided("uncertain", ["ORACLE_ERROR"]) },
      {
        accepted: false,
        cause: { kind: "oracle", detail: "gate could not decide (ORACLE_ERROR)" },
      },
    ],
    [
      "no claim at all",
      { agentClaim: "no-claim", outcome: decided("refuted") },
      { accepted: false, cause: { kind: "agent", detail: "agent made no claim" } },
    ],
  ];
  for (const [name, over, want] of CASES) {
    it(`maps ${name}`, () => {
      const r = row(over);
      expect(r).toMatchObject(want);
      expect(validateSchema(r, benchmarkArmRowSchema)).toEqual([]);
      expect(expectedAccepted(r)).toBe(r.accepted);
    });
  }

  it("refuses an instruction that is not the task's", () => {
    expect(() => row({ instruction: `${T1.instruction} ` })).toThrow(
      /instruction is not task fc-v1-001's/,
    );
  });
  it("refuses a gate result whose accepted contradicts its verdict", () => {
    const o = decided("refuted");
    expect(() => row({ outcome: { ...o, result: { ...o.result, accepted: true } } })).toThrow(
      /contradicts verdict refuted/,
    );
  });
  it("refuses a verified trial with no captured document", () => {
    expect(() => row({ persisted: null })).toThrow(/record says none was captured/);
  });
});

describe("gatedArmRow binds the gate result to this trial (#496 D1-D3, D5)", () => {
  const o = decided("verified");
  const REFUSALS: [string, Partial<GatedTrialRecord>, RegExp][] = [
    // D1: another trial's or run's decision.
    [
      "a verdict for another task",
      { taskId: T2.taskId, instruction: T2.instruction },
      /checked task fc-v1-001, not fc-v1-002/,
    ],
    ["a verdict for another run", { runId: "run-2" }, /sealed for run run-1, not run-2/],
    [
      "a request for another run under this receipt",
      {
        outcome: { ...o, result: { ...o.result, request: { taskId: T1.taskId, runId: "run-9" } } },
      },
      /checked run run-9, not run-1/,
    ],
    [
      "a verified result that names no oracle",
      { outcome: { ...o, result: { ...o.result, oracle: undefined } } },
      /verified but names no oracle/,
    ],
    [
      "a verdict decided on another task's spec",
      {
        outcome: {
          ...o,
          result: {
            ...o.result,
            oracle: {
              family: "calc-record-edit",
              version: "x",
              specSha256: specDigest(gateEntryFor(T2).spec),
            },
          },
        },
      },
      /decided on a different spec/,
    ],
    // D2: the bytes are not the bytes the gate decided on.
    [
      "other bytes than the gate read",
      { persisted: new TextEncoder().encode("clean") },
      /are not the bytes the gate decided on/,
    ],
    [
      "a verified result without a persisted-state ref",
      { outcome: { ...o, result: { ...o.result, evidenceRefs: [] } } },
      /verified without a persisted-state evidence ref/,
    ],
    [
      "two persisted-state refs",
      {
        outcome: {
          ...o,
          result: {
            ...o.result,
            evidenceRefs: [...o.result.evidenceRefs, ...o.result.evidenceRefs],
          },
        },
      },
      /names 2 persisted states/,
    ],
    [
      "a persisted-state ref for another run",
      {
        outcome: {
          ...o,
          result: {
            ...o.result,
            evidenceRefs: o.result.evidenceRefs.map((r) => ({ ...r, runId: "run-9" })),
          },
        },
      },
      /read run-9\/doc.csv, not run-1\/doc.csv/,
    ],
    [
      "a persisted-state ref for another file",
      {
        outcome: {
          ...o,
          result: {
            ...o.result,
            evidenceRefs: o.result.evidenceRefs.map((r) => ({ ...r, path: "other.csv" })),
          },
        },
      },
      /read run-1\/other.csv, not run-1\/doc.csv/,
    ],
    [
      "a decision from another gate family",
      {
        outcome: {
          ...o,
          result: {
            ...o.result,
            oracle: { ...(o.result.oracle as NonNullable<typeof o.result.oracle>), family: "x" },
          },
        },
      },
      /came from family x, not calc-record-edit/,
    ],
    [
      "captured bytes when the gate found no persisted state",
      { outcome: decided("uncertain", ["STATE_MISSING"], null) },
      /found no persisted state, but the record carries captured bytes/,
    ],
    // D3: format and published-task parity.
    ["an xlsx document (the gate reads CSV only)", { persistedFormat: "xlsx" }, /reads CSV only/],
    ["a task not in the published set", { taskId: "fc-v1-999" }, /appears 0 times/],
    ["a schema-invalid output ceiling", { outputCeiling: -5 }, /not schema-valid/],
    // D5: a registrable task marked unregistrable.
    [
      "a registrable task marked unregistrable",
      { outcome: { status: "unregistrable", reason: "r" } },
      /registers with the gate/,
    ],
  ];
  for (const [name, over, want] of REFUSALS) {
    it(`refuses ${name}`, () => {
      expect(() => row(over)).toThrow(want);
    });
  }

  it("takes faultClass and fixture from the published task, and refuses a forged one", () => {
    const forgedFixture = TASKS.map((t) =>
      t.taskId === T1.taskId ? { ...t, fixtureSha256: "0".repeat(64) } : t,
    );
    expect(() => gatedArmRow(record(), forgedFixture)).toThrow(
      /not the fixture its seed generates/,
    );
    // A relabelled task set is caught downstream: make-requests pins faultClass to the bundle.
    expect(row().faultClass).toBe("none");
    const dup = [...TASKS, T1];
    expect(() => gatedArmRow(record(), dup)).toThrow(/appears 2 times/);
    // A published task whose instruction hash is not its instruction's.
    const forgedHash = TASKS.map((t) =>
      t.taskId === T1.taskId ? { ...t, instructionSha256: "0".repeat(64) } : t,
    );
    expect(() => gatedArmRow(record(), forgedHash)).toThrow(/instruction is not task fc-v1-001's/);
  });

  it("an invalid-target task is re-checked against the registry and may be unregistrable", () => {
    const r = gatedArmRow(
      record({
        taskId: INVALID.taskId,
        instruction: INVALID.instruction,
        outcome: { status: "unregistrable", reason: "r" },
      }),
      TASKS,
    );
    expect(r).toMatchObject({ faultClass: "invalid-target", gate: { unregistrable: true } });
  });
});

describe("evidence provenance (#496 D4)", () => {
  const g = (r: BenchmarkArmRow) => gradeFor(r, "pass");
  it.each([
    "simulated:scripted",
    "Simulated:x",
    "SIMULATED:x",
    " simulated:x",
    "\u200bsimulated:x",
    "\uff53imulated:x",
    "simulated-x",
    "sim:x",
    "dry-run:x",
    "claude-sonnet-5-5 ",
    "Claude-sonnet-5-5",
    "claude-sonnet",
    // #496 round 2: substrings of a real id, and ids the old pattern let through.
    "simulated:claude-sonnet-5-5",
    "claude-sonnet-5-5:simulated",
    "xclaude-sonnet-5-5",
    "claude-sonnet-0",
    "claude-sonnet-05-05",
    "claude-opus-1-2-3-4-5-6-7-8-9",
    "claude-sonnet-4-5-20250929",
  ])("refuses planner %j as evidence, and accepts it as plumbing", (planner) => {
    const r = row({ plannerModelId: planner });
    expect(checkBenchmark([r], [g(r)], { expectTrials: { "myco-gate": 1 } }).ok).toBe(true);
    const asEvidence = checkBenchmark([r], [g(r)], {
      expectTrials: { "myco-gate": 1 },
      evidence: true,
    });
    expect(asEvidence.ok).toBe(false);
    expect(asEvidence.errors.join("\n")).toMatch(/1 row\(s\) without evidence provenance/);
    expect(asEvidence.r1?.pass).toBe(false);
  });

  it("labels the result's provenance whether or not evidence was asked for (#496 D-r2-1)", () => {
    const sim = row({ plannerModelId: "simulated:scripted" });
    const real = { ...row(), trialKey: "real-1" };
    const plumbing = checkBenchmark([sim], [g(sim)], { expectTrials: { "myco-gate": 1 } });
    expect(plumbing).toMatchObject({ ok: true, provenance: "simulated" });
    // Unbound: R1 never passes, and the result says the binding was not applied.
    expect(plumbing.r1?.reasons).toEqual([UNBOUND_R1]);
    expect(plumbing.taskSetBinding?.applied).toBe(false);
    expect(checkBenchmark([real], [g(real)], { expectTrials: { "myco-gate": 1 } }).provenance).toBe(
      "evidence",
    );
    expect(
      checkBenchmark([sim, real], [g(sim), g(real)], { expectTrials: { "myco-gate": 2 } })
        .provenance,
    ).toBe("mixed");
    expect(checkBenchmark([], [], { expectTrials: {} }).provenance).toBeNull();
  });
  it.each(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2", "claude-haiku-5-5"])(
    "accepts the Claude model id %j as evidence",
    (planner) => {
      expect(EVIDENCE_PLANNERS.has(planner)).toBe(true);
      const r = row({ plannerModelId: planner });
      const res = checkBenchmark([r], [g(r)], { expectTrials: { "myco-gate": 1 }, evidence: true });
      expect(res.errors).toEqual([]);
    },
  );

  it("the CLI's --evidence flag refuses the same ledger it otherwise accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-check-cli-"));
    try {
      const r = row({ plannerModelId: "simulated:scripted" });
      writeFileSync(join(dir, "arm.jsonl"), `${JSON.stringify(r)}\n`);
      writeFileSync(join(dir, "grades.jsonl"), `${JSON.stringify(g(r))}\n`);
      const run = (extra: string[]) =>
        spawnSync(
          "npx",
          [
            "tsx",
            join(ROOT, "scripts", "benchmark-check.ts"),
            "--arm",
            join(dir, "arm.jsonl"),
            "--grades",
            join(dir, "grades.jsonl"),
            "--expect",
            "myco-gate=1",
            ...extra,
          ],
          { cwd: ROOT, encoding: "utf8" },
        );
      const plumbing = run([]);
      expect(plumbing.status, plumbing.stderr).toBe(0);
      expect((JSON.parse(plumbing.stdout) as CheckResult).provenance).toBe("simulated");
      const evidence = run(["--evidence"]);
      expect(evidence.status).toBe(1);
      expect((JSON.parse(evidence.stdout) as CheckResult).errors.join("\n")).toMatch(
        /without evidence provenance/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the check's unregistrable and capture rules", () => {
  const unreg = (claim: BenchmarkArmRow["claim"]) =>
    gatedArmRow(
      record({
        taskId: INVALID.taskId,
        instruction: INVALID.instruction,
        agentClaim: claim,
        outcome: { status: "unregistrable", reason: "r" },
      }),
      TASKS,
    );

  it("counts only done claims, and only grader fails, in the unregistrable row; R1 notes them", () => {
    const ok = row();
    const rows = [
      ok,
      { ...unreg("done"), trialKey: "u1" },
      { ...unreg("done"), trialKey: "u2" },
      { ...unreg("not-done"), trialKey: "u3" },
      { ...unreg("no-claim"), trialKey: "u4" },
    ];
    const grades = [
      gradeFor(rows[0] as BenchmarkArmRow, "pass"),
      gradeFor(rows[1] as BenchmarkArmRow, "fail"),
      gradeFor(rows[2] as BenchmarkArmRow, "ungradable"),
      gradeFor(rows[3] as BenchmarkArmRow, "fail"),
      gradeFor(rows[4] as BenchmarkArmRow, "fail"),
    ];
    const res = checkBenchmark(rows, grades, {
      expectTrials: { "myco-gate": 5 },
      expectUnregistrable: { "myco-gate": 4 },
    });
    expect(res.errors).toEqual([]);
    expect(res.arms[0]?.unregistrable).toEqual({
      trials: 4,
      claimedDone: 2,
      graderFailClaimedDone: 1,
    });
    expect(res.r1?.reasons).toEqual([UNBOUND_R1]);
    expect(res.r1).toMatchObject({
      pass: false,
      headline: { denominator: 5 },
      gated: { trials: 1, accepted: 1 },
    });
    expect(res.r1?.falseAcceptPerTrial.denominator).toBe(5);
    expect(res.r1?.notes).toEqual([
      "2 DONE claim(s) on unregistrable tasks were never gated (1 graded fail); they cannot be accepted, so they are not in the false-accept numerator",
    ]);
  });

  it("refuses an unregistrable row on a task that is not invalid-target", () => {
    const r = unreg("done");
    const forged = { ...r, taskId: T1.taskId, faultClass: "none", fixtureSha256: T1.fixtureSha256 };
    const res = checkBenchmark([forged], [gradeFor(forged, "fail")], {
      expectTrials: { "myco-gate": 1 },
    });
    expect(res.errors.join("\n")).toMatch(/only an invalid-target task can be unregistrable/);
  });

  it("refuses an accepted gated row without its captured bytes' sha256", () => {
    const r = { ...row(), persistedSha256: null };
    const res = checkBenchmark([r], [gradeFor(r, "ungradable")], {
      expectTrials: { "myco-gate": 1 },
    });
    expect(res.errors.join("\n")).toMatch(/accepted gated row must carry its captured bytes/);
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

  /** One trial: the scripted "agent" saves `doc` (or nothing) and claims done. */
  async function gatedTrial(task: BenchmarkTask, doc: string | null) {
    const tasks = buildRegistry([gateEntryFor(task)]);
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
      taskId: task.taskId,
      trialKey: `r1-${task.taskId}`,
      runId: `run-${task.taskId}`,
      agentClaim: "done",
      instruction: task.instruction,
      persisted: new TextEncoder().encode(doc),
      persistedFormat: "csv",
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
      const row = gatedArmRow(
        {
          taskId: task.taskId,
          trialKey: `r1-${task.taskId}`,
          runId: `run-${task.taskId}`,
          outcome,
          agentClaim: "done",
          instruction: task.instruction,
          persisted,
          persistedFormat: "csv",
          plannerModelId: "simulated:scripted",
          outputCeiling: null,
          cost: { modelUsd: null, wallClockS: null, vmS: null },
        },
        TASKS,
      );
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
      gatedArmRow({ ...baseRecord(ok, honest(ok)), outcome: okOutcome }, TASKS),
      gatedArmRow(
        { ...baseRecord(bad, pristine), outcome: { status: "unregistrable", reason: reg.reason } },
        TASKS,
      ),
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
    const result = checkBenchmark(rows, grades, {
      expectTrials: { "myco-gate": 2 },
      expectUnregistrable: { "myco-gate": 1 },
    });
    expect(result.errors).toEqual([]);
    expect(result.arms[0]).toMatchObject({
      trials: 2,
      accepted: 1,
      falseDoneAccepted: 0,
      unregistrable: { trials: 1, claimedDone: 1, graderFailClaimedDone: 1 },
    });
    expect(result.r1?.falseAcceptPerTrial.denominator).toBe(2);
    expect(result.r1?.reasons).toEqual([UNBOUND_R1]);
    expect(result.r1).toMatchObject({ pass: false, gated: { trials: 1 } });
    expect(result.r1?.notes).toHaveLength(1);
  });

  it("the real gate's decision cannot be attached to another trial or to other bytes", {
    timeout: 60_000,
  }, async () => {
    const [a, b] = TASKS.filter((t) => t.faultClass === "none") as [BenchmarkTask, BenchmarkTask];
    const outcome = await gatedTrial(a, honest(a));
    expect(outcome.status === "decided" && outcome.result.verdict).toBe("verified");
    // D1: task a's verified decision on task b's record.
    expect(() =>
      gatedArmRow({ ...baseRecord(b, honest(b)), runId: `run-${a.taskId}`, outcome }, TASKS),
    ).toThrow(/checked task/);
    // D2: the pristine fixture in place of the bytes the gate verified.
    expect(() =>
      gatedArmRow({ ...baseRecord(a, generateFixture(a.fixtureSeed).csv), outcome }, TASKS),
    ).toThrow(/not the bytes the gate decided on/);
    // The same decision with the bytes it read is accepted.
    expect(gatedArmRow({ ...baseRecord(a, honest(a)), outcome }, TASKS).accepted).toBe(true);
  });

  it("the check refuses an unregistrable row that claims a gate call or verdict", () => {
    const bad = TASKS.find((t) => t.faultClass === "invalid-target") as BenchmarkTask;
    const row = gatedArmRow(
      { ...baseRecord(bad, "x"), outcome: { status: "unregistrable", reason: "r" } },
      TASKS,
    );
    const g = gradeOf(bad, "x", row.trialKey);
    // A call alone, a verdict alone, and both: each is refused by the unregistrable rule
    // itself (#496 round 2 V7: the call-only forgery is not caught by any other rule).
    for (const gate of [
      { called: true, verdict: null, unregistrable: true as const },
      { called: false, verdict: "refuted" as const, unregistrable: true as const },
      { called: true, verdict: "refuted" as const, unregistrable: true as const },
    ]) {
      const r = checkBenchmark([{ ...row, gate }], [g], { expectTrials: { "myco-gate": 1 } });
      expect(r.errors.join("\n"), JSON.stringify(gate)).toMatch(
        /unregistrable task cannot have a gate call or verdict/,
      );
    }
  });
});
