/**
 * Track R, $0 end to end: a scripted "human" demonstrates once, the recorder captures it,
 * the compiler turns it into a workflow and a derived oracle, and the workflow replays on a
 * FRESH fixture (another seed), verified by the gate (derived family, after R5) and graded
 * by the independent grader. No model, no network, no LibreOffice.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import { TASK_SET_VERSION } from "../../src/benchmark/taskset.ts";
import { bindToTaskSet } from "../../src/benchmark/taskset-binding.ts";
import { compileRecording } from "../../src/recording/compile.ts";
import { recordDemonstration, serializeRecording } from "../../src/recording/recorder.ts";
import { hermeticActuator, replayWorkflow } from "../../src/recording/replay.ts";
import { cellFor, type HumanStep, scriptedHuman } from "../../src/recording/scripted-human.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import {
  ALL_MARKERS,
  fixtureBytes,
  operator,
  PLANTED_GH,
  PLANTED_KEY,
  PLANTED_LINUX_HOME,
} from "./helpers.ts";

const roots: string[] = [];
const newRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), "myco-track-r-e2e-"));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const demoDoc = fixtureBytes("track-r-e2e-demo");
const freshDoc = fixtureBytes("track-r-e2e-fresh");

async function demonstrate(steps: HumanStep[], windowTitle?: string) {
  const rec = await recordDemonstration(
    scriptedHuman({ document: demoDoc, steps, ...(windowTitle ? { windowTitle } : {}) }),
    {
      start: operator,
      indicator: () => {},
      before: demoDoc,
      simulated: true,
      recordingId: "rec-e2e",
      markers: ALL_MARKERS,
    },
  );
  return { rec, compiled: compileRecording(rec) };
}

const oneEdit: HumanStep[] = [
  { do: "select", cell: cellFor(demoDoc, "EMP-0005", "name") },
  { do: "type", cell: cellFor(demoDoc, "EMP-0005", "name"), text: "Replayed Person" },
  { do: "save" },
];

describe("record once, replay on a fresh fixture, gate + independent grader", () => {
  it("honest replay: gate VERIFIED by the derived family, grader PASS, they agree", async () => {
    const { compiled } = await demonstrate(oneEdit);
    expect(generateFixture("track-r-e2e-fresh").csv).not.toBe(
      generateFixture("track-r-e2e-demo").csv,
    );
    const report = await replayWorkflow({
      compiled,
      bindings: { record: "EMP-0003", name: "Bound Value" },
      fixture: freshDoc,
      actuator: hermeticActuator(),
      evidenceRoot: newRoot(),
      runId: "run-honest",
    });
    expect(report).toMatchObject({
      outcome: "replayed",
      trust: "derived",
      r1Evidence: false,
      simulated: true,
      gate: {
        family: "derived-workflow",
        familyVersion: "derived/1",
        verdict: "verified",
        accepted: true,
      },
      grade: { status: "pass" },
      agree: true,
    });
    expect(report.selfTest?.pass).toBe(true);
    expect(report.label).toMatch(/DERIVED/);
  });

  it("default bindings replay the demonstrated values", async () => {
    const { compiled } = await demonstrate(oneEdit);
    const report = await replayWorkflow({
      compiled,
      fixture: freshDoc,
      actuator: hermeticActuator(),
      evidenceRoot: newRoot(),
      runId: "run-default",
    });
    expect(report.bindings).toEqual({});
    expect(report.gate?.verdict).toBe("verified");
    expect(report.grade).toMatchObject({ status: "pass" });
  });

  it.each([
    ["skip-save", ["TARGET_MISMATCH"]],
    ["wrong-cell", ["TARGET_MISMATCH", "DOCUMENT_COLLATERAL"]],
    ["collateral", ["DOCUMENT_COLLATERAL"]],
  ] as const)(
    "a faulty replay (%s) is REFUTED by the gate and FAILED by the grader",
    async (fault, codes) => {
      const { compiled } = await demonstrate(oneEdit);
      const report = await replayWorkflow({
        compiled,
        fixture: freshDoc,
        actuator: hermeticActuator(fault),
        evidenceRoot: newRoot(),
        runId: `run-${fault}`,
      });
      expect(report.gate).toMatchObject({ verdict: "refuted", accepted: false });
      expect(report.gate?.reasonCodes).toEqual(expect.arrayContaining(["ORACLE_FAIL", ...codes]));
      expect(report.grade).toMatchObject({ status: "fail" });
      expect(report.agree).toBe(true);
    },
  );

  it("a multi-edit workflow is verified by the gate; the one-intent grader says not-applicable", async () => {
    const { compiled } = await demonstrate([
      { do: "type", cell: cellFor(demoDoc, "EMP-0002", "qty"), text: "321" },
      { do: "type", cell: cellFor(demoDoc, "EMP-0004", "joined"), text: "2025-02-03" },
      { do: "type", cell: cellFor(demoDoc, "EMP-0004", "salary"), text: "$51234.50" },
      { do: "save" },
    ]);
    const report = await replayWorkflow({
      compiled,
      fixture: freshDoc,
      actuator: hermeticActuator(),
      evidenceRoot: newRoot(),
      runId: "run-multi",
    });
    expect(report.edits).toBe(3);
    expect(report.gate?.verdict).toBe("verified");
    expect(report.grade).toMatchObject({ status: "not-applicable" });
    expect(report.agree).toBeNull();
  });

  it("refuses before running: unknown record on the fresh fixture, bad binding, other header", async () => {
    const { compiled } = await demonstrate(oneEdit);
    const rows = generateFixture("track-r-e2e-fresh").dataRows;
    const base = { compiled, actuator: hermeticActuator(), evidenceRoot: newRoot() };
    const r1 = await replayWorkflow({
      ...base,
      fixture: freshDoc,
      runId: "run-r1",
      bindings: { record: `EMP-${String(rows + 1).padStart(4, "0")}` },
    });
    expect(r1).toMatchObject({
      outcome: "refused",
      refusal: { code: "BINDING_REFUSED" },
      gate: null,
      grade: null,
    });
    const r2 = await replayWorkflow({
      ...base,
      fixture: freshDoc,
      runId: "run-r2",
      bindings: { name: PLANTED_KEY },
    });
    expect(r2.refusal?.code).toBe("BINDING_REFUSED");
    expect(JSON.stringify(r2)).not.toContain(PLANTED_KEY);
    const other = new TextEncoder().encode("key,value\nA,1\n");
    const r3 = await replayWorkflow({ ...base, fixture: other, runId: "run-r3" });
    expect(r3.refusal?.code).toBe("FIXTURE_MISMATCH");
  });

  it("refuses with SELFTEST_FAILED (no gate built) when the bound oracle cannot pass R5", async () => {
    const { compiled } = await demonstrate(oneEdit);
    // Binding the fresh fixture's own value makes the edit a no-op: edit-missing equals the control.
    const current = generateFixture("track-r-e2e-fresh").rows[4]?.[1] as string;
    const report = await replayWorkflow({
      compiled,
      fixture: freshDoc,
      bindings: { record: "EMP-0005", name: current },
      actuator: hermeticActuator(),
      evidenceRoot: newRoot(),
      runId: "run-noop",
    });
    expect(report).toMatchObject({
      outcome: "refused",
      refusal: { code: "SELFTEST_FAILED" },
      gate: null,
    });
    expect(report.selfTest?.pass).toBe(false);
  });
});

describe("security end to end: planted markers appear nowhere Myco writes", () => {
  it("recording, workflow, oracle, evidence and report hold no marker", async () => {
    const steps: HumanStep[] = [
      { do: "copy", text: `${PLANTED_KEY} ${PLANTED_GH} ${PLANTED_LINUX_HOME}` },
      ...oneEdit,
    ];
    const { rec, compiled } = await demonstrate(steps, `${PLANTED_LINUX_HOME} - LibreOffice Calc`);
    const root = newRoot();
    const report = await replayWorkflow({
      compiled,
      fixture: freshDoc,
      actuator: hermeticActuator(),
      evidenceRoot: root,
      runId: "run-markers",
    });
    writeFileSync(join(root, "recording.json"), serializeRecording(rec));
    writeFileSync(join(root, "workflow.json"), JSON.stringify(compiled));
    writeFileSync(join(root, "report.json"), JSON.stringify(report));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const text = readFileSync(f, "latin1");
      for (const m of ALL_MARKERS) expect(text, f).not.toContain(m);
      // No host path either: the evidence root's own location is never written into a file.
      expect(text, f).not.toContain(root);
    }
  });
});

describe("a derived replay is never R1 evidence", () => {
  it("the report says so as a constant, and the R1 task-set binding refuses derived rows", async () => {
    const { compiled } = await demonstrate(oneEdit);
    const report = await replayWorkflow({
      compiled,
      fixture: freshDoc,
      actuator: hermeticActuator(),
      evidenceRoot: newRoot(),
      runId: "run-r1-check",
    });
    expect(report.r1Evidence).toBe(false);
    // However a caller might dress a derived replay as an arm row, R1's binding (unchanged)
    // refuses it: its task set is not a published one, and under fc-v1's name its task id
    // is not an fc-v1 task.
    const row = (taskSetVersion: string): BenchmarkArmRow => ({
      schema: "myco.benchmark.arm-row/1",
      taskSetVersion,
      arm: "myco-gate",
      trialKey: report.runId,
      taskId: report.taskId,
      faultClass: "none",
      fixtureSha256: report.fixtureSha256,
      instructionSha256: "0".repeat(64),
      plannerModelId: "none",
      outputCeiling: null,
      claim: "done",
      gate: { called: true, verdict: "verified" },
      accepted: true,
      persistedSha256: report.persistedSha256,
      cause: null,
      cost: { modelUsd: null, wallClockS: null, vmS: null },
    });
    const derived = bindToTaskSet([row(`derived:${report.workflowId}`)], { exactMultiset: true });
    expect(derived.known).toBe(false);
    expect(derived.errors.join(" ")).toMatch(/not a published task set/);
    const disguised = bindToTaskSet([row(TASK_SET_VERSION)], { exactMultiset: true });
    expect(disguised.errors.join(" ")).toMatch(/is not in/);
  });
});
