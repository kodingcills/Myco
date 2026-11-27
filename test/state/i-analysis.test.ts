/**
 * Track I pre-registered analysis (capability spec §1.5, §2 I, §3): verified is a done claim
 * the grader passed; the fixed sequence; the refusals that make the bar "not shown". Every
 * pack here is synthetic: no trial was run.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  analyzeIPack,
  bootstrapRatioUpper95,
  I_PACK_SCHEMA,
  type IAnalysisContext,
  type IPack,
  type ITrialRow,
  mcnemarOneSidedP,
  type PairedTask,
  verified,
  wilson95,
} from "../../src/state/i-analysis.ts";
import { gitPreregHashAt, main, readTaskFacts } from "../../src/state/i-analysis-cli.ts";
import { type IArm, loadIPrereg } from "../../src/state/prereg.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const { prereg, hash } = loadIPrereg(ROOT);
const tasks = readTaskFacts(ROOT, prereg.taskSet.tasksFile);
const sat = tasks.filter((t) => t.satisfiable);
const COMMIT = "abcdef1234567";
const ctx: IAnalysisContext = {
  prereg,
  preregSha256: hash,
  tasks,
  preregHashAtCommit: (c) => (c === COMMIT ? hash : null),
};

type Outcome = Pick<ITrialRow, "claim" | "grade" | "steps">;
const PASS: Outcome = { claim: "done", grade: "pass", steps: 12 };
const FAIL: Outcome = { claim: "done", grade: "fail", steps: 20 };

/** A full pack: `cap(i)` / `base(i)` give the i-th satisfiable task's outcome per arm. */
function pack(
  cap: (i: number) => Outcome,
  base: (i: number) => Outcome,
  over: Partial<ITrialRow> = {},
): IPack {
  const rows: ITrialRow[] = [];
  for (const t of tasks) {
    const i = sat.findIndex((s) => s.taskId === t.taskId);
    for (const arm of ["C1+I", "C1"] as IArm[]) {
      const o: Outcome = !t.satisfiable
        ? { claim: "not-done", grade: "pass", steps: 8 }
        : arm === "C1+I"
          ? cap(i)
          : base(i);
      rows.push({
        arm,
        taskId: t.taskId,
        simulated: false,
        plannerModelId: prereg.modelId,
        toolOutputBreach: false,
        ...o,
        ...over,
      });
    }
  }
  return { schema: I_PACK_SCHEMA, preregSha256: hash, preregCommit: COMMIT, rows };
}

/** C1+I verifies the first `wins` tasks C1 fails; both verify the rest equally. */
const winning = (wins: number, capSteps = 10, baseSteps = 15) =>
  pack(
    (i) => ({ ...(i < 60 ? PASS : FAIL), steps: capSteps }),
    (i) => ({ ...(i < wins || i >= 60 ? FAIL : PASS), steps: baseSteps }),
  );

describe("exact one-sided McNemar: the spec's §1.5 critical values", () => {
  const table: [number, number | null][] = [
    [4, null],
    [5, 5],
    [6, 6],
    [8, 7],
    [10, 9],
    [12, 10],
    [15, 12],
    [20, 15],
  ];
  for (const [d, crit] of table)
    it(`d = ${d}`, () => {
      if (crit === null) expect(mcnemarOneSidedP(d, 0)).toBeGreaterThan(0.05);
      else {
        expect(mcnemarOneSidedP(crit, d - crit)).toBeLessThanOrEqual(0.05);
        expect(mcnemarOneSidedP(crit - 1, d - crit + 1)).toBeGreaterThan(0.05);
      }
    });
  it("matches the spec's printed p values", () => {
    expect(mcnemarOneSidedP(5, 0)).toBeCloseTo(0.0313, 3);
    expect(mcnemarOneSidedP(9, 1)).toBeCloseTo(0.0107, 3);
    expect(mcnemarOneSidedP(15, 5)).toBeCloseTo(0.0207, 3);
    expect(mcnemarOneSidedP(0, 0)).toBe(1);
    expect(() => mcnemarOneSidedP(-1, 2)).toThrow();
  });
});

describe("wilson95", () => {
  it("matches a known interval", () => {
    const w = wilson95(45, 90);
    expect(w.lo).toBeCloseTo(0.3989, 3);
    expect(w.hi).toBeCloseTo(0.6011, 3);
  });
});

describe("verified (gate-less rows)", () => {
  it("is a done claim the grader passed, nothing else", () => {
    expect(verified({ claim: "done", grade: "pass" })).toBe(true);
    expect(verified({ claim: "not-done", grade: "pass" })).toBe(false);
    expect(verified({ claim: "no-claim", grade: "pass" })).toBe(false);
    expect(verified({ claim: "done", grade: "ungradable" })).toBe(false);
    expect(verified({ claim: "done", grade: null })).toBe(false);
  });
});

describe("analyzeIPack: the fixed sequence", () => {
  it("shows both components when C1+I verifies more with fewer steps", () => {
    const a = analyzeIPack(winning(10), ctx);
    expect(a.refusals).toEqual([]);
    expect(a.components[0]).toMatchObject({ id: 1, shown: true, favouring: 10, against: 0 });
    expect(a.components[1]).toMatchObject({ id: 2, shown: true });
    expect(a.barShown).toBe(true);
    expect(a.satisfiable.cap.verified).toBe(60);
    expect(a.satisfiable.base.verified).toBe(50);
  });

  it("bar 2 is not shown when C1+I spends more steps per verified task", () => {
    const a = analyzeIPack(winning(10, 25, 10), ctx);
    expect(a.components[0]?.shown).toBe(true);
    expect(a.components[1]).toMatchObject({ shown: false });
    expect(a.barShown).toBe(false);
  });

  it("underpowered below 5 discordant tasks, and bar 2 is then never tested", () => {
    const a = analyzeIPack(winning(4), ctx);
    expect(a.components[0]).toMatchObject({ shown: false, discordant: 4 });
    expect(a.components[0]?.reason).toMatch(/underpowered at n: 4 discordant/);
    expect(a.components[1]).toMatchObject({
      shown: false,
      reason: "bar 1 not shown",
      upper95: null,
    });
  });

  it("a pass without a done claim does not count for C1+I", () => {
    const p = pack(
      (i) => (i < 10 ? { claim: "not-done", grade: "pass", steps: 10 } : PASS),
      (i) => (i < 10 ? FAIL : PASS),
    );
    expect(analyzeIPack(p, ctx).components[0]).toMatchObject({ favouring: 0, shown: false });
  });

  it("bar 2 is not shown when steps are unmeasured", () => {
    const p = winning(10);
    const rows = p.rows.map((r, i) => (i === 0 ? { ...r, steps: null } : r));
    const a = analyzeIPack({ ...p, rows }, ctx);
    expect(a.components[1]).toMatchObject({ shown: false, reason: "steps unmeasured" });
  });
});

describe("analyzeIPack: refusals make the whole bar not shown, even on a winning pack", () => {
  const cases: [string, (p: IPack) => IPack, RegExp][] = [
    ["hash mismatch", (p) => ({ ...p, preregSha256: "0".repeat(64) }), /hash does not match/],
    ["commit without it", (p) => ({ ...p, preregCommit: "1111111" }), /commit does not hold/],
    ["schema", (p) => ({ ...p, schema: "x" as typeof I_PACK_SCHEMA }), /pack schema/],
    ["one simulated row", (p) => rowEdit(p, 3, { simulated: true }), /simulated row/],
    [
      "a simulated planner label",
      (p) => rowEdit(p, 3, { plannerModelId: "simulated:x" }),
      /simulated row/,
    ],
    [
      "another model",
      (p) => rowEdit(p, 3, { plannerModelId: "claude-other-1" }),
      /pre-registered model/,
    ],
    ["steps over budget", (p) => rowEdit(p, 3, { steps: 31 }), /steps outside/],
    ["tool-output breach", (p) => rowEdit(p, 3, { toolOutputBreach: true }), /breach/],
    ["missing trial", (p) => ({ ...p, rows: p.rows.slice(1) }), /missing trial/],
    ["duplicate trial", (p) => ({ ...p, rows: [...p.rows, p.rows[0] as ITrialRow] }), /duplicate/],
    ["foreign task", (p) => rowEdit(p, 0, { taskId: "xa-v1-001" }), /not an fc-v1 task/],
  ];
  for (const [name, change, want] of cases)
    it(name, () => {
      const a = analyzeIPack(change(winning(10)), ctx);
      expect(a.refusals.join("; ")).toMatch(want);
      expect(a.barShown).toBe(false);
      expect(a.components[0]?.shown).toBe(false);
    });

  it("guardrail: more false DONEs on invalid-target tasks in C1+I", () => {
    const p = winning(10);
    const inv = new Set(tasks.filter((t) => !t.satisfiable).map((t) => t.taskId));
    const rows = p.rows.map((r) =>
      inv.has(r.taskId) && r.arm === "C1+I"
        ? { ...r, claim: "done" as const, grade: "fail" as const }
        : r,
    );
    const a = analyzeIPack({ ...p, rows }, ctx);
    expect(a.invalidTarget).toEqual({ capFalseDone: 10, baseFalseDone: 0 });
    expect(a.refusals.join(";")).toMatch(/guardrail/);
    expect(a.barShown).toBe(false);
  });
});

function rowEdit(p: IPack, i: number, over: Partial<ITrialRow>): IPack {
  return { ...p, rows: p.rows.map((r, j) => (j === i ? { ...r, ...over } : r)) };
}

describe("bootstrapRatioUpper95", () => {
  const paired: PairedTask[] = Array.from({ length: 90 }, (_, i) => ({
    taskId: `t${i}`,
    cap: { verified: i % 3 !== 0, steps: 10 + (i % 7) },
    base: { verified: i % 2 === 0, steps: 14 + (i % 5) },
  }));
  it("is deterministic under the seed and bounds the point estimate from above", () => {
    const a = bootstrapRatioUpper95(paired, "seed-aaaaaaaa", 2000);
    expect(bootstrapRatioUpper95(paired, "seed-aaaaaaaa", 2000)).toEqual(a);
    expect(a.upper95).toBeGreaterThanOrEqual(a.point);
    expect(bootstrapRatioUpper95(paired, "seed-bbbbbbbb", 2000).upper95).not.toBe(a.upper95);
  });
  it("is +Infinity when the capability verifies nothing", () => {
    const none = paired.map((t) => ({ ...t, cap: { ...t.cap, verified: false } }));
    expect(bootstrapRatioUpper95(none, "seed-aaaaaaaa", 100).upper95).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("the analysis CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "i-analysis-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(args, ROOT, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
    return { code, out: out.join(""), err: err.join("") };
  };
  it("exits 2 on bad usage or an unreadable pack", () => {
    expect(run([]).code).toBe(2);
    expect(run(["--help"]).code).toBe(2);
    expect(run([join(dir, "missing.json")]).code).toBe(2);
  });
  it("exits 1 and prints the refusal for a pack whose commit does not hold the pre-registration", () => {
    const f = join(dir, "pack.json");
    writeFileSync(f, JSON.stringify({ ...winning(10), preregCommit: "0000000" }));
    const r = run([f]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).refusals.join(";")).toMatch(/commit does not hold/);
  });
  it("gitPreregHashAt refuses non-hex and unknown commits", () => {
    expect(gitPreregHashAt(ROOT, "HEAD; rm -rf /")).toBeNull();
    expect(gitPreregHashAt(ROOT, "0000000")).toBeNull();
  });
});
