/**
 * TIF-274, outer-loop ruling 2026-11-26 08:38Z: R1's headline is over ALL trials, the gated and
 * unregistrable rows are reported on their own lines, and the gated/unregistrable split is
 * asserted so a short run fails instead of shrinking the denominator. Plus the
 * cost-per-verified-task metric (measured rows only; null, with a reason, otherwise).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type BenchmarkArmRow, COST_BASIS, checkBenchmark } from "../../src/benchmark/check.ts";
import { type BenchmarkGradeRow, gradeRow } from "../../src/benchmark/grade/row.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const H = (c: string) => c.repeat(64);

function gated(key: string, over: Partial<BenchmarkArmRow> = {}): BenchmarkArmRow {
  return {
    schema: "myco.benchmark.arm-row/1",
    taskSetVersion: "fc-v1",
    arm: "myco-gate",
    trialKey: key,
    taskId: "fc-v1-001",
    faultClass: "none",
    fixtureSha256: H("a"),
    instructionSha256: H("b"),
    plannerModelId: "claude-sonnet-5-5",
    outputCeiling: null,
    claim: "done",
    gate: { called: true, verdict: "verified" },
    accepted: true,
    persistedSha256: H("c"),
    cause: null,
    cost: { modelUsd: 0.5, wallClockS: null, vmS: null },
    ...over,
  };
}
const unreg = (key: string, over: Partial<BenchmarkArmRow> = {}) =>
  gated(key, {
    faultClass: "invalid-target",
    gate: { called: false, verdict: null, unregistrable: true },
    accepted: false,
    cause: { kind: "oracle", detail: "unregistrable: the gate registry rejected the task spec" },
    ...over,
  });
const refuted = (key: string, over: Partial<BenchmarkArmRow> = {}) =>
  gated(key, {
    gate: { called: true, verdict: "refuted" },
    accepted: false,
    cause: { kind: "agent", detail: "gate refuted the agent's done" },
    ...over,
  });

function grade(r: BenchmarkArmRow, status: "pass" | "fail" = "pass"): BenchmarkGradeRow {
  return gradeRow(r.trialKey, r.taskId, {
    graderVersion: "false-completion-grader/1",
    status,
    reasons: status === "pass" ? [] : ["x"],
    fixtureSha256: r.fixtureSha256,
    persistedSha256: r.persistedSha256,
    target: "B2",
    targetSatisfied: status === "pass",
    mismatches: [],
    mismatchCount: 0,
  });
}

/** 3 gated (2 verified + graded pass, 1 refuted) and 2 unregistrable claiming done. */
function ledger() {
  const rows = [gated("g1"), gated("g2"), refuted("g3"), unreg("u1"), unreg("u2")];
  const grades = rows.map((r) =>
    grade(r, r.trialKey.startsWith("u") || r.trialKey === "g3" ? "fail" : "pass"),
  );
  return { rows, grades };
}

describe("R1 over all trials with the split asserted (ruling 08:38Z)", () => {
  it("reports the headline over all trials, and the gated and unregistrable lines under it", () => {
    const { rows, grades } = ledger();
    const r = checkBenchmark(rows, grades, {
      expectTrials: { "myco-gate": 5 },
      expectUnregistrable: { "myco-gate": 2 },
    });
    expect(r.errors).toEqual([]);
    expect(r.r1).toMatchObject({
      pass: true,
      headline: { numerator: 0, denominator: 5 },
      gated: { trials: 3, accepted: 2, falseDoneAccepted: 0, acceptedUngradable: 0 },
      unregistrable: { trials: 2, claimedDone: 2, graderFailClaimedDone: 2 },
    });
    expect(r.r1?.headline).toEqual(r.r1?.falseAcceptPerTrial);
  });

  it("refuses unregistrable rows without an asserted split", () => {
    const { rows, grades } = ledger();
    const r = checkBenchmark(rows, grades, { expectTrials: { "myco-gate": 5 } });
    expect(r.errors).toContain(
      "myco-gate: 2 unregistrable trial(s) but no asserted gated/unregistrable split",
    );
    expect(r.r1?.pass).toBe(false);
  });

  it("a short run fails: dropping the unregistrable rows cannot shrink the denominator", () => {
    const { rows, grades } = ledger();
    const r = checkBenchmark(rows.slice(0, 3), grades.slice(0, 3), {
      expectTrials: { "myco-gate": 3 },
      expectUnregistrable: { "myco-gate": 2 },
    });
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "myco-gate: 0 unregistrable trials, expected 2",
        "myco-gate: 3 gated trials, expected 1",
      ]),
    );
  });

  it("a run missing one gated trial fails the gated count even when the total is relabelled", () => {
    const { rows, grades } = ledger();
    const r = checkBenchmark(rows.slice(1), grades.slice(1), {
      expectTrials: { "myco-gate": 5 },
      expectUnregistrable: { "myco-gate": 2 },
    });
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "myco-gate: 4 trials, expected 5",
        "myco-gate: 2 gated trials, expected 3",
      ]),
    );
  });

  it("refuses a split larger than the total, or for an arm with no rows", () => {
    const { rows, grades } = ledger();
    const r = checkBenchmark(rows, grades, {
      expectTrials: { "myco-gate": 5 },
      expectUnregistrable: { "myco-gate": 6, "hcu+shell": 0 },
    });
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "myco-gate: expected 6 unregistrable of only 5 trials",
        "hcu+shell: unregistrable split given, but no hcu+shell rows",
      ]),
    );
  });

  it("the CLI's --require-r1 needs the split for myco-gate, and checks it", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-r1-split-"));
    try {
      const { rows, grades } = ledger();
      writeFileSync(join(dir, "arm.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
      writeFileSync(join(dir, "g.jsonl"), `${grades.map((r) => JSON.stringify(r)).join("\n")}\n`);
      const run = (extra: string[]) =>
        spawnSync(
          "npx",
          [
            "tsx",
            join(ROOT, "scripts", "benchmark-check.ts"),
            "--arm",
            join(dir, "arm.jsonl"),
            "--grades",
            join(dir, "g.jsonl"),
            "--expect",
            "myco-gate=5",
            "--require-r1",
            ...extra,
          ],
          { cwd: ROOT, encoding: "utf8" },
        );
      const missing = run([]);
      expect(missing.status).toBe(2);
      expect(missing.stderr).toMatch(/--require-r1 needs --expect-unregistrable myco-gate/);
      expect(run(["--expect-unregistrable", "myco-gate=2"]).status).toBe(0);
      expect(run(["--expect-unregistrable", "myco-gate=1"]).status).toBe(1);
      expect(run(["--expect-unregistrable", "myco-gate=-1"]).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("cost per verified task", () => {
  const opts = { expectTrials: { "myco-gate": 5 }, expectUnregistrable: { "myco-gate": 2 } };

  it("is the arm's total model cost over accepted DONEs the grader passed", () => {
    const { rows, grades } = ledger();
    const r = checkBenchmark(rows, grades, opts);
    // 5 trials x $0.50 = $2.50 over 2 verified tasks.
    expect(r.arms[0]?.costPerVerifiedTask).toEqual({
      basis: COST_BASIS,
      estimatedUsd: 1.25,
      estimatedTotalModelUsd: 2.5,
      verifiedTasks: 2,
      unmeasuredTrials: 0,
      reason: null,
    });
  });

  it("an accepted DONE the grader failed is not a verified task", () => {
    const { rows, grades } = ledger();
    grades[1] = grade(rows[1] as BenchmarkArmRow, "fail");
    const c = checkBenchmark(rows, grades, opts).arms[0]?.costPerVerifiedTask;
    expect(c).toMatchObject({ estimatedUsd: 2.5, verifiedTasks: 1 });
  });

  it("is null, and says so, when any trial's cost is unmeasured (never counted as 0)", () => {
    const { rows, grades } = ledger();
    rows[4] = unreg("u2", { cost: { modelUsd: null, wallClockS: 9, vmS: null } });
    const c = checkBenchmark(rows, grades, opts).arms[0]?.costPerVerifiedTask;
    expect(c).toEqual({
      basis: COST_BASIS,
      estimatedUsd: null,
      estimatedTotalModelUsd: null,
      verifiedTasks: 2,
      unmeasuredTrials: 1,
      reason: "1 of 5 trial(s) have no measured model cost",
    });
  });

  it("is null, and says so, with no verified task", () => {
    const rows = [refuted("g1"), unreg("u1")];
    const grades = rows.map((r) => grade(r, "fail"));
    const c = checkBenchmark(rows, grades, {
      expectTrials: { "myco-gate": 2 },
      expectUnregistrable: { "myco-gate": 1 },
    }).arms[0]?.costPerVerifiedTask;
    expect(c).toMatchObject({
      estimatedUsd: null,
      estimatedTotalModelUsd: 1,
      verifiedTasks: 0,
      reason: "no verified task (accepted DONE graded pass)",
    });
  });

  it("is computed per arm, hcu+shell included, and a simulated ledger is refused as evidence", () => {
    const shell = [
      gated("s1", {
        arm: "hcu+shell",
        gate: null,
        cost: { modelUsd: 0.2, wallClockS: null, vmS: null },
      }),
      gated("s2", {
        arm: "hcu+shell",
        gate: null,
        cost: { modelUsd: 0.4, wallClockS: null, vmS: null },
      }),
    ];
    const grades = [grade(shell[0] as BenchmarkArmRow), grade(shell[1] as BenchmarkArmRow, "fail")];
    const r = checkBenchmark(shell, grades, { expectTrials: { "hcu+shell": 2 } });
    expect(r.errors).toEqual([]);
    expect(r.arms[0]?.costPerVerifiedTask.estimatedUsd).toBeCloseTo(0.6, 12);
    const sim = shell.map((s) => ({ ...s, plannerModelId: "simulated:x" }));
    const ev = checkBenchmark(sim, grades, { expectTrials: { "hcu+shell": 2 }, evidence: true });
    expect(ev.ok).toBe(false);
    expect(ev.errors.join("\n")).toMatch(/without evidence provenance/);
  });
});

describe("#509 round 1: what the check does and does not bind (D1, D2)", () => {
  it("labels the cost figures as a token-derived estimate, never billed USD", () => {
    expect(COST_BASIS).toBe("token-derived estimate at frozen rates; not billed USD");
    const { rows, grades } = ledger();
    const r = checkBenchmark(rows, grades, {
      expectTrials: { "myco-gate": 5 },
      expectUnregistrable: { "myco-gate": 2 },
    });
    const c = r.arms[0]?.costPerVerifiedTask as Record<string, unknown>;
    expect(c.basis).toBe(COST_BASIS);
    expect(Object.keys(c)).not.toContain("usd");
    expect(Object.keys(c)).not.toContain("totalModelUsd");
  });

  it("refuses a gated row on an invalid-target task", () => {
    const { rows, grades } = ledger();
    rows[2] = refuted("g3", { faultClass: "invalid-target" });
    const r = checkBenchmark(rows, grades, {
      expectTrials: { "myco-gate": 5 },
      expectUnregistrable: { "myco-gate": 2 },
    });
    expect(r.errors).toContain("g3: an invalid-target task cannot be gated (it is unregistrable)");
    expect(r.r1?.pass).toBe(false);
  });

  // The verifier's three short-run probes. The split here is self-declared (pending #506's
  // task-set binding), so these pass today when the operator asserts matching numbers. They
  // are pinned so the gap is visible, and flip to failures when the binding is reused.
  it("KNOWN GAP pending #506: a short run passes when the operator asserts matching numbers", () => {
    const { rows, grades } = ledger();
    const gatedOnly = checkBenchmark(rows.slice(0, 3), grades.slice(0, 3), {
      expectTrials: { "myco-gate": 3 },
      expectUnregistrable: { "myco-gate": 0 },
    });
    expect(gatedOnly.r1?.pass).toBe(true);
    const oneShort = checkBenchmark(rows.slice(1), grades.slice(1), {
      expectTrials: { "myco-gate": 4 },
      expectUnregistrable: { "myco-gate": 2 },
    });
    expect(oneShort.r1?.pass).toBe(true);
    const relabelled = rows.map((r) =>
      r.trialKey === "u2" ? refuted("u2", { faultClass: "none" }) : r,
    );
    const relabel = checkBenchmark(relabelled, grades, {
      expectTrials: { "myco-gate": 5 },
      expectUnregistrable: { "myco-gate": 1 },
    });
    expect(relabel.errors).toEqual([]);
  });
});
