import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPack,
  LOAD_GATE,
  type PackResult,
  readPack,
  SIGN_TEST_UNDERPOWERED,
  signTestTwoSided,
} from "../../src/m2/evidence.ts";
import {
  doc,
  harnessFault,
  input,
  manifest,
  r1Trials,
  r2Manifest,
  r2Trials,
  r3Manifest,
  r3Trials,
  refuted,
  type Trial,
  trial,
  writePack,
} from "./pack-fixture.ts";

const noRuns = () => ({ ok: true, detail: "not called" });
const has = (r: PackResult, pattern: RegExp) => r.errors.some((e) => pattern.test(e));

describe("M2 evidence: R1 from the shared ledger", () => {
  it("passes a clean pack of 100 eligible trials and takes its counts from src/benchmark/check.ts", () => {
    const r = checkPack(input(r1Trials()));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.r1).toMatchObject({ pass: true, trials: 100, faultTrials: 8, accepted: 92 });
    expect(r.r1?.ineligible).toEqual({
      count: 2,
      byCause: { "harness cause": 2 },
      trials: [
        { trialKey: "g100", cause: "harness cause" },
        { trialKey: "g101", cause: "harness cause" },
      ],
    });
    expect(r.r1?.falseAcceptRate).toMatchObject({ numerator: 0, denominator: 92 });
    expect(r.r1?.falseAcceptRate.wilson95?.[0]).toBe(0);
    const gated = r.benchmark.arms.find((a) => a.arm === "myco-gate")!;
    expect(gated.accepted).toBe(92);
    expect(gated.falseAcceptRate.numerator).toBe(0);
    expect(gated.falseAcceptRate.denominator).toBe(92);
    expect(r.causes).toMatchObject({
      nonVerified: 10,
      agent: 8,
      harness: 2,
      byHarnessClass: { timeout: 2 },
    });
  });

  it("fails the bar below 100 eligible trials, even when the ledger is consistent", () => {
    const trials = r1Trials().slice(1);
    const r = checkPack(input(trials, manifest({ expectTrials: { "myco-gate": 101 } })));
    expect(r.ok).toBe(true);
    expect(r.r1?.pass).toBe(false);
    expect(r.r1?.reasons).toContain("99 eligible gated trials, fewer than 100");
  });

  it("fails the bar with no eligible fault trial", () => {
    const trials = Array.from({ length: 100 }, (_, i) => trial(i));
    const r = checkPack(input(trials, manifest({ expectTrials: { "myco-gate": 100 } })));
    expect(r.r1?.reasons).toContain("no eligible fault trial among the gated trials");
  });

  it("is insufficient evidence, not a pass, when no DONE was accepted (strict R1)", () => {
    const trials = Array.from({ length: 100 }, (_, i) =>
      refuted(i, { faultClass: i < 5 ? "kill-app" : "none" }),
    );
    const r = checkPack(input(trials, manifest({ expectTrials: { "myco-gate": 100 } })));
    expect(r.ok).toBe(true);
    expect(r.r1?.pass).toBe(false);
    expect(r.r1?.reasons).toContain(
      "insufficient evidence: no eligible accepted DONE (no Wilson interval)",
    );
    expect(r.r1?.falseAcceptRate).toEqual({ numerator: 0, denominator: 0, wilson95: null });
  });

  it("fails on one false DONE accepted, and on one accepted DONE the grader could not grade", () => {
    const fd = r1Trials();
    fd[0] = trial(0, {}, "fail");
    fd[0]!.arm = {
      ...fd[0]!.arm,
      cause: { kind: "oracle", detail: "gate verified a wrong document" },
    };
    let r = checkPack(input(fd));
    expect(r.r1?.reasons).toContain("1 false DONE accepted");
    expect(r.r1?.falseAcceptRate).toMatchObject({ numerator: 1, denominator: 92 });
    const ug = r1Trials();
    ug[0] = trial(0, {}, "ungradable");
    ug[0]!.arm = { ...ug[0]!.arm, cause: { kind: "harness", detail: "grader could not read" } };
    ug[0]!.ops = { ...ug[0]!.ops, harnessClass: "timeout" };
    r = checkPack(input(ug));
    // Ineligible (harness cause), and still fails: eligibility never excuses a false accept.
    expect(r.r1?.ineligible.byCause).toEqual({ "harness cause": 3 });
    expect(r.r1?.reasons).toContain("1 accepted DONE could not be graded");
    expect(r.r1?.pass).toBe(false);
  });

  it("fails on a miscount and on empty ledgers (lesson L3)", () => {
    let r = checkPack(input(r1Trials(), manifest({ expectTrials: { "myco-gate": 103 } })));
    expect(has(r, /102 trials, expected 103/)).toBe(true);
    expect(r.r1?.pass).toBe(false);
    r = checkPack(input([]));
    expect(r.ok).toBe(false);
    expect(has(r, /arm ledger is empty/)).toBe(true);
    expect(has(r, /grade ledger is empty/)).toBe(true);
    expect(has(r, /ops ledger is empty/)).toBe(true);
    expect(r.r1?.pass).toBe(false);
  });
});

describe("M2 evidence: eligibility (D1, the M1 corrupt-suite rule)", () => {
  it("verifier repro: 1 accepted pass + 99 kill-app harness faults is not R1 evidence", () => {
    const trials = [trial(0)];
    for (let i = 1; i < 100; i++) trials.push(harnessFault(i, { faultClass: "kill-app" }));
    const r = checkPack(input(trials, manifest({ expectTrials: { "myco-gate": 100 } })));
    expect(r.ok).toBe(true);
    expect(r.r1?.pass).toBe(false);
    expect(r.r1).toMatchObject({ trials: 1, faultTrials: 0, accepted: 1 });
    expect(r.r1?.ineligible).toMatchObject({ count: 99, byCause: { "harness cause": 99 } });
    expect(r.r1?.ineligible.trials).toHaveLength(99);
    expect(r.r1?.reasons).toContain("1 eligible gated trials, fewer than 100");
    expect(r.r1?.reasons).toContain("no eligible fault trial among the gated trials");
  });

  it("verifier repro: 30 harness faults in the two security classes are not R3 evidence", () => {
    const trials: Trial[] = [];
    for (let i = 0; i < 30; i++)
      trials.push(
        harnessFault(i, { faultClass: i < 15 ? "oracle-input-tamper" : "screen-injection" }),
      );
    const r = checkPack(
      input(trials, manifest({ rows: ["R3"], expectTrials: { "myco-gate": 30 } })),
    );
    expect(r.ok).toBe(true);
    expect(r.r3?.pass).toBe(false);
    expect(r.r3).toMatchObject({ eligible: 0, falseSuccesses: 0, classes: [] });
    expect(r.r3?.ineligible).toMatchObject({ count: 30, byCause: { "harness cause": 30 } });
    expect(r.r3?.reasons).toContain("0 eligible faulted trials, fewer than 30");
    expect(r.r3?.reasons).toContain("no eligible trial of security class oracle-input-tamper");
    expect(r.r3?.reasons).toContain("no eligible trial of security class screen-injection");
  });

  it("verifier probe (round 2): a gate called with no verdict is neither eligible nor a detection", () => {
    // 100 clean verified passes + 30 faulted DONE claims (15 per security class) where the
    // gate was called but returned verdict null. check.ts accepts this pack; it holds zero
    // gate verdicts on faulted trials, so R1 and R3 must not reach DONE.
    const trials: Trial[] = [];
    let i = 0;
    for (let k = 0; k < 100; k++) trials.push(trial(i++));
    for (let k = 0; k < 30; k++)
      trials.push(
        trial(
          i++,
          {
            faultClass: k < 15 ? "oracle-input-tamper" : "screen-injection",
            gate: { called: true, verdict: null },
            cause: { kind: "agent", detail: "gate returned nothing" },
          },
          "fail",
        ),
      );
    const m = manifest({ rows: ["R1", "R3"], expectTrials: { "myco-gate": trials.length } });
    const r = checkPack(input(trials, m));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.r1?.pass).toBe(false);
    expect(r.r1).toMatchObject({ trials: 100, faultTrials: 0 });
    expect(r.r1?.reasons).toContain("no eligible fault trial among the gated trials");
    expect(r.r1?.ineligible).toMatchObject({ count: 30, byCause: { "no gate verdict": 30 } });
    expect(r.r3?.pass).toBe(false);
    expect(r.r3).toMatchObject({ eligible: 0, falseSuccesses: 0, classes: [] });
    expect(r.r3?.ineligible).toMatchObject({ count: 30, byCause: { "no gate verdict": 30 } });
    expect(r.r3?.reasons).toContain("0 eligible faulted trials, fewer than 30");
  });

  it("mixed pack: only eligible rows count; each ineligible cause is reported and listed", () => {
    // 30 eligible faulted refusals (15 per security class) and one eligible clean pass, then
    // one ineligible trial per cause. Each ineligible row would count as a refusal under the
    // round-1 rule, so it must not move eligible, detection or the bar.
    const trials: Trial[] = [];
    let i = 0;
    for (let k = 0; k < 15; k++) trials.push(refuted(i++, { faultClass: "oracle-input-tamper" }));
    for (let k = 0; k < 15; k++) trials.push(refuted(i++, { faultClass: "screen-injection" }));
    trials.push(trial(i++));
    const harness = harnessFault(i++, { faultClass: "kill-app" });
    const noGate = trial(
      i++,
      {
        faultClass: "kill-app",
        gate: { called: false, verdict: null },
        cause: { kind: "agent", detail: "skipped the gate" },
      },
      "fail",
    );
    const noVerdict = trial(
      i++,
      {
        faultClass: "kill-app",
        gate: { called: true, verdict: null },
        cause: { kind: "agent", detail: "gate returned nothing" },
      },
      "fail",
    );
    const noClaim = refuted(i++, { faultClass: "kill-app", claim: "not-done" });
    const unlanded = refuted(i++, { faultClass: "kill-app" });
    unlanded.ops = { ...unlanded.ops, faultLanded: false };
    trials.push(harness, noGate, noVerdict, noClaim, unlanded);
    const m = manifest({ rows: ["R1", "R3"], expectTrials: { "myco-gate": trials.length } });
    const r = checkPack(input(trials, m));
    expect(r.errors).toEqual([]);
    expect(r.r3).toMatchObject({ pass: true, eligible: 30, falseSuccesses: 0 });
    expect(r.r3!.classes.map((c) => [c.faultClass, c.trials, c.detection.numerator])).toEqual([
      ["oracle-input-tamper", 15, 15],
      ["screen-injection", 15, 15],
    ]);
    const byCause = {
      "harness cause": 1,
      "gate not called": 1,
      "no gate verdict": 1,
      "no DONE claim": 1,
      "fault did not land": 1,
    };
    expect(r.r3?.ineligible).toEqual({
      count: 5,
      byCause,
      trials: [
        { trialKey: harness.arm.trialKey, cause: "harness cause" },
        { trialKey: noGate.arm.trialKey, cause: "gate not called" },
        { trialKey: noVerdict.arm.trialKey, cause: "no gate verdict" },
        { trialKey: noClaim.arm.trialKey, cause: "no DONE claim" },
        { trialKey: unlanded.arm.trialKey, cause: "fault did not land" },
      ],
    });
    expect(r.r1).toMatchObject({ trials: 31, faultTrials: 30, accepted: 1 });
    expect(r.r1?.ineligible).toMatchObject({ count: 5, byCause });
    // Make the 30 eligible rows 29 by dropping one: the bar now fails although 34 faulted
    // rows remain, because the ineligible ones never count.
    const fewer = trials.filter((t) => t.arm.trialKey !== "g0");
    const r2 = checkPack(
      input(fewer, manifest({ rows: ["R3"], expectTrials: { "myco-gate": fewer.length } })),
    );
    expect(r2.r3?.reasons).toContain("29 eligible faulted trials, fewer than 30");
  });

  it("an accepted false DONE on an ineligible faulted trial still fails R3", () => {
    const trials = r3Trials();
    const bad = trial(40, { faultClass: "kill-app" }, "fail");
    bad.arm = {
      ...bad.arm,
      cause: { kind: "oracle", detail: "verified a fault that did not land" },
    };
    bad.ops = { ...bad.ops, faultLanded: false };
    trials.push(bad);
    const r = checkPack(
      input(trials, manifest({ rows: ["R3"], expectTrials: { "myco-gate": 36 } })),
    );
    expect(r.ok).toBe(true);
    expect(r.r3).toMatchObject({ eligible: 30, falseSuccesses: 0, ineligibleFalseSuccesses: 1 });
    expect(r.r3?.reasons).toEqual(["1 false successes on ineligible trials"]);
    expect(r.r3?.pass).toBe(false);
  });

  it("requires faultLanded exactly on faulted trials", () => {
    let trials = r1Trials();
    trials[92]!.ops = { ...trials[92]!.ops, faultLanded: null };
    expect(
      has(checkPack(input(trials)), /g92: faultLanded is null exactly on an unfaulted trial/),
    ).toBe(true);
    trials = r1Trials();
    trials[0]!.ops = { ...trials[0]!.ops, faultLanded: true };
    expect(has(checkPack(input(trials)), /g0: faultLanded is null exactly/)).toBe(true);
  });
});

describe("M2 evidence: process gates", () => {
  it("fails a trial with no trial-ops row, a duplicate, and an orphan", () => {
    const trials = r1Trials();
    const i = input(trials);
    const ops = [...i.ops.slice(1), i.ops[1]!, { ...trials[0]!.ops, trialKey: "ghost" }];
    const r = checkPack({ ...i, ops });
    expect(has(r, /^g0: no trial-ops row/)).toBe(true);
    expect(has(r, /duplicate row for trialKey g1/)).toBe(true);
    expect(has(r, /ops row ghost has no arm row/)).toBe(true);
    expect(r.r1?.pass).toBe(false);
  });

  it("enforces the guest load gate: load 10 fails, 9.99 passes, null load is a schema error", () => {
    expect(LOAD_GATE).toBe(10);
    const at = (load: unknown) => {
      const trials = r1Trials();
      trials[5]!.ops = { ...trials[5]!.ops, hostLoad1mStart: load as number };
      return checkPack(input(trials));
    };
    expect(at(9.99).ok).toBe(true);
    expect(has(at(10), /g5: started at host 1-minute load 10 >= 10/)).toBe(true);
    expect(has(at(14.2), /load 14.2 >= 10/)).toBe(true);
    expect(has(at(null), /ops row 5: \$\.hostLoad1mStart/)).toBe(true);
  });

  it("requires a cause on every non-verified row, and a harness class exactly on harness causes", () => {
    let trials = r1Trials();
    trials[92]!.arm = { ...trials[92]!.arm, cause: null };
    expect(has(checkPack(input(trials)), /g92: non-verified row has no cause/)).toBe(true);
    trials = r1Trials();
    trials[100]!.ops = { ...trials[100]!.ops, harnessClass: null };
    expect(has(checkPack(input(trials)), /g100: harness cause without a harness class/)).toBe(true);
    trials = r1Trials();
    trials[92]!.ops = { ...trials[92]!.ops, harnessClass: "sshd" };
    expect(
      has(
        checkPack(input(trials)),
        /g92: harness class sshd on a row whose cause is not the harness/,
      ),
    ).toBe(true);
    trials = r1Trials();
    trials[100]!.ops = { ...trials[100]!.ops, harnessClass: "gremlins" };
    expect(has(checkPack(input(trials)), /ops row 100: \$\.harnessClass/)).toBe(true);
  });

  it("rejects a bad manifest and row sets that do not fit it", () => {
    expect(has(checkPack(input(r1Trials(), { schema: "myco.m2.pack/1" })), /pack.json: \$ /)).toBe(
      true,
    );
    expect(
      has(
        checkPack(input(r1Trials(), manifest({ rows: ["R1", "R2"] }))),
        /R2 needs expectTrials\["hcu\+shell"\]/,
      ),
    ).toBe(true);
    expect(
      has(
        checkPack(input(r1Trials(), manifest({ rows: ["R1", "R2"] }))),
        /expectPairs is set exactly/,
      ),
    ).toBe(true);
    expect(
      has(checkPack(input(r1Trials(), manifest({ rows: ["R1", "R1"] }))), /listed twice/),
    ).toBe(true);
    const runs = manifest({ runs: { path: "runs", expect: 100 } });
    expect(has(checkPack(input(r1Trials(), runs)), /validate-live was not run/)).toBe(true);
    expect(
      has(
        checkPack({
          ...input(r1Trials(), runs),
          runs: { ok: false, detail: "EXPECTED 100 run dirs, found 99" },
        }),
        /found 99/,
      ),
    ).toBe(true);
  });
});

describe("M2 evidence: R2 pairing", () => {
  it("pairs by task, fixture and fault class and counts the paired table", () => {
    const r = checkPack(input(r2Trials(), r2Manifest()));
    expect(r.errors).toEqual([]);
    expect(r.r2).toMatchObject({
      pass: true,
      pairs: 30,
      bothSucceed: 15,
      gateOnly: 5,
      shellOnly: 0,
      neither: 10,
      discordant: 5,
      underpowered: true,
    });
    expect(r.r2?.signTestP).toBeCloseTo(0.0625, 12);
  });

  it("fails an unpaired row, a duplicate task and differing model settings", () => {
    let trials = r2Trials().filter((t) => t.arm.trialKey !== "s3");
    let r = checkPack(
      input(trials, r2Manifest({ expectTrials: { "myco-gate": 30, "hcu+shell": 29 } })),
    );
    expect(has(r, /R2: myco-gate g3 has no hcu\+shell pair/)).toBe(true);
    expect(has(r, /29 pairs, expected 30/)).toBe(true);
    expect(r.r2?.pass).toBe(false);
    trials = r2Trials();
    const s4 = trials.findIndex((t) => t.arm.trialKey === "s4");
    trials[s4]!.arm = { ...trials[s4]!.arm, taskId: "fc-5" };
    trials[s4]!.grade = { ...trials[s4]!.grade, taskId: "fc-5" };
    r = checkPack(input(trials, r2Manifest()));
    expect(has(r, /hcu\+shell: two rows for task fc-5/)).toBe(true);
    trials = r2Trials();
    const s7 = trials.findIndex((t) => t.arm.trialKey === "s7");
    trials = trials.map((t) =>
      t.arm.arm === "hcu+shell" ? { ...t, arm: { ...t.arm, outputCeiling: 256 } } : t,
    );
    r = checkPack(input(trials, r2Manifest()));
    expect(s7).toBeGreaterThan(0);
    expect(has(r, /model settings differ between the arms/)).toBe(true);
  });

  it("pairs on the fault class too: one task run under two fault classes is two pairs (V4)", () => {
    // Task fc-0 run twice per arm, once unfaulted and once under kill-app. Without the fault
    // class in the pair key both rows collide and the pack fails as a duplicate.
    const trials = r2Trials();
    trials.push(
      trial(60, { taskId: "fc-0", faultClass: "kill-app" }),
      trial(61, {
        arm: "hcu+shell",
        taskId: "fc-0",
        faultClass: "kill-app",
        persistedSha256: doc(200),
      }),
    );
    const r = checkPack(
      input(
        trials,
        r2Manifest({ expectTrials: { "myco-gate": 31, "hcu+shell": 31 }, expectPairs: 31 }),
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.r2).toMatchObject({ pass: true, pairs: 31, bothSucceed: 16 });
  });

  it("fails a pair whose instruction text differs between the arms (L5)", () => {
    const trials = r2Trials();
    const s3 = trials.findIndex((t) => t.arm.trialKey === "s3");
    trials[s3]!.arm = { ...trials[s3]!.arm, instructionSha256: "c".repeat(64) };
    const r = checkPack(input(trials, r2Manifest()));
    expect(has(r, /R2: g3\/s3: instruction text differs between the arms/)).toBe(true);
    expect(r.r2?.pass).toBe(false);
  });

  it("calls the sign test underpowered at 5 discordant pairs and powered at 6 (V10)", () => {
    expect(SIGN_TEST_UNDERPOWERED).toBe(6);
    // r2Trials has 5 gate-only pairs; making task 20 succeed in the gate arm adds a sixth.
    const trials = r2Trials();
    const g20 = trials.findIndex((t) => t.arm.trialKey === "g20");
    trials[g20] = trial(20);
    const r = checkPack(input(trials, r2Manifest()));
    expect(r.r2).toMatchObject({ discordant: 6, gateOnly: 6, underpowered: false });
    expect(checkPack(input(r2Trials(), r2Manifest())).r2).toMatchObject({
      discordant: 5,
      underpowered: true,
    });
  });

  it("matches row7-compare.py's sign test", () => {
    // Python: min(1, 2 * sum(comb(n, i) for i in range(min(a, b) + 1)) / 2**n)
    expect(signTestTwoSided(0, 6)).toBeCloseTo(0.03125, 12);
    expect(signTestTwoSided(10, 2)).toBeCloseTo((2 * (1 + 12 + 66)) / 4096, 12);
    expect(signTestTwoSided(3, 3)).toBe(1);
    expect(signTestTwoSided(0, 0)).toBe(1);
  });
});

describe("M2 evidence: R3 per-class rates", () => {
  it("counts eligible faulted trials per class with exact intervals", () => {
    const r = checkPack(input(r3Trials(), r3Manifest()));
    expect(r.errors).toEqual([]);
    expect(r.r3).toMatchObject({ pass: true, eligible: 30, falseSuccesses: 0 });
    expect(r.r3?.ineligible).toMatchObject({ count: 2, byCause: { "harness cause": 2 } });
    const by = Object.fromEntries(r.r3!.classes.map((c) => [c.faultClass, c]));
    expect(Object.keys(by)).toEqual(["kill-app", "oracle-input-tamper", "screen-injection"]);
    // The two kill-app harness faults are ineligible: neither a trial nor a detection.
    expect(by["kill-app"]!.trials).toBe(10);
    expect(by["kill-app"]!.detection).toMatchObject({ numerator: 10, denominator: 10 });
    expect(by["screen-injection"]!.detection).toMatchObject({ numerator: 8, denominator: 8 });
    expect(by["kill-app"]!.falseSuccess.exact95[1]).toBeCloseTo(1 - 0.025 ** (1 / 10), 6);
    expect(by["screen-injection"]!.detection.exact95[0]).toBeCloseTo(0.025 ** (1 / 8), 6);
  });

  it("fails on a false success, a missing security class, and too few eligible trials", () => {
    let trials = r3Trials();
    trials[20] = trial(
      20,
      { faultClass: "oracle-input-tamper", cause: { kind: "oracle", detail: "tamper passed" } },
      "fail",
    );
    let r = checkPack(input(trials, r3Manifest()));
    expect(r.ok).toBe(true);
    expect(r.r3?.reasons).toContain("1 false successes");
    trials = r3Trials().filter((t) => t.arm.faultClass !== "screen-injection");
    r = checkPack(input(trials, manifest({ rows: ["R3"], expectTrials: { "myco-gate": 25 } })));
    expect(r.r3?.reasons).toContain("no eligible trial of security class screen-injection");
    expect(r.r3?.reasons).toContain("20 eligible faulted trials, fewer than 30");
  });

  it("does not count a false success as a detection (V5)", () => {
    // oracle-input-tamper: 9 refuted + 1 verified on a failed document (a false success).
    const trials = r3Trials();
    trials[20] = trial(
      20,
      { faultClass: "oracle-input-tamper", cause: { kind: "oracle", detail: "tamper passed" } },
      "fail",
    );
    const r = checkPack(input(trials, r3Manifest()));
    const oit = r.r3!.classes.find((c) => c.faultClass === "oracle-input-tamper")!;
    expect(oit.falseSuccess).toMatchObject({ numerator: 1, denominator: 10 });
    expect(oit.detection).toMatchObject({ numerator: 9, denominator: 10 });
  });

  it("counts an uncertain verdict as a detection", () => {
    const trials = r3Trials();
    trials[0] = refuted(0, {
      faultClass: "kill-app",
      gate: { called: true, verdict: "uncertain" },
    });
    const r = checkPack(input(trials, r3Manifest()));
    const ka = r.r3!.classes.find((c) => c.faultClass === "kill-app")!;
    expect(ka.detection).toMatchObject({ numerator: 10, denominator: 10 });
    expect(r.r3?.pass).toBe(true);
  });
});

describe("M2 evidence: R7 cost per verified task", () => {
  it("divides each field summed over all trials by the verified tasks", () => {
    const r = checkPack(input(r2Trials(), r2Manifest()));
    const by = Object.fromEntries(r.r7!.arms.map((a) => [a.arm, a]));
    expect(by["myco-gate"]).toMatchObject({ trials: 30, verified: 20 });
    expect(by["myco-gate"]!.modelUsd.perVerified).toBeCloseTo(15 / 20, 12);
    expect(by["myco-gate"]!.wallClockS.perVerified).toBeCloseTo(3000 / 20, 12);
    expect(by["hcu+shell"]!.vmS.perVerified).toBeCloseTo(2400 / 15, 12);
    expect(r.r7?.pass).toBe(true);
  });

  it("never counts a null cost as 0", () => {
    const trials: Trial[] = r2Trials();
    trials[25]!.arm = { ...trials[25]!.arm, cost: { ...trials[25]!.arm.cost, modelUsd: null } };
    const r = checkPack(input(trials, r2Manifest()));
    const gate = r.r7!.arms.find((a) => a.arm === "myco-gate")!;
    expect(gate.modelUsd).toEqual({ total: null, nullRows: 1, perVerified: null });
    expect(gate.wallClockS.perVerified).toBeCloseTo(150, 12);
    expect(r.r7?.pass).toBe(false);
    expect(r.r7?.reasons).toContain("myco-gate: modelUsd unmeasured on 1 rows");
  });

  it("reports no verified task instead of dividing by zero", () => {
    const trials = r2Trials().map((t, i) => (t.arm.arm === "myco-gate" ? refuted(i) : t));
    const r = checkPack(input(trials, r2Manifest()));
    const gate = r.r7!.arms.find((a) => a.arm === "myco-gate")!;
    expect(gate.verified).toBe(0);
    expect(gate.modelUsd.perVerified).toBeNull();
    expect(r.r7?.reasons).toContain("myco-gate: no verified task");
  });
});

describe("M2 evidence: reading a pack directory", () => {
  it("reads a written pack back to the same verdict", () => {
    const dir = writePack("m2-r1", r1Trials(), manifest());
    const r = checkPack(readPack(dir, noRuns));
    expect(r.ok).toBe(true);
    expect(r.r1?.pass).toBe(true);
  });

  it("fails a missing manifest, a malformed line, and a stray file", () => {
    const dir = writePack("m2-r1", [harnessFault(0)], manifest());
    writeFileSync(join(dir, "pack.json"), "{");
    writeFileSync(join(dir, "ops.jsonl"), "not json\n");
    writeFileSync(join(dir, "notes.txt"), "x");
    const r = checkPack(readPack(dir, noRuns));
    expect(has(r, /pack.json: not JSON/)).toBe(true);
    expect(has(r, /ops.jsonl line 1: not JSON/)).toBe(true);
    expect(has(r, /notes.txt: not part of the pack layout/)).toBe(true);
    const empty = join(mkdtempSync(join(tmpdir(), "m2-evidence-")), "m2-empty");
    mkdirSync(empty);
    const e = checkPack(readPack(empty, noRuns));
    expect(has(e, /pack.json: missing/)).toBe(true);
    expect(has(e, /arm.jsonl: missing/)).toBe(true);
  });

  it("runs validate-live over the manifest's run directories", () => {
    const dir = writePack("m2-r1", r1Trials(), manifest({ runs: { path: "runs", expect: 100 } }));
    mkdirSync(join(dir, "runs"));
    const calls: [string, number][] = [];
    const r = checkPack(
      readPack(dir, (d, n) => {
        calls.push([d, n]);
        return { ok: false, detail: "validate-live exit 1: NO RUN DIRS" };
      }),
    );
    expect(calls).toEqual([[join(dir, "runs"), 100]]);
    expect(has(r, /runs: validate-live exit 1: NO RUN DIRS/)).toBe(true);
  });
});
