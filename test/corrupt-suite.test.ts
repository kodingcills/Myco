import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { corruptionPlan, supplementalCorruptionPlan } from "../scripts/m1-corrupt-suite-params.ts";
import { generateFixture } from "../src/tasks/fixture.ts";
import { groundTruth } from "../src/tasks/intent.ts";

const RECORD = join(__dirname, "..", "scripts", "m1-corrupt-suite-record.py");
const plan = corruptionPlan();

function recorder(trials = plan) {
  const dir = mkdtempSync(join(tmpdir(), "myco-corrupt-recorder-"));
  const manifest = join(dir, "params.json");
  const log = join(dir, "trials.jsonl");
  const out = join(dir, "trial.out");
  writeFileSync(manifest, JSON.stringify(trials));

  function run(command: string, ...args: string[]) {
    return spawnSync("python3", [RECORD, command, manifest, ...args], { encoding: "utf8" });
  }

  function record(
    index: number,
    verdict = "refuted",
    value?: string | null,
    changes: {
      seed?: string;
      sha?: string;
      applied?: boolean;
      recoveryEvents?: string[];
      traceEvents?: string[];
      actionKinds?: string[];
    } = {},
  ) {
    const trial = trials[index];
    if (!trial) throw new Error(`missing trial ${index}`);
    const runId = `run-${index}`;
    const runDir = join(dir, "runs", String(index), runId);
    mkdirSync(runDir, { recursive: true });
    const traceEvents = changes.traceEvents ?? (trial.recovery ? ["retry:1-failed"] : []);
    writeFileSync(
      join(runDir, "trace.jsonl"),
      [
        { type: "run-start", runId },
        { type: "fault-injection", fault: trial.class },
        ...traceEvents.map((event) => ({ type: "recovery", event })),
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    writeFileSync(
      out,
      JSON.stringify({
        runId,
        verdict: { status: verdict, reasons: ["verifier reason"] },
        fixture: {
          seed: changes.seed ?? trial.fixtureSeed,
          csvSha256: changes.sha ?? trial.fixtureSha256,
        },
        corruption: {
          mode: trial.class,
          applied: changes.applied ?? true,
          recovery: trial.recovery,
          persistedValue: value === undefined ? groundTruth(trial).previousValue : value,
          recoveryEvents: changes.recoveryEvents ?? [],
          actionKinds: changes.actionKinds ?? ["setValue"],
        },
      }),
    );
    const result = run("--record", String(index), "report", out);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  function writeRows(rows: unknown[]) {
    writeFileSync(log, rows.map((row) => JSON.stringify(row)).join("\n"));
  }

  function final(rows: unknown[]) {
    writeRows(rows);
    return run("--final", log);
  }

  return {
    record,
    recordMissingReport(index: number) {
      writeFileSync(out, "");
      const result = run("--record", String(index), "report", out);
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    },
    final,
    dir,
    writeRows,
    finalSupplement: () => run("--final-supplement", log),
    pending: () => run("--pending", log),
    ledger: join(dir, "ledger.jsonl"),
    summary: join(dir, "summary.json"),
  };
}

function combined(out: string, ...directories: string[]) {
  return spawnSync("python3", [RECORD, "--final-combined", "--out", out, ...directories], {
    encoding: "utf8",
  });
}

describe("corrupted-suite recorder (host only)", () => {
  it("plans three trials per class and recovery group with distinct fixture seeds, hashes and intents", () => {
    expect(plan).toHaveLength(18);
    expect(new Set(plan.map((p) => p.fixtureSeed)).size).toBe(18);
    expect(new Set(plan.map((p) => p.fixtureSha256)).size).toBe(18);
    expect(new Set(plan.map((p) => p.newValue)).size).toBe(18);
    expect(plan.filter((p) => p.recovery && p.class === "kill")).toHaveLength(3);
    expect(plan.filter((p) => p.recovery && p.class === "invalid-target")).toHaveLength(3);
    expect(corruptionPlan()).toEqual(plan);
    for (const trial of plan) {
      const csv = generateFixture(trial.fixtureSeed).csv;
      expect(trial.fixtureSha256).toBe(createHash("sha256").update(csv).digest("hex"));
      expect(trial.expectedValue).toBe(groundTruth(trial).expectedValue);
    }
  });

  it("passes a complete suite with honest verdicts including a verified recovery", () => {
    const { record, final, summary } = recorder();
    const rows = plan.map((p) => record(p.index));
    rows[4] = record(4, "verified", plan[4]?.expectedValue, {
      traceEvents: ["relaunch:completed"],
    });
    rows[5] = record(5, "verified", plan[5]?.expectedValue, { traceEvents: ["retry:1-completed"] });
    const result = final(rows);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"withVerdict": 18');
    expect(JSON.parse(readFileSync(summary, "utf8"))).toMatchObject({
      ledger: { unaccounted: 0 },
      recoveryResults: expect.arrayContaining([
        expect.objectContaining({ index: 4, recovery: true, verdict: "verified" }),
        expect.objectContaining({ index: 5, recovery: true, verdict: "verified" }),
      ]),
    });
    expect(result.stdout).toContain('"falseSuccesses": 0');
    expect(result.stdout).toContain("54/72");
    expect(result.stdout).toContain("30/30");
  });

  it("flags a verified verdict on the wrong disk value even with a recovery event", () => {
    const { record, final, ledger } = recorder();
    const rows = plan.map((p) => record(p.index));
    rows[4] = record(4, "verified", "WRONG", { traceEvents: ["relaunch:completed"] });
    expect(rows[4]).toMatchObject({
      verdict: "verified",
      expectedValue: plan[4]?.expectedValue,
      persistedValue: "WRONG",
      falseSuccess: true,
    });
    const result = final(rows);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"falseSuccesses": 1');
    expect(JSON.parse(readFileSync(ledger, "utf8").split("\n")[4] ?? "{}")).toMatchObject({
      state: "failure",
      oracle: "ground-truth:false",
    });
  });

  it("classifies applied recovery without trace proof as unproven recovery", () => {
    const { record, final, summary } = recorder();
    const rows = plan.map((p) => record(p.index));
    rows[4] = record(4, "verified", plan[4]?.expectedValue, {
      recoveryEvents: ["relaunch:completed"],
      traceEvents: [],
    });
    expect(rows[4]).toMatchObject({
      falseSuccess: false,
      unprovenRecovery: true,
      recoveryEvents: [],
    });
    rows[4].recoveryEvents = ["relaunch:completed"];
    rows[4].falseSuccess = true;
    const result = final(rows);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"falseSuccesses": 0');
    expect(result.stdout).toContain("RECLASSIFIED index 4: stored true → recomputed false");
    expect(JSON.parse(readFileSync(summary, "utf8"))).toMatchObject({
      unprovenRecovery: 1,
      unprovenRecoveryResults: [
        {
          index: 4,
          storedRecoveryEvents: ["relaunch:completed"],
          recoveryEvents: [],
          countsTowardCoverage: false,
        },
      ],
    });
  });

  it.each([
    [0, false],
    [0, true],
    [4, false],
    [4, true],
  ] as const)(
    "wrong verified disk value is a false success for index %i with faultApplied=%s",
    (index, applied) => {
      const { record } = recorder();
      expect(record(index, "verified", "WRONG", { applied })).toMatchObject({
        verdict: "verified",
        faultApplied: applied,
        falseSuccess: true,
        unprovenVerified: false,
        unprovenRecovery: false,
      });
    },
  );

  it("fails verified with completed recovery and no disk readback", () => {
    const { record, final } = recorder();
    const rows = plan.map((p) => record(p.index));
    rows[4] = record(4, "verified", null, { traceEvents: ["retry:1-completed"] });
    expect(rows[4]).toMatchObject({ falseSuccess: false, unprovenVerified: true });
    expect(final(rows).status).toBe(1);
  });

  it("requires a ladder attempt on a recovery trial even if the verifier abstains", () => {
    const { record, final } = recorder();
    const rows = plan.map((p) => record(p.index));
    rows[5] = record(5, "uncertain", null, { traceEvents: ["aborted-uncertain"] });
    const result = final(rows);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "invalid-target (recovery=yes): fewer than 3 eligible verdicts",
    );
    expect(result.stdout).toContain('"falseSuccesses": 0');
  });

  it.each([{ seed: "wrong-seed" }, { sha: "wrong-hash" }])(
    "records a fixture mismatch and refuses resume",
    (change) => {
      const { record, final, pending } = recorder();
      const rows = plan.map((p) => record(p.index));
      rows[0] = record(0, "refuted", undefined, change);
      expect(rows[0]).toMatchObject({ status: "seed-mismatch" });
      expect(final(rows).status).toBe(1);
      expect(pending().status).toBe(9);
    },
  );

  it("fails class coverage even with seventeen verdicts and skips recorded indices on resume", () => {
    const { record, final, pending } = recorder();
    const rows = plan.map((p) => record(p.index)).slice(1);
    const result = final(rows);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"withVerdict": 17');
    expect(result.stdout).toContain("kill (recovery=no): fewer than 3 eligible verdicts");
    expect(pending().stdout.trim().split("\n")).toEqual([expect.stringMatching(/^0\tkill\t/)]);
  });

  it("does not count verdicts from unapplied faults or duplicate indices", () => {
    const { record, final } = recorder();
    const rows = plan.map((p) => record(p.index, "uncertain", undefined, { applied: false }));
    expect(rows[0]).toMatchObject({ status: "fault-not-applied", verdict: "uncertain" });
    const result = final([...rows, rows[0]]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("duplicate or unexpected trial index");
    expect(result.stdout).toContain("fewer than 10 trials with a verdict");
  });
});

describe("supplemental corrupted batches (host only)", () => {
  it("plans only requested groups with deterministic seeds unique to the batch", () => {
    const trialPlan = supplementalCorruptionPlan("dropped-save:3,kill+recovery:1", "supp-one");
    expect(trialPlan.map((p) => [p.index, p.class, p.recovery])).toEqual([
      [0, "dropped-save", false],
      [1, "dropped-save", false],
      [2, "dropped-save", false],
      [3, "kill", true],
    ]);
    expect(supplementalCorruptionPlan("kill+recovery:1,dropped-save:3", "supp-one")).toEqual(
      trialPlan,
    );
    const all = [
      ...plan,
      ...trialPlan,
      ...supplementalCorruptionPlan("dropped-save:3", "supp-two"),
    ];
    expect(new Set(all.map((p) => p.fixtureSeed)).size).toBe(all.length);
    expect(new Set(all.map((p) => p.fixtureSha256)).size).toBe(all.length);
    expect(trialPlan.every((p) => p.fixtureSeed.startsWith("m1-014s-"))).toBe(true);
  });

  it.each(["", "dropped-save+recovery:3", "kill:0", "kill:1,kill:2", "kill:1:2"])(
    "rejects an invalid group selection %j",
    (selection) => {
      expect(() => supplementalCorruptionPlan(selection, "supp-one")).toThrow(
        "invalid or repeated",
      );
    },
  );

  it("finalizes a recorded supplement and resumes by skipping its existing indices", () => {
    const r = recorder(supplementalCorruptionPlan("dropped-save:1", "supp-one"));
    expect(r.pending().stdout).toMatch(/^0\tdropped-save\tm1-014s-/);
    r.writeRows([r.record(0)]);
    expect(r.pending().stdout).toBe("");
    expect(r.finalSupplement().status).toBe(0);
    expect(r.final([r.record(0)]).status).toBe(1);
  });

  it("passes combined coverage while keeping ineligible main rows and verifying recovery from the supplement trace", () => {
    const main = recorder();
    const supplementPlan = supplementalCorruptionPlan("dropped-save:1,kill+recovery:1", "supp-one");
    const supplement = recorder(supplementPlan);
    main.writeRows(
      plan.map((p) =>
        p.index === 4
          ? main.recordMissingReport(p.index)
          : main.record(p.index, "refuted", undefined, { applied: p.index !== 2 }),
      ),
    );
    supplement.writeRows([
      supplement.record(0),
      supplement.record(1, "verified", supplementPlan[1]?.expectedValue, {
        traceEvents: ["retry:1-completed"],
      }),
    ]);
    const out = join(main.dir, "combined");
    const result = combined(out, main.dir, supplement.dir);
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      total: 20,
      withVerdict: 18,
      falseSuccesses: 0,
      unprovenVerified: 0,
      ineligible: [
        { index: 2, status: "fault-not-applied", countsTowardCoverage: false },
        { index: 4, status: "harness-error", countsTowardCoverage: false },
      ],
      ledger: { gap: 2, pass: 1, unaccounted: 0 },
    });
    expect(summary.groups.map((g: { eligible: number }) => g.eligible)).toEqual([3, 3, 3, 3, 3, 3]);
  });

  it("reclassifies the legacy kill-recovery row when the persisted value matches and the fault never landed", () => {
    const value = "REVISED-419474";
    const mainPlan = plan.map((p) =>
      p.index === 4 ? { ...p, expectedValue: value, newValue: value } : p,
    );
    const main = recorder(mainPlan);
    const supplement = recorder(supplementalCorruptionPlan("kill+recovery:1", "supp-one"));
    const legacy = main.record(4, "verified", value, {
      applied: false,
      traceEvents: [],
      actionKinds: ["click", "setValue", "keyPress"],
    });
    expect(legacy).toMatchObject({
      status: "fault-not-applied",
      falseSuccess: false,
      unprovenRecovery: false,
    });
    const mainRows = mainPlan.map((p) =>
      p.index === 4 ? { ...legacy, falseSuccess: true } : main.record(p.index),
    );
    const standalone = main.final(mainRows);
    expect(standalone.status).toBe(1);
    expect(standalone.stdout).toContain("RECLASSIFIED index 4: stored true → recomputed false");
    supplement.writeRows([supplement.record(0)]);

    const out = join(main.dir, "combined");
    const result = combined(out, main.dir, supplement.dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "RECLASSIFIED index 4: stored true → recomputed false (verified disk value matches and fault did not land)",
    );
    expect(JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))).toMatchObject({
      falseSuccesses: 0,
      unprovenRecovery: 0,
      withVerdict: 18,
      ineligible: [
        {
          index: 4,
          storedFalseSuccess: true,
          falseSuccess: false,
          faultApplied: false,
          status: "fault-not-applied",
          persistedValue: value,
          expectedValue: value,
          countsTowardCoverage: false,
        },
      ],
    });
    expect(
      readFileSync(join(main.dir, "trials.jsonl"), "utf8")
        .split("\n")
        .map((line) => JSON.parse(line))[4],
    ).toMatchObject({ falseSuccess: true });
  });

  it.each(["main", "supplement"])("fails on false success from the %s directory", (source) => {
    const main = recorder();
    const supplement = recorder(supplementalCorruptionPlan("kill+recovery:1", "supp-one"));
    const wrong = { traceEvents: ["retry:1-completed"] };
    main.writeRows(
      plan.map((p) =>
        p.index === 4 && source === "main"
          ? main.record(p.index, "verified", "WRONG", wrong)
          : main.record(p.index),
      ),
    );
    supplement.writeRows([
      source === "supplement"
        ? supplement.record(0, "verified", "WRONG", wrong)
        : supplement.record(0),
    ]);
    const result = combined(join(main.dir, "combined"), main.dir, supplement.dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"falseSuccesses": 1');
  });

  it("refuses duplicate fixture seeds across directories, even without recorded verdicts", () => {
    const repeated = supplementalCorruptionPlan("focus-change:1", "supp-one");
    const a = recorder(repeated);
    const b = recorder(repeated);
    a.writeRows([]);
    b.writeRows([]);
    const result = combined(join(a.dir, "combined"), a.dir, b.dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("duplicate fixture seed");
  });

  it("fails if a group is still short across both directories", () => {
    const main = recorder();
    const supplement = recorder(supplementalCorruptionPlan("focus-change:1", "supp-one"));
    main.writeRows(plan.filter((p) => p.index !== 2).map((p) => main.record(p.index)));
    supplement.writeRows([supplement.record(0)]);
    const result = combined(join(main.dir, "combined"), main.dir, supplement.dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("dropped-save (recovery=no): fewer than 3 eligible verdicts");
    expect(result.stdout).toContain('"withVerdict": 18');
  });
});
