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
const J_V1_PREREG_HASH = "140e929c5fc94d8cfa22cef833028344c369d7b04a484f9ed3a9c19986b6cbb8";

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
    // The spec's k = 1 is replaced by the lead's ruling (k = 2), recorded below.
    expect(j).toContain("fc-v1 satisfiable tasks (90), k = 1.");
    expect(RAW.runsPerTaskPerArm).toBe(2);
  });

  it("records the lead's 05:39Z ruling on spec §6's margin question: option (c), nothing pending", () => {
    expect(RAW.leadRulingPending).toEqual([]);
    expect(RAW.leadRulings).toHaveLength(1);
    const [ruling] = RAW.leadRulings;
    expect(ruling.at).toBe("2026-11-27T05:39Z");
    expect(ruling.ruling).toMatch(/^option \(c\): keep the 5-point non-inferiority margin/);
    expect(ruling.ruling).toMatch(/k = 2 repeats per task/);
    expect(ruling.condition).toMatch(/option \(b\), a 7-point margin at k = 1, before freezing/);
    expect(ruling.applied).toMatch(/^option \(c\)/);
    expect(RAW.status).toMatch(/^lead ruling 2026-11-27 05:39Z recorded/);
    expect(SPEC).toContain("Whether the 5-point non-inferiority margin (J, L) is right for n = 90");
    expect(RAW.spec.openQuestion).toMatch(/^§6: whether the 5-point/);
    expect(README).toMatch(/05:39Z/);
  });

  it("estimates the VM-hours at k = 2 from the repo's measured per-trial figures", () => {
    const v = RAW.vmHoursEstimate;
    expect(v.trials).toBe(RAW.taskSet.taskIds.length * 2 * RAW.runsPerTaskPerArm);
    expect(v.trials).toBe(360);
    expect(v.secondsPerTrial).toBe(140 + 100 + 135);
    expect(v.vmHours).toBe((v.trials * v.secondsPerTrial) / 3600);
    expect(v.ifTrialTimeDoubles.secondsPerTrial).toBe(140 + 100 + 2 * 135);
    expect(v.ifTrialTimeDoubles.vmHours).toBe((360 * 510) / 3600);
    expect(v.atOptionB.trials).toBe(180);
    expect(v.atOptionB.vmHours).toBe((180 * 375) / 3600);
    const source = flat(readFileSync("docs/baseline/screenshot-agent.md", "utf8"));
    expect(source).toContain("cold reset **140 s**");
    expect(source).toContain("140 + 100 + ~135 = 375 s");
    expect(v.trackL).toMatch(/Linux path/);
    expect(README).toContain("37.5");
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

  it("states the k = 2 design, the parity check and the frozen-in commit in the hashed text", () => {
    const notShown: string[] = RAW.notShownWhen;
    const design = notShown.find((x) => x.startsWith("the design is not exactly"));
    expect(design).toMatch(/runsPerTaskPerArm \(k = 2\) times each/);
    expect(notShown.join(" ")).not.toMatch(/once each/);
    expect(
      notShown.some((x) => /^a parity check fails: .*instructionSha256.*fixtureSha256/.test(x)),
    ).toBe(true);
    expect(notShown.some((x) => /40-hex commit .* frozen in .*§3 item 2/.test(x))).toBe(true);
    expect(RAW.analysis.rowParityFields).toBe(
      "instructionSha256, fixtureSha256, stepBudget, outputCeiling (spec §1.3)",
    );
    expect(RAW.analysis.packRecords).toMatch(/commit on main .* frozen in \(spec §3 item 2\)/);
    expect(RAW.gate).toMatch(/refuses a fast-path row that carries a gate verdict/);
  });

  it("keeps capability rows out of R1 evidence", () => {
    expect(RAW.evidenceUse).toMatch(/never R1 evidence/);
  });
});
