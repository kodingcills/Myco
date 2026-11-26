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
  recordMeasuredUses,
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
import { SkillStore, SkillStoreError } from "../../src/skills/store.ts";
import { taskById } from "./helpers.ts";

/** These rows come from a scripted planner: count them only in an explicitly simulated scope. */
const SIM = { simulated: true } as const;

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
    gradedGateBytes: true,
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
    const s = summarizeSkillArms(bad, SIM);
    expect(s.r1Evidence).toBe(false);
    for (const id of ["a", "b", "c", "d", "e", "f"])
      expect(
        s.errors.some((e) => e.startsWith(`${id}:`)),
        id,
      ).toBe(true);
  });

  it("cost per verified is total of ALL trials / verified; a null cost is never 0", () => {
    const s = summarizeSkillArms(
      [
        row({ runId: "1", cost: { estimatedUsd: 0.2, estimate: true } }),
        row({
          runId: "2",
          verified: false,
          gate: { verdict: "refuted", accepted: false },
          cost: { estimatedUsd: 0.4, estimate: true },
        }),
      ],
      SIM,
    );
    expect(s.cells[0]).toMatchObject({ trials: 2, verified: 1, verifiedRate: 0.5 });
    expect(s.cells[0]?.estimatedCostPerVerified).toBeCloseTo(0.6);
    const n = summarizeSkillArms(
      [row({ runId: "1" }), row({ runId: "2", cost: { estimatedUsd: 1, estimate: true } })],
      SIM,
    );
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
        simulated: true,
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
        simulated: true,
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
        simulated: true,
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
        simulated: true,
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
    expect(pairedCounts(rows, "hcu-shell", SIM)).toEqual({
      both: 1,
      warmOnly: 1,
      coldOnly: 0,
      neither: 0,
      unpaired: 1,
      excluded: 0,
    });
  });

  it("exact one-sided McNemar", () => {
    expect(mcnemarOneSided(0, 0)).toBe(1);
    expect(mcnemarOneSided(13, 5)).toBeCloseTo(0.0481, 3);
    expect(mcnemarOneSided(12, 6)).toBeCloseTo(0.1189, 3);
    expect(mcnemarOneSided(5, 0)).toBeCloseTo(1 / 32, 6);
  });
});

/** A hand-made trial outcome (admission trusts the harness's gate object). */
function fakeRun(
  task: ReturnType<typeof taskById>,
  runId: string,
  o: {
    verdict?: "verified" | "refuted";
    grade?: "pass" | "fail";
    planner?: string;
    gradedSha?: string;
  } = {},
): SkillTrialRun {
  const verdict = o.verdict ?? "verified";
  return {
    gate: {
      verdict,
      accepted: verdict === "verified",
      reasonCodes: [verdict === "verified" ? "ORACLE_PASS" : "TARGET_MISMATCH"],
      request: { taskId: task.taskId, runId },
      evidenceRefs: [
        { kind: "persisted-state", runId, path: "doc.csv", sha256: "c".repeat(64), bytes: 1 },
      ],
      oracle: { family: task.family, version: "2", specSha256: "d".repeat(64) },
    },
    grade: {
      graderVersion: "g/1",
      status: o.grade ?? "pass",
      fixtureSha256: task.fixtureSha256,
      persistedSha256: o.gradedSha ?? "c".repeat(64),
      mismatchCount: 0,
    },
    procedure: { preconditions: [], steps: ["Open the spreadsheet in Calc and save it as CSV"] },
    plannerModelId: o.planner ?? "simulated:scripted",
    assisted: false,
    corrections: "off",
    ledgerRef: { ledger: "attempts.jsonl", entrySha256: "a".repeat(64) },
    estimatedUsd: null,
  };
}

describe("measured trials see one frozen store (B2), simulated never counts (B3)", () => {
  const [p0, p1] = skillTaskPairs();
  const seedTask = taskById(p0?.seedTaskId as string);
  const t1 = taskById(p1?.similarTaskId as string);
  let dir: string;

  async function seed(planner = "simulated:scripted"): Promise<{ store: SkillStore; id: string }> {
    dir = mkdtempSync(join(tmpdir(), "myco-skills-arm-frozen-"));
    const store = SkillStore.open(dir);
    const r = await runSkillArmTrial({
      baseArm: "hcu-shell",
      arm: "cold",
      kind: "seed",
      pairId: p0?.pairId as string,
      task: seedTask,
      runId: "seed-0",
      store,
      learn: true,
      simulated: planner.startsWith("simulated"),
      forbidden: { values: [seedTask.intent.newValue] },
      execute: async () => fakeRun(seedTask, "seed-0", { planner }),
    });
    if (r.admittedSkillId === null) throw new Error(String(r.admissionCode));
    return { store, id: r.admittedSkillId };
  }
  const warm = (
    store: SkillStore,
    runId: string,
    pinnedHead: string | undefined,
    run: SkillTrialRun,
    simulated = true,
  ) =>
    runSkillArmTrial({
      baseArm: "hcu-shell",
      arm: "warm",
      kind: "similar",
      pairId: p1?.pairId as string,
      task: t1,
      runId,
      store,
      ...(pinnedHead !== undefined ? { pinnedHead } : {}),
      learn: false,
      simulated,
      execute: async () => run,
    });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  it("a refuted warm trial leaves the pinned store unchanged; the next warm trial gets the same advice", async () => {
    const { store, id } = await seed();
    try {
      const pinned = store.head();
      const a = await warm(store, "warm-a", pinned, fakeRun(t1, "warm-a", { verdict: "refuted" }));
      expect(a.retrievedSkillIds).toEqual([id]);
      expect(a.verified).toBe(false);
      const b = await warm(store, "warm-b", pinned, fakeRun(t1, "warm-b"));
      expect(b.retrievedSkillIds).toEqual([id]);
      expect(b.storeHead).toBe(pinned);
      expect(store.head()).toBe(pinned);
      expect(() => SkillStore.open(dir, { expectHead: pinned })).not.toThrow();
      // Between phases the uses are written: the refuted one quarantines the skill.
      expect(recordMeasuredUses(store, [a, b], pinned)).toBe(2);
      expect(store.skills()[0]?.status).toBe("quarantined");
      // A second write for the same phase is refused: the store is no longer at the pin.
      expect(() => recordMeasuredUses(store, [a, b], pinned)).toThrow(SkillStoreError);
    } finally {
      cleanup();
    }
  });

  it("a warm trial needs the pin, and a store that moved off the pin refuses it", async () => {
    const { store, id } = await seed();
    try {
      const pinned = store.head();
      await expect(warm(store, "warm-x", undefined, fakeRun(t1, "warm-x"))).rejects.toThrow(
        /pinned store head/,
      );
      SkillStore.open(dir).revoke(id, "operator"); // someone writes mid-phase
      await expect(warm(store, "warm-y", pinned, fakeRun(t1, "warm-y"))).rejects.toThrow(
        /STORE_NOT_PINNED/,
      );
    } finally {
      cleanup();
    }
  });

  it("recordMeasuredUses refuses a warm row that did not read the pinned head", async () => {
    const { store } = await seed();
    try {
      const pinned = store.head();
      const r = await warm(store, "warm-a", pinned, fakeRun(t1, "warm-a"));
      expect(() =>
        recordMeasuredUses(store, [{ ...r, storeHead: "f".repeat(64) }], pinned),
      ).toThrow(/did not read the pinned head/);
      expect(store.head()).toBe(pinned);
    } finally {
      cleanup();
    }
  });

  it("a real-planner warm trial is never served a simulated skill; a simulated one is", async () => {
    const { store, id } = await seed();
    try {
      const pinned = store.head();
      const real = await warm(
        store,
        "warm-real",
        pinned,
        fakeRun(t1, "warm-real", { planner: "claude-test-1" }),
        false,
      );
      expect(real.retrievedSkillIds).toEqual([]);
      expect(real.simulated).toBe(false);
      const sim = await warm(store, "warm-sim", pinned, fakeRun(t1, "warm-sim"));
      expect(sim.retrievedSkillIds).toEqual([id]);
    } finally {
      cleanup();
    }
  });

  it("a real-planner seed is served to a real warm trial", async () => {
    const { store, id } = await seed("claude-test-1");
    try {
      const real = await warm(
        store,
        "warm-real",
        store.head(),
        fakeRun(t1, "warm-real", { planner: "claude-test-1" }),
        false,
      );
      expect(real.retrievedSkillIds).toEqual([id]);
    } finally {
      cleanup();
    }
  });

  it("a run whose planner contradicts the trial's declared flag is refused", async () => {
    const { store } = await seed();
    try {
      await expect(
        warm(store, "warm-z", store.head(), fakeRun(t1, "warm-z"), false),
      ).rejects.toThrow(/contradicts/);
    } finally {
      cleanup();
    }
  });

  it("a real (default) summary refuses and leaves out simulated rows; paired counts exclude them", () => {
    const real = (over: Partial<SkillArmRow>) =>
      row({ plannerModelId: "claude-test-1", simulated: false, ...over });
    const rows = [
      real({ runId: "c1", pairId: "a", arm: "cold" }),
      real({ runId: "w1", pairId: "a", arm: "warm" }),
      row({ runId: "s1", pairId: "b", arm: "cold" }),
      row({ runId: "s2", pairId: "b", arm: "warm" }),
    ];
    const s = summarizeSkillArms(rows);
    expect(s.errors).toEqual([
      "s1: a simulated row never counts in a real summary",
      "s2: a simulated row never counts in a real summary",
    ]);
    expect(s.cells.map((c) => c.trials)).toEqual([1, 1]);
    expect(pairedCounts(rows, "hcu-shell")).toEqual({
      both: 1,
      warmOnly: 0,
      coldOnly: 0,
      neither: 0,
      unpaired: 0,
      excluded: 2,
    });
    // The simulated scope is the mirror image: real rows are refused there.
    const sim = summarizeSkillArms(rows, SIM);
    expect(sim.errors).toEqual([
      "c1: a real row in a simulated summary",
      "w1: a real row in a simulated summary",
    ]);
    expect(pairedCounts(rows, "hcu-shell", SIM)).toMatchObject({ both: 1, excluded: 2 });
  });

  it("a row whose simulated flag contradicts its planner never counts", () => {
    const liar = row({ runId: "l1", simulated: false }); // planner is simulated:scripted
    const s = summarizeSkillArms([liar]);
    expect(s.errors).toEqual(["l1: simulated flag contradicts the planner"]);
    expect(s.cells).toEqual([]);
    expect(summarizeSkillArms([liar], SIM).cells).toEqual([]);
    expect(pairedCounts([liar], "hcu-shell", SIM).excluded).toBe(1);
  });

  it("verified needs the grade to be on the gate's bytes", async () => {
    const { store } = await seed();
    try {
      const r = await warm(
        store,
        "warm-other-bytes",
        store.head(),
        fakeRun(t1, "warm-other-bytes", { gradedSha: "9".repeat(64) }),
      );
      expect(r.gradedGateBytes).toBe(false);
      expect(r.verified).toBe(false);
      const s = summarizeSkillArms([row({ runId: "x", gradedGateBytes: false })], SIM);
      expect(s.errors).toEqual(["x: verified contradicts gate and grade"]);
    } finally {
      cleanup();
    }
  });
});
