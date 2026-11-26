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

/**
 * All 120 cells of one arm; the first `passed` cells pass, the rest get `rest`. A myco-arm
 * trial carries a gate verdict consistent with its grade unless `extra` overrides it.
 */
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
      const grade: XaGrade = i < passed ? "pass" : rest;
      const verdict: Partial<XaBarTrial> =
        which === "myco" ? { gateVerdict: grade === "pass" ? "verified" : "refuted" } : {};
      out.push({ arm: which, taskId, repetition, grade, ...verdict, ...extra });
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
    // Round 3: the frozen ids and the required verdicts are stated; unbacked claims are gone.
    expect(bar).toContain("XA_BAR.taskIds");
    expect(bar).toMatch(/Every myco-arm trial must carry its gate verdict/);
    expect(bar).not.toMatch(/topped-up-run rule/);
    expect(bar).toMatch(/Cost \(not computed by `cross-app-bar\.ts`\)/);
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
    const r = evaluateXaBar([...arm("baseline", 60), ...arm("myco", 90)]);
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
    const r = evaluateXaBar([...arm("baseline", 60), ...arm("myco", 72)]);
    expect(r.difference).toBeCloseTo(0.1, 10);
    expect(r.decision).toBe("fail");
    expect(r.reasons).toEqual(["the 95% Newcombe interval on the difference does not exclude 0"]);
  });

  it("fails when the interval excludes 0 but the difference is below the margin", () => {
    const r = evaluateXaBar([...arm("baseline", 0), ...arm("myco", 9)]);
    expect(r.differenceInterval?.[0]).toBeGreaterThan(0);
    expect(r.decision).toBe("fail");
    expect(r.reasons).toEqual(["the observed difference is below the 0.1 margin"]);
  });

  it("a difference of exactly the margin, with the interval above 0, passes", () => {
    const r = evaluateXaBar([...arm("baseline", 0), ...arm("myco", 12)]);
    expect(r.decision).toBe("pass");
  });

  it("one false-verified trial in the myco arm fails the bar outright", () => {
    const myco = arm("myco", 110);
    myco[119] = { ...(myco[119] as XaBarTrial), grade: "fail", gateVerdict: "verified" };
    const r = evaluateXaBar([...arm("baseline", 20), ...myco]);
    expect(r.decision).toBe("fail");
    expect(r.falseVerified).toBe(1);
    expect(r.falseVerifiedUpper95).toBeUndefined();
    expect(r.reasons).toEqual(["1 false-verified trial(s) in the myco arm"]);
  });

  it("an ungradable trial the gate verified is also false-verified", () => {
    const myco = arm("myco", 110);
    myco[119] = { ...(myco[119] as XaBarTrial), grade: "ungradable", gateVerdict: "verified" };
    expect(evaluateXaBar([...arm("baseline", 20), ...myco]).falseVerified).toBe(1);
  });

  it("the primary metric is the grade alone: the gate's verdict never changes a pass rate", () => {
    const myco = arm("myco", 90, { gateVerdict: "refuted" });
    const baseline = arm("baseline", 60, { gateVerdict: "verified" }, "ungradable");
    const r = evaluateXaBar([...baseline, ...myco]);
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
    expect(evaluateXaBar(full()).decision).toBe("pass");
  });

  it("a missing cell", () => {
    const r = evaluateXaBar(full().slice(0, -1));
    expect(r.decision).toBe("incomplete");
    expect(r.reasons).toContain(`myco: ${TASK_IDS[11]} repetition 10 ran 0 times`);
  });

  it("a repeated cell (a re-run counted twice)", () => {
    const trials = full();
    trials.push(trials[trials.length - 1] as XaBarTrial);
    expect(evaluateXaBar(trials).decision).toBe("incomplete");
  });

  it("a task outside xa-v1, or a repetition out of range", () => {
    const a = full();
    a[0] = { ...(a[0] as XaBarTrial), taskId: "xa-v2-001" };
    expect(evaluateXaBar(a).decision).toBe("incomplete");
    const b = full();
    b[0] = { ...(b[0] as XaBarTrial), repetition: 11 };
    const rb = evaluateXaBar(b);
    expect(rb.decision).toBe("incomplete");
    expect(rb.reasons).toContain(`baseline: ${TASK_IDS[0]} repetition 11 is out of range`);
  });

  it("round-3 D3(a): the task set is the frozen xa-v1 list, never the caller's", () => {
    // Verifier probe P1: 12 invented ids, every cell filled, a clear improvement.
    const fake = Array.from({ length: 12 }, (_, i) => `fake-${i}`);
    const onFake = full().map((t, i) => ({ ...t, taskId: fake[i % 12] as string }));
    const r = evaluateXaBar(onFake);
    expect(r.decision).toBe("incomplete");
    expect(r.reasons).toContain("baseline: fake-0 is not in xa-v1");
    expect(r.reasons).toContain(`myco: ${TASK_IDS[0]} repetition 1 ran 0 times`);
    // A caller-supplied task list (the old second argument) is ignored at runtime.
    const evalAny = evaluateXaBar as unknown as (
      t: readonly XaBarTrial[],
      ids: string[],
    ) => {
      decision: string;
    };
    expect(evalAny(onFake, fake).decision).toBe("incomplete");
    // A run on only 11 of the 12 tasks is incomplete too.
    const eleven = full().filter((t) => t.taskId !== TASK_IDS[11]);
    expect(evaluateXaBar(eleven).decision).toBe("incomplete");
  });

  it("round-3 D3(a): the frozen ids are exactly the ids the pinned manifest hashes", () => {
    const dir = join(ROOT, "benchmark/cross-app/xa-v1");
    const manifestBytes = readFileSync(join(dir, "manifest.json"));
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(XA_BAR.manifestSha256);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      taskSetVersion: string;
      tasks: number;
      files: Record<string, string>;
    };
    const jsonl = readFileSync(join(dir, "tasks.jsonl"));
    expect(createHash("sha256").update(jsonl).digest("hex")).toBe(manifest.files["tasks.jsonl"]);
    const ids = jsonl
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as { taskId: string }).taskId);
    expect(XA_BAR.taskIds).toEqual(ids);
    expect(XA_BAR.taskIds).toEqual(TASK_IDS);
    expect(manifest.taskSetVersion).toBe(XA_BAR.taskSet);
    expect(manifest.tasks).toBe(XA_BAR.tasks);
    expect(Object.isFrozen(XA_BAR.taskIds)).toBe(true);
  });

  it("round-3 D3(b): a myco-arm trial without a gate verdict makes the run incomplete", () => {
    // Verifier probe P2: no gate verdict anywhere in the myco arm.
    const bare = full().map((t) => {
      if (t.arm !== "myco") return t;
      const { gateVerdict: _drop, ...rest } = t;
      return rest as XaBarTrial;
    });
    const r = evaluateXaBar(bare);
    expect(r.decision).toBe("incomplete");
    expect(r.falseVerified).toBeUndefined();
    expect(r.falseVerifiedUpper95).toBeUndefined();
    expect(r.reasons).toContain(`myco: ${TASK_IDS[0]} repetition 1 has no gate verdict`);
    // One missing verdict is enough.
    const one = full();
    const last = one.length - 1;
    const { gateVerdict: _v, ...noVerdict } = one[last] as XaBarTrial;
    one[last] = noVerdict as XaBarTrial;
    expect(evaluateXaBar(one).decision).toBe("incomplete");
    // The baseline arm needs none (control: `full()` has no baseline verdicts and passes).
    expect(
      full()
        .filter((t) => t.arm === "baseline")
        .every((t) => !t.gateVerdict),
    ).toBe(true);
  });

  it("round-3 D3(b): an unknown verdict, grade or arm is never read as a value", () => {
    // "Verified" is not "verified": read loosely it would hide a false-verified trial.
    const v = full();
    const last = v.length - 1;
    v[last] = { ...(v[last] as XaBarTrial), grade: "fail", gateVerdict: "Verified" as "verified" };
    expect(evaluateXaBar(v).decision).toBe("incomplete");
    // A mis-spelled baseline grade would otherwise lower the baseline rate.
    const g = full();
    g[0] = { ...(g[0] as XaBarTrial), grade: "PASS" as XaGrade };
    const rg = evaluateXaBar(g);
    expect(rg.decision).toBe("incomplete");
    expect(rg.reasons).toContain(`baseline: ${TASK_IDS[0]} repetition 1 has no valid grade`);
    const a = full();
    a[0] = { ...(a[0] as XaBarTrial), arm: "Baseline" as XaArm };
    expect(evaluateXaBar(a).reasons).toContain("unknown arm Baseline");
  });
});
