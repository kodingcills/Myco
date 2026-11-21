import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    changes: {
      seed?: string;
      sha?: string;
      applied?: boolean;
      recoveryEvents?: string[];
      traceEvents?: string[];
    } = {},
  ) {
    const trial = plan[index];
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

  return {
    record,
    final,
    pending: () => run("--pending", log),
    ledger: join(dir, "ledger.jsonl"),
    summary: join(dir, "summary.json"),
  };
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

  it("flags a matching verified value without recovery in the trace as false success", () => {
    const { record, final } = recorder();
    const rows = plan.map((p) => record(p.index));
    rows[4] = record(4, "verified", plan[4]?.expectedValue, {
      recoveryEvents: ["relaunch:completed"],
      traceEvents: [],
    });
    expect(rows[4]).toMatchObject({ falseSuccess: true, recoveryEvents: [] });
    const result = final(rows);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"falseSuccesses": 1');
  });

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
