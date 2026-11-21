import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { corruptionPlan } from "../scripts/m1-corrupt-suite-params.ts";
import { generateFixture } from "../src/tasks/fixture.ts";
import { groundTruth } from "../src/tasks/intent.ts";

const RECORD = join(__dirname, "..", "scripts", "m1-corrupt-suite-record.py");
const plan = corruptionPlan();

function recorder() {
  const dir = mkdtempSync(join(tmpdir(), "myco-corrupt-recorder-"));
  const manifest = join(dir, "params.json");
  const log = join(dir, "trials.jsonl");
  const out = join(dir, "trial.out");
  writeFileSync(manifest, JSON.stringify(plan));

  function run(command: string, ...args: string[]) {
    return spawnSync("python3", [RECORD, command, manifest, ...args], { encoding: "utf8" });
  }

  function record(
    index: number,
    verdict = "refuted",
    value?: string | null,
    changes: { seed?: string; sha?: string; applied?: boolean; recoveryEvents?: string[] } = {},
  ) {
    const trial = plan[index];
    if (!trial) throw new Error(`missing trial ${index}`);
    writeFileSync(
      out,
      JSON.stringify({
        runId: `run-${index}`,
        verdict: { status: verdict, reasons: ["verifier reason"] },
        fixture: {
          seed: changes.seed ?? trial.fixtureSeed,
          csvSha256: changes.sha ?? trial.fixtureSha256,
        },
        corruption: {
          mode: trial.class,
          applied: changes.applied ?? true,
          persistedValue: value === undefined ? groundTruth(trial).previousValue : value,
          recoveryEvents: changes.recoveryEvents ?? [],
          actionKinds: ["setValue"],
        },
      }),
    );
    const result = run("--record", String(index), "report", out);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  function final(rows: unknown[]) {
    writeFileSync(log, rows.map((row) => JSON.stringify(row)).join("\n"));
    return run("--final", log);
  }

  return { record, final, pending: () => run("--pending", log), ledger: join(dir, "ledger.jsonl") };
}

describe("corrupted-suite recorder (host only)", () => {
  it("plans three trials per class with distinct fixture seeds, hashes and intents", () => {
    expect(plan).toHaveLength(12);
    expect(new Set(plan.map((p) => p.fixtureSeed)).size).toBe(12);
    expect(new Set(plan.map((p) => p.fixtureSha256)).size).toBe(12);
    expect(new Set(plan.map((p) => p.newValue)).size).toBe(12);
    expect(corruptionPlan()).toEqual(plan);
    for (const trial of plan) {
      const csv = generateFixture(trial.fixtureSeed).csv;
      expect(trial.fixtureSha256).toBe(createHash("sha256").update(csv).digest("hex"));
      expect(trial.expectedValue).toBe(groundTruth(trial).expectedValue);
    }
  });

  it("passes a complete suite with honest verdicts including a verified recovery", () => {
    const { record, final } = recorder();
    const rows = plan.map((p) => record(p.index));
    rows[0] = record(0, "verified", plan[0]?.expectedValue, {
      recoveryEvents: ["retry:1-completed"],
    });
    const result = final(rows);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"withVerdict": 12');
    expect(result.stdout).toContain('"falseSuccesses": 0');
    expect(result.stdout).toContain("54/72");
    expect(result.stdout).toContain("30/30");
  });

  it("flags a verified verdict on the wrong disk value even with a recovery event", () => {
    const { record, final, ledger } = recorder();
    const rows = plan.map((p) => record(p.index));
    rows[0] = record(0, "verified", "WRONG", { recoveryEvents: ["relaunch:completed"] });
    expect(rows[0]).toMatchObject({
      verdict: "verified",
      expectedValue: plan[0]?.expectedValue,
      persistedValue: "WRONG",
      falseSuccess: true,
    });
    const result = final(rows);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"falseSuccesses": 1');
    expect(JSON.parse(readFileSync(ledger, "utf8").split("\n")[0] ?? "{}")).toMatchObject({
      state: "failure",
      oracle: "ground-truth:false",
    });
  });

  it("fails verified with a matching value and no completed recovery", () => {
    const { record, final } = recorder();
    const rows = plan.map((p) => record(p.index));
    rows[0] = record(0, "verified", plan[0]?.expectedValue, {
      recoveryEvents: ["re-observe:already-satisfied"],
    });
    expect(rows[0]).toMatchObject({ falseSuccess: false, unprovenVerified: true });
    const result = final(rows);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"unprovenVerified": 1');
  });

  it("fails verified with completed recovery and no disk readback", () => {
    const { record, final } = recorder();
    const rows = plan.map((p) => record(p.index));
    rows[0] = record(0, "verified", null, { recoveryEvents: ["retry:1-completed"] });
    expect(rows[0]).toMatchObject({ falseSuccess: false, unprovenVerified: true });
    expect(final(rows).status).toBe(1);
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

  it("fails class coverage even with eleven verdicts and skips recorded indices on resume", () => {
    const { record, final, pending } = recorder();
    const rows = plan.map((p) => record(p.index)).slice(1);
    const result = final(rows);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"withVerdict": 11');
    expect(result.stdout).toContain("kill: fewer than 3 trials");
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
