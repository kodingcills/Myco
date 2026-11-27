/**
 * Track R pre-registration r-v1 (capability-spec §3): the committed hash is the SHA-256 over
 * canonical JSON of prereg.json, the analysis files still hash to the frozen values, and the
 * frozen values match the spec's bar and the code they describe. Proposed values stay flagged
 * as pending the lead's ruling; nothing claims ratification.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STEP_BUDGET } from "../../src/baseline/c1-trial.ts";
import { EVIDENCE_PLANNERS } from "../../src/benchmark/check.ts";
import { GRADER_VERSION } from "../../src/benchmark/grade/grade.ts";
import { canonicalJson, canonicalSha256, sha256Hex } from "../../src/recording-eval/canonical.ts";
import { PREREG_DIR, ROOT, readPrereg } from "./helpers.ts";

interface PreregDoc {
  analysis: { files: { path: string; sha256: string }[] };
  bar: { sequence: Record<string, unknown>[]; guardrails: { id: string }[] };
  arms: { primary: unknown; secondary: Record<string, unknown>[]; rowKind: string };
  grader: { version: string };
  stepBudget: number;
  modelId: string;
  retryBudget: number;
  scoredAttemptsPerTrial: number;
  taskSet: { trialsPerTaskPerArm: number };
  demonstration: Record<string, unknown>;
  seeds: { assignment: string };
  verified: string;
  leadRulingPending: string[];
  ratification: string;
}
const prereg = readPrereg() as unknown as PreregDoc;

describe("r-v1 pre-registration hash", () => {
  it("prereg.sha256 is the SHA-256 over canonical JSON of prereg.json", () => {
    const committed = readFileSync(join(PREREG_DIR, "prereg.sha256"), "utf8").trim();
    expect(committed).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalSha256(prereg)).toBe(committed);
  });

  it("canonical JSON sorts keys, drops whitespace, refuses non-JSON values", () => {
    expect(canonicalJson({ b: [1, { d: "x", c: null }], a: true })).toBe(
      '{"a":true,"b":[1,{"c":null,"d":"x"}]}',
    );
    expect(canonicalSha256({ a: 1, b: 2 })).toBe(canonicalSha256({ b: 2, a: 1 }));
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson(new Date(0))).toThrow();
  });

  it("every analysis file still hashes to its frozen SHA-256", () => {
    const files = prereg.analysis.files as { path: string; sha256: string }[];
    expect(files.map((f) => f.path)).toEqual([
      "src/recording-eval/analysis.ts",
      "src/recording-eval/canonical.ts",
      "scripts/r-v1-analysis.ts",
    ]);
    for (const f of files)
      expect(sha256Hex(readFileSync(join(ROOT, f.path))), f.path).toBe(f.sha256);
  });
});

describe("r-v1 values match the spec's bar and the code", () => {
  it("fixed-sequence bar: R5 prerequisite, then one-sided McNemar at 0.05 with 5 discordant", () => {
    const [prereq, primary] = prereg.bar.sequence;
    expect(prereq).toMatchObject({ id: "R-prereq", kind: "property" });
    expect(primary).toMatchObject({
      id: "R-primary",
      kind: "exact-mcnemar-one-sided",
      capability: "hcu+shell+R",
      baseline: "hcu+shell",
      metric: "verified",
      alpha: 0.05,
      minDiscordant: 5,
    });
    expect(prereg.bar.sequence).toHaveLength(2);
    expect(prereg.bar.guardrails.map((g: { id: string }) => g.id)).toEqual([
      "zero-derived-false-accepts",
      "planted-marker-scan",
    ]);
    expect(prereg.arms.primary).toEqual({ capability: "hcu+shell+R", baseline: "hcu+shell" });
    expect(prereg.arms.secondary[0]).toMatchObject({ baseline: "C1" });
  });

  it("grader version, step budget, model id, k and budgets", () => {
    expect(prereg.grader.version).toBe(GRADER_VERSION);
    expect(prereg.stepBudget).toBe(STEP_BUDGET);
    expect(EVIDENCE_PLANNERS.has(prereg.modelId)).toBe(true);
    expect(prereg.retryBudget).toBe(0);
    expect(prereg.scoredAttemptsPerTrial).toBe(1);
    expect(prereg.taskSet.trialsPerTaskPerArm).toBe(1);
    expect(prereg.demonstration).toMatchObject({
      perFamily: 1,
      simulated: false,
      operatorStarted: true,
    });
    expect(prereg.seeds.assignment).toMatch(/^r-v1-assign-/);
  });

  it("VERIFIED is defined by the independent grader, never the derived gate", () => {
    expect(prereg.verified).toMatch(/independent grader/);
    expect(prereg.verified).toMatch(/never the derived gate/);
    expect(prereg.arms.rowKind).toMatch(/^gate-less/);
  });

  it("proposed values are flagged pending the lead's ruling; nothing claims ratification", () => {
    expect(prereg.leadRulingPending.length).toBeGreaterThanOrEqual(4);
    expect(prereg.ratification).toMatch(/^proposed/);
    expect(JSON.stringify(prereg)).not.toMatch(/\bratified\b/i);
  });
});
