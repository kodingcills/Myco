/**
 * Capability track P (tier 2), round-2 D1: the cross-app measurement bar is concrete and
 * executable. Every number the docs state (task set digest, n per arm, test, margin,
 * decision rule, false-verified rule) is pinned here against `src/benchmark/cross-app-bar.ts`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateXaBar,
  newcombeDifference,
  XA_BAR,
  type XaArm,
  type XaBarTrial,
  type XaGrade,
} from "../../src/benchmark/cross-app-bar.ts";
import { wilson } from "../../src/foundry/stats.ts";
import { buildXaTaskSet } from "../../src/tasks/cross-app-taskset.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const TASK_IDS = buildXaTaskSet().tasks.map((t) => t.taskId);

/** All 120 cells of one arm; the first `passed` cells pass, the rest get `rest`. */
function arm(
  which: XaArm,
  passed: number,
  extra: Partial<XaBarTrial> = {},
  rest: XaGrade = "fail",
): XaBarTrial[] {
  const out: XaBarTrial[] = [];
  let i = 0;
  for (let repetition = 1; repetition <= XA_BAR.repetitions; repetition++)
    for (const taskId of TASK_IDS) {
      out.push({ arm: which, taskId, repetition, grade: i < passed ? "pass" : rest, ...extra });
      i++;
    }
  return out;
}

describe("the pre-registered design", () => {
  it("pins xa-v1 by its committed manifest digest, 12 tasks x 10 repetitions = 120 per arm", () => {
    const manifest = readFileSync(join(ROOT, "benchmark/cross-app/xa-v1/manifest.json"));
    expect(createHash("sha256").update(manifest).digest("hex")).toBe(XA_BAR.manifestSha256);
    expect(TASK_IDS).toHaveLength(XA_BAR.tasks);
    expect(XA_BAR.perArm).toBe(XA_BAR.tasks * XA_BAR.repetitions);
    expect(XA_BAR.perArm).toBe(120);
    expect(XA_BAR.margin).toBe(0.1);
  });

  it("the docs state the same bar the code enforces", () => {
    const doc = readFileSync(join(ROOT, "docs/gate/cross-app.md"), "utf8");
    const bar = doc.slice(doc.indexOf("## Measurement bar"), doc.indexOf("## Limits"));
    expect(bar).toContain(XA_BAR.manifestSha256);
    expect(bar).toContain("12 tasks x 10 repetitions = 120 trials per arm");
    expect(bar).toContain("Newcombe");
    expect(bar).toContain("margin of 0.10");
    expect(bar).toContain("src/benchmark/cross-app-bar.ts");
    expect(bar).not.toMatch(/margin\s+pre-registered before the run/);
  });
});

describe("Newcombe hybrid-score interval (method 10)", () => {
  it("reproduces Newcombe (1998) example: 56/70 vs 48/80 -> (0.0524, 0.3339)", () => {
    const [low, high] = newcombeDifference(56, 70, 48, 80);
    expect(low).toBeCloseTo(0.0524, 4);
    expect(high).toBeCloseTo(0.3339, 4);
  });

  it("refuses an empty arm", () => {
    expect(() => newcombeDifference(0, 0, 1, 2)).toThrow();
  });
});

describe("the decision rule", () => {
  it("passes a clear improvement with zero false-verified, and reports the zero-event bound", () => {
    const r = evaluateXaBar([...arm("baseline", 60), ...arm("myco", 90)], TASK_IDS);
    expect(r.decision).toBe("pass");
    expect(r.reasons).toEqual([]);
    expect(r.difference).toBeCloseTo(0.25, 10);
    expect(r.differenceInterval?.[0]).toBeGreaterThan(0);
    expect(r.falseVerified).toBe(0);
    expect(r.falseVerifiedUpper95).toBeCloseTo(1 - 0.05 ** (1 / 120), 12);
    expect(r.falseVerifiedUpper95).toBeLessThan(0.025);
    // Each arm's rate carries its denominator and Wilson 95% interval.
    expect(r.baseline).toEqual({ n: 120, passed: 60, rate: 0.5, interval: wilson(60, 120) });
    expect(r.myco).toEqual({ n: 120, passed: 90, rate: 0.75, interval: wilson(90, 120) });
  });

  it("fails when the difference meets the margin but the interval includes 0", () => {
    const r = evaluateXaBar([...arm("baseline", 60), ...arm("myco", 72)], TASK_IDS);
    expect(r.difference).toBeCloseTo(0.1, 10);
    expect(r.decision).toBe("fail");
    expect(r.reasons).toEqual(["the 95% Newcombe interval on the difference does not exclude 0"]);
  });

  it("fails when the interval excludes 0 but the difference is below the margin", () => {
    const r = evaluateXaBar([...arm("baseline", 0), ...arm("myco", 9)], TASK_IDS);
    expect(r.differenceInterval?.[0]).toBeGreaterThan(0);
    expect(r.decision).toBe("fail");
    expect(r.reasons).toEqual(["the observed difference is below the 0.1 margin"]);
  });

  it("a difference of exactly the margin, with the interval above 0, passes", () => {
    const r = evaluateXaBar([...arm("baseline", 0), ...arm("myco", 12)], TASK_IDS);
    expect(r.decision).toBe("pass");
  });

  it("one false-verified trial in the myco arm fails the bar outright", () => {
    const myco = arm("myco", 110);
    myco[119] = { ...(myco[119] as XaBarTrial), grade: "fail", gateVerdict: "verified" };
    const r = evaluateXaBar([...arm("baseline", 20), ...myco], TASK_IDS);
    expect(r.decision).toBe("fail");
    expect(r.falseVerified).toBe(1);
    expect(r.falseVerifiedUpper95).toBeUndefined();
    expect(r.reasons).toEqual(["1 false-verified trial(s) in the myco arm"]);
  });

  it("an ungradable trial the gate verified is also false-verified", () => {
    const myco = arm("myco", 110);
    myco[119] = { ...(myco[119] as XaBarTrial), grade: "ungradable", gateVerdict: "verified" };
    expect(evaluateXaBar([...arm("baseline", 20), ...myco], TASK_IDS).falseVerified).toBe(1);
  });

  it("the primary metric is the grade alone: the gate's verdict never changes a pass rate", () => {
    const myco = arm("myco", 90, { gateVerdict: "refuted" });
    const baseline = arm("baseline", 60, { gateVerdict: "verified" }, "ungradable");
    const r = evaluateXaBar([...baseline, ...myco], TASK_IDS);
    expect(r.myco?.passed).toBe(90);
    expect(r.baseline?.passed).toBe(60);
    // A baseline verdict is ignored: the baseline arm has no gate, so no false-verified.
    expect(r.falseVerified).toBe(0);
    expect(r.decision).toBe("pass");
  });
});

describe("an incomplete design is never a pass", () => {
  const full = () => [...arm("baseline", 0), ...arm("myco", 120)];

  it("the complete design passes (control)", () => {
    expect(evaluateXaBar(full(), TASK_IDS).decision).toBe("pass");
  });

  it("a missing cell", () => {
    const r = evaluateXaBar(full().slice(0, -1), TASK_IDS);
    expect(r.decision).toBe("incomplete");
    expect(r.reasons).toContain(`myco: ${TASK_IDS[11]} repetition 10 ran 0 times`);
  });

  it("a repeated cell (a re-run counted twice)", () => {
    const trials = full();
    trials.push(trials[trials.length - 1] as XaBarTrial);
    expect(evaluateXaBar(trials, TASK_IDS).decision).toBe("incomplete");
  });

  it("a task outside xa-v1, or a repetition out of range", () => {
    const a = full();
    a[0] = { ...(a[0] as XaBarTrial), taskId: "xa-v2-001" };
    expect(evaluateXaBar(a, TASK_IDS).decision).toBe("incomplete");
    const b = full();
    b[0] = { ...(b[0] as XaBarTrial), repetition: 11 };
    const rb = evaluateXaBar(b, TASK_IDS);
    expect(rb.decision).toBe("incomplete");
    expect(rb.reasons).toContain(`baseline: ${TASK_IDS[0]} repetition 11 is out of range`);
  });

  it("a task set that is not 12 distinct tasks", () => {
    const short = evaluateXaBar(full(), TASK_IDS.slice(0, 11));
    expect(short.decision).toBe("incomplete");
    expect(short.reasons).toContain("the task set must name 12 distinct tasks");
    // Twelve ids with a repeat, and every trial on them, is still not the design.
    const repeated = [...TASK_IDS.slice(0, 11), TASK_IDS[0] as string];
    const onRepeated = full().filter((t) => t.taskId !== TASK_IDS[11]);
    expect(evaluateXaBar(onRepeated, repeated).reasons).toContain(
      "the task set must name 12 distinct tasks",
    );
  });
});
