/**
 * Track R task set fr-v1: deterministic, committed byte-for-byte, fresh fixtures, all four
 * column kinds, single edit; and every task is solvable by a workflow compiled from one
 * demonstration of its family (SIMULATED: scripted human, hermetic actuator), graded pass by
 * the independent grader. That proves the plumbing, never agent capability.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTaskSet } from "../../src/benchmark/taskset.ts";
import { compileRecording } from "../../src/recording/compile.ts";
import { recordDemonstration } from "../../src/recording/recorder.ts";
import { hermeticActuator, replayWorkflow } from "../../src/recording/replay.ts";
import { cellFor, scriptedHuman } from "../../src/recording/scripted-human.ts";
import { canonicalSha256 } from "../../src/recording-eval/canonical.ts";
import {
  buildFrV1,
  FR_V1_TASK_SEEDS,
  manifestSha256,
  manifestText,
} from "../../src/recording-eval/fr-v1.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { PREREG_DIR, readPrereg } from "./helpers.ts";

const manifest = buildFrV1();
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("fr-v1 manifest", () => {
  it("is deterministic and the committed file is byte-identical to the builder's output", () => {
    expect(manifestText(buildFrV1())).toBe(manifestText(manifest));
    expect(readFileSync(join(PREREG_DIR, "fr-v1-manifest.json"), "utf8")).toBe(
      manifestText(manifest),
    );
  });

  it("the prereg pins this manifest's canonical SHA-256", () => {
    const taskSet = readPrereg().taskSet as {
      manifestSha256: string;
      version: string;
      tasks: number;
    };
    expect(taskSet.manifestSha256).toBe(manifestSha256(manifest));
    expect(taskSet.manifestSha256).toBe(canonicalSha256(JSON.parse(manifestText(manifest))));
    expect(taskSet.version).toBe("fr-v1");
    expect(taskSet.tasks).toBe(manifest.tasks.length);
  });

  it("30 single-edit CSV tasks with unique ids and unique (fixture, record, column)", () => {
    expect(manifest.tasks).toHaveLength(30);
    expect(new Set(manifest.tasks.map((t) => t.taskId)).size).toBe(30);
    const cells = manifest.tasks.map(
      (t) => `${t.fixtureSeed}|${t.intent.rowKey}|${t.intent.column}`,
    );
    expect(new Set(cells).size).toBe(30);
    for (const t of manifest.tasks) {
      expect(t.persistedFormat).toBe("csv");
      expect(t.instruction).toContain(t.intent.rowKey);
      expect(t.demonstrationFamily).toBe(`record-edit:${t.intent.column}`);
    }
  });

  it("covers all four column kinds, each with its own demonstration family", () => {
    const families = manifest.demonstrationFamilies.map((f) => f.family);
    expect(families).toEqual([
      "record-edit:name",
      "record-edit:qty",
      "record-edit:joined",
      "record-edit:salary",
    ]);
    expect(manifest.demonstrationFamilies.map((f) => f.kind).sort()).toEqual([
      "currency",
      "date",
      "integer",
      "text",
    ]);
    for (const f of families)
      expect(manifest.tasks.some((t) => t.demonstrationFamily === f)).toBe(true);
    expect((readPrereg().demonstration as { families: string[] }).families).toEqual(families);
  });

  it("fresh fixtures: task fixtures differ from every demonstration fixture and every fc-v1 fixture", () => {
    const task = new Set(manifest.tasks.map((t) => t.fixtureSha256));
    const demo = manifest.demonstrationFamilies.map((f) => f.fixtureSha256);
    const fc = new Set(buildTaskSet().tasks.map((t) => t.fixtureSha256));
    for (const d of demo) expect(task.has(d)).toBe(false);
    for (const t of task) expect(fc.has(t)).toBe(false);
    expect(new Set(demo).size).toBe(4);
    expect((readPrereg().seeds as { taskBuild: string[] }).taskBuild).toEqual([
      ...FR_V1_TASK_SEEDS,
    ]);
  });
});

describe("every fr-v1 task replays from its family's one demonstration (SIMULATED plumbing)", () => {
  it("bind record + value, replay on the task fixture: derived gate verified, grader pass", async () => {
    const evidence = mkdtempSync(join(tmpdir(), "myco-fr-v1-"));
    roots.push(evidence);
    const compiled = new Map<string, Awaited<ReturnType<typeof compileRecording>>>();
    for (const fam of manifest.demonstrationFamilies) {
      const doc = new TextEncoder().encode(generateFixture(fam.fixtureSeed).csv);
      const cell = cellFor(doc, "EMP-0002", fam.column);
      const demoValue = {
        name: "Demo Person",
        qty: "7",
        joined: "2021-03-04",
        salary: "$41000.50",
      }[fam.column] as string;
      const rec = await recordDemonstration(
        scriptedHuman({
          document: doc,
          steps: [{ do: "select", cell }, { do: "type", cell, text: demoValue }, { do: "save" }],
        }),
        {
          start: { startedBy: "operator", interactive: false },
          indicator: () => {},
          before: doc,
          simulated: true,
          recordingId: `fr-v1-${fam.column}`,
        },
      );
      compiled.set(fam.family, compileRecording(rec));
    }
    for (const t of manifest.tasks) {
      const c = compiled.get(t.demonstrationFamily);
      if (!c) throw new Error("missing family");
      const report = await replayWorkflow({
        compiled: c,
        bindings: { record: t.intent.rowKey, [t.intent.column]: t.intent.newValue },
        fixture: new TextEncoder().encode(generateFixture(t.fixtureSeed).csv),
        actuator: hermeticActuator(),
        evidenceRoot: evidence,
        runId: t.taskId,
        taskId: t.taskId,
        columnTypes: t.columnTypes,
      });
      expect(report.outcome, `${t.taskId}: ${report.refusal?.code}`).toBe("replayed");
      expect(report.fixtureSha256).toBe(t.fixtureSha256);
      expect(report.gate?.verdict).toBe("verified");
      expect(report.grade?.status, t.taskId).toBe("pass");
      expect(report.simulated).toBe(true);
      expect(report.r1Evidence).toBe(false);
    }
  }, 120_000);
});
