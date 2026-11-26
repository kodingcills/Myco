/**
 * TIF-274 / outer-loop ruling 2026-11-26 08:38Z in the M2 evidence pack: R1 counts all 100
 * fc-v1 trials. The 10 unregistrable (invalid-target) rows get their own line, are never
 * eligible, and the manifest asserts the gated/unregistrable split, so a short pack fails.
 * The 03:13Z eligibility rule for detection and false successes is unchanged.
 */
import { describe, expect, it } from "vitest";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import { checkPack, ineligibleCause, type PackResult } from "../../src/m2/evidence.ts";
import {
  fcRow,
  fcTasks,
  input,
  manifest,
  r1Trials,
  refuted,
  type Trial,
  trial,
  unregistrable as unregTrial,
} from "./pack-fixture.ts";

const has = (r: PackResult, pattern: RegExp) => r.errors.some((e) => pattern.test(e));

/** Row fields binding a trial to the i-th fc-v1 task of `cls`, with the REAL hashes. */
const FC = (i: number, cls: string): Partial<BenchmarkArmRow> => fcRow(fcTasks(cls)[i]!);
/** An unregistrable trial on the k-th fc-v1 invalid-target task. */
const unregistrable = (i: number, k = i % 10): Trial =>
  unregTrial(i, fcTasks("invalid-target")[k]!);
/** The real fc-v1 pack, each task once (the shared fixture). */
const fcV1 = r1Trials;
const fcManifest = (over: Record<string, unknown> = {}) =>
  manifest({
    rows: ["R1"],
    expectTrials: { "myco-gate": 100 },
    expectUnregistrable: { "myco-gate": 10 },
    ...over,
  });

describe("R1 over all 100 fc-v1 trials (ruling 08:38Z)", () => {
  it("a 90-gated + 10-unregistrable pack passes, with the unregistrable rows on their own line", () => {
    const r = checkPack(input(fcV1(), fcManifest()));
    expect(r.errors).toEqual([]);
    expect(r.r1).toMatchObject({
      pass: true,
      trials: 90,
      counted: 100,
      allTrials: 100,
      unregistrable: { trials: 10, claimedDone: 10, graderFailClaimedDone: 10 },
      headline: { numerator: 0, denominator: 100 },
      accepted: 60,
      falseAcceptRate: { numerator: 0, denominator: 60 },
    });
    // Never eligible: their own cause, never folded into another.
    expect(r.r1?.ineligible.byCause).toEqual({ unregistrable: 10 });
  });

  it("the unregistrable line counts only DONE claims, and only grader fails among them", () => {
    const trials = fcV1();
    const nd = unregistrable(99, 9);
    trials[99] = {
      ...nd,
      arm: { ...nd.arm, claim: "not-done" },
    };
    const r = checkPack(input(trials, fcManifest()));
    expect(r.errors).toEqual([]);
    expect(r.r1?.unregistrable).toEqual({ trials: 10, claimedDone: 9, graderFailClaimedDone: 9 });
    // An unregistrable row counts toward the 100 whatever its claim (#506 round 3, N1).
    expect(r.r1).toMatchObject({ pass: true, counted: 100 });
    // A DONE claim the grader passes is not a grader fail (#506 round 1, D3). Unreachable on a
    // real invalid-target document; pinned so the count cannot drift to "every DONE claim".
    const passed = fcV1();
    const t98 = passed[98] as Trial;
    passed[98] = { ...t98, grade: { ...t98.grade, status: "pass", reasons: [] } };
    const p = checkPack(input(passed, fcManifest()));
    expect(p.r1?.unregistrable).toEqual({ trials: 10, claimedDone: 10, graderFailClaimedDone: 9 });
  });

  it("a short pack fails: dropping the unregistrable rows cannot shrink the denominator", () => {
    const short = fcV1().slice(0, 90);
    const r = checkPack(input(short, fcManifest({ expectTrials: { "myco-gate": 90 } })));
    expect(r.r1?.pass).toBe(false);
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "myco-gate: 0 unregistrable trials, expected 10",
        "myco-gate: 90 gated trials, expected 80",
      ]),
    );
    // Relabelling the split to 0 is refused by the task-set binding (not the whole published
    // set), and R1 is still short of 100 counted trials.
    const relabel = checkPack(
      input(
        short,
        fcManifest({ expectTrials: { "myco-gate": 90 }, expectUnregistrable: { "myco-gate": 0 } }),
      ),
    );
    expect(relabel.errors).toEqual([
      "R1 task set: 90 rows is not a whole number of runs of fc-v1's 100 tasks",
    ]);
    expect(relabel.r1?.pass).toBe(false);
    expect(relabel.r1?.reasons).toContain(
      "90 trials counted toward R1 (90 eligible gated + 0 unregistrable), fewer than 100",
    );
  });

  it("a pack missing one gated trial fails the gated count", () => {
    const r = checkPack(input(fcV1().slice(1), fcManifest()));
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "ledger: myco-gate: 99 trials, expected 100",
        "myco-gate: 89 gated trials, expected 90",
      ]),
    );
    expect(r.r1?.pass).toBe(false);
  });

  it("R1 evidence needs the split; a split must add up and name only myco-gate", () => {
    const { expectUnregistrable: _drop, ...noSplit } = fcManifest();
    const missing = checkPack(input(fcV1(), noSplit));
    expect(has(missing, /R1 needs expectUnregistrable\["myco-gate"\]/)).toBe(true);
    expect(missing.r1?.pass).toBe(false);
    expect(
      has(
        checkPack(input(fcV1(), fcManifest({ expectUnregistrable: { "myco-gate": 101 } }))),
        /expectUnregistrable 101 exceeds expectTrials 100/,
      ),
    ).toBe(true);
    expect(
      has(
        checkPack(input(fcV1(), fcManifest({ expectUnregistrable: { "myco-gate": 9 } }))),
        /10 unregistrable trials, expected 9/,
      ),
    ).toBe(true);
    // The manifest schema is closed: no split for hcu+shell.
    expect(
      has(
        checkPack(
          input(fcV1(), fcManifest({ expectUnregistrable: { "myco-gate": 10, "hcu+shell": 0 } })),
        ),
        /expectUnregistrable/,
      ),
    ).toBe(true);
  });

  it("a split needs the arm's expected total", () => {
    const { expectTrials: _t, ...m } = fcManifest({ rows: ["R2"] });
    const r = checkPack(input(fcV1(), { ...m, expectTrials: {} }));
    expect(has(r, /expectUnregistrable\["myco-gate"\] needs expectTrials\["myco-gate"\]/)).toBe(
      true,
    );
  });

  it("a non-R1 pack on fc-v1 with unregistrable rows is bound row by row, not to the whole set", () => {
    // R3 packs run a subset of tasks, so no multiset; the rows are still fc-v1's own.
    const subset = fcV1().slice(85); // 5 refuted focus-change + 10 unregistrable
    const ok = checkPack(
      input(
        subset,
        manifest({
          rows: ["R3"],
          expectTrials: { "myco-gate": 15 },
          expectUnregistrable: { "myco-gate": 10 },
        }),
      ),
    );
    expect(ok.errors).toEqual([]);
    const forged = subset.map((t, i) =>
      i === 0 ? { ...t, arm: { ...t.arm, fixtureSha256: "a".repeat(64) } } : t,
    );
    const bad = checkPack(
      input(
        forged,
        manifest({
          rows: ["R3"],
          expectTrials: { "myco-gate": 15 },
          expectUnregistrable: { "myco-gate": 10 },
        }),
      ),
    );
    expect(has(bad, /^task set: g85: fixtureSha256 is not task .*'s published fixture$/)).toBe(
      true,
    );
  });

  it("a non-R1 pack with unregistrable rows still needs the split", () => {
    const { expectUnregistrable: _drop, ...m } = manifest({
      rows: ["R3"],
      expectTrials: { "myco-gate": 100 },
    });
    const r = checkPack(input(fcV1(), m));
    expect(has(r, /10 unregistrable myco-gate trial\(s\) but no expectUnregistrable/)).toBe(true);
  });

  it("detection and false successes keep the 03:13Z rule: unregistrable rows are never eligible", () => {
    const u = unregistrable(0);
    expect(ineligibleCause(u.arm, u.ops)).toBe("unregistrable");
    const r = checkPack(input(fcV1(), fcManifest({ rows: ["R1", "R3"] })));
    // R3's eligible faulted trials are the 30 refuted faulted ones only.
    expect(r.r3?.eligible).toBe(30);
    expect(r.r3?.ineligible.byCause).toEqual({ unregistrable: 10 });
    expect(r.r3?.classes.find((c) => c.faultClass === "invalid-target")).toBeUndefined();
  });

  describe("forged or misplaced unregistrable rows (#506 round 1, D1: the verifier's probes)", () => {
    const probe = (row: Partial<BenchmarkArmRow>, status: "pass" | "fail" = "fail") => {
      const trials = fcV1();
      trials[95] = trial(95, { ...FC(5, "invalid-target"), ...row }, status, { faultLanded: true });
      return checkPack(input(trials, fcManifest()));
    };
    it("a verified, accepted 'unregistrable' row on a clean task", () => {
      const r = probe(
        {
          ...FC(0, "none"),
          gate: { called: true, verdict: "verified", unregistrable: true },
          accepted: true,
          cause: null,
        },
        "pass",
      );
      expect(has(r, /unregistrable task cannot have a gate call or verdict/)).toBe(true);
      expect(has(r, /only an invalid-target task can be unregistrable/)).toBe(true);
      expect(r.r1?.pass).toBe(false);
    });
    it("an unregistrable row on a kill-app task", () => {
      const r = probe({
        ...FC(0, "kill-app"),
        gate: { called: false, verdict: null, unregistrable: true },
        accepted: false,
        cause: { kind: "oracle", detail: "unregistrable" },
      });
      expect(has(r, /only an invalid-target task can be unregistrable/)).toBe(true);
      expect(r.r1?.pass).toBe(false);
    });
    it("an unregistrable row on a clean task", () => {
      const r = probe({
        ...FC(0, "none"),
        gate: { called: false, verdict: null, unregistrable: true },
        accepted: false,
        cause: { kind: "oracle", detail: "unregistrable" },
      });
      expect(has(r, /only an invalid-target task can be unregistrable/)).toBe(true);
      expect(has(r, /is satisfiable, so it cannot be unregistrable/)).toBe(true);
    });
    it("an unregistrable row with a verified verdict, accepted, graded fail", () => {
      const r = probe({
        gate: { called: true, verdict: "verified", unregistrable: true },
        accepted: true,
        cause: null,
      });
      expect(has(r, /unregistrable task cannot have a gate call or verdict/)).toBe(true);
      expect(r.r1?.pass).toBe(false);
    });
  });

  describe("the split is bound to the published task set (#506 round 1, D2)", () => {
    it("the verifier's inflated split fails: 40 clean + 10 refuted + 50 unregistrable", () => {
      const trials: Trial[] = [];
      for (let i = 0; i < 40; i++) trials.push(trial(i, FC(i, "none")));
      for (let k = 0; k < 10; k++) trials.push(refuted(40 + k, FC(k, "kill-app")));
      for (let k = 0; k < 50; k++) trials.push(unregistrable(50 + k, k % 10));
      const r = checkPack(input(trials, fcManifest({ expectUnregistrable: { "myco-gate": 50 } })));
      // 20 clean, 20 faulted tasks missing; every invalid-target task ran 5 times.
      expect(has(r, /^R1 task set: task fc-v1-\d+ ran 0 time\(s\), expected 1/)).toBe(true);
      expect(has(r, /^R1 task set: \d+ more task\(s\) of fc-v1 ran other than 1 time\(s\)$/)).toBe(
        true,
      );
      expect(r.r1?.pass).toBe(false);
    });
    it("refuses a row whose task is not in the task set, or whose faultClass is relabelled", () => {
      const trials = fcV1();
      trials[0] = trial(0, { taskSetVersion: "fc-v1", taskId: "fc-v1-999" });
      trials[1] = trial(1, { ...FC(1, "none"), faultClass: "kill-app" }, "pass", {
        faultLanded: true,
      });
      const r = checkPack(input(trials, fcManifest()));
      expect(r.errors).toEqual(
        expect.arrayContaining([
          "R1 task set: g0: task fc-v1-999 is not in fc-v1",
          `R1 task set: g1: faultClass kill-app is not task ${fcTasks("none")[1]?.taskId}'s (none)`,
        ]),
      );
    });
    it("refuses unregistrable rows on a task set the check does not know", () => {
      const trials = fcV1().map((t) => ({
        ...t,
        arm: { ...t.arm, taskSetVersion: "fc-v9" },
      }));
      const r = checkPack(input(trials, fcManifest()));
      expect(r.errors).toContain(
        'R1 task set: task set "fc-v9" is not a published task set this check knows',
      );
      expect(r.r1?.pass).toBe(false);
    });
    it("the schema alone refuses a negative split and a split for another arm", () => {
      const neg = checkPack(
        input(fcV1(), fcManifest({ expectUnregistrable: { "myco-gate": -1 } })),
      );
      expect(has(neg, /^pack\.json: .*expectUnregistrable.*(minimum|>=)/)).toBe(true);
      const other = checkPack(
        input(fcV1(), fcManifest({ expectUnregistrable: { "myco-gate": 10, "hcu+shell": 0 } })),
      );
      expect(has(other, /^pack\.json: .*expectUnregistrable/)).toBe(true);
    });
  });

  describe("R1 evidence is exactly the published task set (#506 round 2, D1-D3)", () => {
    const inv = fcTasks("invalid-target");
    const clean = fcTasks("none");

    it("D1: all 10 unregistrable rows on one invalid-target task fail", () => {
      const trials = fcV1();
      for (let k = 0; k < 10; k++) trials[90 + k] = unregistrable(90 + k, 0);
      const r = checkPack(input(trials, fcManifest()));
      expect(r.errors).toEqual(
        expect.arrayContaining([
          `R1 task set: task ${inv[0]?.taskId} ran 10 time(s), expected 1 (each fc-v1 task exactly 1)`,
          `R1 task set: task ${inv[1]?.taskId} ran 0 time(s), expected 1 (each fc-v1 task exactly 1)`,
        ]),
      );
      expect(r.r1?.pass).toBe(false);
    });

    it("D1: the 60 clean rows on one clean task fail", () => {
      const trials = fcV1();
      for (let i = 0; i < 60; i++) trials[i] = trial(i, FC(0, "none"));
      const r = checkPack(input(trials, fcManifest()));
      expect(r.errors).toContain(
        `R1 task set: task ${clean[0]?.taskId} ran 60 time(s), expected 1 (each fc-v1 task exactly 1)`,
      );
      expect(has(r, /^R1 task set: \d+ more task\(s\) of fc-v1 ran other than 1 time\(s\)$/)).toBe(
        true,
      );
      expect(r.r1?.pass).toBe(false);
    });

    it("D1: 89 copies of one clean task + 1 refuted kill-app + 10 copies of one invalid-target task fail", () => {
      const trials: Trial[] = [];
      for (let i = 0; i < 89; i++) trials.push(trial(i, FC(0, "none")));
      trials.push(refuted(89, FC(0, "kill-app")));
      for (let k = 0; k < 10; k++) trials.push(unregistrable(90 + k, 0));
      const r = checkPack(input(trials, fcManifest()));
      expect(has(r, /^R1 task set: task .* ran 89 time\(s\), expected 1/)).toBe(true);
      expect(r.r1?.pass).toBe(false);
    });

    it("D1: a whole number of runs passes (each task twice), and the split must be the set's", () => {
      const twice = [
        ...fcV1(),
        ...fcV1().map((t) => ({
          arm: { ...t.arm, trialKey: `${t.arm.trialKey}b` },
          grade: { ...t.grade, trialKey: `${t.grade.trialKey}b` },
          ops: { ...t.ops, trialKey: `${t.ops.trialKey}b` },
        })),
      ];
      const ok = checkPack(
        input(
          twice,
          fcManifest({
            expectTrials: { "myco-gate": 200 },
            expectUnregistrable: { "myco-gate": 20 },
          }),
        ),
      );
      expect(ok.errors).toEqual([]);
      expect(ok.r1).toMatchObject({ pass: true, counted: 200, unregistrable: { trials: 20 } });
      // A split that is not the task set's own (k x its unsatisfiable tasks) is refused.
      const wrongSplit = checkPack(
        input(
          twice,
          fcManifest({
            expectTrials: { "myco-gate": 200 },
            expectUnregistrable: { "myco-gate": 10 },
          }),
        ),
      );
      expect(wrongSplit.errors).toContain(
        "pack.json: expectUnregistrable 10 is not fc-v1's 20 (its unsatisfiable tasks x 2 run(s))",
      );
    });

    it("D2: a row whose fixture or instruction hash is not its task's fails", () => {
      const fixture = fcV1();
      fixture[0] = trial(0, { ...FC(0, "none"), fixtureSha256: "a".repeat(64) });
      const rf = checkPack(input(fixture, fcManifest()));
      expect(rf.errors).toContain(
        `R1 task set: g0: fixtureSha256 is not task ${clean[0]?.taskId}'s published fixture`,
      );
      expect(rf.r1?.pass).toBe(false);
      const instruction = fcV1();
      instruction[0] = trial(0, { ...FC(0, "none"), instructionSha256: "b".repeat(64) });
      const ri = checkPack(input(instruction, fcManifest()));
      expect(ri.errors).toContain(
        `R1 task set: g0: instructionSha256 is not task ${clean[0]?.taskId}'s published instruction`,
      );
      expect(ri.r1?.pass).toBe(false);
    });

    it("D2: the passing pack carries the real fc-v1 hashes", () => {
      for (const t of fcV1()) {
        const task = [
          ...clean,
          ...inv,
          ...fcTasks("kill-app"),
          ...fcTasks("delayed-save"),
          ...fcTasks("focus-change"),
        ].find((x) => x.taskId === t.arm.taskId);
        expect(t.arm.fixtureSha256, t.arm.trialKey).toBe(task?.fixtureSha256);
        expect(t.arm.instructionSha256, t.arm.trialKey).toBe(task?.instructionSha256);
      }
    });

    it("D2: a gated row on an unsatisfiable task fails (unregistrable in both directions)", () => {
      const trials = fcV1();
      trials[90] = refuted(90, FC(0, "invalid-target"));
      const r = checkPack(input(trials, fcManifest({ expectUnregistrable: { "myco-gate": 9 } })));
      expect(r.errors).toContain(
        `R1 task set: g90: task ${inv[0]?.taskId} is unsatisfiable, so it must be unregistrable`,
      );
      expect(r.r1?.pass).toBe(false);
    });

    it("D3: an unknown task set never passes R1, the synthetic fixture included", () => {
      const synthetic = Array.from({ length: 100 }, (_, i) =>
        i < 99 ? trial(i) : refuted(i, { faultClass: "kill-app" }),
      );
      for (const version of ["fx-synthetic", "fc-v1-rerun"]) {
        const rows = synthetic.map((t) => ({ ...t, arm: { ...t.arm, taskSetVersion: version } }));
        const r = checkPack(
          input(
            rows,
            manifest({
              expectTrials: { "myco-gate": 100 },
              expectUnregistrable: { "myco-gate": 0 },
            }),
          ),
        );
        expect(r.errors, version).toEqual([
          `R1 task set: task set ${JSON.stringify(version)} is not a published task set this check knows`,
        ]);
        expect(r.r1?.pass, version).toBe(false);
      }
    });
  });
});
