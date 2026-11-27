/**
 * Track J, j-v1: the frozen analysis script's behaviour (capability spec §2 J, §1.5, §3).
 *
 * Every row here is synthetic and SIMULATED in spirit: no model ran. Rows marked with a model
 * id exist only to exercise the "shown" path; nothing here is evidence.
 *
 * This file reads prereg.json directly (not through the loader), so a mutant of the analysis
 * script is killed by behaviour, not by the script's pinned SHA-256 (that is
 * `j-v1-prereg.test.ts`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeJV1,
  bootstrapUpperBounds,
  J_BASELINE_ARM,
  J_CAPABILITY_ARM,
  J_V1_TRIAL_SCHEMA,
  type JArm,
  type JTrialRow,
  jV1Schedule,
  newcombePairedUpper,
  preregHash,
  preregProblems,
  wilsonInterval,
  Z_ONE_SIDED_95,
  Z_TWO_SIDED_95,
} from "../../src/actions/j-v1-analysis.ts";
import { wilson } from "../../src/foundry/stats.ts";
import { newcombePairedCi } from "../../src/m2/corrections-ab.ts";

type Prereg = Record<string, unknown> & {
  leadRulingPending: string[];
  modelId: string;
  taskSet: { taskIds: string[] };
  seeds: { assignment: string; bootstrap: string };
  bar: { sequence: Record<string, unknown>[] };
};

const PREREG_TEXT = readFileSync("docs/product/capability-prereg/j-v1/prereg.json", "utf8");
const committed = (): Prereg => JSON.parse(PREREG_TEXT) as Prereg;
/** The committed pre-registration with the lead's rulings marked as given (for the "shown" path). */
const ratified = (): Prereg => ({ ...committed(), leadRulingPending: [] });

const MODEL = committed().modelId;
const TASKS = committed().taskSet.taskIds;

type Override = (taskId: string, arm: JArm, index: number) => Partial<JTrialRow>;

/** Rows in schedule order: every trial a verified done claim, J faster and with fewer steps. */
function rows(prereg: Prereg, override: Override = () => ({})): JTrialRow[] {
  const index = new Map(prereg.taskSet.taskIds.map((id, i) => [id, i]));
  return jV1Schedule(prereg).map((s) => ({
    schema: J_V1_TRIAL_SCHEMA,
    taskId: s.taskId,
    arm: s.arm,
    seq: s.seq,
    plannerModelId: MODEL,
    simulated: false,
    claim: "done",
    grade: "pass",
    steps: s.arm === J_CAPABILITY_ARM ? 4 : 9,
    wallMs: s.arm === J_CAPABILITY_ARM ? 40_000 : 90_000,
    harnessFault: null,
    boundaryBreach: false,
    ...override(s.taskId, s.arm, index.get(s.taskId) as number),
  }));
}

const run = (prereg: Prereg, r: readonly unknown[], hash = preregHash(prereg)) =>
  analyzeJV1({ prereg, packPreregHash: hash, rows: r });

const statusOf = (result: ReturnType<typeof analyzeJV1>) => result.bar.map((c) => c.status);

describe("j-v1 statistics", () => {
  it("Wilson matches the repo's two-sided implementation at z = 1.96", () => {
    for (const [x, n] of [
      [81, 90],
      [0, 90],
      [90, 90],
      [7, 13],
    ] as const)
      expect(wilsonInterval(x, n, Z_TWO_SIDED_95)).toEqual(wilson(x, n));
    const [l, u] = wilsonInterval(81, 90, Z_TWO_SIDED_95) as readonly [number, number];
    expect(l).toBeCloseTo(0.8208, 4);
    expect(u).toBeGreaterThan(0.9);
  });

  it("Newcombe's paired upper bound agrees with the corrections A/B's at z = 1.96", () => {
    for (const [a, b, c, d] of [
      [70, 8, 3, 9],
      [80, 2, 2, 6],
      [40, 20, 1, 29],
      [90, 0, 0, 0],
    ] as const) {
      const theirs = newcombePairedCi(a, b, c, d) as readonly [number, number];
      expect(newcombePairedUpper(a, b, c, d, Z_TWO_SIDED_95)).toBeCloseTo(theirs[1], 12);
    }
  });

  it("the non-inferiority bound is one-sided 95% (z = 1.645), tighter than the two-sided one", () => {
    expect(Z_ONE_SIDED_95).toBeCloseTo(1.6449, 4);
    const one = newcombePairedUpper(76, 5, 5, 4, Z_ONE_SIDED_95);
    const two = newcombePairedUpper(76, 5, 5, 4, Z_TWO_SIDED_95);
    expect(one).toBeLessThan(two);
  });

  it("reproduces the spec's margin caveat: equality with ~10% discordant has a bound above 5 points", () => {
    // n = 90, 10 discordant tasks split 5 / 5 (true equality, ~11% discordant): the bound on
    // baseline − J is about 5.5 points, so component 1 fails with no real drop (spec §2 J).
    const ub = newcombePairedUpper(76, 5, 5, 4, Z_ONE_SIDED_95);
    expect(ub).toBeGreaterThan(0.05);
    expect(ub).toBeLessThan(0.07);
  });

  it("the bootstrap is deterministic under its seed and counts a resample without verified tasks as +Infinity", () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({
      vB: i % 2,
      vJ: i % 3 === 0 ? 1 : 0,
      wallB: 1000,
      wallJ: 500,
      stepsB: 10,
      stepsJ: 5,
    }));
    const a = bootstrapUpperBounds(pairs, "seed-aaaaaaaaaaaaaaaa", 2000);
    expect(bootstrapUpperBounds(pairs, "seed-aaaaaaaaaaaaaaaa", 2000)).toEqual(a);
    expect(bootstrapUpperBounds(pairs, "seed-bbbbbbbbbbbbbbbb", 2000)).not.toEqual(a);
    const none = pairs.map((p) => ({ ...p, vJ: 0 }));
    expect(bootstrapUpperBounds(none, "seed-aaaaaaaaaaaaaaaa", 1000).wall).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("the bootstrap's upper bound is the 95th percentile, not a lower one", () => {
    // J's wall time varies by task; the ratio's 95th percentile is above its median.
    const pairs = Array.from({ length: 30 }, (_, i) => ({
      vB: 1,
      vJ: 1,
      wallB: 1000,
      wallJ: 200 + 40 * i,
      stepsB: 10,
      stepsJ: 10,
    }));
    const point = pairs.reduce((s, p) => s + p.wallJ, 0) / pairs.reduce((s, p) => s + p.wallB, 0);
    const { wall, steps } = bootstrapUpperBounds(pairs, "seed-aaaaaaaaaaaaaaaa", 4000);
    expect(wall).toBeGreaterThan(point + 0.05);
    expect(steps).toBeCloseTo(1, 12);
  });
});

describe("j-v1 schedule", () => {
  const prereg = committed();
  const schedule = jV1Schedule(prereg);

  it("runs every (task, arm) once, seq 0..179", () => {
    expect(schedule).toHaveLength(2 * TASKS.length);
    expect(schedule.map((s) => s.seq)).toEqual(schedule.map((_, i) => i));
    const keys = new Set(schedule.map((s) => `${s.taskId}|${s.arm}`));
    expect(keys.size).toBe(180);
    for (const id of TASKS) {
      expect(keys.has(`${id}|${J_BASELINE_ARM}`)).toBe(true);
      expect(keys.has(`${id}|${J_CAPABILITY_ARM}`)).toBe(true);
    }
  });

  it("keeps each task's two trials adjacent and alternates arms in ABBA blocks", () => {
    for (let t = 0; t < TASKS.length; t++) {
      const [x, y] = [schedule[2 * t], schedule[2 * t + 1]];
      expect(x?.taskId).toBe(y?.taskId);
      expect(x?.arm).not.toBe(y?.arm);
      if (t > 0) expect(x?.arm).toBe(schedule[2 * t - 1]?.arm);
    }
  });

  it("is seeded: same seed same order, another seed another order, and not task-id order", () => {
    expect(jV1Schedule(prereg)).toEqual(schedule);
    const other = jV1Schedule({
      ...prereg,
      seeds: { ...prereg.seeds, assignment: "x".repeat(20) },
    });
    expect(other.map((s) => s.taskId)).not.toEqual(schedule.map((s) => s.taskId));
    const order = schedule.filter((_, i) => i % 2 === 0).map((s) => s.taskId);
    expect(order).not.toEqual([...TASKS].sort());
  });
});

describe("j-v1 analysis: refusals", () => {
  it("refuses a pack whose pre-registration hash does not match", () => {
    const p = ratified();
    const r = run(p, rows(p), "0".repeat(64));
    expect(r.computed).toBe(false);
    expect(r.verdict).toBe("not-shown");
    expect(r.reasons[0]).toMatch(/^PREREG_HASH_MISMATCH/);
    expect(statusOf(r)).toEqual(["not-tested", "not-tested", "not-tested"]);
  });

  it("refuses a pack whose pre-registration was edited after the hash was taken", () => {
    const p = ratified();
    const hash = preregHash(p);
    const edited = { ...p, bar: { ...p.bar, sequence: p.bar.sequence.map((c) => ({ ...c })) } };
    (edited.bar.sequence[0] as Record<string, unknown>).marginPoints = 10;
    expect(run(edited, rows(edited), hash).reasons[0]).toMatch(/^PREREG_HASH_MISMATCH/);
  });

  it("refuses a pack with a missing, duplicated, unknown or mis-ordered trial", () => {
    const p = ratified();
    const base = rows(p);
    expect(run(p, base.slice(1)).reasons).toEqual([expect.stringMatching(/^DESIGN_MISSING: /)]);
    expect(run(p, [...base, base[0]]).reasons).toEqual([
      expect.stringMatching(/^DESIGN_DUPLICATE: /),
    ]);
    expect(
      run(p, [...base, { ...base[0], taskId: "fc-v1-091" }]).reasons.some((x) =>
        x.startsWith("DESIGN_UNKNOWN_TASK: fc-v1-091"),
      ),
    ).toBe(true);
    const swapped = base.map((r) =>
      r.seq === 0 ? { ...r, seq: 1 } : r.seq === 1 ? { ...r, seq: 0 } : r,
    );
    const res = run(p, swapped);
    expect(res.computed).toBe(false);
    expect(res.reasons.filter((x) => x.startsWith("DESIGN_ORDER"))).toHaveLength(2);
  });

  it("refuses malformed rows: extra field, steps over the budget, bad grade, inconsistent simulated flag", () => {
    const p = ratified();
    const bad: Partial<Record<string, unknown>>[] = [
      { extra: 1 },
      { steps: 31 },
      { grade: "verified" },
      { simulated: true },
      { wallMs: -1 },
      { harnessFault: "" },
      { claim: "failure" },
    ];
    for (const b of bad) {
      const r = rows(p);
      r[5] = { ...(r[5] as JTrialRow), ...b } as JTrialRow;
      const res = run(p, r);
      expect(res.computed, JSON.stringify(b)).toBe(false);
      expect(res.reasons[0], JSON.stringify(b)).toMatch(/^ROW_INVALID: row 5/);
    }
    const ok = rows(p);
    ok[5] = { ...(ok[5] as JTrialRow), steps: 30 };
    expect(run(p, ok).computed).toBe(true);
  });

  it("refuses a pre-registration the script cannot apply", () => {
    const cases: ((p: Prereg) => void)[] = [
      (p) => {
        delete p.bar.sequence[0]?.marginPoints;
      },
      (p) => {
        (p.bar.sequence[0] as Record<string, unknown>).confidenceOneSided = 0.9;
      },
      (p) => {
        (p.bar.sequence[1] as Record<string, unknown>).resamples = 10;
      },
      (p) => {
        (p.bar.sequence[2] as Record<string, unknown>).resamples = 5000;
      },
      (p) => {
        (p.bar.sequence[1] as Record<string, unknown>).threshold = 1.1;
      },
      (p) => {
        p.bar.sequence.reverse();
      },
      (p) => {
        p.runsPerTaskPerArm = 2;
      },
      (p) => {
        p.seeds.bootstrap = p.seeds.assignment;
      },
      (p) => {
        p.taskSet.taskIds.push(p.taskSet.taskIds[0] as string);
      },
      (p) => {
        p.modelId = "scripted";
      },
      (p) => {
        (p.bar as Record<string, unknown>).alphaOneSided = 0.1;
      },
    ];
    for (const mutate of cases) {
      const p = structuredClone(ratified());
      mutate(p);
      expect(preregProblems(p).length, mutate.toString()).toBeGreaterThan(0);
      const res = run(p, rows(ratified()));
      expect(res.computed).toBe(false);
    }
    expect(preregProblems(committed())).toEqual([]);
  });
});

describe("j-v1 analysis: the bar", () => {
  it("is shown when J is non-inferior, faster and uses fewer steps, and every row is a real model's", () => {
    const p = ratified();
    const r = run(p, rows(p));
    expect(r.reasons).toEqual([]);
    expect(r.verdict).toBe("shown");
    expect(statusOf(r)).toEqual(["shown", "shown", "shown"]);
    expect(r.n).toBe(90);
    expect(r.table).toEqual({ a: 90, b: 0, c: 0, d: 0 });
    expect(r.bar[1]?.estimate).toBeCloseTo(40 / 90, 12);
    expect(r.bar[2]?.estimate).toBeCloseTo(4 / 9, 12);
  });

  it("is never shown while a lead ruling is pending (the committed j-v1: the 5-point margin)", () => {
    const p = committed();
    expect(p.leadRulingPending).toEqual(["bar.sequence[0].marginPoints"]);
    const r = run(p, rows(p));
    expect(r.computed).toBe(true);
    expect(statusOf(r)).toEqual(["shown", "shown", "shown"]);
    expect(r.verdict).toBe("not-shown");
    expect(r.reasons).toEqual(["LEAD_RULING_PENDING: bar.sequence[0].marginPoints"]);
  });

  it("is never shown on simulated rows, though the numbers are computed (plumbing)", () => {
    const p = ratified();
    const r = run(
      p,
      rows(p, (_, arm) =>
        arm === J_CAPABILITY_ARM ? { plannerModelId: "scripted", simulated: true } : {},
      ),
    );
    expect(r.computed).toBe(true);
    expect(r.verdict).toBe("not-shown");
    expect(r.reasons).toContain("SIMULATED: 90 row(s); simulated rows are never evidence");
  });

  it("is never shown when a row's planner is not the pre-registered model", () => {
    const p = ratified();
    const r = run(
      p,
      rows(p, (_, __, i) => (i === 3 ? { plannerModelId: "claude-opus-5-5" } : {})),
    );
    expect(r.verdict).toBe("not-shown");
    expect(r.reasons.some((x) => x.startsWith("PLANNER_MISMATCH"))).toBe(true);
  });

  it("stops at component 1 when J verifies fewer tasks: 2 and 3 are not tested", () => {
    const p = ratified();
    const r = run(
      p,
      rows(p, (_, arm, i) => (arm === J_CAPABILITY_ARM && i < 10 ? { grade: "fail" } : {})),
    );
    expect(r.table).toEqual({ a: 80, b: 10, c: 0, d: 0 });
    expect(statusOf(r)).toEqual(["not-shown", "not-tested", "not-tested"]);
    expect(r.bar[0]?.upperBound).toBeGreaterThan(0.05);
    expect(r.bar[0]?.estimate).toBeCloseTo(10 / 90, 12);
    expect(r.verdict).toBe("not-shown");
  });

  it("uses the margin as a strict bound: a bound just under 5 points is shown, the same data with a 4-point margin is not", () => {
    const p = ratified();
    const data = rows(p, (_, arm, i) =>
      arm === J_CAPABILITY_ARM && i === 0 ? { grade: "fail" } : {},
    );
    const r = run(p, data);
    const ub = r.bar[0]?.upperBound as number;
    expect(ub).toBeGreaterThan(0.04);
    expect(ub).toBeLessThan(0.05);
    expect(r.bar[0]?.status).toBe("shown");
    const tight = structuredClone(p);
    (tight.bar.sequence[0] as Record<string, unknown>).marginPoints = 4;
    expect(run(tight, data).bar[0]?.status).toBe("not-shown");
  });

  it("follows the fixed sequence: a slower J stops at component 2 even with fewer steps", () => {
    const p = ratified();
    const r = run(
      p,
      rows(p, (_, arm) => (arm === J_CAPABILITY_ARM ? { wallMs: 95_000 } : {})),
    );
    expect(statusOf(r)).toEqual(["shown", "not-shown", "not-tested"]);
    expect(r.bar[2]?.upperBound).toBeNull();
    expect(r.verdict).toBe("not-shown");
  });

  it("component 3 fails on its own when J is faster but takes more steps", () => {
    const p = ratified();
    const r = run(
      p,
      rows(p, (_, arm) => (arm === J_CAPABILITY_ARM ? { steps: 12 } : {})),
    );
    expect(statusOf(r)).toEqual(["shown", "shown", "not-shown"]);
  });

  it("charges every trial's time to the ratio, failed trials included, not only verified ones", () => {
    // J: 85 verified fast trials and 5 failed slow ones. Over verified trials alone J looks
    // faster (40 s vs 90 s); over ALL trials J spends 85·40 + 5·900 s for 85 verified.
    const p = ratified();
    const r = run(
      p,
      rows(p, (_, arm, i) => {
        if (arm !== J_CAPABILITY_ARM) return {};
        return i < 5 ? { grade: "fail", wallMs: 900_000 } : {};
      }),
    );
    const point = r.bar[1]?.estimate as number;
    expect(point).toBeCloseTo((85 * 40_000 + 5 * 900_000) / 85 / 90_000, 12);
    expect(point).toBeGreaterThan(1);
  });

  it("a harness fault or boundary breach is counted in the denominator and never verified", () => {
    const p = ratified();
    const r = run(
      p,
      rows(p, (_, arm, i) => {
        if (arm !== J_CAPABILITY_ARM) return {};
        if (i === 0) return { harnessFault: "UNRECORDED_ROUTE" };
        if (i === 1) return { boundaryBreach: true };
        return {};
      }),
    );
    const j = r.arms?.capability;
    expect(j?.trials).toBe(90);
    expect(j?.verified).toBe(88);
    expect(j?.harnessFaults).toEqual({ UNRECORDED_ROUTE: 1 });
    expect(j?.boundaryBreaches).toBe(1);
    expect(r.reasons).toContain("GUARDRAIL_BOUNDARY_BREACH: 1 trial(s)");
    expect(r.verdict).toBe("not-shown");
  });

  it("a harness fault alone is not a guardrail breach (it is counted, not voiding the bar)", () => {
    const p = ratified();
    const r = run(
      p,
      rows(p, (_, arm, i) =>
        arm === J_CAPABILITY_ARM && i === 0 ? { harnessFault: "UNRECORDED_ROUTE" } : {},
      ),
    );
    expect(r.reasons.some((x) => x.startsWith("GUARDRAIL"))).toBe(false);
    expect(r.arms?.capability.verified).toBe(89);
  });

  it("reports false done and ungraded trials, and a pass without a done claim is not verified", () => {
    const p = ratified();
    const r = run(
      p,
      rows(p, (_, arm, i) => {
        if (arm !== J_BASELINE_ARM) return {};
        if (i === 0) return { grade: "fail" };
        if (i === 1) return { grade: "ungradable" };
        if (i === 2) return { claim: "not-done" };
        if (i === 3) return { grade: null };
        return {};
      }),
    );
    const b = r.arms?.baseline;
    expect(b?.falseDone).toBe(2);
    expect(b?.ungraded).toBe(1);
    expect(b?.verified).toBe(86);
    expect(r.table).toEqual({ a: 86, b: 0, c: 4, d: 0 });
    expect(b?.verifiedRateWilson95[0]).toBeLessThan(b?.verifiedRate as number);
  });

  it("an arm with no verified task gives no per-verified figure and an infinite bound", () => {
    const p = ratified();
    const r = run(
      p,
      rows(p, (_, arm) => (arm === J_BASELINE_ARM ? { claim: "no-claim" } : {})),
    );
    expect(r.arms?.baseline.wallMsPerVerified).toBeNull();
    expect(r.bar[1]?.estimate).toBeNull();
    expect(r.bar[1]?.upperBound).toBe(Number.POSITIVE_INFINITY);
    expect(r.bar[1]?.status).toBe("not-shown");
  });

  it("is deterministic: the same pack gives the same report", () => {
    const p = ratified();
    const data = rows(p, (_, arm, i) =>
      arm === J_CAPABILITY_ARM ? { wallMs: 30_000 + 997 * i } : {},
    );
    expect(run(p, data)).toEqual(run(p, data));
  });
});
