/**
 * Track J, j-v1: the frozen analysis script's behaviour (capability spec §2 J, §1.5, §3; lead
 * ruling 2026-11-27 05:39Z: 5-point margin, k = 2 repeats per task per arm).
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
  runsPerTaskPerArm: number;
  modelId: string;
  taskSet: { taskIds: string[] };
  seeds: { assignment: string; bootstrap: string };
  bar: { sequence: Record<string, unknown>[] };
};

const PREREG_TEXT = readFileSync("docs/product/capability-prereg/j-v1/prereg.json", "utf8");
/** The committed j-v1: lead ruling recorded, 5-point margin, k = 2. */
const committed = (): Prereg => JSON.parse(PREREG_TEXT) as Prereg;
/** j-v1 with a ruling still pending (as before 05:39Z). */
const pending = (): Prereg => ({ ...committed(), leadRulingPending: ["x"] });
/** The ruling's fallback, option (b): 7-point margin at k = 1. */
function optionB(): Prereg {
  const p = structuredClone(committed());
  p.runsPerTaskPerArm = 1;
  (p.bar.sequence[0] as Record<string, unknown>).marginPoints = 7;
  return p;
}

const MODEL = committed().modelId;
const TASKS = committed().taskSet.taskIds;

type Override = (taskId: string, arm: JArm, index: number, rep: number) => Partial<JTrialRow>;

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
    ...override(s.taskId, s.arm, index.get(s.taskId) as number, s.rep),
  }));
}

/** Override only J's first repeat of the tasks at indices below `count`. */
const jFirstRep =
  (count: number, o: Partial<JTrialRow>): Override =>
  (_, arm, i, rep) =>
    arm === J_CAPABILITY_ARM && rep === 1 && i < count ? o : {};

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

  it("reproduces the spec's margin caveat at k = 1, and why the ruling took k = 2", () => {
    // True equality with ~11% discordant: at n = 90 pairs the bound on baseline − J is about
    // 6.2 points, above the 5-point margin (spec §2 J); at n = 180 pairs (k = 2) it is about
    // 4.2 points, below it.
    const k1 = newcombePairedUpper(76, 5, 5, 4, Z_ONE_SIDED_95);
    expect(k1).toBeGreaterThan(0.05);
    expect(k1).toBeLessThan(0.07);
    const k2 = newcombePairedUpper(152, 10, 10, 8, Z_ONE_SIDED_95);
    expect(k2).toBeGreaterThan(0.04);
    expect(k2).toBeLessThan(0.05);
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

describe("j-v1 schedule (k = 2)", () => {
  const prereg = committed();
  const schedule = jV1Schedule(prereg);

  it("runs every (task, arm, repeat) once, seq 0..359", () => {
    expect(prereg.runsPerTaskPerArm).toBe(2);
    expect(schedule).toHaveLength(4 * TASKS.length);
    expect(schedule.map((s) => s.seq)).toEqual(schedule.map((_, i) => i));
    const keys = new Set(schedule.map((s) => `${s.taskId}|${s.arm}|${s.rep}`));
    expect(keys.size).toBe(360);
    for (const id of TASKS)
      for (const arm of [J_BASELINE_ARM, J_CAPABILITY_ARM])
        for (const rep of [1, 2]) expect(keys.has(`${id}|${arm}|${rep}`)).toBe(true);
  });

  it("runs each task as one ABBA block, alternating ABBA / BAAB over task positions", () => {
    for (let t = 0; t < TASKS.length; t++) {
      const block = schedule.slice(4 * t, 4 * t + 4);
      expect(new Set(block.map((s) => s.taskId)).size).toBe(1);
      const [a, b, c, d] = block.map((s) => s.arm);
      expect(a).not.toBe(b);
      expect(b).toBe(c);
      expect(a).toBe(d);
      expect(block.map((s) => s.rep)).toEqual([1, 1, 2, 2]);
      if (t > 0) expect(a).not.toBe(schedule[4 * (t - 1)]?.arm);
    }
  });

  it("at k = 1 (option b) is the two-trial ABBA-over-task-pairs order", () => {
    const one = jV1Schedule(optionB());
    expect(one).toHaveLength(180);
    for (let t = 0; t < TASKS.length; t++) {
      const [x, y] = [one[2 * t], one[2 * t + 1]];
      expect(x?.taskId).toBe(y?.taskId);
      expect(x?.arm).not.toBe(y?.arm);
      expect([x?.rep, y?.rep]).toEqual([1, 1]);
      if (t > 0) expect(x?.arm).toBe(one[2 * t - 1]?.arm);
    }
    // Same seed, same task order and opener as k = 2.
    expect(one.filter((_, i) => i % 2 === 0).map((s) => s.taskId)).toEqual(
      schedule.filter((_, i) => i % 4 === 0).map((s) => s.taskId),
    );
  });

  it("is seeded: same seed same order, another seed another order, and not task-id order", () => {
    expect(jV1Schedule(prereg)).toEqual(schedule);
    const other = jV1Schedule({
      ...prereg,
      seeds: { ...prereg.seeds, assignment: "x".repeat(20) },
    });
    expect(other.map((s) => s.taskId)).not.toEqual(schedule.map((s) => s.taskId));
    const order = schedule.filter((_, i) => i % 4 === 0).map((s) => s.taskId);
    expect(order).not.toEqual([...TASKS].sort());
  });
});

describe("j-v1 analysis: refusals", () => {
  it("refuses a pack whose pre-registration hash does not match", () => {
    const p = committed();
    const r = run(p, rows(p), "0".repeat(64));
    expect(r.computed).toBe(false);
    expect(r.verdict).toBe("not-shown");
    expect(r.reasons[0]).toMatch(/^PREREG_HASH_MISMATCH/);
    expect(statusOf(r)).toEqual(["not-tested", "not-tested", "not-tested"]);
  });

  it("refuses a pack whose pre-registration was edited after the hash was taken", () => {
    const p = committed();
    const hash = preregHash(p);
    const edited = structuredClone(p);
    (edited.bar.sequence[0] as Record<string, unknown>).marginPoints = 7;
    expect(run(edited, rows(edited), hash).reasons[0]).toMatch(/^PREREG_HASH_MISMATCH/);
    // A pack recorded under k = 2 cannot be re-analysed as option (b), or the reverse.
    expect(run(optionB(), rows(optionB()), hash).reasons[0]).toMatch(/^PREREG_HASH_MISMATCH/);
  });

  it("refuses a pack with a missing, duplicated, unknown, out-of-range or mis-ordered trial", () => {
    const p = committed();
    const base = rows(p);
    expect(run(p, base.slice(1)).reasons).toEqual([
      expect.stringMatching(/^DESIGN_MISSING: seq 0 /),
    ]);
    expect(run(p, [...base, base[0]]).reasons).toEqual([
      expect.stringMatching(/^DESIGN_DUPLICATE: seq 0$/),
    ]);
    expect(
      run(p, [...base, { ...base[0], taskId: "fc-v1-091" }]).reasons.some((x) =>
        x.startsWith("DESIGN_UNKNOWN_TASK: fc-v1-091"),
      ),
    ).toBe(true);
    expect(
      run(p, [...base, { ...base[0], seq: 360 }]).reasons.some((x) =>
        x.startsWith("DESIGN_UNKNOWN_SEQ: 360"),
      ),
    ).toBe(true);
    const swapped = base.map((r) =>
      r.seq === 0 ? { ...r, seq: 1 } : r.seq === 1 ? { ...r, seq: 0 } : r,
    );
    const res = run(p, swapped);
    expect(res.computed).toBe(false);
    expect(res.reasons.filter((x) => x.startsWith("DESIGN_ORDER"))).toHaveLength(2);
  });

  it("refuses a k = 1 pack under the k = 2 pre-registration", () => {
    const res = run(committed(), rows(optionB()));
    expect(res.computed).toBe(false);
    expect(res.reasons.some((x) => x.startsWith("DESIGN_"))).toBe(true);
  });

  it("refuses malformed rows: extra field, steps over the budget, bad grade, inconsistent simulated flag", () => {
    const p = committed();
    const bad: Partial<Record<string, unknown>>[] = [
      { extra: 1 },
      { steps: 31 },
      { grade: "verified" },
      { simulated: true },
      { wallMs: -1 },
      { harnessFault: "" },
      { claim: "failure" },
      { seq: 1.5 },
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
        p.runsPerTaskPerArm = 3;
      },
      (p) => {
        p.runsPerTaskPerArm = 0;
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
      const p = structuredClone(committed());
      mutate(p);
      expect(preregProblems(p).length, mutate.toString()).toBeGreaterThan(0);
      const res = run(p, rows(committed()));
      expect(res.computed).toBe(false);
    }
    expect(preregProblems(committed())).toEqual([]);
    expect(preregProblems(optionB())).toEqual([]);
  });
});

describe("j-v1 analysis: the bar (k = 2)", () => {
  it("is shown when J is non-inferior, faster and uses fewer steps, and every row is a real model's", () => {
    const p = committed();
    const r = run(p, rows(p));
    expect(r.reasons).toEqual([]);
    expect(r.verdict).toBe("shown");
    expect(statusOf(r)).toEqual(["shown", "shown", "shown"]);
    expect(r.n).toBe(180);
    expect(r.tasks).toBe(90);
    expect(r.table).toEqual({ a: 180, b: 0, c: 0, d: 0 });
    expect(r.arms?.capability.trials).toBe(180);
    expect(r.bar[1]?.estimate).toBeCloseTo(40 / 90, 12);
    expect(r.bar[2]?.estimate).toBeCloseTo(4 / 9, 12);
  });

  it("is never shown while a lead ruling is pending", () => {
    const p = pending();
    const r = run(p, rows(p));
    expect(r.computed).toBe(true);
    expect(statusOf(r)).toEqual(["shown", "shown", "shown"]);
    expect(r.verdict).toBe("not-shown");
    expect(r.reasons).toEqual(["LEAD_RULING_PENDING: x"]);
  });

  it("is never shown on simulated rows, though the numbers are computed (plumbing)", () => {
    const p = committed();
    const r = run(
      p,
      rows(p, (_, arm) =>
        arm === J_CAPABILITY_ARM ? { plannerModelId: "scripted", simulated: true } : {},
      ),
    );
    expect(r.computed).toBe(true);
    expect(r.verdict).toBe("not-shown");
    expect(r.reasons).toContain("SIMULATED: 180 row(s); simulated rows are never evidence");
  });

  it("is never shown when a row's planner is not the pre-registered model", () => {
    const p = committed();
    const r = run(
      p,
      rows(p, (_, __, i, rep) =>
        i === 3 && rep === 2 ? { plannerModelId: "claude-opus-5-5" } : {},
      ),
    );
    expect(r.verdict).toBe("not-shown");
    expect(r.reasons.some((x) => x.startsWith("PLANNER_MISMATCH"))).toBe(true);
  });

  it("pairs repeat r with repeat r: failures on different repeats of a task are two discordant pairs", () => {
    const p = committed();
    const r = run(
      p,
      rows(p, (_, arm, i, rep) => {
        if (i !== 0) return {};
        if (arm === J_CAPABILITY_ARM && rep === 1) return { grade: "fail" };
        if (arm === J_BASELINE_ARM && rep === 2) return { grade: "fail" };
        return {};
      }),
    );
    expect(r.table).toEqual({ a: 178, b: 1, c: 1, d: 0 });
    expect(r.bar[0]?.estimate).toBe(0);
  });

  it("stops at component 1 when J verifies fewer trials: 2 and 3 are not tested", () => {
    const p = committed();
    const r = run(
      p,
      rows(p, (_, arm, i) => (arm === J_CAPABILITY_ARM && i < 10 ? { grade: "fail" } : {})),
    );
    expect(r.table).toEqual({ a: 160, b: 20, c: 0, d: 0 });
    expect(statusOf(r)).toEqual(["not-shown", "not-tested", "not-tested"]);
    expect(r.bar[0]?.upperBound).toBeGreaterThan(0.05);
    expect(r.bar[0]?.estimate).toBeCloseTo(20 / 180, 12);
    expect(r.verdict).toBe("not-shown");
  });

  it("uses the margin as a strict bound: just under 5 points is shown, the same data at a 4-point margin is not", () => {
    const p = committed();
    const data = rows(p, jFirstRep(4, { grade: "fail" }));
    const r = run(p, data);
    expect(r.table).toEqual({ a: 176, b: 4, c: 0, d: 0 });
    const ub = r.bar[0]?.upperBound as number;
    expect(ub).toBeGreaterThan(0.045);
    expect(ub).toBeLessThan(0.05);
    expect(r.bar[0]?.status).toBe("shown");
    const tight = structuredClone(p);
    (tight.bar.sequence[0] as Record<string, unknown>).marginPoints = 4;
    expect(run(tight, data).bar[0]?.status).toBe("not-shown");
  });

  it("follows the fixed sequence: a slower J stops at component 2 even with fewer steps", () => {
    const p = committed();
    const r = run(
      p,
      rows(p, (_, arm) => (arm === J_CAPABILITY_ARM ? { wallMs: 95_000 } : {})),
    );
    expect(statusOf(r)).toEqual(["shown", "not-shown", "not-tested"]);
    expect(r.bar[2]?.upperBound).toBeNull();
    expect(r.verdict).toBe("not-shown");
  });

  it("component 3 fails on its own when J is faster but takes more steps", () => {
    const p = committed();
    const r = run(
      p,
      rows(p, (_, arm) => (arm === J_CAPABILITY_ARM ? { steps: 12 } : {})),
    );
    expect(statusOf(r)).toEqual(["shown", "shown", "not-shown"]);
  });

  it("charges every trial's time to the ratio, failed trials and both repeats included", () => {
    // J: 170 verified fast trials and 10 failed slow ones. Over verified trials alone J looks
    // faster (40 s vs 90 s); over ALL trials J spends 170·40 + 10·900 s for 170 verified.
    const p = committed();
    const r = run(p, rows(p, jFirstRep(10, { grade: "fail", wallMs: 900_000 })));
    const point = r.bar[1]?.estimate as number;
    expect(point).toBeCloseTo((170 * 40_000 + 10 * 900_000) / 170 / 90_000, 12);
    expect(point).toBeGreaterThan(1);
  });

  it("a harness fault or boundary breach is counted in the denominator and never verified", () => {
    const p = committed();
    const r = run(
      p,
      rows(p, (_, arm, i, rep) => {
        if (arm !== J_CAPABILITY_ARM || rep !== 1) return {};
        if (i === 0) return { harnessFault: "UNRECORDED_ROUTE" };
        if (i === 1) return { boundaryBreach: true };
        return {};
      }),
    );
    const j = r.arms?.capability;
    expect(j?.trials).toBe(180);
    expect(j?.verified).toBe(178);
    expect(j?.harnessFaults).toEqual({ UNRECORDED_ROUTE: 1 });
    expect(j?.boundaryBreaches).toBe(1);
    expect(r.reasons).toContain("GUARDRAIL_BOUNDARY_BREACH: 1 trial(s)");
    expect(r.verdict).toBe("not-shown");
  });

  it("a harness fault alone is not a guardrail breach (it is counted, not voiding the bar)", () => {
    const p = committed();
    const r = run(p, rows(p, jFirstRep(1, { harnessFault: "UNRECORDED_ROUTE" })));
    expect(r.reasons.some((x) => x.startsWith("GUARDRAIL"))).toBe(false);
    expect(r.arms?.capability.verified).toBe(179);
  });

  it("reports false done and ungraded trials, and a pass without a done claim is not verified", () => {
    const p = committed();
    const r = run(
      p,
      rows(p, (_, arm, i, rep) => {
        if (arm !== J_BASELINE_ARM || rep !== 1) return {};
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
    expect(b?.verified).toBe(176);
    expect(r.table).toEqual({ a: 176, b: 0, c: 4, d: 0 });
    expect(b?.verifiedRateWilson95[0]).toBeLessThan(b?.verifiedRate as number);
  });

  it("an arm with no verified trial gives no per-verified figure and an infinite bound", () => {
    const p = committed();
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
    const p = committed();
    const data = rows(p, (_, arm, i, rep) =>
      arm === J_CAPABILITY_ARM ? { wallMs: 30_000 + 997 * i + 13 * rep } : {},
    );
    expect(run(p, data)).toEqual(run(p, data));
  });
});

describe("j-v1 analysis: option (b) fallback (7-point margin, k = 1)", () => {
  it("analyses a k = 1 pack with n = 90 pairs and the 7-point margin", () => {
    const p = optionB();
    const ok = run(p, rows(p));
    expect(ok.verdict).toBe("shown");
    expect(ok.n).toBe(90);
    expect(ok.bar[0]?.threshold).toBe(0.07);
    // Equality with ~11% discordant: about 6.2 points, under 7 (it fails the 5-point margin).
    const equal = run(
      p,
      rows(p, (_, arm, i) => {
        if (i < 5) return arm === J_CAPABILITY_ARM ? { grade: "fail" } : {};
        if (i < 10) return arm === J_BASELINE_ARM ? { grade: "fail" } : {};
        if (i < 14) return { grade: "fail" };
        return {};
      }),
    );
    expect(equal.table).toEqual({ a: 76, b: 5, c: 5, d: 4 });
    expect(equal.bar[0]?.upperBound).toBeGreaterThan(0.05);
    expect(equal.bar[0]?.status).toBe("shown");
  });
});
