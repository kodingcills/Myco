/**
 * Track I pre-registered analysis (capability spec §1.5, §2 I, §3): verified is a done claim
 * the grader passed; the fixed sequence; the refusals that make the bar "not shown". Every
 * pack here is synthetic: no trial was run.
 */
import { spawnSync } from "node:child_process";
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
  LEAD_RULING_PENDING,
  mcnemarOneSidedP,
  type PairedTask,
  pendingLeadRulings,
  rowShapeProblem,
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
/** The committed pre-registration, which still has pending lead rulings. */
const committedCtx: IAnalysisContext = {
  prereg,
  preregSha256: hash,
  tasks,
  preregHashAtCommit: (c) => (c === COMMIT ? hash : null),
};
/**
 * A HYPOTHETICAL ratified copy (no pending lead ruling), so the bar logic itself can be
 * exercised. Nothing here claims the lead ruled.
 */
const ctx: IAnalysisContext = { ...committedCtx, prereg: { ...prereg, leadRulingPending: [] } };

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

describe("analyzeIPack: never shown while a lead ruling is pending", () => {
  it("the committed pre-registration has pending rulings, so a winning pack is LEAD_RULING_PENDING", () => {
    expect(prereg.leadRulingPending.length).toBeGreaterThan(0);
    const a = analyzeIPack(winning(10), committedCtx);
    expect(a.status).toBe(LEAD_RULING_PENDING);
    expect(a.barShown).toBe(false);
    expect(a.leadRulingPending).toEqual(prereg.leadRulingPending);
    expect(a.components[0]).toMatchObject({ shown: false, reason: LEAD_RULING_PENDING });
    expect(a.components[1]).toMatchObject({ shown: false });
    // The pack itself is clean: pending is not a refusal of the pack.
    expect(a.refusals).toEqual([]);
  });
  it("one pending ruling is enough", () => {
    const one = { ...ctx, prereg: { ...prereg, leadRulingPending: ["modelId"] } };
    const a = analyzeIPack(winning(10), one);
    expect(a.status).toBe(LEAD_RULING_PENDING);
    expect(a.barShown).toBe(false);
  });
  it("a leadRulingPending that is not a list of strings counts as pending (fail closed)", () => {
    for (const bad of [undefined, null, "none", [1], {}]) {
      const c = { ...ctx, prereg: { ...prereg, leadRulingPending: bad as never } };
      const a = analyzeIPack(winning(10), c);
      expect(a.status).toBe(LEAD_RULING_PENDING);
      expect(a.barShown).toBe(false);
      expect(pendingLeadRulings(c.prereg)).toEqual(["leadRulingPending is not a list of strings"]);
    }
  });
  it("pending wins over a refusal too", () => {
    const a = analyzeIPack(rowEdit(winning(10), 0, { toolOutputBreach: true }), committedCtx);
    expect(a.status).toBe(LEAD_RULING_PENDING);
    expect(a.refusals.join(";")).toMatch(/breach/);
  });
});

describe("analyzeIPack: the fixed sequence (hypothetical ratified pre-registration)", () => {
  it("shows both components when C1+I verifies more with fewer steps", () => {
    const a = analyzeIPack(winning(10), ctx);
    expect(a.refusals).toEqual([]);
    expect(a.components[0]).toMatchObject({ id: 1, shown: true, favouring: 10, against: 0 });
    expect(a.components[1]).toMatchObject({ id: 2, shown: true });
    expect(a.barShown).toBe(true);
    expect(a.status).toBe("shown");
    expect(a.leadRulingPending).toEqual([]);
    expect(a.satisfiable.cap.verified).toBe(60);
    expect(a.satisfiable.base.verified).toBe(50);
  });

  it("bar 2's metric is total steps over ALL satisfiable trials per verified task (hand-computed)", () => {
    // C1+I: 90 trials x 10 steps / 60 verified = 15; C1: 90 x 15 / 50 = 27; ratio 15/27.
    // Counting steps over verified trials only would give 600/60 / (750/50) = 10/15 instead.
    const a = analyzeIPack(winning(10, 10, 15), ctx);
    expect(a.satisfiable.cap.stepsPerVerified).toBe(15);
    expect(a.satisfiable.base.stepsPerVerified).toBe(27);
    const c2 = a.components[1] as { point: number; upper95: number };
    expect(c2.point).toBeCloseTo(15 / 27, 12);
    expect(c2.upper95).toBeGreaterThanOrEqual(c2.point);
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
      "a row with no simulated field (fail closed)",
      (p) => rowDrop(p, 3, "simulated"),
      /simulated row/,
    ],
    [
      'simulated: "false" (a string)',
      (p) => rowEdit(p, 3, { simulated: "false" as never }),
      /simulated row/,
    ],
    ["simulated: 0", (p) => rowEdit(p, 3, { simulated: 0 as never }), /simulated row/],
    [
      "a row with no plannerModelId (named, not a TypeError)",
      (p) => rowDrop(p, 3, "plannerModelId"),
      /row 3: malformed \(plannerModelId is not a string\)/,
    ],
    [
      "a row with a bad claim",
      (p) => rowEdit(p, 3, { claim: "claimed" as never }),
      /row 3: malformed \(claim/,
    ],
    [
      "a row whose breach flag is not a boolean",
      (p) => rowDrop(p, 3, "toolOutputBreach"),
      /row 3: malformed \(toolOutputBreach/,
    ],
    ["rows not a list", (p) => ({ ...p, rows: {} as never }), /rows is not a list/],
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
function rowDrop(p: IPack, i: number, field: keyof ITrialRow): IPack {
  const rows = p.rows.map((r, j) => {
    if (j !== i) return r;
    const copy: Record<string, unknown> = { ...r };
    delete copy[field];
    return copy as unknown as ITrialRow;
  });
  return { ...p, rows };
}

describe("analyzeIPack: the task facts must split 90 / 10", () => {
  it("refuses when one invalid-target task is read as satisfiable", () => {
    const firstInvalid = tasks.findIndex((t) => !t.satisfiable);
    const skewed = tasks.map((t, i) => (i === firstInvalid ? { ...t, satisfiable: true } : t));
    const a = analyzeIPack(winning(10), { ...ctx, tasks: skewed });
    expect(a.refusals.join(";")).toMatch(/task facts do not split 90 satisfiable \/ 10/);
    expect(a.barShown).toBe(false);
  });
});

describe("rowShapeProblem", () => {
  it("accepts a well-formed row and names the first bad field", () => {
    const ok = winning(10).rows[0];
    expect(rowShapeProblem(ok)).toBeNull();
    expect(rowShapeProblem(null)).toBe("row is not an object");
    expect(rowShapeProblem({ ...ok, steps: "3" })).toMatch(/steps/);
    expect(rowShapeProblem({ ...ok, grade: "PASS" })).toMatch(/grade/);
    expect(rowShapeProblem({ ...ok, taskId: 1 })).toMatch(/taskId/);
    expect(rowShapeProblem({ ...ok, arm: null })).toMatch(/arm/);
  });
});

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
  it("has no --require-r1 or --evidence mode: either flag exits 2 before any analysis", () => {
    const f = join(dir, "flags.json");
    writeFileSync(f, JSON.stringify(winning(10)));
    for (const flag of ["--require-r1", "--evidence"]) {
      const r = run([flag, f]);
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
      expect(run([flag]).code).toBe(2);
    }
  });
  it("exits 3 (LEAD_RULING_PENDING), never 0, for a winning pack at a commit that holds the pre-registration", () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    const commit = head.stdout.trim();
    // HEAD holds the committed pre-registration (true at any committed head of this branch).
    expect(gitPreregHashAt(ROOT, commit)).toBe(hash);
    const f = join(dir, "winning.json");
    writeFileSync(f, JSON.stringify({ ...winning(10), preregCommit: commit }));
    const r = run([f]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/LEAD_RULING_PENDING/);
    const out = JSON.parse(r.out);
    expect(out.status).toBe(LEAD_RULING_PENDING);
    expect(out.barShown).toBe(false);
    expect(out.refusals).toEqual([]);
    expect(out.leadRulingPending.length).toBeGreaterThan(0);
  });
  it("a row with no plannerModelId is a named refusal, not a crash (exit 3, not 2)", () => {
    const f = join(dir, "noplanner.json");
    writeFileSync(f, JSON.stringify(rowDrop(winning(10), 3, "plannerModelId")));
    const r = run([f]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).refusals.join(";")).toMatch(/plannerModelId is not a string/);
  });
  it("exits non-zero and prints the refusal for a pack whose commit does not hold the pre-registration", () => {
    const f = join(dir, "pack.json");
    writeFileSync(f, JSON.stringify({ ...winning(10), preregCommit: "0000000" }));
    const r = run([f]);
    // 3 while lead rulings are pending (status wins); the refusal is printed either way.
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).refusals.join(";")).toMatch(/commit does not hold/);
  });
  it("gitPreregHashAt refuses non-hex and unknown commits", () => {
    expect(gitPreregHashAt(ROOT, "HEAD; rm -rf /")).toBeNull();
    expect(gitPreregHashAt(ROOT, "0000000")).toBeNull();
  });
});
