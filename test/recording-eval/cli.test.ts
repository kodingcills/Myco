/**
 * Track R analysis CLI: `hash` prints the committed prereg hash, `manifest --check` confirms
 * the committed fr-v1 manifest, and `analyse` runs the frozen analysis on a pack directory,
 * refusing a simulated pack under `--evidence`. Offline, $0.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalSha256 } from "../../src/recording-eval/canonical.ts";
import { buildPack, discordant, PREREG_DIR, ROOT } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "myco-r-v1-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", join(ROOT, "scripts", "r-v1-analysis.ts"), ...args],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    },
  );

function writePack(name: string, b: ReturnType<typeof buildPack>): string {
  const p = join(dir, name);
  mkdirSync(p);
  writeFileSync(join(p, "pack.json"), JSON.stringify(b.pack));
  writeFileSync(join(p, "trials.jsonl"), `${b.trials.map((t) => JSON.stringify(t)).join("\n")}\n`);
  writeFileSync(join(p, "grades.jsonl"), `${b.grades.map((g) => JSON.stringify(g)).join("\n")}\n`);
  return p;
}

describe("r-v1-analysis CLI", () => {
  it("hash prints the committed pre-registration hash", () => {
    const r = run(["hash"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(readFileSync(join(PREREG_DIR, "prereg.sha256"), "utf8").trim());
  }, 60_000);

  it("manifest --check: the committed fr-v1 manifest matches the builder", () => {
    const r = run(["manifest", "--check"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("MANIFEST_OK");
  }, 60_000);

  it("analyse a simulated pack: analysed, labelled SIMULATED, never evidence", () => {
    const p = writePack("sim", buildPack({ outcome: discordant(8, 0) }));
    const r = run(["analyse", "--pack", p]);
    expect(r.status, r.stdout).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ status: "analysed", evidence: false, barShown: false });
    expect(out.label).toMatch(/SIMULATED/);
  }, 60_000);

  it("analyse --evidence refuses the simulated pack with codes only (exit 1)", () => {
    const p = writePack("sim-ev", buildPack({ outcome: discordant(8, 0) }));
    const r = run(["analyse", "--pack", p, "--evidence"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      status: "refused",
      codes: ["DEMONSTRATION_SIMULATED", "SIMULATED_PLANNER"],
    });
  }, 60_000);

  it("B1 (round 1): the verifier's 8-vs-1 real-model pack under --evidence reports LEAD_RULING_PENDING, never shown", () => {
    const p = writePack(
      "real-8v1",
      buildPack({ planner: "claude-sonnet-5-5", outcome: discordant(8, 1) }),
    );
    const r = run(["analyse", "--pack", p, "--evidence"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ status: "analysed", evidence: true, barShown: false });
    expect(out.leadRulingPending).toBeGreaterThan(0);
    expect(out.primary).toMatchObject({ capabilityOnly: 8, baselineOnly: 1, shown: false });
    expect(out.reading).toMatch(/^LEAD_RULING_PENDING: /);
    expect(out.reading).not.toMatch(/\bshown\b/);
  }, 60_000);

  /** A copy of the files the CLI reads, so a test can edit one without touching the repo. */
  function copyTree(name: string): string {
    const tree = join(dir, `tree-${name.replace(/\W/g, "-")}`);
    const files = [
      "scripts/r-v1-analysis.ts",
      "src/recording-eval/analysis.ts",
      "src/recording-eval/canonical.ts",
      "src/recording-eval/fr-v1.ts",
      "src/recording/scrub.ts",
      "src/tasks/fixture.ts",
      "src/tasks/intent.ts",
      "src/tasks/task-text.ts",
      "docs/product/capability-prereg/r-v1/prereg.json",
      "docs/product/capability-prereg/r-v1/prereg.sha256",
      "docs/product/capability-prereg/r-v1/fr-v1-manifest.json",
    ];
    for (const f of files) {
      mkdirSync(dirname(join(tree, f)), { recursive: true });
      cpSync(join(ROOT, f), join(tree, f));
    }
    return tree;
  }
  const runIn = (tree: string, args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", join(tree, "scripts", "r-v1-analysis.ts"), "analyse", ...args],
      { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 },
    );

  it.each([
    ["the analysis module", "src/recording-eval/analysis.ts"],
    ["the marker scanner (N5)", "src/recording/scrub.ts"],
  ])(
    "a copy of the tree with %s edited refuses ANALYSIS_CODE_CHANGED",
    (_what, edited) => {
      const tree = copyTree(edited);
      const p = writePack(
        `pack-${edited.replace(/\W/g, "-")}`,
        buildPack({ outcome: discordant(8, 0) }),
      );
      // Control: the unmodified copy analyses.
      const ok = runIn(tree, ["--pack", p]);
      expect(ok.status, ok.stdout + ok.stderr).toBe(0);
      appendFileSync(join(tree, edited), "\n// edited after freeze\n");
      const r = runIn(tree, ["--pack", p]);
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout)).toEqual({ status: "refused", codes: ["ANALYSIS_CODE_CHANGED"] });
    },
    60_000,
  );

  it("N-b (round 2): an edited prereg.json and a pack built against it refuse PREREG_NOT_COMMITTED", () => {
    const tree = copyTree("prereg-edited");
    // The verifier's case: empty leadRulingPending in prereg.json and hash the pack against it.
    const b = buildPack({ ruled: true, planner: "claude-sonnet-5-5", outcome: discordant(8, 1) });
    const p = writePack("pack-prereg-edited", b);
    // Control: against the committed prereg this pack is a hash mismatch, not an analysis.
    const before = runIn(tree, ["--pack", p, "--evidence"]);
    expect(before.status).toBe(1);
    expect(JSON.parse(before.stdout)).toEqual({
      status: "refused",
      codes: ["PREREG_HASH_MISMATCH"],
    });
    writeFileSync(
      join(tree, "docs/product/capability-prereg/r-v1/prereg.json"),
      JSON.stringify(b.prereg, null, 2),
    );
    const r = runIn(tree, ["--pack", p, "--evidence"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ status: "refused", codes: ["PREREG_NOT_COMMITTED"] });
    // Re-pinning prereg.sha256 to the edited file is what a new freeze looks like: then it runs.
    writeFileSync(
      join(tree, "docs/product/capability-prereg/r-v1/prereg.sha256"),
      `${canonicalSha256(b.prereg)}\n`,
    );
    const repinned = runIn(tree, ["--pack", p, "--evidence"]);
    expect(repinned.status, repinned.stdout + repinned.stderr).toBe(0);
    expect(JSON.parse(repinned.stdout)).toMatchObject({ status: "analysed", leadRulingPending: 0 });
  }, 60_000);

  it("usage errors exit 3; an unreadable pack is refused, not crashed", () => {
    expect(run(["analyse"]).status).toBe(3);
    expect(run(["nope"]).status).toBe(3);
    const r = run(["analyse", "--pack", join(dir, "missing")]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ status: "refused", codes: ["INPUT_UNREADABLE"] });
  }, 60_000);
});
