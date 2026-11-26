/**
 * Track E: simulated rows are refused by the M2 evidence-pack CLI (`m2-evidence-check.ts`),
 * even at full size. `checkPack` alone passes a 100-row SIMULATED fc-v1 pack (R1 ok) that carries
 * a valid attempt ledger, pin and host-side anchor (#518: an R1 pack without them is refused
 * before provenance matters), so the CLI adds the shared check's provenance allowlist
 * (`src/m2/provenance.ts`). No model, no VM.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import type { BenchmarkGradeRow } from "../../src/benchmark/grade/row.ts";
import { runDryRun } from "../../src/benchmark/r1-dryrun.ts";
import { anchorPathFor } from "../../src/m2/attempt-ledger.ts";
import { checkPack, type TrialOps } from "../../src/m2/evidence.ts";
import { packProvenanceErrors } from "../../src/m2/provenance.ts";
import { anchorFor, ledgerFor } from "../m2/pack-fixture.ts";
import { PUBLISHED, ROOT, SOURCES, tmp } from "./helpers.ts";

const tsx = (script: string, args: string[]) =>
  spawnSync("npx", ["tsx", join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
const lines = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const jsonl = (rows: readonly unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

describe("M2 pack CLI refuses simulated rows (track E)", () => {
  it("a full-size SIMULATED fc-v1 pack: checkPack passes it, the CLI refuses it on provenance", {
    timeout: 180_000,
  }, async () => {
    const run = tmp();
    await runDryRun(PUBLISHED, run, SOURCES);
    const made = tsx("benchmark-make-requests.ts", [
      "--bundle",
      join(ROOT, "benchmark", "false-completion", "fc-v1"),
      "--arm",
      join(run, "arm.jsonl"),
      "--docs",
      join(run, "docs"),
      "--out",
      join(run, "work"),
    ]);
    expect(made.status, made.stderr).toBe(0);
    const graded = tsx("benchmark-grade.ts", [join(run, "work", "requests.jsonl")]);
    expect(graded.status, graded.stderr).toBe(0);

    const arm = lines(readFileSync(join(run, "arm.jsonl"), "utf8"));
    const grades = lines(graded.stdout);
    const ops = arm.map((r) => ({
      schema: "myco.m2.trial-ops/1",
      trialKey: r.trialKey,
      hostLoad1mStart: 0,
      harnessClass: null,
      faultLanded: r.faultClass === "none" ? null : true,
      // TIF-98: every trial-ops row records its reset's cold boot (required).
      resetBootClass: "cold",
      resetGuestCpuFirstSshS: 280,
    }));
    // The attempt ledger an honest runner writes for these trials (#518, the shared fixture's
    // `ledgerFor`/`anchorFor`): one start and one completed end per trial, no harness faults.
    // The events name only trialKey, taskId and arm, so the relabelled rows below share it.
    const { events, head } = ledgerFor(
      arm.map((r, i) => ({
        arm: r as unknown as BenchmarkArmRow,
        grade: grades[i] as unknown as BenchmarkGradeRow,
        ops: ops[i] as unknown as TrialOps,
      })),
    );
    const anchor = anchorFor(events);
    const manifest = {
      schema: "myco.m2.pack/1",
      rows: ["R1"],
      expectTrials: { "myco-gate": 100 },
      expectUnregistrable: { "myco-gate": 10 },
      expectPairs: null,
      runs: null,
      attempts: head,
    };
    const writePack = (root: string, name: string, armRows: readonly unknown[]) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest));
      writeFileSync(join(dir, "attempts.jsonl"), jsonl(events));
      // The external anchor: outside the pack, at its conventional host-side path.
      mkdirSync(dirname(anchorPathFor(dir)), { recursive: true });
      writeFileSync(anchorPathFor(dir), jsonl(anchor));
      writeFileSync(join(dir, "arm.jsonl"), jsonl(armRows));
      writeFileSync(join(dir, "grades.jsonl"), jsonl(grades));
      writeFileSync(join(dir, "ops.jsonl"), jsonl(ops));
      return dir;
    };

    // The gap: the pack check (its numbers, the attempt ledger, the pin and the anchor) accepts
    // the simulated rows.
    const packInput = { manifest, arm, grades, ops, readErrors: [], runs: null };
    const full = checkPack({ ...packInput, attempts: events, anchor });
    expect(full.errors).toEqual([]);
    expect(full.ok).toBe(true);
    // ...and that pass rests on the ledger: without it (#518) the same R1 pack is refused.
    const { attempts: _pin, ...unpinned } = manifest;
    expect(checkPack({ ...packInput, manifest: unpinned }).errors).toContain(
      "attempts.jsonl: missing (the attempt ledger)",
    );

    const root = tmp();
    const dir = writePack(root, "m2-simulated", arm);
    expect(packProvenanceErrors(dir, arm)).toEqual([
      '100 arm row(s) without evidence provenance (planner "simulated:scripted-credulous" is not a Claude model id): simulated rows are never evidence',
    ]);
    const refused = tsx("m2-evidence-check.ts", ["--all", "--root", root]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(
      /ERROR \S*m2-simulated: provenance: 100 arm row\(s\) without evidence provenance/,
    );
    // Refused on provenance alone: the ledger, pin and anchor the CLI read back all pass.
    // npm's own "npm warn ..." config notices (seen in CI) are not the CLI's output; drop
    // only those, so any other stray line (e.g. a ledger ERROR) still fails this assertion.
    const cliLines = refused.stderr
      .trim()
      .split("\n")
      .filter((line) => !line.startsWith("npm warn "));
    expect(cliLines).toEqual([expect.stringMatching(/^ERROR \S*m2-simulated: provenance: /)]);

    // The check is about provenance only: the same rows under a Claude planner pass the CLI
    // (a declared string; this stops mislabelled dry runs, not a deliberate forgery).
    const root2 = tmp();
    writePack(
      root2,
      "m2-labelled",
      arm.map((r) => ({ ...r, plannerModelId: "claude-sonnet-5-5" })),
    );
    const labelled = tsx("m2-evidence-check.ts", ["--all", "--root", root2]);
    expect(labelled.status, labelled.stderr).toBe(0);

    // A SIMULATED marker in the pack directory is refused too.
    writeFileSync(join(dir, "SIMULATED"), "x\n");
    expect(packProvenanceErrors(dir, [])).toEqual([
      "the pack carries a SIMULATED marker: simulated rows are never evidence",
    ]);
  });
});
