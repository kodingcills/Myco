/**
 * Track E: simulated rows are refused by the M2 evidence-pack CLI (`m2-evidence-check.ts`),
 * even at full size. `checkPack` alone passes a 100-row SIMULATED fc-v1 pack (R1 ok), so the
 * CLI adds the shared check's provenance allowlist (`src/m2/provenance.ts`). No model, no VM.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDryRun } from "../../src/benchmark/r1-dryrun.ts";
import { checkPack } from "../../src/m2/evidence.ts";
import { packProvenanceErrors } from "../../src/m2/provenance.ts";
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
    }));
    const manifest = {
      schema: "myco.m2.pack/1",
      rows: ["R1"],
      expectTrials: { "myco-gate": 100 },
      expectUnregistrable: { "myco-gate": 10 },
      expectPairs: null,
      runs: null,
    };
    const writePack = (root: string, name: string, armRows: readonly unknown[]) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest));
      writeFileSync(join(dir, "arm.jsonl"), jsonl(armRows));
      writeFileSync(join(dir, "grades.jsonl"), jsonl(grades));
      writeFileSync(join(dir, "ops.jsonl"), jsonl(ops));
      return dir;
    };

    // The gap: the pack check's numbers alone accept the simulated rows.
    expect(checkPack({ manifest, arm, grades, ops, readErrors: [], runs: null }).ok).toBe(true);

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
