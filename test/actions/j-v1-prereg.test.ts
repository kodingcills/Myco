/**
 * Track J, j-v1: the committed pre-registration is what capability spec §3 asks for, and is
 * pinned: the analysis script's bytes match its SHA-256, the task set matches fc-v1's
 * satisfiable tasks and manifest, the bar is the spec's as written, and the
 * pre-registration hash is stated where packs and reviewers read it.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  J_BASELINE_ARM,
  J_CAPABILITY_ARM,
  preregHash,
} from "../../src/actions/j-v1-analysis.ts";
import {
  J_V1_ANALYSIS_PATH,
  J_V1_PREREG_PATH,
  loadJV1Prereg,
} from "../../src/actions/j-v1-harness.ts";
import { STEP_BUDGET } from "../../src/baseline/c1-trial.ts";
import { MAX_OUTPUT } from "../../src/baseline/planner.ts";
import { publishedTasks } from "../../src/benchmark/published-tasks.ts";
import { TASK_SET_VERSION } from "../../src/benchmark/task-types.ts";
import { PILOT_MODEL } from "../../src/pilot/config.ts";

const ROOT = process.cwd();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const RAW = JSON.parse(readFileSync(J_V1_PREREG_PATH, "utf8"));
const README = readFileSync("docs/product/capability-prereg/j-v1/README.md", "utf8");
const SPEC = readFileSync("docs/product/capability-spec.md", "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

/** The pre-registration hash, stated in the README and the PR. Changing j-v1 changes this. */
const J_V1_PREREG_HASH = "5b749c6563d8a56d911782bb3d4b0bc64c302d81093229b058d67a53e157549e";

let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("j-v1 pre-registration (capability spec §3)", () => {
  it("loads, and the analysis script's bytes match the SHA-256 it names", () => {
    const { prereg, hash } = loadJV1Prereg(ROOT);
    expect(RAW.analysis.script).toBe(J_V1_ANALYSIS_PATH);
    expect(RAW.analysis.sha256).toBe(sha(readFileSync(J_V1_ANALYSIS_PATH)));
    expect(RAW.analysis.entry).toBe("analyzeJV1");
    expect(hash).toBe(preregHash(prereg));
  });

  it("its hash is SHA-256 over canonical JSON, pinned here and stated in the README", () => {
    expect(preregHash(RAW)).toBe(sha(canonicalJson(RAW)));
    expect(preregHash(RAW)).toBe(J_V1_PREREG_HASH);
    expect(README).toContain(J_V1_PREREG_HASH);
    expect(README).toContain(RAW.analysis.sha256);
  });

  it("canonical JSON ignores key order and whitespace but not values", () => {
    const reorder = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reorder)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>)
                .reverse()
                .map(([k, x]) => [k, reorder(x)]),
            )
          : v;
    const shuffled = reorder(RAW);
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(RAW));
    expect(preregHash(shuffled)).toBe(preregHash(RAW));
    expect(preregHash(JSON.parse(JSON.stringify(RAW, null, 7)))).toBe(preregHash(RAW));
    expect(preregHash({ ...RAW, stepBudget: 31 })).not.toBe(preregHash(RAW));
  });

  it("the loader refuses an analysis script that no longer matches", () => {
    tmp = mkdtempSync(join(tmpdir(), "j-v1-"));
    cpSync(join(ROOT, "docs"), join(tmp, "docs"), { recursive: true });
    cpSync(join(ROOT, "src/actions"), join(tmp, "src/actions"), { recursive: true });
    expect(() => loadJV1Prereg(tmp as string)).not.toThrow();
    const script = join(tmp, J_V1_ANALYSIS_PATH);
    writeFileSync(script, `${readFileSync(script, "utf8")}\n// edited\n`);
    expect(() => loadJV1Prereg(tmp as string)).toThrow(/does not match its SHA-256/);
  });

  it("the loader refuses a pre-registration naming another script", () => {
    tmp = mkdtempSync(join(tmpdir(), "j-v1-"));
    cpSync(join(ROOT, "docs"), join(tmp, "docs"), { recursive: true });
    cpSync(join(ROOT, "src/actions"), join(tmp, "src/actions"), { recursive: true });
    const p = join(tmp, J_V1_PREREG_PATH);
    writeFileSync(
      p,
      JSON.stringify({ ...RAW, analysis: { ...RAW.analysis, script: "src/actions/arm.ts" } }),
    );
    expect(() => loadJV1Prereg(tmp as string)).toThrow(/not the frozen script/);
  });

  it("the analysis script is self-contained: it imports node:crypto and nothing else", () => {
    const src = readFileSync(J_V1_ANALYSIS_PATH, "utf8");
    const specs = [...src.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)].map(
      (m) => m[1],
    );
    expect(specs).toEqual(["node:crypto"]);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  it("the task set is fc-v1's 90 satisfiable tasks, with the manifest's SHA-256", () => {
    expect(RAW.taskSet.version).toBe(TASK_SET_VERSION);
    const satisfiable = (publishedTasks(TASK_SET_VERSION) ?? [])
      .filter((t) => t.satisfiable)
      .map((t) => t.taskId)
      .sort();
    expect(satisfiable).toHaveLength(90);
    expect([...RAW.taskSet.taskIds].sort()).toEqual(satisfiable);
    expect(RAW.taskSet.manifestSha256).toBe(sha(readFileSync(RAW.taskSet.manifestPath)));
  });

  it("states the bar exactly as spec §2 J writes it, and the spec's numbers", () => {
    const j = flat(SPEC.slice(SPEC.indexOf("### J. Fastest"), SPEC.indexOf("### K. Recovery")));
    for (const line of RAW.spec.barAsWritten) expect(j).toContain(flat(line));
    const [ni, wall, steps] = RAW.bar.sequence;
    expect(ni.marginPoints).toBe(5);
    expect(j).toContain("is below 5 points");
    expect(wall.threshold).toBe(1);
    expect(steps.threshold).toBe(1);
    expect(wall.resamples).toBe(10_000);
    expect(steps.resamples).toBe(10_000);
    expect(flat(SPEC)).toContain("paired bootstrap over tasks, 10,000 resamples");
    expect(RAW.bar.alphaOneSided).toBe(0.05);
    expect(j).toContain("fc-v1 satisfiable tasks (90), k = 1.");
    expect(RAW.runsPerTaskPerArm).toBe(1);
  });

  it("flags the 5-point margin as lead ruling pending (spec §6), not ratified", () => {
    expect(RAW.leadRulingPending).toEqual(["bar.sequence[0].marginPoints"]);
    expect(RAW.status).toMatch(/^proposed, not ratified/);
    expect(SPEC).toContain("Whether the 5-point non-inferiority margin (J, L) is right for n = 90");
    expect(README).toMatch(/lead ruling pending/i);
  });

  it("pairs hcu+shell+J with hcu+shell on the shared harness's parameters", () => {
    expect(RAW.arms.baseline).toBe(J_BASELINE_ARM);
    expect(RAW.arms.capability).toBe(J_CAPABILITY_ARM);
    expect(RAW.stepBudget).toBe(STEP_BUDGET);
    expect(RAW.stepBudget).toBe(30);
    expect(RAW.outputCeiling).toBe(MAX_OUTPUT);
    expect(RAW.modelId).toBe(PILOT_MODEL);
    expect(RAW.retryBudget).toBe(0);
    expect(RAW.wallClockBudget).toBeNull();
  });

  it("has distinct, non-trivial assignment and bootstrap seeds", () => {
    expect(RAW.seeds.assignment).toMatch(/^j-v1\/assignment\/[0-9a-f]{32}$/);
    expect(RAW.seeds.bootstrap).toMatch(/^j-v1\/bootstrap\/[0-9a-f]{32}$/);
    expect(RAW.seeds.taskBuild).toMatch(/fc-v1 is frozen/);
  });

  it("keeps capability rows out of R1 evidence", () => {
    expect(RAW.evidenceUse).toMatch(/never R1 evidence/);
  });
});
