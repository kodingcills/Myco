/**
 * Track M acceptance 5: the warm-vs-cold arm on a frozen repeat/similar task set; rows are
 * never R1 evidence (they fail the benchmark ledger schema, the R1 task-set binding does not
 * know their task set, and they say `evidence: "never-r1"`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkArmRowSchema } from "../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { bindToTaskSet } from "../../src/benchmark/taskset-binding.ts";
import {
  mcnemarOneSided,
  pairedCounts,
  renderAdvice,
  runSkillArmTrial,
  SKILL_ARM_ROW_SCHEMA,
  SKILLS_TASKSET_VERSION,
  type SkillArmRow,
  type SkillTrialRun,
  skillTaskPairs,
  skillTaskSetDigest,
  summarizeSkillArms,
  taskFeatures,
} from "../../src/skills/arm.ts";
import { SkillStore } from "../../src/skills/store.ts";
import { taskById } from "./helpers.ts";

/** Pinned: a change to the pairs is a new task-set version, never a silent edit. */
const PINNED_DIGEST = "130217f6346860724f06deee276e01a3c1129d0a9cab58835c525bb06472d51c";

function row(over: Partial<SkillArmRow>): SkillArmRow {
  return {
    schema: SKILL_ARM_ROW_SCHEMA,
    taskSetVersion: SKILLS_TASKSET_VERSION,
    taskSetSha256: skillTaskSetDigest(),
    baseArm: "hcu-shell",
    arm: "cold",
    kind: "repeat",
    pairId: "p1",
    taskId: "fc-v1-001",
    runId: "r1",
    plannerModelId: "simulated:scripted",
    simulated: true,
    storeHead: null,
    retrievedSkillIds: [],
    gate: { verdict: "verified", accepted: true },
    grade: { status: "pass" },
    verified: true,
    admittedSkillId: null,
    admissionCode: null,
    cost: { estimatedUsd: null, estimate: true },
    evidence: "never-r1",
    ...over,
  };
}

describe("frozen repeat/similar task set", () => {
  it("is 30 pairs of published, satisfiable, no-fault fc-v1 tasks, pinned by digest", () => {
    const pairs = skillTaskPairs();
    expect(pairs).toHaveLength(30);
    expect(skillTaskSetDigest()).toBe(PINNED_DIGEST);
    const used = new Set<string>();
    for (const p of pairs) {
      const seed = taskById(p.seedTaskId);
      const similar = taskById(p.similarTaskId);
      for (const t of [seed, similar]) {
        expect(t.faultClass).toBe("none");
        expect(t.satisfiable).toBe(true);
        expect(used.has(t.taskId)).toBe(false);
        used.add(t.taskId);
      }
      expect(seed.columnTypes[seed.intent.column]).toBe(p.columnType);
      expect(similar.columnTypes[similar.intent.column]).toBe(p.columnType);
      expect(taskFeatures(seed)).toEqual(taskFeatures(similar));
    }
  });

  it("features carry no record key, value or fixture content", () => {
    for (const p of skillTaskPairs()) {
      const t = taskById(p.seedTaskId);
      const f = taskFeatures(t).join(" ");
      expect(f).not.toContain(t.intent.rowKey);
      expect(f).not.toContain(t.intent.newValue);
      expect(f).not.toContain(t.intent.column);
    }
  });
});

describe("skills arm rows are never R1 evidence", () => {
  it("fail the benchmark ledger schema", () => {
    expect(validateSchema(row({}), benchmarkArmRowSchema).length).toBeGreaterThan(0);
  });

  it("name a task set the R1 binding does not know", () => {
    const b = bindToTaskSet([row({}) as never], { exactMultiset: true });
    expect(b.known).toBe(false);
    expect(b.errors.join(" ")).toMatch(/not a published task set/);
  });

  it("the summary refuses rows that break the invariants", () => {
    const bad = [
      row({ runId: "a", evidence: "r1" as never }),
      row({ runId: "b", verified: true, grade: { status: "fail" } }),
      row({
        runId: "c",
        verified: false,
        gate: { verdict: "refuted", accepted: false },
        admittedSkillId: "sk-x",
      }),
      row({ runId: "d", arm: "warm", kind: "repeat", admittedSkillId: "sk-y" }),
      row({ runId: "e", arm: "cold", retrievedSkillIds: ["sk-z"] }),
      row({ runId: "f", taskSetSha256: "0".repeat(64) }),
    ];
    const s = summarizeSkillArms(bad);
    expect(s.r1Evidence).toBe(false);
    for (const id of ["a", "b", "c", "d", "e", "f"])
      expect(
        s.errors.some((e) => e.startsWith(`${id}:`)),
        id,
      ).toBe(true);
  });

  it("cost per verified is total of ALL trials / verified; a null cost is never 0", () => {
    const s = summarizeSkillArms([
      row({ runId: "1", cost: { estimatedUsd: 0.2, estimate: true } }),
      row({
        runId: "2",
        verified: false,
        gate: { verdict: "refuted", accepted: false },
        cost: { estimatedUsd: 0.4, estimate: true },
      }),
    ]);
    expect(s.cells[0]).toMatchObject({ trials: 2, verified: 1, verifiedRate: 0.5 });
    expect(s.cells[0]?.estimatedCostPerVerified).toBeCloseTo(0.6);
    const n = summarizeSkillArms([
      row({ runId: "1" }),
      row({ runId: "2", cost: { estimatedUsd: 1, estimate: true } }),
    ]);
    expect(n.cells[0]?.estimatedCostPerVerified).toBeNull();
  });
});

describe("arm wiring", () => {
  const task = taskById(skillTaskPairs()[0]?.seedTaskId as string);
  const exec = async () => {
    throw new Error("must not run");
  };
  it("learning outside the cold seed phase is refused before anything runs", async () => {
    await expect(
      runSkillArmTrial({
        baseArm: "hcu-shell",
        arm: "cold",
        kind: "repeat",
        pairId: "p",
        task,
        runId: "r",
        store: null,
        learn: true,
        execute: exec,
      }),
    ).rejects.toThrow(/seed phase/);
    await expect(
      runSkillArmTrial({
        baseArm: "hcu-shell",
        arm: "warm",
        kind: "seed",
        pairId: "p",
        task,
        runId: "r",
        store: null,
        learn: true,
        execute: exec,
      }),
    ).rejects.toThrow(/runs cold/);
    await expect(
      runSkillArmTrial({
        baseArm: "hcu-shell",
        arm: "warm",
        kind: "repeat",
        pairId: "p",
        task,
        runId: "r",
        store: null,
        learn: false,
        execute: exec,
      }),
    ).rejects.toThrow(/needs a store/);
  });

  it("a gate-verified run the grader fails (a false VERIFIED) is not verified and not stored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-skills-arm-"));
    try {
      const store = SkillStore.open(dir);
      const run: SkillTrialRun = {
        gate: {
          verdict: "verified",
          accepted: true,
          reasonCodes: ["ORACLE_PASS"],
          request: { taskId: task.taskId, runId: "seed-fv" },
          evidenceRefs: [
            {
              kind: "persisted-state",
              runId: "seed-fv",
              path: "doc.csv",
              sha256: "c".repeat(64),
              bytes: 1,
            },
          ],
          oracle: { family: task.family, version: "2", specSha256: "d".repeat(64) },
        },
        grade: {
          graderVersion: "g/1",
          status: "fail",
          fixtureSha256: task.fixtureSha256,
          persistedSha256: "c".repeat(64),
          mismatchCount: 1,
        },
        procedure: {
          preconditions: [],
          steps: ["Open the spreadsheet in Calc and save it as CSV"],
        },
        plannerModelId: "simulated:scripted",
        assisted: false,
        corrections: "off",
        ledgerRef: { ledger: "attempts.jsonl", entrySha256: "a".repeat(64) },
        estimatedUsd: null,
      };
      const r = await runSkillArmTrial({
        baseArm: "hcu-shell",
        arm: "cold",
        kind: "seed",
        pairId: "p",
        task,
        runId: "seed-fv",
        store,
        learn: true,
        forbidden: { values: [task.intent.newValue] },
        execute: async () => run,
      });
      expect(r.verified).toBe(false);
      expect(r.admittedSkillId).toBeNull();
      expect(r.admissionCode).toBe("GRADE_NOT_PASS");
      expect(store.skills()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advice is labelled as advice, not evidence; nothing retrieved means no advice", () => {
    expect(renderAdvice([])).toBeNull();
    const text = renderAdvice([
      {
        skillId: "sk-1",
        taskFamily: "calc-record-edit",
        similarity: 1,
        preconditions: ["Calc is open"],
        steps: ["Open it", "Save it"],
        provenance: {
          runId: "r",
          ledgerEntrySha256: "a",
          verdictSha256: "b",
          gradeSha256: "c",
          simulated: true,
        },
      },
    ]);
    expect(text).toMatch(/not evidence/);
    expect(text).toContain("1. Open it 2. Save it");
  });

  it("pairs cold and warm by (pair, kind); duplicates and singletons are unpaired", () => {
    const rows = [
      row({
        runId: "1",
        pairId: "a",
        arm: "cold",
        verified: false,
        gate: { verdict: "refuted", accepted: false },
      }),
      row({ runId: "2", pairId: "a", arm: "warm" }),
      row({ runId: "3", pairId: "b", arm: "cold" }),
      row({ runId: "4", pairId: "b", arm: "warm" }),
      row({ runId: "5", pairId: "c", arm: "cold" }),
      row({ runId: "6", pairId: "a", kind: "seed", arm: "cold" }),
    ];
    expect(pairedCounts(rows, "hcu-shell")).toEqual({
      both: 1,
      warmOnly: 1,
      coldOnly: 0,
      neither: 0,
      unpaired: 1,
    });
  });

  it("exact one-sided McNemar", () => {
    expect(mcnemarOneSided(0, 0)).toBe(1);
    expect(mcnemarOneSided(13, 5)).toBeCloseTo(0.0481, 3);
    expect(mcnemarOneSided(12, 6)).toBeCloseTo(0.1189, 3);
    expect(mcnemarOneSided(5, 0)).toBeCloseTo(1 / 32, 6);
  });
});
