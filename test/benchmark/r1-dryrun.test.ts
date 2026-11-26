/**
 * TIF-274 SIMULATED dry run over the whole fc-v1 task set: the real gate, registry, arm-row
 * mapping, make-requests, grader and check, with a scripted credulous agent. Asserts exact
 * counts, and that the check refuses the ledger as evidence. No model, no VM.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import {
  anchorPathFor,
  crossCheckAttempts,
  verifyAnchor,
  verifyAttemptLedger,
} from "../../src/m2/attempt-ledger.ts";
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
    // The runner logged every attempt in the append-only ledger, and it accounts for every row.
    const ledger = verifyAttemptLedger(
      readFileSync(join(dir, "attempts.jsonl"), "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as unknown),
    );
    expect(ledger.errors).toEqual([]);
    expect(ledger.head.events).toBe(200);
    const disclosed = armRows.map((r) => ({
      trialKey: r.trialKey,
      taskId: r.taskId,
      arm: r.arm,
      harnessClass: null,
    }));
    expect(crossCheckAttempts(ledger.events, disclosed, ledger.head, ledger.head)).toEqual([]);
    // The runner's external anchor: outside the run directory, one head per attempt end, and
    // in agreement with the ledger.
    const anchorPath = anchorPathFor(dir);
    expect(anchorPath.startsWith(dir)).toBe(false);
    const anchor = readFileSync(anchorPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as unknown);
    expect(anchor).toHaveLength(100);
    expect(verifyAnchor(anchor, ledger.events, ledger.head)).toEqual([]);
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

  it("the public reproduce doc's §1 setup and commands run verbatim and exit as documented (#509 round 3, N2 and N4; #517 round 1, D1)", {
    timeout: 300_000,
  }, async () => {
    const doc = readFileSync(
      join(ROOT, "docs", "benchmark", "public", "reproduce-linux.md"),
      "utf8",
    );
    const { setup, commands } = reproduceSection(doc);
    // Every command in §1 is classified and run below; none is skipped.
    const gatedCheck = commands.filter((c) => c.includes("myco-gate="));
    const thirdPartyCheck = commands.filter((c) => c.includes("hcu+shell="));
    const common = commands.filter((c) => !gatedCheck.includes(c) && !thirdPartyCheck.includes(c));
    expect(gatedCheck).toHaveLength(1);
    expect(thirdPartyCheck).toHaveLength(1);
    expect(common).toHaveLength(3);
    const [, makeRequests, grade] = common as [string, string, string];
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

    /**
     * The doc's setup block, verbatim, from the clone root. Its mktemp template names
     * `$TMPDIR`, so the release directory lands under this fresh TMPDIR on GNU and BSD
     * mktemp alike (#517 round 2, D1: a bare `mktemp -d` ignored TMPDIR on macOS).
     */
    const runSetup = (releaseFiles: string | undefined, cwd = ROOT) => {
      const tmp = mkdtempSync(join(tmpdir(), "myco-reproduce-tmp-"));
      expect(readdirSync(tmp)).toEqual([]);
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
      delete env.RELEASE_FILES;
      if (releaseFiles !== undefined) env.RELEASE_FILES = releaseFiles;
      const r = spawnSync("sh", ["-c", setup], { cwd, env, encoding: "utf8" });
      return { ...r, tmp };
    };
    const runAll = (rows: readonly BenchmarkArmRow[], check: string) => {
      const published = unpackedRelease(rows, join(sim, "docs"));
      const s = runSetup(published);
      expect(s.status, s.stderr).toBe(0);
      const release = /^release directory: (.+)$/m.exec(s.stdout)?.[1] as string;
      // The setup made exactly one new directory, directly under its TMPDIR. Real paths, so
      // macOS's /var -> /private/var link (and any logical $PWD) compares equal.
      const made = readdirSync(s.tmp);
      expect(made).toHaveLength(1);
      expect(made[0]).toMatch(/^myco-release\./);
      expect(realpathSync(release)).toBe(realpathSync(join(s.tmp, made[0] as string)));
      const results = [...common, check].map((cmd) => {
        // Verbatim: no path rewriting. The setup linked the clone's code in.
        const r = spawnSync("sh", ["-c", cmd], { cwd: release, encoding: "utf8" });
        return { cmd, status: r.status, stdout: r.stdout, stderr: r.stderr };
      });
      for (const r of results.slice(0, -1))
        expect(r.status, `${r.cmd}\n${r.stderr}${r.stdout.slice(-500)}`).toBe(0);
      expect(existsSync(join(release, "regraded.jsonl"))).toBe(true);
      return { release, last: results.at(-1) as (typeof results)[number] };
    };
    const provenanceError =
      '100 row(s) without evidence provenance (planner "simulated:scripted-credulous" is not a Claude model id): dry-run rows are never evidence';

    // D1: the setup fails loudly and creates nothing without a usable release.
    const unset = runSetup(undefined);
    expect(unset.status).not.toBe(0);
    expect(unset.stderr).toContain("set RELEASE_FILES to the unpacked release");
    expect(readdirSync(unset.tmp)).toEqual([]);
    const noDocs = mkdtempSync(join(tmpdir(), "myco-reproduce-nodocs-"));
    writeFileSync(join(noDocs, "arm.jsonl"), "{}\n");
    const partial = runSetup(noDocs);
    expect(partial.status).not.toBe(0);
    expect(readdirSync(partial.tmp)).toEqual([]);
    const usable = unpackedRelease(armRows, join(sim, "docs"));
    const notClone = runSetup(usable, mkdtempSync(join(tmpdir(), "myco-reproduce-elsewhere-")));
    expect(notClone.status).not.toBe(0);
    expect(readdirSync(notClone.tmp)).toEqual([]);

    // D1: in a clone, whose docs/ is Myco's documentation, step 2 refuses and step 3 then
    // fails, instead of grading every trial ungradable with exit 0.
    const clone = mkdtempSync(join(tmpdir(), "myco-reproduce-clone-"));
    mkdirSync(join(clone, ".git"));
    for (const name of LINKED) symlinkSync(join(ROOT, name), join(clone, name));
    mkdirSync(join(clone, "docs"));
    writeFileSync(join(clone, "docs", "README.md"), "Myco's own documentation\n");
    writeFileSync(
      join(clone, "arm.jsonl"),
      `${armRows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    const refused = spawnSync("sh", ["-c", makeRequests], { cwd: clone, encoding: "utf8" });
    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toContain("not a release directory");
    expect(existsSync(join(clone, "work"))).toBe(false);
    const noRequests = spawnSync("sh", ["-c", grade], { cwd: clone, encoding: "utf8" });
    expect(noRequests.status).toBe(1);
    // What the doc's step 3 comment says the reader sees there (#517 round 2, nit 3).
    expect(noRequests.stderr).toContain("ENOENT");
    expect(noRequests.stderr).toContain("work/requests.jsonl");
    expect(statSync(join(clone, "regraded.jsonl")).size).toBe(0);
    // A git worktree's `.git` is a file, not a directory; the guard refuses it too
    // (#517 round 2, nit 1: `test ! -d .git` would let it through).
    const worktree = mkdtempSync(join(tmpdir(), "myco-reproduce-worktree-"));
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");
    for (const name of LINKED) symlinkSync(join(ROOT, name), join(worktree, name));
    cpSync(join(clone, "docs"), join(worktree, "docs"), { recursive: true });
    cpSync(join(clone, "arm.jsonl"), join(worktree, "arm.jsonl"));
    const refusedWorktree = spawnSync("sh", ["-c", makeRequests], {
      cwd: worktree,
      encoding: "utf8",
    });
    expect(refusedWorktree.status, refusedWorktree.stderr).toBe(1);
    expect(refusedWorktree.stderr).toContain("not a release directory");
    expect(existsSync(join(worktree, "work"))).toBe(false);
    // The guard is what makes it loud: the same make-requests without it exits 0 there.
    const unguarded = makeRequests.slice(makeRequests.indexOf("npx tsx "));
    expect(unguarded).not.toContain(".git");
    const silent = spawnSync("sh", ["-c", unguarded], { cwd: clone, encoding: "utf8" });
    expect(silent.status, silent.stderr).toBe(0);

    // Gated, simulated: exit 1, refused as evidence (documented in §1).
    const gatedSim = runAll(armRows, gatedCheck[0] as string).last;
    expect(gatedSim.status, gatedSim.stderr).toBe(1);
    expect((JSON.parse(gatedSim.stdout) as CheckResult).errors).toEqual([provenanceError]);
    // Gated, evidence planner: exit 0, R1 bound to fc-v1 and passing.
    const { release: evRelease, last: gatedEv } = runAll(relabel(armRows), gatedCheck[0] as string);
    expect(gatedEv.status, gatedEv.stderr).toBe(0);
    const gatedEvResult = JSON.parse(gatedEv.stdout) as CheckResult;
    expect(gatedEvResult).toMatchObject({
      ok: true,
      provenance: "evidence",
      taskSetBinding: { applied: true, version: "fc-v1", repetitions: 1 },
      r1: { pass: true, headline: { numerator: 0, denominator: 100 } },
    });
    // The documented usage error: --require-r1 on the gated arm without the split exits 2.
    const noSplit = (gatedCheck[0] as string).replace(" --expect-unregistrable myco-gate=10", "");
    expect(noSplit).not.toBe(gatedCheck[0]);
    const usage = spawnSync("sh", ["-c", noSplit], { cwd: evRelease, encoding: "utf8" });
    expect(usage.status, usage.stderr).toBe(2);
    // Third-party, simulated: exit 1, refused as evidence.
    const thirdSim = runAll(asThirdParty, thirdPartyCheck[0] as string).last;
    expect(thirdSim.status, thirdSim.stderr).toBe(1);
    expect((JSON.parse(thirdSim.stdout) as CheckResult).errors).toEqual([provenanceError]);
    // Third-party, evidence planner: exit 0. The credulous agent's 40 wrong DONEs are all
    // accepted with no gate, and the check counts them; R1 does not apply to this arm.
    const thirdEv = runAll(relabel(asThirdParty), thirdPartyCheck[0] as string).last;
    expect(thirdEv.status, thirdEv.stderr).toBe(0);
    const thirdEvResult = JSON.parse(thirdEv.stdout) as CheckResult;
    expect(thirdEvResult).toMatchObject({ ok: true, provenance: "evidence", r1: null });
    expect(thirdEvResult.arms[0]).toMatchObject({
      arm: "hcu+shell",
      trials: 100,
      accepted: 100,
      falseDoneAccepted: 40,
    });

    // The doc states exactly what this test proves (#517 round 1, nit 4: X5 and X9).
    const flat = doc.replace(/\s+/g, " ");
    for (const claim of [
      "- the setup exits non-zero, creating nothing, when `RELEASE_FILES` is unset, when it names a directory without `docs/`, and when run outside the clone root;",
      "- steps 1-3 exit 0;",
      "- step 2 run in a clone instead exits 1 with \"not a release directory\", whether the clone's `.git` is a directory or a worktree's `.git` file, and step 3 then exits 1,",
      "- the setup makes one new release directory under `$TMPDIR`;",
      "(in a clone: an ENOENT error naming work/requests.jsonl,",
      "and the shell's redirect leaves an empty regraded.jsonl behind)",
      'RELEASE=$(mktemp -d "${TMPDIR:-/tmp}/myco-release.XXXXXX")',
      "- the gated check without `--expect-unregistrable` exits 2;",
      "- both check commands exit 1 on it, with the provenance refusal above;",
      "- **2** on a usage error, including `--require-r1` on the gated arm without `--expect-unregistrable`.",
    ])
      expect(flat).toContain(claim);
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

/** The clone's files the §1 commands use; the doc's setup block links exactly these. */
const LINKED = ["scripts", "src", "schemas", "benchmark", "node_modules", "package.json"];

/**
 * The reproduce doc's §1: its setup block (the one that runs `mktemp`) and every other
 * command line, continuation lines joined, comments dropped, in order.
 */
function reproduceSection(doc: string): { setup: string; commands: string[] } {
  const section = doc.slice(doc.indexOf("## 1. Regrade"), doc.indexOf("## 2."));
  const blocks = [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  const setups = blocks.filter((b) => b.includes("mktemp"));
  expect(setups).toHaveLength(1);
  const setup = setups[0] as string;
  // An explicit template under TMPDIR: GNU and BSD mktemp both honour it, so the test's
  // "creating nothing" checks look where the setup would create (#517 round 2, D1).
  expect(setup).toContain('mktemp -d "${TMPDIR:-/tmp}/myco-release.XXXXXX"');
  // The setup links exactly the files the test's fake clone links.
  for (const name of LINKED) expect(setup).toContain(`"$PWD/${name}"`);
  const commands = blocks
    .filter((b) => b !== setup)
    .join("\n")
    .replace(/\\\n\s*/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  return { setup, commands };
}

/** A release as published and unpacked: `arm.jsonl` and `docs/`, nothing else. */
function unpackedRelease(rows: readonly BenchmarkArmRow[], docs: string): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-reproduce-release-"));
  cpSync(docs, join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "arm.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return dir;
}
