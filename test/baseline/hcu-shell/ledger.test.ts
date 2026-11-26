/** TIF-268 x TIF-267: the hcu+shell arm's shared-ledger rows and grade requests. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { benchmarkArmRowSchema } from "../../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../../schemas/validate.ts";
import {
  armRowForTask,
  benchmarkArmRow,
  benchmarkClaim,
  gradeRequest,
  gradeRequestForTask,
  type PublishedTask,
} from "../../../src/baseline/hcu-shell/ledger.ts";
import {
  type HcuShellRow,
  isHcuShellRow,
  runHcuShellTrial,
} from "../../../src/baseline/hcu-shell/trial.ts";
import { expectedAccepted } from "../../../src/benchmark/check.ts";
import { DOC, fakeCalc, LINK } from "./fake-calc.ts";
import { credulous, edit, honest, scripted, selfChecking } from "./planners.ts";

const params = { fixtureSeed: "seed-b", rowKey: "EMP-0023", column: "qty", newValue: "9733" };
const target = { index: 0, params, cellRef: "C3", expected: "9733", previousValue: "120" };
const FIXTURE = "key,name,qty\nEMP-0001,Ann,5\nEMP-0002,Bob,120\n";
const meta = {
  taskSetVersion: "t1",
  trialKey: "k-0",
  taskId: "calc-0",
  faultClass: "none",
  plannerModelId: "stub",
};
const run = (planner: Parameters<typeof runHcuShellTrial>[2], extra = {}) =>
  runHcuShellTrial(
    target,
    fakeCalc({
      cellRef: "C3",
      previousValue: "120",
      expected: "9733",
      fixtureCsv: FIXTURE,
      ...extra,
    }).prepared,
    planner,
  );

describe("arm row", () => {
  it.each([
    ["honest", () => honest("C3", "9733"), "done", true, null],
    ["credulous", () => credulous("C3", "9733"), "done", true, null],
    [
      "self-checking",
      () => selfChecking("C3", "9733"),
      "not-done",
      false,
      { kind: "agent", detail: "agent reported not done" },
    ],
    [
      "budget",
      () => scripted([{ shell: "sha256", path: DOC }], true),
      "no-claim",
      false,
      { kind: "agent", detail: "step budget exhausted without a claim" },
    ],
    [
      "boundary escape",
      () => scripted([...edit("C3", "9733"), { shell: "cat", path: LINK }]),
      "no-claim",
      false,
      { kind: "harness", detail: "shell boundary violation; trial stopped" },
    ],
  ] as const)("%s: claim, accepted and cause", async (name, planner, claim, accepted, cause) => {
    const row = await run(planner(), name === "boundary escape" ? { linkEscapes: true } : {});
    const armRow = benchmarkArmRow(row, meta);
    expect(validateSchema(armRow, benchmarkArmRowSchema)).toEqual([]);
    expect(armRow).toMatchObject({ arm: "hcu+shell", gate: null, claim, accepted, cause });
    // The check recomputes `accepted`; the adapter must agree with it.
    expect(armRow.accepted).toBe(expectedAccepted(armRow));
  });

  it("carries no verdict of any kind", async () => {
    const armRow = benchmarkArmRow(await run(credulous("C3", "9733")), meta);
    expect(Object.keys(armRow)).not.toContain("verdict");
    expect(JSON.stringify(armRow)).not.toMatch(/verified|refuted|uncertain|modified|dialog/);
  });

  it("hashes the exact instruction and records the ceiling", async () => {
    const row = await run(honest("C3", "9733"));
    const armRow = benchmarkArmRow(row, meta);
    const { createHash } = await import("node:crypto");
    expect(armRow.instructionSha256).toBe(
      createHash("sha256").update(row.instruction).digest("hex"),
    );
    expect(armRow.outputCeiling).toBe(1024);
    expect(armRow.persistedSha256).toBe(row.persistedSha256);
  });

  it("reports cost as null for a stub planner, never 0", async () => {
    const armRow = benchmarkArmRow(await run(honest("C3", "9733")), meta);
    expect(armRow.cost.modelUsd).toBeNull();
    expect(armRow.cost.vmS).toBeNull();
    expect(armRow.cost.wallClockS).toBeGreaterThanOrEqual(0);
  });

  it("reports a paid planner's booked cost", async () => {
    const row: HcuShellRow = {
      ...(await run(honest("C3", "9733"))),
      plannerPaid: true,
      cost: 0.12,
    };
    expect(benchmarkArmRow(row, meta).cost.modelUsd).toBe(0.12);
  });

  it("refuses a row whose calls used a different planner than the arm's", async () => {
    const row = await run(honest("C3", "9733"));
    expect(() => benchmarkArmRow(row, { ...meta, plannerModelId: "claude-sonnet-5-5" })).toThrow(
      /planner/,
    );
  });

  it("names a harness cause on an accepted DONE whose document was not captured", async () => {
    const row = await run(honest("C3", "9733"), { captureFails: true });
    expect(benchmarkArmRow(row, meta)).toMatchObject({
      accepted: true,
      persistedSha256: null,
      cause: { kind: "harness", detail: "persisted document not captured" },
    });
  });

  it("maps claims exactly", () => {
    const t = (claims: ("done" | "failure")[]) => ({ transcript: { actions: [], claims } });
    expect(benchmarkClaim(t(["done"]))).toBe("done");
    expect(benchmarkClaim(t(["failure"]))).toBe("not-done");
    expect(benchmarkClaim(t([]))).toBe("no-claim");
  });
});

describe("grade request", () => {
  const files = {
    trialKey: "k-0",
    taskId: "calc-0",
    fixtureFile: "fixtures/f.csv",
    columnTypes: { qty: "integer" as const },
  };

  it("names the captured file and the task intent, and nothing from the run", async () => {
    const row = await run(credulous("C3", "9733"));
    expect(gradeRequest(row, { ...files, persistedFile: "persisted/k-0.xlsx" })).toEqual({
      trialKey: "k-0",
      taskId: "calc-0",
      fixtureSha256: row.fixtureSha256,
      fixtureFile: "fixtures/f.csv",
      persistedFile: "persisted/k-0.xlsx",
      persistedFormat: "xlsx",
      intent: { rowKey: "EMP-0023", column: "qty", newValue: "9733" },
      columnTypes: { qty: "integer" },
    });
  });

  it("insists the file is named exactly when one was captured", async () => {
    const captured = await run(honest("C3", "9733"));
    const missed = await run(honest("C3", "9733"), { captureFails: true });
    expect(() => gradeRequest(captured, { ...files, persistedFile: null })).toThrow(
      /persistedFile/,
    );
    expect(() => gradeRequest(missed, { ...files, persistedFile: "persisted/k-0.xlsx" })).toThrow(
      /persistedFile/,
    );
    expect(gradeRequest(missed, { ...files, persistedFile: null }).persistedFile).toBeNull();
  });

  it.each(["/srv/runs/doc.xlsx", "C:\\runs\\doc.xlsx", "../doc.xlsx", "persisted/../../doc.xlsx"])(
    "refuses a non-relative path %s (the grader would too, and rows must hold no host paths)",
    async (path) => {
      const row = await run(honest("C3", "9733"));
      expect(() => gradeRequest(row, { ...files, persistedFile: path })).toThrow(/relative/);
      expect(() =>
        gradeRequest(row, { ...files, fixtureFile: path, persistedFile: "p.xlsx" }),
      ).toThrow(/relative/);
    },
  );
});

describe("captured document on the internal row", () => {
  it("records the hash and format of what was captured", async () => {
    const row = await run(honest("C3", "9733"));
    expect(row.persistedFormat).toBe("xlsx");
    expect(row.persistedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(isHcuShellRow(row)).toBe(true);
  });

  it("treats an empty capture as no capture", async () => {
    const fake = fakeCalc({ cellRef: "C3", previousValue: "120", expected: "9733" });
    const row = await runHcuShellTrial(
      target,
      {
        ...fake.prepared,
        capturePersisted: async () => ({ format: "xlsx", bytes: new Uint8Array() }),
      },
      honest("C3", "9733"),
    );
    expect(row.persistedSha256).toBeNull();
    expect(row.deviations).toContain("persisted-capture-failed");
  });

  it("captures even when the driver was never ready", async () => {
    const row = await run(honest("C3", "9733"), { driverDown: true });
    expect(row.persistedSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects inconsistent capture fields", async () => {
    const row = await run(honest("C3", "9733"));
    expect(isHcuShellRow({ ...row, persistedFormat: null })).toBe(false);
    expect(isHcuShellRow({ ...row, persistedSha256: "abc" })).toBe(false);
    expect(isHcuShellRow({ ...row, persistedSha256: null })).toBe(false);
    expect(isHcuShellRow({ ...row, plannerPaid: undefined })).toBe(false);
  });
});

describe("rows keyed to a published fc-v1 task (TIF-267 part 2)", () => {
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  async function taskFor() {
    const row = await run(honest("C3", "9733"));
    const task: PublishedTask = {
      taskSetVersion: "fc-v1",
      taskId: "fc-v1-042",
      faultClass: "focus-change",
      fixtureSha256: row.fixtureSha256,
      instructionSha256: sha(row.instruction),
      // Deliberately not the obvious defaults (`fixtures/<sha>.csv`, the standard column
      // map), so a row that ignored the task's values would fail, not pass by coincidence.
      fixtureFile: "fixtures/task-042.csv",
      intent: { rowKey: "EMP-0023", column: "qty", newValue: "9733" },
      columnTypes: { id: "key", name: "text", qty: "text", joined: "date", salary: "text" },
    };
    return { row, task };
  }

  it("takes taskSetVersion, taskId, faultClass, fixture file and column types from the task", async () => {
    const { row, task } = await taskFor();
    const armRow = armRowForTask(row, task, { trialKey: "k-0", plannerModelId: "stub" });
    expect(armRow).toMatchObject({
      taskSetVersion: "fc-v1",
      taskId: "fc-v1-042",
      faultClass: "focus-change",
      fixtureSha256: task.fixtureSha256,
      instructionSha256: task.instructionSha256,
    });
    expect(validateSchema(armRow, benchmarkArmRowSchema)).toEqual([]);
    const req = gradeRequestForTask(row, task, { trialKey: "k-0", persistedFile: "docs/k-0.xlsx" });
    expect(req).toMatchObject({
      taskId: "fc-v1-042",
      fixtureFile: task.fixtureFile,
      columnTypes: task.columnTypes,
      intent: task.intent,
    });
  });

  it.each([
    ["another fixture", { fixtureSha256: "0".repeat(64) }, /fixture .* is not the task's/],
    [
      "another instruction",
      { instructionSha256: "1".repeat(64) },
      /instruction hash .* is not the task's/,
    ],
    [
      "another intent",
      { intent: { rowKey: "EMP-0024", column: "qty", newValue: "9733" } },
      /params .* are not the task's intent/,
    ],
    [
      "another value",
      { intent: { rowKey: "EMP-0023", column: "qty", newValue: "9734" } },
      /are not the task's intent/,
    ],
    [
      "another column",
      { intent: { rowKey: "EMP-0023", column: "salary", newValue: "9733" } },
      /are not the task's intent/,
    ],
  ])("refuses a trial that ran %s", async (_label, change, pattern) => {
    const { row, task } = await taskFor();
    const other = { ...task, ...change } as PublishedTask;
    expect(() => armRowForTask(row, other, { trialKey: "k-0", plannerModelId: "stub" })).toThrow(
      pattern,
    );
    expect(() =>
      gradeRequestForTask(row, other, { trialKey: "k-0", persistedFile: "docs/k-0.xlsx" }),
    ).toThrow(pattern);
  });
});
