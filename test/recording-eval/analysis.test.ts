/**
 * Track R analysis under r-v1: the grader decides VERIFIED, the R5 prerequisite gates the
 * primary, the false-accept and marker guardrails break the bar, every pack-integrity refusal
 * fires with its code, and simulated packs are never evidence. All packs here are synthetic.
 */
import { describe, expect, it } from "vitest";
import {
  analyseRPack,
  LEAD_RULING_PENDING,
  mcnemarOneSided,
  NOT_EVIDENCE_LABEL,
  R_ARM,
  R_ARMS,
  type RAnalysis,
  type RTrialRow,
  rV1Schedule,
  SIMULATED_LABEL,
  zeroEventUpper95,
} from "../../src/recording-eval/analysis.ts";
import { canonicalSha256 } from "../../src/recording-eval/canonical.ts";
import { buildPack, discordant, readManifest, readPrereg, recordingSha } from "./helpers.ts";

const MODEL = "claude-sonnet-5-5";
type Built = ReturnType<typeof buildPack>;
const run = (b: Built, evidence = true, markers: string[] = []) =>
  analyseRPack({ ...b, evidence, markers });
const analysed = (r: RAnalysis) => {
  if (r.status !== "analysed") throw new Error(`refused: ${r.codes.join(",")}`);
  return r;
};
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const codes = (r: RAnalysis) => (r.status === "refused" ? r.codes : []);

describe("statistics", () => {
  it("exact one-sided McNemar matches capability-spec 1.5's critical-value table", () => {
    expect(round4(mcnemarOneSided(5, 0))).toBe(0.0313);
    expect(round4(mcnemarOneSided(6, 0))).toBe(0.0156);
    expect(round4(mcnemarOneSided(7, 1))).toBe(0.0352);
    expect(round4(mcnemarOneSided(9, 1))).toBe(0.0107);
    expect(round4(mcnemarOneSided(10, 2))).toBe(0.0193);
    expect(round4(mcnemarOneSided(12, 3))).toBe(0.0176);
    expect(round4(mcnemarOneSided(15, 5))).toBe(0.0207);
    expect(mcnemarOneSided(0, 0)).toBe(1);
    // One-sided: the baseline winning never yields a small p.
    expect(mcnemarOneSided(0, 10)).toBe(1);
  });

  it("zero-event upper bound matches capability-spec-2 1.2 at n = 30", () => {
    expect(zeroEventUpper95(30)).toBeCloseTo(0.095, 4);
    expect(zeroEventUpper95(0)).toBeNull();
  });
});

describe("run order (assignment seed)", () => {
  const ids = readManifest().tasks.map((t) => t.taskId);
  const seed = (readPrereg().seeds as { assignment: string }).assignment;

  it("is deterministic, covers 0..89 once, keeps each task's arms back to back", () => {
    const a = rV1Schedule(seed, ids);
    expect([...a.entries()]).toEqual([...rV1Schedule(seed, ids).entries()]);
    expect([...a.values()].sort((x, y) => x - y)).toEqual(Array.from({ length: 90 }, (_, i) => i));
    for (const t of ids) {
      const [lo = -1, , hi = -1] = R_ARMS.map((arm) => a.get(`${t}|${arm}`) as number).sort(
        (x, y) => x - y,
      );
      expect(hi - lo).toBe(2);
      expect(lo % 3).toBe(0);
    }
  });

  it("balances the six arm orders (5 each over 30 tasks) and depends on the seed", () => {
    const a = rV1Schedule(seed, ids);
    const orders = new Map<string, number>();
    for (const t of ids) {
      const key = [...R_ARMS]
        .sort((x, y) => (a.get(`${t}|${x}`) as number) - (a.get(`${t}|${y}`) as number))
        .join(">");
      orders.set(key, (orders.get(key) ?? 0) + 1);
    }
    expect([...orders.values()]).toEqual([5, 5, 5, 5, 5, 5]);
    expect([...rV1Schedule(`${seed}x`, ids).entries()]).not.toEqual([...a.entries()]);
  });
});

describe("the grader decides VERIFIED; the derived gate never does", () => {
  it("evidence pack with 8 vs 1 discordant, every lead ruling made: primary shown, bar shown", () => {
    const b = buildPack({ ruled: true, planner: MODEL, outcome: discordant(8, 1, 3) });
    const r = analysed(run(b));
    expect(r.evidence).toBe(true);
    expect(r.label).toBeNull();
    expect(r.leadRulingPending).toBe(0);
    expect(r.primary).toMatchObject({
      capabilityOnly: 8,
      baselineOnly: 1,
      both: 3,
      discordant: 9,
      shown: true,
    });
    expect(r.primary?.pOneSided).toBeCloseTo(mcnemarOneSided(8, 1), 10);
    expect(r.barShown).toBe(true);
    expect(r.reading).toMatch(/^shown: hcu\+shell\+R better than hcu\+shell/);
    expect(r.preregHash).toBe(canonicalSha256(b.prereg));
    expect(r.secondary.rates).toEqual([
      expect.objectContaining({ arm: R_ARM, verified: 11, trials: 30 }),
      expect.objectContaining({ arm: "hcu+shell", verified: 4, trials: 30 }),
    ]);
  });

  it("derived gate VERIFIED but grader FAIL: not verified, counted as a false accept, bar not shown", () => {
    const b = buildPack({
      ruled: true,
      planner: MODEL,
      outcome: (i, arm) => {
        const base = discordant(8, 0)(i, arm);
        if (i === 20 && arm === R_ARM)
          return {
            grade: "fail",
            invocations: [
              {
                workflowId: "wf",
                recordingSha256: recordingSha("record-edit:name"),
                certified: true,
                refusal: null,
                gateVerdict: "verified",
              },
            ],
          };
        return base;
      },
    });
    const r = analysed(run(b));
    expect(r.secondary.rates[0]).toMatchObject({ verified: 8 });
    expect(r.guardrails.derivedFalseAccepts).toBe(1);
    expect(r.guardrails.zeroEventUpper95).toBeNull();
    expect(r.primary?.shown).toBe(true);
    expect(r.barShown).toBe(false);
    expect(r.reading).toMatch(/false accept/);
  });

  it("grader PASS with the derived gate refuting still counts as verified", () => {
    const b = buildPack({
      ruled: true,
      planner: MODEL,
      outcome: (i, arm) =>
        i < 6 && arm === R_ARM
          ? {
              grade: "pass",
              invocations: [
                {
                  workflowId: "wf",
                  recordingSha256: recordingSha("record-edit:qty"),
                  certified: true,
                  refusal: null,
                  gateVerdict: "refuted",
                },
              ],
            }
          : { grade: "fail" },
    });
    const r = analysed(run(b));
    expect(r.primary).toMatchObject({ capabilityOnly: 6, shown: true });
    expect(r.guardrails.derivedFalseAccepts).toBe(0);
    expect(r.guardrails.zeroEventUpper95).toBeCloseTo(0.095, 4);
  });

  it("a grader pass without a done claim is not verified", () => {
    const b = buildPack({
      ruled: true,
      planner: MODEL,
      outcome: (i, arm) =>
        i < 8 ? { grade: "pass", claim: arm === R_ARM ? "no-claim" : "done" } : { grade: "fail" },
    });
    const r = analysed(run(b));
    expect(r.primary).toMatchObject({ capabilityOnly: 0, baselineOnly: 8, shown: false });
  });
});

describe("R5 prerequisite (fixed sequence: primary not tested when it fails)", () => {
  const uncertified = (
    refusal: "SELFTEST_FAILED" | "BINDING_REFUSED" | null,
    gateVerdict: "verified" | null,
  ) =>
    buildPack({
      ruled: true,
      planner: MODEL,
      outcome: (i, arm) =>
        i === 0 && arm === R_ARM
          ? {
              grade: "pass",
              invocations: [
                {
                  workflowId: "wf",
                  recordingSha256: recordingSha("record-edit:name"),
                  certified: false,
                  refusal,
                  gateVerdict,
                },
              ],
            }
          : discordant(10, 0)(i, arm),
    });

  it("an uncertified oracle that reached a verdict fails the prerequisite; primary is null", () => {
    const r = analysed(run(uncertified(null, "verified")));
    expect(r.prerequisite).toEqual({
      held: false,
      uncertifiedVerdicts: 1,
      uncertifiedNotRefused: 1,
    });
    expect(r.primary).toBeNull();
    expect(r.barShown).toBe(false);
  });

  it("an uncertified oracle not refused as SELFTEST_FAILED fails the prerequisite", () => {
    const r = analysed(run(uncertified("BINDING_REFUSED", null)));
    expect(r.prerequisite).toEqual({
      held: false,
      uncertifiedVerdicts: 0,
      uncertifiedNotRefused: 1,
    });
    expect(r.primary).toBeNull();
  });

  it("an uncertified oracle refused SELFTEST_FAILED keeps the prerequisite; R5 pass rate counts it", () => {
    const r = analysed(run(uncertified("SELFTEST_FAILED", null)));
    expect(r.prerequisite.held).toBe(true);
    expect(r.secondary.r5PassRate).toEqual({ certified: 29, invocations: 30 });
    expect(r.primary?.shown).toBe(true);
  });

  it("a row claiming a refused replay still got a gate verdict is refused as malformed", () => {
    const b = uncertified("SELFTEST_FAILED", "verified");
    expect(codes(run(b))).toContain("TRIAL_SHAPE");
  });
});

describe("not shown, with the reason", () => {
  it("fewer than 5 discordant: underpowered at n = 30, even at 4 vs 0", () => {
    const r = analysed(run(buildPack({ ruled: true, planner: MODEL, outcome: discordant(4, 0) })));
    expect(r.primary).toMatchObject({ discordant: 4, shown: false });
    expect(r.primary?.reading).toMatch(/underpowered at n = 30 \(4 discordant/);
    expect(r.barShown).toBe(false);
  });

  it("the 5-discordant minimum binds on its own: a prereg at alpha 0.10 still refuses 4 vs 0 (p = 0.0625)", () => {
    const b = buildPack({ ruled: true, planner: MODEL, outcome: discordant(4, 0) });
    const bar = b.prereg.bar as { sequence: Record<string, unknown>[] };
    b.prereg = {
      ...b.prereg,
      bar: {
        ...bar,
        sequence: bar.sequence.map((c) => (c.id === "R-primary" ? { ...c, alpha: 0.1 } : c)),
      },
    };
    b.pack.preregHash = canonicalSha256(b.prereg);
    const r = analysed(run(b));
    expect(r.primary?.pOneSided).toBeCloseTo(0.0625, 10);
    expect(r.primary?.shown).toBe(false);
    expect(r.primary?.reading).toMatch(/underpowered/);
  });

  it("p above alpha: 6 vs 3", () => {
    const r = analysed(run(buildPack({ ruled: true, planner: MODEL, outcome: discordant(6, 3) })));
    expect(r.primary?.shown).toBe(false);
    expect(r.primary?.reading).toMatch(/p = 0\.2539/);
  });

  it("a planted marker anywhere in the pack breaks the bar", () => {
    const b = buildPack({ ruled: true, planner: MODEL, outcome: discordant(8, 0) });
    const t = b.trials[3] as RTrialRow;
    b.trials[3] = { ...t, cause: { kind: "agent", detail: "MYCO-PLANTED-R-0042 seen" } };
    const r = analysed(run(b, true, ["MYCO-PLANTED-R-0042"]));
    expect(r.guardrails.markerScan.clean).toBe(false);
    expect(r.guardrails.markerScan.finding).not.toContain("MYCO-PLANTED");
    expect(r.barShown).toBe(false);
  });
});

describe("simulated packs are plumbing, never evidence", () => {
  it("analysed without --evidence, labelled SIMULATED, nothing reported as shown (N4)", () => {
    const r = analysed(run(buildPack({ ruled: true, outcome: discordant(10, 0) }), false));
    expect(r.evidence).toBe(false);
    expect(r.label).toBe(SIMULATED_LABEL);
    expect(r.primary).toMatchObject({ capabilityOnly: 10, discordant: 10, shown: false });
    expect(r.primary?.reading).toMatch(/^SIMULATED: .*computed, not a result: p = 0\.0010/);
    expect(r.reading).toBe(r.primary?.reading);
    expect(r.reading).not.toMatch(/\bshown\b/);
    expect(r.barShown).toBe(false);
  });

  it("a real-model pack without --evidence is labelled NOT EVIDENCE, never SIMULATED (N4)", () => {
    const r = analysed(
      run(buildPack({ ruled: true, planner: MODEL, outcome: discordant(10, 0) }), false),
    );
    expect(r.label).toBe(NOT_EVIDENCE_LABEL);
    expect(r.reading).not.toMatch(/SIMULATED|\bshown\b/);
    expect(r.reading).toMatch(/^NOT EVIDENCE: /);
    expect(r.primary?.shown).toBe(false);
    expect(r.barShown).toBe(false);
  });

  it("with --evidence a simulated planner is refused", () => {
    expect(codes(run(buildPack()))).toContain("SIMULATED_PLANNER");
  });

  it("with --evidence a scripted-human demonstration is refused", () => {
    expect(codes(run(buildPack({ ruled: true, planner: MODEL, simulatedDemo: true })))).toEqual([
      "DEMONSTRATION_SIMULATED",
    ]);
  });

  it("real planner with a simulated demonstration, without --evidence: analysed but not evidence", () => {
    const r = analysed(
      run(
        buildPack({ ruled: true, planner: MODEL, simulatedDemo: true, outcome: discordant(10, 0) }),
        false,
      ),
    );
    expect(r.evidence).toBe(false);
    expect(r.barShown).toBe(false);
  });
});

describe("pack integrity refusals (codes only, no numbers)", () => {
  const ok = () => buildPack({ ruled: true, planner: MODEL, outcome: discordant(8, 0) });
  const mutate = (f: (b: Built) => void) => {
    const b = ok();
    f(b);
    return run(b);
  };
  const trial = (b: Built, i: number) => b.trials[i] as RTrialRow;

  it("the baseline pack is analysed", () => {
    expect(run(ok()).status).toBe("analysed");
  });
  it("PREREG_HASH_MISMATCH: pack records another prereg hash", () => {
    expect(codes(mutate((b) => (b.pack.preregHash = "f".repeat(64))))).toEqual([
      "PREREG_HASH_MISMATCH",
    ]);
  });
  it("PREREG_HASH_MISMATCH: the prereg changed after the pack recorded it", () => {
    expect(
      codes(mutate((b) => (b.prereg = { ...b.prereg, stepBudget: 30, retryBudget: 1 }))),
    ).toEqual(["PREREG_HASH_MISMATCH"]);
  });
  it("PREREG_SHAPE: an unreadable prereg", () => {
    expect(codes(mutate((b) => (b.prereg = { ...b.prereg, modelId: 7 })))).toEqual([
      "PREREG_SHAPE",
    ]);
  });
  it("MANIFEST_HASH_MISMATCH: an edited manifest", () => {
    expect(
      codes(
        mutate((b) => {
          b.manifest = { ...b.manifest, taskSeeds: ["fr-v1-99"] };
        }),
      ),
    ).toEqual(["MANIFEST_HASH_MISMATCH"]);
  });
  it("PACK_TASK_SET_MISMATCH: pack names another manifest", () => {
    expect(codes(mutate((b) => (b.pack.manifestSha256 = "e".repeat(64))))).toEqual([
      "PACK_TASK_SET_MISMATCH",
    ]);
  });
  it("DEMONSTRATIONS_INCOMPLETE: a family without its demonstration", () => {
    expect(codes(mutate((b) => b.pack.demonstrations.pop()))).toContain(
      "DEMONSTRATIONS_INCOMPLETE",
    );
  });
  it("RECORDING_UNDECLARED: a workflow from a recording the pack does not declare", () => {
    expect(
      codes(
        mutate((b) => {
          const i = b.trials.findIndex((t) => t.arm === R_ARM);
          const t = trial(b, i);
          b.trials[i] = {
            ...t,
            derived: {
              invocations: [
                {
                  workflowId: "wf",
                  recordingSha256: "d".repeat(64),
                  certified: true,
                  refusal: null,
                  gateVerdict: "refuted",
                },
              ],
            },
          };
        }),
      ),
    ).toEqual(["RECORDING_UNDECLARED"]);
  });
  it("ARM_INCOMPLETE: a dropped trial (and its grade)", () => {
    expect(
      codes(
        mutate((b) => {
          b.trials.splice(5, 1);
          b.grades.splice(5, 1);
        }),
      ),
    ).toEqual(["ARM_INCOMPLETE"]);
  });
  it("ARM_INCOMPLETE: a partial C1 arm", () => {
    const b = buildPack({ ruled: true, planner: MODEL, withC1: true, outcome: discordant(8, 0) });
    const i = b.trials.findIndex((t) => t.arm === "C1");
    b.trials.splice(i, 1);
    b.grades.splice(i, 1);
    expect(codes(run(b))).toEqual(["ARM_INCOMPLETE"]);
  });
  it("TRIAL_KEY_DUPLICATE: two rows with one key", () => {
    expect(
      codes(mutate((b) => (b.trials[1] = { ...trial(b, 1), trialKey: trial(b, 0).trialKey }))),
    ).toContain("TRIAL_KEY_DUPLICATE");
  });
  it("TASK_HASH_MISMATCH: another instruction or fixture", () => {
    expect(
      codes(mutate((b) => (b.trials[0] = { ...trial(b, 0), instructionSha256: "c".repeat(64) }))),
    ).toEqual(["TASK_HASH_MISMATCH"]);
  });
  it("TASK_UNKNOWN: a task not in fr-v1", () => {
    expect(codes(mutate((b) => (b.trials[0] = { ...trial(b, 0), taskId: "fc-v1-001" })))).toContain(
      "TASK_UNKNOWN",
    );
  });
  it("PLANNER_MISMATCH: another model than the prereg's", () => {
    expect(
      codes(mutate((b) => (b.trials[0] = { ...trial(b, 0), plannerModelId: "claude-opus-5-5" }))),
    ).toEqual(["PLANNER_MISMATCH"]);
  });
  it("PLANNER_MIXED: simulated and real planners in one pack", () => {
    expect(
      codes(mutate((b) => (b.trials[0] = { ...trial(b, 0), plannerModelId: "simulated:x" }))),
    ).toContain("PLANNER_MIXED");
  });
  it("STEP_BUDGET_MISMATCH", () => {
    expect(codes(mutate((b) => (b.trials[0] = { ...trial(b, 0), stepBudget: 80 })))).toEqual([
      "STEP_BUDGET_MISMATCH",
    ]);
  });
  it("SCHEDULE_MISMATCH: two trials swapped out of the pre-registered order", () => {
    expect(
      codes(
        mutate((b) => {
          const a = trial(b, 0).ordinal;
          b.trials[0] = { ...trial(b, 0), ordinal: trial(b, 1).ordinal };
          b.trials[1] = { ...trial(b, 1), ordinal: a };
        }),
      ),
    ).toEqual(["SCHEDULE_MISMATCH"]);
  });
  it("DERIVED_ON_BASE_ARM: workflow use on the hcu+shell arm", () => {
    expect(
      codes(
        mutate((b) => {
          const i = b.trials.findIndex((t) => t.arm === "hcu+shell");
          b.trials[i] = { ...trial(b, i), derived: { invocations: [] } };
        }),
      ),
    ).toEqual(["DERIVED_ON_BASE_ARM"]);
  });
  it("TRIAL_SHAPE: an extra field", () => {
    expect(
      codes(
        mutate((b) => (b.trials[0] = { ...trial(b, 0), gate: { verdict: "verified" } } as never)),
      ),
    ).toContain("TRIAL_SHAPE");
  });
  it("GRADE_MISSING / GRADE_UNKNOWN_TRIAL", () => {
    expect(codes(mutate((b) => b.grades.pop()))).toEqual(["GRADE_MISSING"]);
    expect(codes(mutate((b) => b.grades.push({ ...b.grades[0], trialKey: "ghost" })))).toEqual([
      "GRADE_UNKNOWN_TRIAL",
    ]);
  });
  it("GRADE_MISMATCH: grade of other bytes, another grader version, another task", () => {
    expect(
      codes(mutate((b) => (b.grades[0] = { ...b.grades[0], persistedSha256: "b".repeat(64) }))),
    ).toEqual(["GRADE_MISMATCH"]);
    expect(
      codes(mutate((b) => (b.grades[0] = { ...b.grades[0], graderVersion: "other/1" }))),
    ).toEqual(["GRADE_MISMATCH"]);
    expect(
      codes(mutate((b) => (b.grades[0] = { ...b.grades[0], fixtureSha256: "a".repeat(64) }))),
    ).toEqual(["GRADE_MISMATCH"]);
  });
  it("C1 secondary: reported when the C1 arm ran, absent otherwise, never in the bar", () => {
    const r = analysed(
      run(
        buildPack({
          ruled: true,
          planner: MODEL,
          withC1: true,
          outcome: (i, arm) => (arm === "C1" ? { grade: "pass" } : discordant(8, 0)(i, arm)),
        }),
      ),
    );
    expect(r.secondary.vsC1).toMatchObject({ capability: R_ARM, baseline: "C1", shown: false });
    expect(r.barShown).toBe(true);
    expect(analysed(run(ok())).secondary.vsC1).toBeNull();
  });
});

describe("B1 (round 1): never shown while a lead ruling is pending", () => {
  const pendingCount = (readPrereg().leadRulingPending as string[]).length;
  const withPending = (b: Built, items: unknown) => {
    b.prereg = { ...b.prereg, leadRulingPending: items };
    b.pack.preregHash = canonicalSha256(b.prereg);
    return b;
  };

  it("the committed prereg still lists pending rulings", () => {
    expect(pendingCount).toBeGreaterThan(0);
  });

  it("the verifier's 8-vs-1 evidence pack on the committed prereg: LEAD_RULING_PENDING, bar not shown", () => {
    const r = analysed(run(buildPack({ planner: MODEL, outcome: discordant(8, 1) })));
    expect(r.evidence).toBe(true);
    expect(r.leadRulingPending).toBe(pendingCount);
    expect(r.barShown).toBe(false);
    expect(r.primary).toMatchObject({ capabilityOnly: 8, baselineOnly: 1, shown: false });
    expect(r.primary?.pOneSided).toBeCloseTo(10 / 512, 10);
    expect(r.reading.startsWith(`${LEAD_RULING_PENDING}: ${pendingCount} `)).toBe(true);
    expect(r.reading).toMatch(/computed, not a result: p = 0\.0195, 8 vs 1 discordant$/);
    expect(r.reading).not.toMatch(/\bshown\b/);
  });

  it("the 5-vs-0 boundary pack on the committed prereg: not shown either", () => {
    const r = analysed(run(buildPack({ planner: MODEL, outcome: discordant(5, 0) })));
    expect(r.barShown).toBe(false);
    expect(r.primary?.shown).toBe(false);
    expect(r.reading).toMatch(new RegExp(`^${LEAD_RULING_PENDING}`));
  });

  it("one pending item is enough to block the bar", () => {
    const b = withPending(buildPack({ ruled: true, planner: MODEL, outcome: discordant(8, 1) }), [
      "one open item",
    ]);
    const r = analysed(run(b));
    expect(r.leadRulingPending).toBe(1);
    expect(r.barShown).toBe(false);
    expect(r.primary?.shown).toBe(false);
  });

  it("the C1 secondary is withheld too", () => {
    const r = analysed(
      run(
        buildPack({
          planner: MODEL,
          withC1: true,
          outcome: (i, arm) => (arm === "C1" ? { grade: "fail" } : discordant(8, 0)(i, arm)),
        }),
      ),
    );
    expect(r.secondary.vsC1).toMatchObject({ capabilityOnly: 8, shown: false });
    expect(r.secondary.vsC1?.reading).toMatch(new RegExp(`^${LEAD_RULING_PENDING}`));
  });

  it("a guardrail breach still reads not shown, prefixed with the pending state", () => {
    const b = buildPack({
      planner: MODEL,
      outcome: (i, arm) =>
        i === 20 && arm === R_ARM
          ? {
              grade: "fail",
              invocations: [
                {
                  workflowId: "wf",
                  recordingSha256: recordingSha("record-edit:name"),
                  certified: true,
                  refusal: null,
                  gateVerdict: "verified",
                },
              ],
            }
          : discordant(8, 0)(i, arm),
    });
    const r = analysed(run(b));
    expect(r.reading).toMatch(
      new RegExp(`^${LEAD_RULING_PENDING}: .*; not shown: 1 derived-gate false accept`),
    );
  });

  it("a prereg without a leadRulingPending list, or with a non-string item, is refused PREREG_SHAPE", () => {
    const missing = buildPack({ ruled: true, planner: MODEL, outcome: discordant(8, 0) });
    const { leadRulingPending: _drop, ...rest } = missing.prereg;
    missing.prereg = rest;
    missing.pack.preregHash = canonicalSha256(missing.prereg);
    expect(codes(run(missing))).toEqual(["PREREG_SHAPE"]);
    const bad = withPending(
      buildPack({ ruled: true, planner: MODEL, outcome: discordant(8, 0) }),
      [7],
    );
    expect(codes(run(bad))).toEqual(["PREREG_SHAPE"]);
    const notList = withPending(
      buildPack({ ruled: true, planner: MODEL, outcome: discordant(8, 0) }),
      "none",
    );
    expect(codes(run(notList))).toEqual(["PREREG_SHAPE"]);
  });
});

describe("N1 (round 1): claims the round-1 tests did not exercise", () => {
  const derivedVerifiedGraded = (grade: "fail" | "ungradable") =>
    buildPack({
      ruled: true,
      planner: MODEL,
      outcome: (i, arm) =>
        i === 20 && arm === R_ARM
          ? {
              grade,
              invocations: [
                {
                  workflowId: "wf",
                  recordingSha256: recordingSha("record-edit:name"),
                  certified: true,
                  refusal: null,
                  gateVerdict: "verified",
                },
              ],
            }
          : discordant(8, 0)(i, arm),
    });

  it("V1: derived gate verified, grader ungradable: a false accept, bar not shown", () => {
    const r = analysed(run(derivedVerifiedGraded("ungradable")));
    expect(r.guardrails.derivedFalseAccepts).toBe(1);
    expect(r.barShown).toBe(false);
    expect(r.reading).toMatch(/1 derived-gate false accept/);
  });

  it("V5: steps, wall time and cost per verified task are ALL-trial sums over verified tasks", () => {
    const r = analysed(
      run(buildPack({ ruled: true, planner: MODEL, outcome: discordant(8, 1, 3) })),
    );
    // R verifies 11 of 30 (steps 10, wall 60 s, cost 0.01 each); hcu+shell verifies 4.
    expect(r.secondary.perVerified[R_ARM]?.steps).toBeCloseTo(300 / 11, 10);
    expect(r.secondary.perVerified[R_ARM]?.wallClockS).toBeCloseTo(1800 / 11, 10);
    expect(r.secondary.perVerified[R_ARM]?.costUsdEstimate).toBeCloseTo(0.3 / 11, 10);
    expect(r.secondary.perVerified["hcu+shell"]?.steps).toBeCloseTo(300 / 4, 10);
  });

  it("V6: one unmeasured cost makes that arm's cost per verified null, never 0-filled", () => {
    const b = buildPack({ ruled: true, planner: MODEL, outcome: discordant(8, 1, 3) });
    const i = b.trials.findIndex((t) => t.arm === R_ARM);
    b.trials[i] = { ...(b.trials[i] as RTrialRow), costUsdEstimate: null };
    const r = analysed(run(b));
    expect(r.secondary.perVerified[R_ARM]?.costUsdEstimate).toBeNull();
    expect(r.secondary.perVerified[R_ARM]?.steps).toBeCloseTo(300 / 11, 10);
    expect(r.secondary.perVerified["hcu+shell"]?.costUsdEstimate).toBeCloseTo(0.3 / 4, 10);
  });

  it("V16: a duplicate grade row (even an identical one) is refused GRADE_SHAPE", () => {
    const b = buildPack({ ruled: true, planner: MODEL, outcome: discordant(8, 0) });
    b.grades.push({ ...b.grades[0] });
    expect(codes(run(b))).toEqual(["GRADE_SHAPE"]);
  });
});

describe("shared rule: a row is simulated unless `simulated` is absent or exactly false", () => {
  const ok = () => buildPack({ ruled: true, planner: MODEL, outcome: discordant(8, 0) });

  it("a trial row with simulated true is refused ROW_SIMULATED, with or without --evidence", () => {
    for (const evidence of [true, false]) {
      const b = ok();
      b.trials[0] = { ...(b.trials[0] as RTrialRow), simulated: true } as never;
      expect(codes(run(b, evidence))).toContain("ROW_SIMULATED");
    }
  });

  it("any non-false value is simulated: the string 'false', 0, null", () => {
    for (const v of ["false", 0, null]) {
      const b = ok();
      b.trials[0] = { ...(b.trials[0] as RTrialRow), simulated: v } as never;
      expect(codes(run(b)), String(v)).toContain("ROW_SIMULATED");
    }
  });

  it("a grade row with simulated true is refused ROW_SIMULATED", () => {
    const b = ok();
    b.grades[0] = { ...b.grades[0], simulated: true };
    expect(codes(run(b))).toContain("ROW_SIMULATED");
  });

  it("simulated exactly false on a trial or grade row is accepted", () => {
    const b = ok();
    b.trials[0] = { ...(b.trials[0] as RTrialRow), simulated: false } as never;
    b.grades[0] = { ...b.grades[0], simulated: false };
    expect(analysed(run(b)).barShown).toBe(true);
  });
});
