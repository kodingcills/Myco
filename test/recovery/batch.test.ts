/**
 * Track K batch, rows, pack check and bar (docs/recovery/recovery.md, acceptance K9, K11-K14).
 * Trials here are real `runRecoveryTrial` runs against a real bound gate; the grader is a stub
 * (the multi-step grader entry is a follow-up), which is exactly what the halt rule needs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type BenchmarkArmRow, correctionsOnError } from "../../src/benchmark/check.ts";
import {
  type BatchResult,
  type BatchTrial,
  checkRecoveryPack,
  type GraderVerdict,
  mcnemarExactOneSided,
  type RecoveryRow,
  recoveryBar,
  runRecoveryBatch,
} from "../../src/recovery/batch.ts";
import { type RecoveryArm, runRecoveryTrial } from "../../src/recovery/trial.ts";
import { type Agent, STEPS, world } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

const solves: Agent = async (_c, w) => {
  w.setGuest(STEPS);
  return { claim: "done" };
};
const fails: Agent = async (_c, w) => {
  w.setGuest([]);
  return { claim: "done" };
};

function trial(
  key: string,
  arm: RecoveryArm,
  agent: Agent,
  grade: (a: 1 | 2) => Promise<GraderVerdict> = async () => "pass",
  extra: Partial<BatchTrial> = {},
): BatchTrial & { ran: () => boolean } {
  let ran = false;
  return {
    trialKey: key,
    taskId: key.split("#")[0] as string,
    faulted: false,
    simulated: true,
    plannerModelId: "simulated:scripted",
    run: async () => {
      ran = true;
      const w = world(agent, { corrections: arm === "K", runId: key.replace("#", "-") });
      return runRecoveryTrial(w.harness, { arm });
    },
    grade,
    ran: () => ran,
    ...extra,
  };
}

describe("K11. any gate miss halts the K run", () => {
  for (const [label, grade] of [
    ["fail", async () => "fail" as const],
    ["ungradable", async () => "ungradable" as const],
    [
      "a grader that throws",
      async (): Promise<GraderVerdict> => {
        throw new Error("x");
      },
    ],
    ["a malformed grade", async () => "PASS" as GraderVerdict],
  ] as const) {
    it(`gate verified + grader ${label}: halted at that trial; nothing after it runs`, async () => {
      const t1 = trial("t1#K", "K", solves);
      const t2 = trial("t2#K", "K", solves, grade);
      const t3 = trial("t3#K", "K", solves);
      const res = await runRecoveryBatch([t1, t2, t3], { arm: "K" });
      expect(res.status).toBe("halted");
      if (res.status !== "halted") return;
      expect(res.halt.trialKey).toBe("t2#K");
      expect(res.halt.attempt).toBe(1);
      expect(res.rows.map((r) => r.trialKey)).toEqual(["t1#K"]);
      expect(t3.ran()).toBe(false);
    });
  }

  it("a refuted attempt the grader fails is not a miss", async () => {
    const res = await runRecoveryBatch([trial("t1#K", "K", fails, async () => "fail")], {
      arm: "K",
    });
    expect(res.status).toBe("complete");
    expect(res.rows[0]?.grade).toBe("fail");
  });

  it("a halted batch is never summarized", async () => {
    const k = await runRecoveryBatch([trial("t1#K", "K", solves, async () => "fail")], {
      arm: "K",
    });
    const none = await runRecoveryBatch([trial("t1#N", "no-recovery", solves)], {
      arm: "no-recovery",
    });
    expect(() => recoveryBar(k, none, { simulated: true })).toThrow(/halted/);
  });

  it("a trial that ran the wrong arm is refused", async () => {
    await expect(
      runRecoveryBatch([trial("t1#K", "no-recovery", solves)], { arm: "K" }),
    ).rejects.toThrow(/arm/);
  });
});

describe("K12. K rows record gate.corrections on, and are never R1 evidence", () => {
  it("a K row relabelled myco-gate is refused by the existing R1 check", async () => {
    const res = await runRecoveryBatch([trial("t1#K", "K", solves)], { arm: "K" });
    const row = res.rows[0] as RecoveryRow;
    expect(row.gate.corrections).toBe("on");
    expect(row.evidence).toBe("never-r1");
    expect(row.contrast).toBe("K-vs-nothing");
    const relabelled = {
      ...row,
      schema: "myco.benchmark.arm-row/1",
      arm: "myco-gate",
    } as unknown as BenchmarkArmRow;
    expect(correctionsOnError([relabelled])).toMatch(/corrections on/);
  });

  it("no-recovery rows record corrections off", async () => {
    const res = await runRecoveryBatch([trial("t1#N", "no-recovery", solves)], {
      arm: "no-recovery",
    });
    expect(res.rows[0]?.gate.corrections).toBe("off");
  });
});

describe("K9. the pack check refuses an attempt count that is not the harness's", () => {
  let base: BatchResult;
  const rowsOf = async () => {
    base ??= await runRecoveryBatch(
      [trial("t1#K", "K", solves), trial("t2#K", "K", fails, async () => "fail")],
      { arm: "K" },
    );
    return base;
  };

  it("the honest pack passes; harness attempts = rows' attempts", async () => {
    const b = await rowsOf();
    expect(b.harnessAttempts).toBe(3);
    expect(checkRecoveryPack(b.rows, { harnessAttempts: b.harnessAttempts })).toEqual([]);
  });

  it("a dropped attempt, a dropped row, or an extra attempt is refused", async () => {
    const b = await rowsOf();
    const r2 = b.rows[1] as RecoveryRow;
    expect(
      checkRecoveryPack([b.rows[0] as RecoveryRow, { ...r2, attempts: 1 }], { harnessAttempts: 3 }),
    ).toEqual([expect.stringMatching(/attempt count 2 .* 3/)]);
    expect(checkRecoveryPack([r2], { harnessAttempts: 3 })[0]).toMatch(/attempt count/);
    expect(checkRecoveryPack(b.rows, { harnessAttempts: 2 })[0]).toMatch(/attempt count/);
  });

  it("an arm config, contrast, attempt budget or duplicate that does not fit is refused", async () => {
    const b = await rowsOf();
    const r = b.rows[0] as RecoveryRow;
    const bad: [Partial<RecoveryRow> | Record<string, unknown>, RegExp][] = [
      [{ gate: { ...r.gate, corrections: "off" } }, /arm config/],
      [{ retryBudget: 0 }, /arm config/],
      [{ recoveryTools: false }, /arm config/],
      [{ arm: "C1" }, /arm config/],
      [{ contrast: "corrections" }, /contrast/],
      [{ schema: "myco.benchmark.arm-row/1" }, /not a recovery row/],
    ];
    for (const [patch, re] of bad)
      expect(
        checkRecoveryPack([{ ...r, ...patch } as RecoveryRow], {
          harnessAttempts: r.attempts,
        }).join("|"),
      ).toMatch(re);
    const none = {
      ...r,
      arm: "no-recovery",
      gate: { ...r.gate, corrections: "off" },
      retryBudget: 0,
      recoveryTools: false,
      attempts: 2,
    } as RecoveryRow;
    expect(checkRecoveryPack([none], { harnessAttempts: 2 }).join("|")).toMatch(/budget/);
    expect(checkRecoveryPack([r, r], { harnessAttempts: 2 * r.attempts }).join("|")).toMatch(
      /duplicate/,
    );
  });

  it("simulated rows are refused when checking evidence", async () => {
    const b = await rowsOf();
    expect(
      checkRecoveryPack(b.rows, { harnessAttempts: b.harnessAttempts, evidence: true }).join("|"),
    ).toMatch(/simulated/);
  });
});

describe("K13. the pre-registered bar: exact one-sided McNemar, p <= 0.05, >= 5 discordant", () => {
  it("exact values", () => {
    expect(mcnemarExactOneSided(5, 0)).toBeCloseTo(1 / 32, 12);
    expect(mcnemarExactOneSided(4, 0)).toBeCloseTo(1 / 16, 12);
    expect(mcnemarExactOneSided(6, 1)).toBeCloseTo(8 / 128, 12);
    expect(mcnemarExactOneSided(7, 1)).toBeCloseTo(9 / 256, 12);
    expect(mcnemarExactOneSided(0, 3)).toBe(1);
    expect(mcnemarExactOneSided(0, 0)).toBe(1);
  });

  const row = (taskId: string, arm: RecoveryArm, pass: boolean, faulted = false): RecoveryRow => ({
    schema: "myco.recovery.arm-row/1",
    taskSetVersion: "ms-long-v1",
    contrast: "K-vs-nothing",
    evidence: "never-r1",
    arm,
    trialKey: `${taskId}#${arm}`,
    taskId,
    faulted,
    simulated: false,
    plannerModelId: "claude-opus-5-5",
    gate: {
      called: true,
      verdict: pass ? "verified" : "refuted",
      corrections: arm === "K" ? "on" : "off",
    },
    retryBudget: arm === "K" ? 1 : 0,
    recoveryTools: arm === "K",
    attempts: 1,
    stepBudget: 80,
    steps: 10,
    elapsedMs: 1,
    costUsd: 0.1,
    grade: pass ? "pass" : "fail",
  });
  const batch = (rows: RecoveryRow[]): BatchResult => ({
    status: "complete",
    rows,
    harnessAttempts: rows.length,
  });
  /** n tasks; the first kOnly K-only, then noneOnly none-only, then both-pass. */
  const arms = (n: number, kOnly: number, noneOnly: number) => {
    const tasks = Array.from({ length: n }, (_, i) => `ms-${i}`);
    return [
      batch(tasks.map((t, i) => row(t, "K", i < kOnly || i >= kOnly + noneOnly, i % 2 === 0))),
      batch(tasks.map((t, i) => row(t, "no-recovery", i >= kOnly, i % 2 === 0))),
    ] as const;
  };

  it("5-0 discordant passes; 4-0 does not (too few, and p > 0.05); 6-1 does not", () => {
    expect(recoveryBar(...arms(40, 5, 0)).passes).toBe(true);
    expect(recoveryBar(...arms(40, 4, 0)).passes).toBe(false);
    expect(recoveryBar(...arms(40, 6, 1)).passes).toBe(false);
    expect(recoveryBar(...arms(40, 7, 1)).passes).toBe(true);
  });

  it("reports the faulted / unfaulted split and steps and cost per verified task", () => {
    const r = recoveryBar(...arms(40, 5, 0));
    expect(r.all).toMatchObject({ tasks: 40, kOnly: 5, noneOnly: 0 });
    expect(r.faulted.tasks + r.unfaulted.tasks).toBe(40);
    expect(r.faulted.kOnly + r.unfaulted.kOnly).toBe(5);
    expect(r.perVerified.K.steps).toBe(10);
    expect(r.perVerified["no-recovery"].steps).toBeCloseTo(400 / 35, 12);
  });

  it("a null cost is unknown, never 0", () => {
    const [k, none] = arms(10, 5, 0);
    const kNull = batch(k.rows.map((r, i) => (i === 0 ? { ...r, costUsd: null } : r)));
    expect(recoveryBar(kNull, none).perVerified.K.costUsd).toBeNull();
  });

  it("refuses mismatched tasks, duplicates, fault labels, swapped arms and simulated rows", () => {
    const [k, none] = arms(10, 5, 0);
    expect(() => recoveryBar(k, batch(none.rows.slice(1)))).toThrow(/same tasks/);
    expect(() =>
      recoveryBar(
        batch([...k.rows.slice(1), { ...(k.rows[1] as RecoveryRow), trialKey: "dup" }]),
        none,
      ),
    ).toThrow(/twice/);
    expect(() =>
      recoveryBar(k, batch(none.rows.map((r) => ({ ...r, faulted: !r.faulted })))),
    ).toThrow(/fault labels/);
    expect(() => recoveryBar(none, k)).toThrow();
    const sim = batch(k.rows.map((r) => ({ ...r, simulated: true })));
    expect(() => recoveryBar(sim, none)).toThrow(/simulated/);
    expect(
      recoveryBar(sim, batch(none.rows.map((r) => ({ ...r, simulated: true }))), {
        simulated: true,
      }).passes,
    ).toBe(true);
  });

  it("a pack whose attempt count does not match is refused before any number is computed", () => {
    const [k, none] = arms(10, 5, 0);
    expect(() => recoveryBar({ ...k, harnessAttempts: 11 }, none)).toThrow(/attempt count/);
  });
});

describe("K14. grader independence: src/recovery never imports the grader", () => {
  it("no file under src/recovery reaches src/benchmark/grade", () => {
    const dir = join(ROOT, "src", "recovery");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/(?:from|import)\s*\(?\s*["'][^"']*benchmark\/grade/);
    }
  });
});
