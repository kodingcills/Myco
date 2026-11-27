/**
 * Track K batch, rows, pack check and bar (docs/recovery/recovery.md, acceptance K9, K11-K14).
 * Trials here are real `runRecoveryTrial` runs against a real bound gate; the grader is a stub
 * (the multi-step grader entry is a follow-up), which is exactly what the halt rule needs.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type BenchmarkArmRow, correctionsOnError } from "../../src/benchmark/check.ts";
import { CLAIM_LIMIT } from "../../src/gate/api.ts";
import {
  type BatchResult,
  type BatchTrial,
  checkRecoveryPack,
  type GraderVerdict,
  isVerifiedRow,
  mcnemarExactOneSided,
  type RecoveryRow,
  recoveryBar,
  runRecoveryBatch,
} from "../../src/recovery/batch.ts";
import {
  type RecoveryArm,
  type RecoveryHarness,
  runRecoveryTrial,
} from "../../src/recovery/trial.ts";
import { type Agent, doc, STEPS, sha, type World, world } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const INSTRUCTION = "a".repeat(64);
const FIXTURE = "f".repeat(64);

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
    instructionSha256: INSTRUCTION,
    fixtureSha256: FIXTURE,
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
  instructionSha256: INSTRUCTION,
  fixtureSha256: FIXTURE,
  claim: "done",
  gate: {
    called: true,
    verdict: pass ? "verified" : "refuted",
    corrections: arm === "K" ? "on" : "off",
  },
  accepted: pass,
  harnessCodes: [],
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
    expect(() => recoveryBar(batch(k.rows.slice(1)), none)).toThrow(/same tasks/);
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

/** A trial whose harness the test bends (a stale capture, a refusing gate, a fault). */
function bentTrial(
  key: string,
  arm: RecoveryArm,
  agent: Agent,
  bend: (w: World) => Partial<RecoveryHarness>,
  grade: () => Promise<GraderVerdict> = async () => "pass",
): BatchTrial {
  return {
    ...trial(key, arm, agent, grade),
    run: async () => {
      const w = world(agent, { corrections: arm === "K", runId: key.replace("#", "-") });
      return runRecoveryTrial({ ...w.harness, ...bend(w) }, { arm });
    },
  };
}

/** The capture forgot to copy: the evidence path holds a passing document from elsewhere. */
const staleCapture = (w: World): Partial<RecoveryHarness> => ({
  capture: async () => {
    mkdirSync(dirname(w.capturedFile), { recursive: true });
    writeFileSync(w.capturedFile, doc(STEPS));
    return { sha256: sha(readFileSync(w.guestFile)) };
  },
});

describe("K15 (D1). only a done claim the gate verified and the grader passed is a verified task", () => {
  const pristine: Agent = async (_c, w) => {
    w.setGuest([]);
    return { claim: "done" };
  };
  const one = async (t: BatchTrial, arm: RecoveryArm = "K") => {
    const res = await runRecoveryBatch([t], { arm });
    expect(res.status).toBe("complete");
    return res.rows[0] as RecoveryRow;
  };

  it("positive control: solved, claimed done, gate verified, grader pass -> verified", async () => {
    const r = await one(trial("t1#K", "K", solves));
    expect(r).toMatchObject({ claim: "done", accepted: true, harnessCodes: [], grade: "pass" });
    expect(r.gate.verdict).toBe("verified");
    expect(isVerifiedRow(r)).toBe(true);
  });

  it("fail-closed (EVIDENCE_NOT_FRESH) + grader pass -> not verified", async () => {
    const r = await one(bentTrial("t1#K", "K", pristine, staleCapture));
    expect(r.harnessCodes).toEqual(["EVIDENCE_NOT_FRESH"]);
    expect(r).toMatchObject({ accepted: false, grade: "pass" });
    expect(r.gate.verdict).toBe("uncertain");
    expect(isVerifiedRow(r)).toBe(false);
  });

  it("gate refuted + grader pass -> not verified", async () => {
    const r = await one(trial("t1#K", "K", fails, async () => "pass"));
    expect(r.gate.verdict).toBe("refuted");
    expect(r.grade).toBe("pass");
    expect(isVerifiedRow(r)).toBe(false);
  });

  it("gate uncertain + grader pass -> not verified", async () => {
    const t = bentTrial("t1#K", "K", solves, (w) => ({
      checkGate: async (c) => ({
        ...(await w.harness.checkGate(c)),
        verdict: "uncertain",
        accepted: false,
      }),
    }));
    const r = await one(t);
    expect(r).toMatchObject({ accepted: false, harnessCodes: [], grade: "pass" });
    expect(r.gate.verdict).toBe("uncertain");
    expect(isVerifiedRow(r)).toBe(false);
  });

  it("a request the real gate refuses + grader pass -> not verified", async () => {
    const t = bentTrial("t1#K", "K", solves, (w) => ({
      checkGate: (c) => w.harness.checkGate(`${c}${" ".repeat(CLAIM_LIMIT)}`),
    }));
    const r = await one(t);
    expect(r).toMatchObject({ claim: "done", accepted: false, grade: "pass" });
    expect(r.gate.verdict).not.toBe("verified");
    expect(isVerifiedRow(r)).toBe(false);
  });

  it("a harness fault (CAPTURE_FAILED) + grader pass -> not verified", async () => {
    const t = bentTrial("t1#K", "K", solves, () => ({
      capture: async () => {
        throw new Error("boom");
      },
    }));
    const r = await one(t);
    expect(r.harnessCodes).toEqual(["CAPTURE_FAILED"]);
    expect(r).toMatchObject({ accepted: false, grade: "pass" });
    expect(isVerifiedRow(r)).toBe(false);
  });

  it("no done claim + gate verified + grader pass -> correct, not claimed; not verified", async () => {
    const notDone: Agent = async (_c, w) => {
      w.setGuest(STEPS);
      return { claim: "not done yet" };
    };
    const r = await one(trial("t1#K", "K", notDone));
    expect(r).toMatchObject({ claim: "not-done", accepted: true, grade: "pass" });
    expect(isVerifiedRow(r)).toBe(false);
    const silent: Agent = async (_c, w) => {
      w.setGuest(STEPS);
      return { claim: "" };
    };
    expect((await one(trial("t2#K", "K", silent))).claim).toBe("no-claim");
    for (const near of ["Done", " done", "done "]) {
      const nearMiss: Agent = async (_c, w) => {
        w.setGuest(STEPS);
        return { claim: near };
      };
      expect((await one(trial("t3#K", "K", nearMiss))).claim).toBe("not-done");
    }
  });

  it("the round-1 probe: 5 fail-closed K trials graded pass never pass the bar", async () => {
    const tasks = ["a", "b", "c", "d", "e"];
    const k = await runRecoveryBatch(
      tasks.map((t) => bentTrial(`${t}#K`, "K", pristine, staleCapture)),
      { arm: "K" },
    );
    const none = await runRecoveryBatch(
      tasks.map((t) => trial(`${t}#N`, "no-recovery", fails, async () => "fail")),
      { arm: "no-recovery" },
    );
    const bar = recoveryBar(k, none, { simulated: true });
    expect(bar.all).toMatchObject({ kVerified: 0, kOnly: 0, kCorrectNotVerified: 5 });
    expect(bar.passes).toBe(false);
    expect(bar.perVerified.K).toEqual({ steps: null, costUsd: null });
  });

  it("each clause of the rule is load-bearing on a row", () => {
    const good = row("t", "K", true);
    expect(isVerifiedRow(good)).toBe(true);
    for (const patch of [
      { claim: "not-done" },
      { claim: "no-claim" },
      { accepted: false },
      { gate: { ...good.gate, verdict: "uncertain" } },
      { gate: { ...good.gate, verdict: "refuted" } },
      { harnessCodes: ["EVIDENCE_NOT_FRESH"] },
      { harnessCodes: undefined },
      { grade: "ungradable" },
      { grade: "fail" },
    ] as Partial<RecoveryRow>[])
      expect(isVerifiedRow({ ...good, ...patch }), JSON.stringify(patch)).toBe(false);
  });

  it("the bar counts by the rule: grader pass without acceptance is reported, not counted", () => {
    const [k, none] = arms(10, 5, 0);
    const unaccepted = batch(
      k.rows.map((r, i) =>
        i < 5 ? { ...r, accepted: false, gate: { ...r.gate, verdict: "uncertain" as const } } : r,
      ),
    );
    const bar = recoveryBar(unaccepted, none);
    expect(bar.all).toMatchObject({ kOnly: 0, kCorrectNotVerified: 5 });
    expect(bar.passes).toBe(false);
  });

  it("the pack refuses a row that disagrees with itself", () => {
    const good = row("t", "K", true);
    for (const [patch, re] of [
      [{ gate: { ...good.gate, verdict: "uncertain" } }, /not a clean verified/],
      [{ harnessCodes: ["EVIDENCE_NOT_FRESH"] }, /not a clean verified/],
      [
        { accepted: false, harnessCodes: ["EVIDENCE_NOT_FRESH"], gate: { ...good.gate } },
        /not uncertain/,
      ],
      [{ harnessCodes: ["MADE_UP"] }, /known codes/],
      [{ harnessCodes: "none" }, /known codes/],
      [{ accepted: "yes" }, /boolean/],
      [{ claim: "DONE" }, /unknown claim/],
      [{ instructionSha256: "x" }, /sha256/],
      [{ fixtureSha256: undefined }, /sha256/],
    ] as [Record<string, unknown>, RegExp][])
      expect(
        checkRecoveryPack([{ ...good, ...patch } as RecoveryRow], { harnessAttempts: 1 }).join("|"),
        JSON.stringify(patch),
      ).toMatch(re);
  });
});

describe("K16 (D4). simulated rows are never evidence, on every path the bar touches", () => {
  const good = row("t", "K", true);
  const evidenceErrors = (r: RecoveryRow) =>
    checkRecoveryPack([r], { harnessAttempts: 1, evidence: true }).join("|");

  it("a real planner on a non-simulated row is evidence", () => {
    expect(evidenceErrors(good)).toBe("");
  });

  it("a simulated planner is refused even when the row says simulated: false", () => {
    expect(evidenceErrors({ ...good, plannerModelId: "simulated:scripted" })).toMatch(
      /not a model id/,
    );
  });

  it("near-miss planner ids are refused (allowlist, not a pattern)", () => {
    for (const p of ["Claude-Opus-5-5", " claude-opus-5-5", "claude-opus", "", "gpt-5"])
      expect(evidenceErrors({ ...good, plannerModelId: p }), p).toMatch(/not a model id/);
  });

  it("a row that says simulated is refused even with a real planner; so is a non-boolean flag", () => {
    expect(evidenceErrors({ ...good, simulated: true })).toMatch(/simulated/);
    expect(evidenceErrors({ ...good, simulated: undefined as unknown as boolean })).toMatch(
      /simulated/,
    );
  });

  it("the bar refuses a simulated planner unless explicitly in plumbing mode, which is never evidence", () => {
    const [k, none] = arms(10, 5, 0);
    const relabel = (b: BatchResult) =>
      batch(b.rows.map((r) => ({ ...r, plannerModelId: "simulated:scripted" })));
    expect(() => recoveryBar(relabel(k), relabel(none))).toThrow(/not a model id/);
    const plumbing = recoveryBar(relabel(k), relabel(none), { simulated: true });
    expect(plumbing.evidence).toBe(false);
    expect(recoveryBar(k, none).evidence).toBe(true);
  });
});

describe("K17 (D5). parity between and within the arms", () => {
  it("the pack refuses mixed planners, step budgets or task sets within one arm", () => {
    const [k] = arms(4, 0, 0);
    const rows = k.rows;
    for (const [patch, re] of [
      [{ plannerModelId: "claude-sonnet-5-5" }, /mixed planners/],
      [{ stepBudget: 500 }, /mixed step budgets/],
      [{ taskSetVersion: "ms-long-v2" }, /mixed task sets/],
    ] as [Partial<RecoveryRow>, RegExp][]) {
      const mixed = rows.map((r, i) => (i === 0 ? { ...r, ...patch } : r));
      expect(checkRecoveryPack(mixed, { harnessAttempts: 4 }).join("|")).toMatch(re);
      expect(() => recoveryBar(batch(mixed), arms(4, 0, 0)[1])).toThrow(re);
    }
  });

  it("the bar refuses arms with different planners, step budgets or task sets", () => {
    const [k, none] = arms(10, 5, 0);
    const all = (b: BatchResult, patch: Partial<RecoveryRow>) =>
      batch(b.rows.map((r) => ({ ...r, ...patch })));
    expect(() => recoveryBar(all(k, { plannerModelId: "claude-sonnet-5-5" }), none)).toThrow(
      /different planners/,
    );
    expect(() => recoveryBar(all(k, { stepBudget: 500 }), none)).toThrow(/step budgets/);
    expect(() => recoveryBar(k, all(none, { stepBudget: 30 }))).toThrow(/step budgets/);
    expect(() => recoveryBar(all(k, { taskSetVersion: "other" }), none)).toThrow(/task sets/);
  });

  it("the bar refuses a task whose instruction or fixture differs between the arms", () => {
    const [k, none] = arms(10, 5, 0);
    const bendOne = (patch: Partial<RecoveryRow>) =>
      batch(none.rows.map((r, i) => (i === 3 ? { ...r, ...patch } : r)));
    expect(() => recoveryBar(k, bendOne({ instructionSha256: "b".repeat(64) }))).toThrow(
      /instructions differ/,
    );
    expect(() => recoveryBar(k, bendOne({ fixtureSha256: "e".repeat(64) }))).toThrow(
      /fixtures differ/,
    );
  });

  it("real batches record the trial's planner, step budget and hashes on each row", async () => {
    const res = await runRecoveryBatch([trial("t1#K", "K", solves)], { arm: "K" });
    expect(res.rows[0]).toMatchObject({
      plannerModelId: "simulated:scripted",
      stepBudget: 80,
      instructionSha256: INSTRUCTION,
      fixtureSha256: FIXTURE,
    });
  });
});
