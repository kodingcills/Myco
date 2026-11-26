/**
 * TIF-274 topped-up runs (lead ruling 2026-11-26 12:22Z): a trial lost to a HARNESS fault is
 * re-run in place, its pack row replaced, never appended; the faulted attempt stays in
 * `superseded.jsonl` with its reason, linked to its replacement. Only harness faults may be
 * replaced: never a refuted, accepted, unregistrable or agent-caused (step-budget) attempt.
 * Plus #506 round 3 N2: hcu+shell rows in an R1 pack are outside the task-set binding.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import {
  checkPack,
  type PackResult,
  readPack,
  type SupersededAttempt,
} from "../../src/m2/evidence.ts";
import {
  fcRow,
  fcTasks,
  harnessFault,
  input,
  manifest,
  r1Trials,
  r2Manifest,
  r2Trials,
  refuted,
  type Trial,
  trial,
  unregistrable,
  writePack,
} from "./pack-fixture.ts";

const has = (r: PackResult, pattern: RegExp) => r.errors.some((e) => pattern.test(e));
const LIVE = 61; // r1Trials()[61] is g61, a refuted kill-app trial: the re-run that stands.

/** A faulted attempt of the trial at `LIVE`, under its own key, as `superseded.jsonl` holds it. */
function attempt(
  key: string,
  over: Partial<BenchmarkArmRow> = {},
  replacedBy = `g${LIVE}`,
  t: Trial = harnessFault(0, fcRow(fcTasks("kill-app")[1]!)),
): SupersededAttempt {
  return {
    schema: "myco.m2.superseded/1",
    replacedBy,
    reason: "agent call timed out; re-run in place",
    arm: { ...t.arm, trialKey: key, ...over },
    ops: { ...t.ops, trialKey: key },
  };
}

const check = (superseded: unknown[], trials: Trial[] = r1Trials()) =>
  checkPack({ ...input(trials, manifest()), superseded });

describe("topped-up runs: a harness-faulted trial re-run in place", () => {
  it("passes: the faulted attempt is kept, linked, and never counted", () => {
    const r = check([attempt("g61-a1")]);
    expect(r.errors).toEqual([]);
    expect(r.superseded).toEqual({ count: 1, byHarnessClass: { timeout: 1 } });
    // R1 is unchanged: the re-run is the row.
    expect(r.r1).toMatchObject({ pass: true, counted: 100, allTrials: 100, trials: 90 });
  });

  it("follows a chain of re-runs to the row that stands", () => {
    const r = check([attempt("g61-a1", {}, "g61-a2"), attempt("g61-a2")]);
    expect(r.errors).toEqual([]);
    expect(r.superseded.count).toBe(2);
  });

  it("refuses an appended attempt (still in arm.jsonl)", () => {
    const trials = r1Trials();
    const a = attempt("g61-a1");
    trials.push({ arm: a.arm, grade: { ...trials[LIVE]!.grade, trialKey: "g61-a1" }, ops: a.ops });
    const r = check([a], trials);
    expect(has(r, /superseded g61-a1: still in arm\.jsonl/)).toBe(true);
    expect(r.r1?.pass).toBe(false);
  });

  it.each([
    [
      "a refuted attempt",
      refuted(0, fcRow(fcTasks("kill-app")[1]!)),
      [/only a harness fault may be replaced/, /a gate verdict \(refuted\) is an outcome/],
    ],
    [
      "an agent-caused step-budget stop",
      trial(
        0,
        {
          ...fcRow(fcTasks("kill-app")[1]!),
          claim: "no-claim",
          gate: { called: false, verdict: null },
          cause: { kind: "agent", detail: "step budget exhausted" },
        },
        "fail",
      ),
      [/only a harness fault may be replaced \(cause agent/],
    ],
    [
      "an accepted, verified attempt marked harness",
      trial(0, {
        ...fcRow(fcTasks("kill-app")[1]!),
        cause: { kind: "harness", detail: "x" },
      }),
      [/an accepted DONE is never replaced/, /a gate verdict \(verified\) is an outcome/],
    ],
  ] as const)("refuses %s", (_name, t, want) => {
    const r = check([attempt("g61-a1", {}, `g${LIVE}`, t)]);
    for (const w of want) expect(has(r, w), String(w)).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("refuses an unregistrable attempt", () => {
    const u = unregistrable(0, fcTasks("invalid-target")[0]!);
    const r = check([attempt("g90-a1", {}, "g90", u)]);
    expect(has(r, /superseded g90-a1: an unregistrable trial is never replaced/)).toBe(true);
  });

  it("refuses a replacement that is another trial, a missing link, a loop and a harness fault with no class", () => {
    expect(
      has(
        check([attempt("g61-a1", {}, "g62")]),
        /replacement g62 is another trial \(taskId differs\)/,
      ),
    ).toBe(true);
    expect(
      has(
        check([attempt("g61-a1", {}, "g999")]),
        /replacedBy g999 is neither in arm\.jsonl nor superseded/,
      ),
    ).toBe(true);
    expect(
      has(
        check([attempt("g61-a1", {}, "g61-a2"), attempt("g61-a2", {}, "g61-a1")]),
        /replacement chain loops/,
      ),
    ).toBe(true);
    const noClass = attempt("g61-a1");
    const r = check([{ ...noClass, ops: { ...noClass.ops, harnessClass: null } }]);
    expect(
      has(r, /only a harness fault may be replaced \(cause harness, harness class none\)/),
    ).toBe(true);
    expect(has(check([attempt("g61-a1"), attempt("g61-a1")]), /duplicate attempt g61-a1/)).toBe(
      true,
    );
    expect(has(check([{ ...attempt("g61-a1"), extra: 1 }]), /^superseded row 0: /)).toBe(true);
  });

  it("reads superseded.jsonl from a pack directory", () => {
    const dir = writePack("m2-topped", r1Trials(), manifest());
    writeFileSync(join(dir, "superseded.jsonl"), `${JSON.stringify(attempt("g61-a1"))}\n`);
    const read = readPack(dir, () => ({ ok: true, detail: "not called" }));
    expect(read.superseded).toHaveLength(1);
    const r = checkPack(read);
    expect(r.errors).toEqual([]);
    expect(r.superseded.count).toBe(1);
    expect(readFileSync(join(dir, "superseded.jsonl"), "utf8")).toContain("g61-a1");
  });
});

describe("#506 round 3 N2: hcu+shell rows in an R1 pack are outside the task-set binding", () => {
  it("binds only the gated arm", () => {
    const trials = r1Trials();
    // Two hcu+shell rows on fc-v1 with made-up task ids and dummy hashes: the binding would
    // refuse them if it covered that arm.
    const shell = [0, 1].map((i) =>
      trial(200 + i, { arm: "hcu+shell", gate: null, taskSetVersion: "fc-v1" }),
    );
    const r = checkPack(
      input(
        [...trials, ...shell],
        manifest({ expectTrials: { "myco-gate": 100, "hcu+shell": 2 } }),
      ),
    );
    expect(r.errors.filter((e) => e.startsWith("R1 task set"))).toEqual([]);
    expect(r.r1?.pass).toBe(true);
  });
});

describe("#511 round 1: verdicts, R7 cost, same settings, and the unpinned checks", () => {
  /** A harness-faulted attempt of the live row `live`, under its own key. */
  const attemptOf = (
    live: BenchmarkArmRow,
    key: string,
    over: Partial<BenchmarkArmRow> = {},
    harnessClass: "timeout" | "sshd" = "timeout",
  ): SupersededAttempt => ({
    schema: "myco.m2.superseded/1",
    replacedBy: live.trialKey,
    reason: "lost to the harness; re-run in place",
    arm: {
      ...live,
      trialKey: key,
      claim: "no-claim",
      gate: live.gate === null ? null : { called: false, verdict: null },
      accepted: false,
      persistedSha256: null,
      cause: { kind: "harness", detail: "harness fault" },
      ...over,
    },
    ops: {
      schema: "myco.m2.trial-ops/1",
      trialKey: key,
      hostLoad1mStart: 1,
      harnessClass,
      faultLanded: live.faultClass === "none" ? null : true,
    },
  });
  const live = () => r1Trials()[LIVE]!.arm;

  it("D1: an uncertain verdict is an outcome and is never replaced", () => {
    const r = check([
      attemptOf(live(), "g61-a1", { claim: "done", gate: { called: true, verdict: "uncertain" } }),
    ]);
    expect(
      has(r, /superseded g61-a1: a gate verdict \(uncertain\) is an outcome, never replaced/),
    ).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("D2 (lead 13:42Z): a superseded attempt's cost counts in R7's numerator; a null cost makes it unmeasured", () => {
    const trials = r2Trials();
    const g0 = trials[0]!.arm;
    const base = checkPack({ ...input(trials, r2Manifest()), superseded: [] });
    const gate0 = base.r7?.arms.find((a) => a.arm === "myco-gate");
    expect(gate0).toMatchObject({ trials: 30, supersededAttempts: 0, verified: 20 });
    expect(gate0?.modelUsd.total).toBeCloseTo(15, 9);
    // The verifier's probe: one superseded attempt that cost $100.
    const spent = attemptOf(g0, "g0-a1", { cost: { modelUsd: 100, wallClockS: 10, vmS: 5 } });
    const r = checkPack({ ...input(trials, r2Manifest()), superseded: [spent] });
    expect(r.errors).toEqual([]);
    const gate = r.r7?.arms.find((a) => a.arm === "myco-gate");
    expect(gate).toMatchObject({ trials: 30, supersededAttempts: 1, verified: 20 });
    expect(gate?.modelUsd.total).toBeCloseTo(115, 9);
    expect(gate?.modelUsd.perVerified).toBeCloseTo(115 / 20, 9);
    // The attempt is charged to its own arm only (#511 round 2, E1 / M7).
    const shell = r.r7?.arms.find((a) => a.arm === "hcu+shell");
    expect(shell).toMatchObject({ supersededAttempts: 0 });
    expect(shell?.modelUsd.total).toBeCloseTo(15, 9);
    // R2 is untouched: still 30 pairs.
    expect(r.r2?.pairs).toBe(30);
    // A null cost on the attempt: unmeasured, never 0.
    const unmeasured = attemptOf(g0, "g0-a1", { cost: { modelUsd: null, wallClockS: 10, vmS: 5 } });
    const n = checkPack({ ...input(trials, r2Manifest()), superseded: [unmeasured] });
    const nGate = n.r7?.arms.find((a) => a.arm === "myco-gate");
    expect(nGate?.modelUsd).toEqual({ total: null, nullRows: 1, perVerified: null });
    expect(n.r7?.reasons).toContain("myco-gate: modelUsd unmeasured on 1 rows");
  });

  it.each([
    ["fixtureSha256", { fixtureSha256: "c".repeat(64) }],
    ["instructionSha256", { instructionSha256: "d".repeat(64) }],
    ["plannerModelId", { plannerModelId: "claude-haiku-5-5" }],
    ["outputCeiling", { outputCeiling: 1024 }],
    ["faultClass", { faultClass: "delayed-save" }],
    ["arm", { arm: "hcu+shell", gate: null }],
    ["taskSetVersion", { taskSetVersion: "fc-v9" }],
  ] as const)("D3/D5: a replacement whose %s differs is another trial", (field, over) => {
    const r = check([attemptOf(live(), "g61-a1", over)]);
    expect(has(r, new RegExp(`replacement g61 is another trial \\(${field} differs\\)`))).toBe(
      true,
    );
  });

  it("D4: an attempt on an unsatisfiable task is never topped up", () => {
    const g90 = r1Trials()[90]!.arm;
    const a = attemptOf(g90, "g90-a1", { gate: { called: false, verdict: null } });
    const r = check([a]);
    expect(
      has(r, /superseded g90-a1: task fc-v1-\d+ is unsatisfiable; re-pack, never top up/),
    ).toBe(true);
  });

  it("nit 2: an hcu+shell attempt on an invalid-target task may be re-run (no gate, no binding rule)", () => {
    const inv = fcTasks("invalid-target")[0]!;
    const shellLive = trial(
      300,
      {
        ...fcRow(inv),
        arm: "hcu+shell",
        gate: null,
        cause: { kind: "agent", detail: "claimed done" },
      },
      "fail",
      { faultLanded: true },
    );
    const trials = [...r1Trials(), shellLive];
    const r = checkPack({
      ...input(trials, manifest({ expectTrials: { "myco-gate": 100, "hcu+shell": 1 } })),
      superseded: [attemptOf(shellLive.arm, "s300-a1")],
    });
    expect(r.errors).toEqual([]);
    expect(r.superseded.count).toBe(1);
  });

  it("D3: counts attempts by their own harness class", () => {
    const r = check([attemptOf(live(), "g61-a1", {}, "sshd")]);
    expect(r.errors).toEqual([]);
    expect(r.superseded).toEqual({ count: 1, byHarnessClass: { sshd: 1 } });
  });

  it("D3: a tail cycle is refused and the walk ends", () => {
    const a = attemptOf(live(), "a");
    const r = check([
      { ...a, replacedBy: "b" },
      { ...attemptOf(live(), "b"), replacedBy: "c" },
      { ...attemptOf(live(), "c"), replacedBy: "b" },
    ]);
    expect(has(r, /superseded a: its replacement chain loops at b/)).toBe(true);
  });

  it("D3: duplicates count once; an ops row for another key; a non-harness cause with a class", () => {
    const dup = check([attemptOf(live(), "g61-a1"), attemptOf(live(), "g61-a1")]);
    expect(dup.superseded.count).toBe(1);
    const a = attemptOf(live(), "g61-a1");
    const wrongOps = check([{ ...a, ops: { ...a.ops, trialKey: "g61-zz" } }]);
    expect(has(wrongOps, /superseded g61-a1: its trial-ops row is for g61-zz/)).toBe(true);
    const agent = check([
      attemptOf(live(), "g61-a1", { cause: { kind: "agent", detail: "wrong cell" } }),
    ]);
    expect(
      has(agent, /only a harness fault may be replaced \(cause agent, harness class timeout\)/),
    ).toBe(true);
  });
});
