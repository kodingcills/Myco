import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPack,
  LOAD_GATE,
  type PackResult,
  readPack,
  signTestTwoSided,
} from "../../src/m2/evidence.ts";
import {
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
  it("passes a clean 100-trial pack and takes its counts from src/benchmark/check.ts", () => {
    const r = checkPack(input(r1Trials()));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.r1).toMatchObject({ pass: true, trials: 100, faultTrials: 10 });
    const gated = r.benchmark.arms.find((a) => a.arm === "myco-gate")!;
    expect(gated.accepted).toBe(90);
    expect(gated.falseAcceptRate.numerator).toBe(0);
    expect(gated.falseAcceptRate.denominator).toBe(90);
    expect(r.causes).toMatchObject({
      nonVerified: 10,
      agent: 8,
      harness: 2,
      byHarnessClass: { timeout: 2 },
    });
  });

  it("fails the bar below 100 gated trials, even when the ledger is consistent", () => {
    const trials = r1Trials().slice(1);
    const r = checkPack(input(trials, manifest({ expectTrials: { "myco-gate": 99 } })));
    expect(r.ok).toBe(true);
    expect(r.r1?.pass).toBe(false);
    expect(r.r1?.reasons).toContain("99 gated trials, fewer than 100");
  });

  it("fails the bar with no fault trial", () => {
    const trials = Array.from({ length: 100 }, (_, i) => trial(i));
    const r = checkPack(input(trials));
    expect(r.r1?.reasons).toContain("no fault trial among the gated trials");
  });

  it("is insufficient evidence, not a pass, when no DONE was accepted (strict R1)", () => {
    const trials = Array.from({ length: 100 }, (_, i) =>
      refuted(i, { faultClass: i < 5 ? "kill-app" : "none" }),
    );
    const r = checkPack(input(trials));
    expect(r.ok).toBe(true);
    expect(r.r1?.pass).toBe(false);
    expect(r.r1?.reasons.join()).toMatch(/insufficient evidence/);
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
    const ug = r1Trials();
    ug[0] = trial(0, {}, "ungradable");
    ug[0]!.arm = { ...ug[0]!.arm, cause: { kind: "harness", detail: "grader could not read" } };
    ug[0]!.ops = { ...ug[0]!.ops, harnessClass: "timeout" };
    r = checkPack(input(ug));
    expect(r.r1?.reasons).toContain("1 accepted DONE could not be graded");
  });

  it("fails on a miscount and on empty ledgers (lesson L3)", () => {
    let r = checkPack(input(r1Trials(), manifest({ expectTrials: { "myco-gate": 101 } })));
    expect(has(r, /100 trials, expected 101/)).toBe(true);
    expect(r.r1?.pass).toBe(false);
    r = checkPack(input([]));
    expect(r.ok).toBe(false);
    expect(has(r, /arm ledger is empty/)).toBe(true);
    expect(has(r, /grade ledger is empty/)).toBe(true);
    expect(has(r, /ops ledger is empty/)).toBe(true);
    expect(r.r1?.pass).toBe(false);
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
    trials[90]!.arm = { ...trials[90]!.arm, cause: null };
    expect(has(checkPack(input(trials)), /g90: non-verified row has no cause/)).toBe(true);
    trials = r1Trials();
    trials[98]!.ops = { ...trials[98]!.ops, harnessClass: null };
    expect(has(checkPack(input(trials)), /g98: harness cause without a harness class/)).toBe(true);
    trials = r1Trials();
    trials[90]!.ops = { ...trials[90]!.ops, harnessClass: "sshd" };
    expect(
      has(
        checkPack(input(trials)),
        /g90: harness class sshd on a row whose cause is not the harness/,
      ),
    ).toBe(true);
    trials = r1Trials();
    trials[98]!.ops = { ...trials[98]!.ops, harnessClass: "gremlins" };
    expect(has(checkPack(input(trials)), /ops row 98: \$\.harnessClass/)).toBe(true);
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
    expect(r.r3).toMatchObject({ pass: true, eligible: 32, falseSuccesses: 0 });
    const by = Object.fromEntries(r.r3!.classes.map((c) => [c.faultClass, c]));
    expect(Object.keys(by)).toEqual(["kill-app", "oracle-input-tamper", "screen-injection"]);
    expect(by["screen-injection"]!.detection).toMatchObject({ numerator: 8, denominator: 8 });
    expect(by["kill-app"]!.falseSuccess.exact95[1]).toBeCloseTo(1 - 0.025 ** (1 / 12), 6);
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
    expect(r.r3?.reasons).toContain("no trial of security class screen-injection");
    expect(r.r3?.reasons).toContain("22 eligible faulted trials, fewer than 30");
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
