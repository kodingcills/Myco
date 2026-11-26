/**
 * TIF-274 SIMULATED dry run over the whole fc-v1 task set: the real gate, registry, arm-row
 * mapping, make-requests, grader and check, with a scripted credulous agent. Asserts exact
 * counts, and that the check refuses the ledger as evidence. No model, no VM.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type BenchmarkArmRow, type CheckResult, COST_BASIS } from "../../src/benchmark/check.ts";
import {
  DRY_RUN_PLANNER,
  runDryRun,
  SIMULATED_MARKER,
  scriptedDocument,
} from "../../src/benchmark/r1-dryrun.ts";
import type { BenchmarkTask } from "../../src/benchmark/taskset.ts";
import { parseCsvSpreadsheet } from "../../src/core/filepersist.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { groundTruth } from "../../src/tasks/intent.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, "benchmark", "false-completion", "fc-v1");
const TASKS = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l) as BenchmarkTask);
const SOURCES = ["src/gate/families.ts", "src/gate/calc-document.ts"].map((p) => join(ROOT, p));

const tsx = (script: string, args: string[]) => {
  const r = spawnSync("npx", ["tsx", join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe("TIF-274 simulated dry run over fc-v1", () => {
  it("runs all 100 tasks through the real gate, grader and check, and is refused as evidence", {
    timeout: 180_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-r1-dry-"));
    const { armRows } = await runDryRun(TASKS, dir, SOURCES);
    expect(armRows).toHaveLength(100);
    expect(readFileSync(join(dir, "SIMULATED"), "utf8")).toBe(SIMULATED_MARKER);
    expect(armRows.every((r) => r.plannerModelId === DRY_RUN_PLANNER)).toBe(true);

    const made = tsx("benchmark-make-requests.ts", [
      "--bundle",
      BUNDLE,
      "--arm",
      join(dir, "arm.jsonl"),
      "--docs",
      join(dir, "docs"),
      "--out",
      join(dir, "work"),
    ]);
    expect(made.status, made.stderr).toBe(0);
    const graded = tsx("benchmark-grade.ts", [join(dir, "work", "requests.jsonl")]);
    expect(graded.status, graded.stderr).toBe(0);
    writeFileSync(join(dir, "grades.jsonl"), graded.stdout);

    const checked = tsx("benchmark-check.ts", [
      "--arm",
      join(dir, "arm.jsonl"),
      "--grades",
      join(dir, "grades.jsonl"),
      "--expect",
      "myco-gate=100",
      "--expect-unregistrable",
      "myco-gate=10",
      "--require-r1",
    ]);
    expect(checked.status, checked.stderr).toBe(0);
    const result = JSON.parse(checked.stdout) as CheckResult;
    expect(result.ok).toBe(true);
    // Labelled as not evidence even though the check and R1 pass (#496 round 3).
    expect(result.provenance).toBe("simulated");
    // 60 clean tasks: honest edit, gate verified, accepted. 30 faulted: the gate refutes the
    // untouched or misplaced document. 10 invalid-target: unregistrable, graded fail.
    expect(result.arms[0]).toMatchObject({
      arm: "myco-gate",
      trials: 100,
      claimedDone: 100,
      accepted: 60,
      acceptedPass: 60,
      falseDoneAccepted: 0,
      graderPass: 60,
      graderFail: 40,
      ungradable: 0,
      unregistrable: { trials: 10, claimedDone: 10, graderFailClaimedDone: 10 },
    });
    for (const cls of ["kill-app", "delayed-save", "focus-change", "invalid-target"]) {
      expect(result.arms[0]?.perFaultClass[cls], cls).toEqual({
        trials: 10,
        accepted: 0,
        falseDoneAccepted: 0,
        acceptedUngradable: 0,
      });
    }
    const refutedByGate = armRows.filter((r) => r.gate?.verdict === "refuted").length;
    expect(refutedByGate).toBe(30);
    expect(result.r1).toMatchObject({
      pass: true,
      headline: { numerator: 0, denominator: 100 },
      gated: { trials: 90, accepted: 60, falseDoneAccepted: 0 },
      unregistrable: { trials: 10, claimedDone: 10, graderFailClaimedDone: 10 },
    });
    expect(result.r1?.notes).toHaveLength(1);
    // #509 round 3, N1: a dry run measures no cost. Every row's modelUsd is null, never a
    // measured $0, so the estimate is null with its reason (R7: null cost is never 0).
    expect(armRows.every((r) => r.cost.modelUsd === null)).toBe(true);
    expect(result.arms[0]?.costPerVerifiedTask).toEqual({
      basis: COST_BASIS,
      estimatedUsd: null,
      estimatedTotalModelUsd: null,
      verifiedTasks: 60,
      unmeasuredTrials: 100,
      reason: "100 of 100 trial(s) have no measured model cost",
    });

    const asEvidence = tsx("benchmark-check.ts", [
      "--arm",
      join(dir, "arm.jsonl"),
      "--grades",
      join(dir, "grades.jsonl"),
      "--expect",
      "myco-gate=100",
      "--expect-unregistrable",
      "myco-gate=10",
      "--evidence",
    ]);
    expect(asEvidence.status).toBe(1);
    expect((JSON.parse(asEvidence.stdout) as CheckResult).errors).toContain(
      '100 row(s) without evidence provenance (planner "simulated:scripted-credulous" is not a Claude model id): dry-run rows are never evidence',
    );
  });

  it("the scripted documents follow each fault class (focus-change edits the neighbouring column)", () => {
    for (const task of TASKS) {
      const doc = scriptedDocument(task);
      const pristine = generateFixture(task.fixtureSeed).csv;
      const cells = parseCsvSpreadsheet(doc, "d").cells;
      if (task.faultClass === "none" || task.faultClass === "focus-change")
        expect(doc, task.taskId).not.toBe(pristine);
      else expect(doc, task.taskId).toBe(pristine);
      if (task.faultClass === "focus-change") {
        const target = groundTruth({ fixtureSeed: task.fixtureSeed, ...task.intent }).cellRef;
        expect(cells[target], task.taskId).not.toBe(task.intent.newValue);
        expect(Object.values(cells), task.taskId).toContain(task.intent.newValue);
      }
    }
  });

  it("the public reproduce doc's §1 commands run verbatim and exit as documented (#509 round 3, N2 and N4)", {
    timeout: 300_000,
  }, async () => {
    const doc = readFileSync(
      join(ROOT, "docs", "benchmark", "public", "reproduce-linux.md"),
      "utf8",
    );
    const commands = reproduceCommands(doc);
    // Every command in §1 is classified and run below; none is skipped.
    const gatedCheck = commands.filter((c) => c.includes("myco-gate="));
    const thirdPartyCheck = commands.filter((c) => c.includes("hcu+shell="));
    const common = commands.filter((c) => !gatedCheck.includes(c) && !thirdPartyCheck.includes(c));
    expect(gatedCheck).toHaveLength(1);
    expect(thirdPartyCheck).toHaveLength(1);
    expect(common).toHaveLength(3);
    // N2: the published checks are evidence-mode checks, and the gated one is R1-bound.
    expect(gatedCheck[0]).toContain("--require-r1");
    for (const c of [...gatedCheck, ...thirdPartyCheck]) expect(c).toContain("--evidence");

    // One SIMULATED fc-v1 run supplies the documents and the gated ledger.
    const sim = mkdtempSync(join(tmpdir(), "myco-reproduce-sim-"));
    const { armRows } = await runDryRun(TASKS, sim, SOURCES);
    // The third-party form of the same trials: no gate record, every DONE accepted.
    const asThirdParty = armRows.map(
      (r): BenchmarkArmRow => ({
        ...r,
        arm: "hcu+shell",
        gate: null,
        accepted: r.claim === "done",
      }),
    );
    // TEST-ONLY relabel of the planner to a Claude model id, so the check's exit-0 path is
    // exercised. These rows are still simulated and are never published or counted anywhere.
    const relabel = (rows: readonly BenchmarkArmRow[]) =>
      rows.map((r) => ({ ...r, plannerModelId: "claude-opus-5-5" }));

    const runAll = (rows: readonly BenchmarkArmRow[], check: string) => {
      const release = releaseDir(rows, join(sim, "docs"));
      const results = [...common, check].map((cmd) => {
        // Verbatim: no path rewriting. The release directory links the repository in.
        const r = spawnSync("sh", ["-c", cmd], { cwd: release, encoding: "utf8" });
        return { cmd, status: r.status, stdout: r.stdout, stderr: r.stderr };
      });
      for (const r of results.slice(0, -1))
        expect(r.status, `${r.cmd}\n${r.stderr}${r.stdout.slice(-500)}`).toBe(0);
      expect(existsSync(join(release, "regraded.jsonl"))).toBe(true);
      return results.at(-1) as (typeof results)[number];
    };
    const provenanceError =
      '100 row(s) without evidence provenance (planner "simulated:scripted-credulous" is not a Claude model id): dry-run rows are never evidence';

    // Gated, simulated: exit 1, refused as evidence (documented in §1).
    const gatedSim = runAll(armRows, gatedCheck[0] as string);
    expect(gatedSim.status, gatedSim.stderr).toBe(1);
    expect((JSON.parse(gatedSim.stdout) as CheckResult).errors).toEqual([provenanceError]);
    // Gated, evidence planner: exit 0, R1 bound to fc-v1 and passing.
    const gatedEv = runAll(relabel(armRows), gatedCheck[0] as string);
    expect(gatedEv.status, gatedEv.stderr).toBe(0);
    const gatedEvResult = JSON.parse(gatedEv.stdout) as CheckResult;
    expect(gatedEvResult).toMatchObject({
      ok: true,
      provenance: "evidence",
      taskSetBinding: { applied: true, version: "fc-v1", repetitions: 1 },
      r1: { pass: true, headline: { numerator: 0, denominator: 100 } },
    });
    // Third-party, simulated: exit 1, refused as evidence.
    const thirdSim = runAll(asThirdParty, thirdPartyCheck[0] as string);
    expect(thirdSim.status, thirdSim.stderr).toBe(1);
    expect((JSON.parse(thirdSim.stdout) as CheckResult).errors).toEqual([provenanceError]);
    // Third-party, evidence planner: exit 0. The credulous agent's 40 wrong DONEs are all
    // accepted with no gate, and the check counts them; R1 does not apply to this arm.
    const thirdEv = runAll(relabel(asThirdParty), thirdPartyCheck[0] as string);
    expect(thirdEv.status, thirdEv.stderr).toBe(0);
    const thirdEvResult = JSON.parse(thirdEv.stdout) as CheckResult;
    expect(thirdEvResult).toMatchObject({ ok: true, provenance: "evidence", r1: null });
    expect(thirdEvResult.arms[0]).toMatchObject({
      arm: "hcu+shell",
      trials: 100,
      accepted: 100,
      falseDoneAccepted: 40,
    });
  });

  it("refuses to write under docs/research/experiments", async () => {
    // A temp root whose path contains docs/research/experiments, so a broken guard writes
    // there and never into the repository (#509 round 2, N4).
    const target = join(
      mkdtempSync(join(tmpdir(), "myco-dry-guard-")),
      "docs",
      "research",
      "experiments",
      "dry",
    );
    await expect(runDryRun(TASKS.slice(0, 1), target, SOURCES)).rejects.toThrow(
      /never written under docs\/research\/experiments/,
    );
    expect(existsSync(target)).toBe(false);
  });
});

/** The `npx tsx` commands of the reproduce doc's §1, continuation lines joined, in order. */
function reproduceCommands(doc: string): string[] {
  const section = doc.slice(doc.indexOf("## 1. Regrade"), doc.indexOf("## 2."));
  const blocks = [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  return blocks
    .join("\n")
    .replace(/\\\n\s*/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("npx tsx "));
}

/**
 * A release directory as the doc assumes one: `arm.jsonl` and `docs/` at its root, run from a
 * clone. The clone's files the commands use are linked in, so the commands run unchanged.
 */
function releaseDir(rows: readonly BenchmarkArmRow[], docs: string): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-reproduce-release-"));
  for (const name of ["scripts", "src", "schemas", "benchmark", "node_modules", "package.json"])
    symlinkSync(join(ROOT, name), join(dir, name));
  cpSync(docs, join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "arm.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return dir;
}
