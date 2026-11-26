/**
 * Track E: the SIMULATED pilot dry run exercises the full path end to end (runner, launch
 * audit, real gate on a sealed vault, arm rows, ledger, export, the independent grader, the
 * shared check and the M2 pack check) with a fake transport and $0, and is refused as
 * evidence. No model, no VM.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CheckResult, COST_BASIS, checkBenchmark } from "../../src/benchmark/check.ts";
import { checkPack } from "../../src/m2/evidence.ts";
import { estimatedCostPerVerified } from "../../src/pilot/cost.ts";
import { fakeDriver, PILOT_DRY_RUN_PLANNER } from "../../src/pilot/dry-run.ts";
import { ledgerRows, loadLedger, PROGRESS_FILE } from "../../src/pilot/ledger.ts";
import { exportRun, HarnessFault, SIMULATED_FILE } from "../../src/pilot/runner.ts";
import { dryRun, ROOT, tmp } from "./helpers.ts";

const BUNDLE = join(ROOT, "benchmark", "false-completion", "fc-v1");
const tsx = (script: string, args: string[]) =>
  spawnSync("npx", ["tsx", join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
const jsonl = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);

describe("SIMULATED pilot dry run (track E)", () => {
  it("runs the full path end to end and is refused as evidence", { timeout: 120_000 }, async () => {
    const dir = tmp();
    let n = 0;
    const usage = {
      inputTokens: 20_000,
      outputTokens: 1_500,
      cacheReadInputTokens: 100_000,
      cacheCreationInputTokens: 10_000,
    };
    const driver = fakeDriver({
      // One harness fault on the way, so a superseded attempt and its cost are exercised too.
      beforeAgent: () => {
        if (++n === 7) throw new HarnessFault("transport-error", "fake transport dropped", usage);
      },
      usage: () => usage,
    });
    const { result } = await dryRun(dir, { driver });
    expect(result).toMatchObject({ status: "complete", ran: 30, faulted: 1 });
    expect(readFileSync(join(dir, SIMULATED_FILE), "utf8")).toMatch(/Never evidence/);
    expect(loadLedger(join(dir, PROGRESS_FILE)).header).toMatchObject({
      simulated: true,
      plannerModelId: PILOT_DRY_RUN_PLANNER,
    });

    const exp = join(tmp(), "export");
    exportRun(dir, exp);
    expect(() => exportRun(dir, exp)).toThrow(/never overwrites/);
    expect(existsSync(join(exp, SIMULATED_FILE))).toBe(true);
    const arm = jsonl(join(exp, "arm.jsonl"));
    expect(arm).toHaveLength(30);
    const superseded = jsonl(join(exp, "faulted-attempts.jsonl")) as { replacedBy: string }[];
    expect(superseded).toHaveLength(1);
    expect((arm as { trialKey: string }[]).map((r) => r.trialKey)).toContain(
      superseded[0]?.replacedBy,
    );

    const made = tsx("benchmark-make-requests.ts", [
      "--bundle",
      BUNDLE,
      "--arm",
      join(exp, "arm.jsonl"),
      "--docs",
      join(exp, "docs"),
      "--out",
      join(exp, "work"),
    ]);
    expect(made.status, made.stderr).toBe(0);
    const graded = tsx("benchmark-grade.ts", [join(exp, "work", "requests.jsonl")]);
    expect(graded.status, graded.stderr).toBe(0);
    writeFileSync(join(exp, "grades.jsonl"), graded.stdout);
    const grades = jsonl(join(exp, "grades.jsonl"));

    // As plumbing: the shared check passes and labels the rows simulated.
    const opts = { expectTrials: { "myco-gate": 30 }, expectUnregistrable: { "myco-gate": 3 } };
    const plumbing = checkBenchmark(arm, grades, opts);
    expect(plumbing.errors).toEqual([]);
    expect(plumbing.provenance).toBe("simulated");
    expect(plumbing.arms[0]).toMatchObject({
      trials: 30,
      accepted: 18,
      acceptedPass: 18,
      falseDoneAccepted: 0,
      unregistrable: { trials: 3 },
    });
    // R7: a token-derived ESTIMATE, labelled; the faulted attempt's cost counts too.
    expect(plumbing.arms[0]?.costPerVerifiedTask.basis).toBe(COST_BASIS);
    const { costs } = ledgerRows(loadLedger(join(dir, PROGRESS_FILE)));
    expect(costs).toHaveLength(31);
    const r7 = estimatedCostPerVerified(costs, 18);
    expect(r7.basis).toBe(COST_BASIS);
    // Per attempt: 20k x 2 + 1.5k x 10 + 100k x 0.1 + 10k x 2.5 micros = $0.09 (an estimate).
    expect(r7.total).toBeCloseTo(31 * 0.09, 6);
    expect(r7.perVerified).toBeCloseTo((31 * 0.09) / 18, 6);

    // As evidence: refused (the shared check, in process and through its CLI).
    const evidence = checkBenchmark(arm, grades, { ...opts, evidence: true });
    expect(evidence.ok).toBe(false);
    expect(evidence.errors).toContain(
      `30 row(s) without evidence provenance (planner "${PILOT_DRY_RUN_PLANNER}" is not a Claude model id): dry-run rows are never evidence`,
    );
    const cli = tsx("benchmark-check.ts", [
      "--arm",
      join(exp, "arm.jsonl"),
      "--grades",
      join(exp, "grades.jsonl"),
      "--expect",
      "myco-gate=30",
      "--expect-unregistrable",
      "myco-gate=3",
      "--evidence",
    ]);
    expect(cli.status).toBe(1);
    expect((JSON.parse(cli.stdout) as CheckResult).errors.join("\n")).toMatch(
      /without evidence provenance/,
    );

    // The M2 evidence-pack check refuses it as an R1 pack.
    const pack = checkPack({
      manifest: {
        schema: "myco.m2.pack/1",
        rows: ["R1"],
        expectTrials: { "myco-gate": 30 },
        expectUnregistrable: { "myco-gate": 3 },
        expectPairs: null,
        runs: null,
      },
      arm,
      grades,
      ops: (arm as { trialKey: string; faultClass: string }[]).map((r) => ({
        schema: "myco.m2.trial-ops/1",
        trialKey: r.trialKey,
        hostLoad1mStart: 0,
        harnessClass: null,
        faultLanded: r.faultClass === "none" ? null : true,
        // TIF-98: every trial-ops row records its reset's cold boot (required).
        resetBootClass: "cold",
        resetGuestCpuFirstSshS: 280,
      })),
      readErrors: [],
      runs: null,
    });
    expect(pack.ok).toBe(false);
  });

  it("refuses to write a run under docs/research/experiments", async () => {
    const target = join(tmp(), "docs", "research", "experiments", "pilot");
    await expect(dryRun(target)).rejects.toThrow(/never under docs\/research\/experiments/);
    expect(existsSync(target)).toBe(false);
  });
});
