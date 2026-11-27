/**
 * Capability track P: pre-registration p-v1 is frozen per Part 1 §3 and its analysis applies
 * capability-spec-2 §P's bar as written. Every claim of the PR is pinned here:
 * - the committed prereg agrees with its hash file and with everything it pins (task set
 *   manifest and ids, analysis module and script), and each tamper is caught by name;
 * - the bar's numbers are the spec's (alpha, 5 discordant, 10,000 resamples, ratio < 1.0,
 *   40 tasks, xa-v1 as conformance);
 * - the statistics match the spec's own tables (Part 1 §1.5 McNemar, spec-2 §1.2 zero-event);
 * - verified is the gated-row rule with P's checkpoint clause; false-verified is a guardrail;
 * - refused / incomplete / not shown / shown follow Part 1 §1.5 and §3;
 * - the analysis module is self-contained (imports only node builtins), so its pinned digest
 *   covers the whole analysis.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { XA_BAR } from "../../src/benchmark/cross-app-bar.ts";
import {
  analyzePPack,
  assignmentSchedule,
  bootstrapRatioUpper95,
  canonicalJson,
  isFalseDone,
  isFalseVerified,
  isVerified,
  loadPPrereg,
  mcnemarOneSided,
  P_ANALYSIS_MODULE,
  P_ANALYSIS_SCRIPT,
  P_PREREG_HASH_PATH,
  P_PREREG_PATH,
  type PArm,
  type PPack,
  type PPairedCell,
  type PTrial,
  preregHash,
  sha256Hex,
  wilson95,
  zeroEventUpper95,
} from "../../src/benchmark/cross-app-prereg.ts";
import { XA_V2, xaTaskIds } from "../../src/tasks/cross-app-taskset.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const loaded = loadPPrereg(ROOT);
const { prereg, hash } = loaded;
const COMMIT = "0".repeat(40);
/**
 * The committed prereg lists lead rulings as pending, so no pack can be decided under it. The
 * decision tests run under a test-only ratified copy (the pending list emptied) and its hash;
 * nothing here writes it to disk.
 */
const ratified = { ...prereg, leadRulingPending: [] as string[] };
const ratifiedHash = preregHash(ratified);

describe("p-v1 is frozen and consistent", () => {
  it("the committed prereg agrees with its hash file and every digest it pins", () => {
    expect(loaded.problems).toEqual([]);
    expect(readFileSync(join(ROOT, P_PREREG_HASH_PATH), "utf8").trim()).toBe(hash);
    expect(hash).toBe(
      sha256Hex(canonicalJson(JSON.parse(readFileSync(join(ROOT, P_PREREG_PATH), "utf8")))),
    );
  });

  it("states the bar of capability-spec-2 §P as written", () => {
    expect(prereg.track).toBe("P");
    expect(prereg.taskSet.version).toBe("xa-v2");
    expect(prereg.taskSet.tasks).toBe(40);
    expect(prereg.taskSet.taskIds).toEqual(xaTaskIds(XA_V2));
    expect(prereg.bar).toMatchObject({
      alpha: 0.05,
      minDiscordant: 5,
      bootstrapResamples: 10000,
      ratioUpperBoundBelow: 1.0,
    });
    expect(prereg.retryBudget).toEqual({ "B+P": 1, B: 0 });
    const raw = JSON.parse(readFileSync(join(ROOT, P_PREREG_PATH), "utf8"));
    expect(raw.arms["B+P"].gated).toBe(true);
    expect(raw.arms.B.gated).toBe(true);
    expect(raw.bar.sided).toBe("one-sided");
    // xa-v1 is the conformance set, pinned by the digest the spec states.
    expect(raw.taskSet.conformanceSet.manifestSha256).toBe(XA_BAR.manifestSha256);
    expect(raw.taskSet.conformanceSet.manifestSha256).toBe(
      "d740ed0434c664cc79fa9517562ba7c540489ffc39f7f24a58a6cc758975c79c",
    );
    // Lead-pending values are flagged in the prereg itself, never claimed ratified.
    expect(raw.leadRulingPending.length).toBeGreaterThan(0);
    expect(raw.evidence).toContain("never R1 evidence");
  });

  it("the hash is order-independent over keys (canonical JSON) and changes with any value", () => {
    const reordered = Object.fromEntries(Object.entries(prereg).reverse());
    expect(preregHash(reordered)).toBe(hash);
    expect(preregHash({ ...prereg, stepBudget: 31 })).not.toBe(hash);
  });

  /** A temp repo with the files the prereg pins; `mutate` tampers with one. */
  function tamper(mutate: (root: string) => void): readonly string[] {
    const root = mkdtempSync(join(tmpdir(), "p-v1-"));
    for (const rel of [
      P_PREREG_PATH,
      P_PREREG_HASH_PATH,
      prereg.taskSet.manifest,
      join(dirname(prereg.taskSet.manifest), "tasks.jsonl"),
      P_ANALYSIS_MODULE,
      P_ANALYSIS_SCRIPT,
    ]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      copyFileSync(join(ROOT, rel), join(root, rel));
    }
    mutate(root);
    return loadPPrereg(root).problems;
  }
  const append = (root: string, rel: string, text: string) =>
    writeFileSync(join(root, rel), readFileSync(join(root, rel), "utf8") + text);

  it("catches each tamper by name", () => {
    expect(tamper(() => {})).toEqual([]);
    expect(tamper((r) => append(r, P_ANALYSIS_MODULE, "\n"))).toEqual(["ANALYSIS_MODULE_SHA256"]);
    expect(tamper((r) => append(r, P_ANALYSIS_SCRIPT, "\n"))).toEqual(["ANALYSIS_SCRIPT_SHA256"]);
    expect(tamper((r) => append(r, prereg.taskSet.manifest, " "))).toEqual(["MANIFEST_SHA256"]);
    expect(
      tamper((r) => writeFileSync(join(r, P_PREREG_HASH_PATH), `${"f".repeat(64)}\n`)),
    ).toEqual(["PREREG_HASH_FILE"]);
    // Editing the prereg without re-hashing it is caught.
    expect(
      tamper((r) => {
        const p = JSON.parse(readFileSync(join(r, P_PREREG_PATH), "utf8"));
        p.stepBudget = 60;
        writeFileSync(join(r, P_PREREG_PATH), JSON.stringify(p));
      }),
    ).toEqual(["PREREG_HASH_FILE"]);
    // Dropping a task from tasks.jsonl is caught even with the manifest left alone.
    expect(
      tamper((r) => {
        const rel = join(dirname(prereg.taskSet.manifest), "tasks.jsonl");
        const lines = readFileSync(join(r, rel), "utf8").trim().split("\n");
        writeFileSync(join(r, rel), `${lines.slice(0, -1).join("\n")}\n`);
      }),
    ).toEqual(["TASK_IDS", "TASK_COUNT"]);
  });

  it("the analysis module imports only node builtins, so its digest covers the analysis", () => {
    const src = readFileSync(join(ROOT, P_ANALYSIS_MODULE), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i).toMatch(/^node:/);
  });
});

describe("statistics match the spec's tables", () => {
  it("exact one-sided McNemar: Part 1 §1.5 critical values", () => {
    const table: [number, number, number][] = [
      [5, 5, 0.0313],
      [6, 6, 0.0156],
      [8, 7, 0.0352],
      [10, 9, 0.0107],
      [12, 10, 0.0193],
      [15, 12, 0.0176],
      [20, 15, 0.0207],
    ];
    for (const [d, k, p] of table) {
      // The spec's table is rounded to 4 places.
      expect(Math.abs(mcnemarOneSided(k, d - k) - p)).toBeLessThanOrEqual(0.00005 + 1e-12);
      expect(mcnemarOneSided(k, d - k)).toBeLessThanOrEqual(0.05);
      expect(mcnemarOneSided(k - 1, d - k + 1)).toBeGreaterThan(0.05);
    }
    // d = 4 can never reach 0.05.
    expect(mcnemarOneSided(4, 0)).toBeGreaterThan(0.05);
    expect(mcnemarOneSided(0, 0)).toBe(1);
  });

  it("zero-event upper bound: capability-spec-2 §1.2 table", () => {
    const table: [number, number][] = [
      [20, 0.1391],
      [30, 0.095],
      [40, 0.0722],
      [60, 0.0487],
      [100, 0.0295],
    ];
    for (const [n, u] of table) expect(zeroEventUpper95(n)).toBeCloseTo(u, 4);
  });

  it("the bootstrap is deterministic per seed and conservative when an arm verifies nothing", () => {
    const cells: PPairedCell[] = Array.from({ length: 40 }, (_, i) => ({
      pSteps: 12 + (i % 5),
      pVerified: i % 3 !== 0,
      bSteps: 20 + (i % 7),
      bVerified: i % 4 === 0,
    }));
    const a = bootstrapRatioUpper95(cells, 2000, "seed-a");
    expect(bootstrapRatioUpper95(cells, 2000, "seed-a")).toBe(a);
    expect(bootstrapRatioUpper95(cells, 2000, "seed-b")).not.toBe(a);
    const none = cells.map((c) => ({ ...c, bVerified: false }));
    expect(bootstrapRatioUpper95(none, 200, "seed-a")).toBe(Number.POSITIVE_INFINITY);
  });

  it("the schedule covers each (task, arm) once, in ABBA blocks, fixed by the seed", () => {
    const s = assignmentSchedule(prereg.taskSet.taskIds, prereg.seeds.assignment);
    expect(s).toHaveLength(80);
    expect(new Set(s.map((x) => `${x.arm}:${x.taskId}`)).size).toBe(80);
    for (let i = 0; i < 80; i += 2) {
      expect(s[i]?.taskId).toBe(s[i + 1]?.taskId);
      expect(s[i]?.arm).toBe((i / 2) % 2 === 0 ? "B+P" : "B");
    }
    expect(assignmentSchedule(prereg.taskSet.taskIds, "other")).not.toEqual(s);
  });
});

// ---------------------------------------------------------------- packs

type Outcome = "verified" | "failed" | "correct-not-accepted" | "false-verified";

function trial(
  arm: PArm,
  taskId: string,
  ordinal: number,
  outcome: Outcome,
  steps: number,
): PTrial {
  const pass = outcome === "verified" || outcome === "correct-not-accepted";
  const gate = outcome === "verified" || outcome === "false-verified" ? "verified" : "refuted";
  return {
    arm,
    taskId,
    ordinal,
    plannerModelId: prereg.model.plannerModelId,
    instructionSha256: sha256Hex(taskId),
    stepBudget: prereg.stepBudget,
    retryBudget: prereg.retryBudget[arm],
    doneClaim: true,
    gateEndVerdict: gate,
    ...(arm === "B+P" ? { checkpointVerdicts: [gate, gate, gate] } : {}),
    stepGrades:
      outcome === "false-verified"
        ? ["fail", "pass", "pass"]
        : pass
          ? ["pass", "pass", "pass"]
          : ["pass", "fail", "fail"],
    endGrade: pass || outcome === "false-verified" ? "pass" : "fail",
    steps,
  };
}

/**
 * A complete, scheduled pack. Task index i (in prereg order): the first `pOnly` are verified
 * in B+P only, the next `bOnly` in B only, the next `both` in both, the rest in neither.
 */
function pack(o: {
  pOnly: number;
  bOnly: number;
  both?: number;
  pSteps?: number;
  bSteps?: number;
  edit?: (t: PTrial) => PTrial;
}): PPack {
  const ids = prereg.taskSet.taskIds;
  const kind = new Map(
    ids.map((id, i) => {
      const both = o.both ?? 10;
      const k =
        i < o.pOnly
          ? "p"
          : i < o.pOnly + o.bOnly
            ? "b"
            : i < o.pOnly + o.bOnly + both
              ? "both"
              : "none";
      return [id, k];
    }),
  );
  const trials = assignmentSchedule(ids, prereg.seeds.assignment).map(
    ({ arm, taskId }, ordinal) => {
      const k = kind.get(taskId);
      const ok = k === "both" || (k === "p" && arm === "B+P") || (k === "b" && arm === "B");
      const t = trial(
        arm,
        taskId,
        ordinal,
        ok ? "verified" : "failed",
        arm === "B+P" ? (o.pSteps ?? 12) : (o.bSteps ?? 20),
      );
      return o.edit ? o.edit(t) : t;
    },
  );
  return {
    schema: "myco.cross-app.p-pack/1",
    preregSha256: ratifiedHash,
    preregCommit: COMMIT,
    taskSetVersion: "xa-v2",
    manifestSha256: prereg.taskSet.manifestSha256,
    trials,
  };
}
const analyze = (p: PPack) => analyzePPack(p, ratified, ratifiedHash);

describe("no decision while a lead ruling is pending", () => {
  it("the committed prereg (rulings pending) never yields shown, however strong the pack", () => {
    expect(prereg.leadRulingPending.length).toBeGreaterThan(0);
    for (const [pOnly, bOnly] of [
      [8, 0],
      [5, 0],
      [10, 2],
    ] as const) {
      const p = { ...pack({ pOnly, bOnly }), preregSha256: hash };
      // Under the ratified copy the same pack is shown...
      expect(analyze({ ...p, preregSha256: ratifiedHash }).decision).toBe("shown");
      // ...under the committed prereg it is not decided at all.
      const r = analyzePPack(p, prereg, hash);
      expect(r.decision).toBe("lead-ruling-pending");
      expect(r.reasons).toEqual([`LEAD_RULING_PENDING ${prereg.leadRulingPending.length}`]);
      expect(r.arms).toBeUndefined();
      expect(r.component1).toBeUndefined();
    }
  });

  it("one pending item is enough; a missing or non-array field fails closed", () => {
    const strong = pack({ pOnly: 8, bOnly: 0 });
    const under = (pending: unknown) => {
      const pr = { ...prereg, leadRulingPending: pending } as unknown as typeof prereg;
      return analyzePPack({ ...strong, preregSha256: preregHash(pr) }, pr, preregHash(pr));
    };
    expect(under(["x"])).toMatchObject({
      decision: "lead-ruling-pending",
      reasons: ["LEAD_RULING_PENDING 1"],
    });
    for (const bad of [undefined, null, "none", {}, 0]) {
      expect(under(bad), String(bad)).toMatchObject({
        decision: "lead-ruling-pending",
        reasons: ["LEAD_RULING_FIELD"],
      });
    }
    expect(under([]).decision).toBe("shown");
  });

  it("refusals still come first: a simulated pack under pending rulings is refused", () => {
    const sim = pack({ pOnly: 8, bOnly: 0, edit: (t) => ({ ...t, plannerModelId: "scripted" }) });
    const r = analyzePPack({ ...sim, preregSha256: hash }, prereg, hash);
    expect(r.decision).toBe("refused");
    expect(r.reasons).toEqual(["SIMULATED_ROW"]);
  });
});

describe("verified and false-verified", () => {
  const base = trial("B+P", "xa-v2-001", 0, "verified", 10);
  it("verified needs a done claim, gate end verified, last checkpoint verified (B+P) and all grades pass", () => {
    expect(isVerified(base)).toBe(true);
    expect(isVerified({ ...base, doneClaim: false })).toBe(false);
    expect(isVerified({ ...base, gateEndVerdict: "uncertain" })).toBe(false);
    expect(isVerified({ ...base, checkpointVerdicts: ["verified", "verified", "refuted"] })).toBe(
      false,
    );
    expect(isVerified({ ...base, checkpointVerdicts: undefined })).toBe(false);
    expect(isVerified({ ...base, endGrade: "ungradable" })).toBe(false);
    expect(isVerified({ ...base, stepGrades: ["pass", "fail", "pass"] })).toBe(false);
    // B has no checkpoints: the end-state gate check is enough.
    const b = trial("B", "xa-v2-001", 1, "verified", 10);
    expect(isVerified(b)).toBe(true);
    expect("checkpointVerdicts" in b).toBe(false);
  });

  it("a checkpoint verified over a failed step is a false-verified, even with the end refuted", () => {
    const ckpt: PTrial = {
      ...trial("B+P", "xa-v2-001", 0, "failed", 10),
      gateEndVerdict: "refuted",
      checkpointVerdicts: ["verified", "verified", "refuted"],
      stepGrades: ["pass", "fail", "pass"],
      endGrade: "fail",
    };
    expect(isFalseVerified(ckpt)).toBe(true);
    // Checkpoint 1 verified covers step 1 only: a later failure is not a false-verified...
    expect(
      isFalseVerified({ ...ckpt, checkpointVerdicts: ["verified", "refuted", "not-reached"] }),
    ).toBe(false);
    // ...but an ungradable step 1 under it is.
    expect(
      isFalseVerified({
        ...ckpt,
        checkpointVerdicts: ["verified", "refuted", "not-reached"],
        stepGrades: ["ungradable", "fail", "fail"],
      }),
    ).toBe(true);
    // The last checkpoint verified over an earlier failure, end refuted.
    expect(
      isFalseVerified({
        ...ckpt,
        checkpointVerdicts: ["refuted", "refuted", "verified"],
        stepGrades: ["fail", "pass", "pass"],
      }),
    ).toBe(true);
    expect(
      isFalseVerified({ ...ckpt, checkpointVerdicts: ["refuted", "refuted", "refuted"] }),
    ).toBe(false);
  });

  it("false done: a done claim while any step or the end grades fail, a masked step included", () => {
    const masked: PTrial = {
      ...trial("B", "xa-v2-001", 1, "failed", 10),
      stepGrades: ["fail", "pass", "pass"],
      endGrade: "pass",
    };
    expect(isFalseDone(masked)).toBe(true);
    expect(isFalseDone({ ...masked, doneClaim: false })).toBe(false);
    expect(isFalseDone({ ...masked, stepGrades: ["pass", "pass", "pass"] })).toBe(false);
    expect(
      isFalseDone({ ...masked, stepGrades: ["pass", "pass", "pass"], endGrade: "ungradable" }),
    ).toBe(true);
  });

  it("a masked step (step 1 wrong, end right, gate verified) is not verified and is a false-verified", () => {
    const masked = trial("B+P", "xa-v2-001", 0, "false-verified", 10);
    expect(isVerified(masked)).toBe(false);
    expect(isFalseVerified(masked)).toBe(true);
    expect(isFalseVerified(trial("B+P", "xa-v2-001", 0, "failed", 10))).toBe(false);
  });
});

describe("analysis decisions", () => {
  it("shown: 8 discordant all for B+P, fewer steps; both components shown", () => {
    const r = analyze(pack({ pOnly: 8, bOnly: 0 }));
    expect(r.decision).toBe("shown");
    expect(r.reasons).toEqual([]);
    expect(r.table).toEqual({ both: 10, pOnly: 8, bOnly: 0, neither: 22 });
    expect(r.mcnemarP).toBeCloseTo(0.0039, 4);
    expect(r.component1).toBe("shown");
    expect(r.component2).toBe("shown");
    expect(r.ratioUpper95).toBeLessThan(1);
    // The bound is the 95th percentile: above the point ratio (0.6 x 10/18 = 0.333...).
    expect(r.ratioStepsPerVerified).toBeCloseTo(12 / 18 / (20 / 10), 10);
    expect(r.ratioUpper95).toBeGreaterThan(r.ratioStepsPerVerified as number);
    expect(r.falseVerified).toBe(0);
    expect(r.falseVerifiedUpper95).toBeCloseTo(zeroEventUpper95(40), 10);
    expect(r.evidenceUse).toBe("experiment-only (never R1 evidence)");
    expect(r.arms?.["B+P"].verified).toBe(18);
    expect(r.arms?.B.verified).toBe(10);
  });

  it("component 2 not shown: the overall decision is not shown; component 1 is still reported", () => {
    const r = analyze(pack({ pOnly: 8, bOnly: 0, pSteps: 30, bSteps: 10 }));
    expect(r.component1).toBe("shown");
    expect(r.component2).toBe("not-shown");
    expect(r.decision).toBe("not-shown");
    expect(r.reasons.some((x) => x.startsWith("RATIO_UPPER95"))).toBe(true);
  });

  it("each arm's verified count carries its Wilson 95% interval (z = 1.96)", () => {
    // Reference values of the Wilson score interval at 95%.
    const [lo, hi] = wilson95(5, 10);
    expect(lo).toBeCloseTo(0.2366, 4);
    expect(hi).toBeCloseTo(0.7634, 4);
    expect(wilson95(0, 10)[0]).toBe(0);
    expect(wilson95(0, 10)[1]).toBeCloseTo(0.2775, 4);
    const r = analyze(pack({ pOnly: 8, bOnly: 0 }));
    expect(r.arms?.B.wilson95).toEqual(wilson95(10, 40));
    expect(r.arms?.["B+P"].wilson95).toEqual(wilson95(18, 40));
  });

  it("false done is counted per arm: done claim and the task grades fail", () => {
    // 8 B+P-only, 10 both, 22 neither: every failed trial claims done in the fixture.
    const base = analyze(pack({ pOnly: 8, bOnly: 0 }));
    expect(base.arms?.["B+P"].falseDone).toBe(22);
    expect(base.arms?.B.falseDone).toBe(30);
    const r = analyze(
      pack({
        pOnly: 8,
        bOnly: 0,
        edit: (t) =>
          t.arm !== "B"
            ? t
            : t.taskId === "xa-v2-040"
              ? { ...t, doneClaim: false } // a failed trial without a done claim
              : t.taskId === "xa-v2-010" // a "both" task: masked step, gate refuted
                ? {
                    ...t,
                    gateEndVerdict: "refuted",
                    stepGrades: ["fail", "pass", "pass"],
                    endGrade: "pass",
                  }
                : t,
      }),
    );
    expect(r.arms?.B.falseDone).toBe(30);
    expect(r.arms?.B.verified).toBe(9);
  });

  it("a checkpoint false-verified in B+P fails the bar (end refuted)", () => {
    const r = analyze(
      pack({
        pOnly: 12,
        bOnly: 0,
        edit: (t) =>
          t.arm === "B+P" && t.taskId === "xa-v2-040"
            ? {
                ...t,
                gateEndVerdict: "refuted",
                checkpointVerdicts: ["verified", "verified", "refuted"],
                stepGrades: ["pass", "fail", "pass"],
                endGrade: "fail",
              }
            : t,
      }),
    );
    expect(r.decision).toBe("not-shown");
    expect(r.reasons).toContain("GUARDRAIL_FALSE_VERIFIED 1");
  });

  it("p-v1 reports no wall-time or cost secondaries, and the prereg says so", () => {
    const r = analyze(pack({ pOnly: 8, bOnly: 0 }));
    const keys = JSON.stringify(r).toLowerCase();
    expect(keys).not.toMatch(/wall|cost|usd|seconds/);
    const raw = JSON.parse(readFileSync(join(ROOT, P_PREREG_PATH), "utf8"));
    expect(raw.notInAnalysis).toMatch(/wall time and cost per verified task/i);
    expect(JSON.stringify(raw.secondary)).not.toMatch(/wall|cost/);
  });

  it("underpowered: 4 discordant, all for B+P, is not shown and says so", () => {
    const r = analyze(pack({ pOnly: 4, bOnly: 0 }));
    expect(r.decision).toBe("not-shown");
    expect(r.reasons.some((x) => x.startsWith("UNDERPOWERED at n=40: 4 discordant"))).toBe(true);
    expect(r.component2).toBe("not-tested");
  });

  it("p > 0.05: 7 vs 5 is not shown", () => {
    const r = analyze(pack({ pOnly: 7, bOnly: 5 }));
    expect(r.decision).toBe("not-shown");
    expect(r.reasons.some((x) => x.startsWith("MCNEMAR_P"))).toBe(true);
  });

  it("one false-verified in B+P fails the bar however strong the effect", () => {
    let flipped = false;
    const r = analyze(
      pack({
        pOnly: 12,
        bOnly: 0,
        edit: (t) => {
          if (!flipped && t.arm === "B+P" && t.taskId === "xa-v2-040") {
            flipped = true;
            return trial("B+P", t.taskId, t.ordinal, "false-verified", t.steps);
          }
          return t;
        },
      }),
    );
    expect(r.decision).toBe("not-shown");
    expect(r.reasons).toContain("GUARDRAIL_FALSE_VERIFIED 1");
    expect(r.falseVerifiedUpper95).toBeUndefined();
  });

  it("correct, not accepted is counted and never verified", () => {
    const r = analyze(
      pack({
        pOnly: 8,
        bOnly: 0,
        edit: (t) =>
          t.arm === "B" && t.taskId === "xa-v2-040"
            ? trial("B", t.taskId, t.ordinal, "correct-not-accepted", t.steps)
            : t,
      }),
    );
    expect(r.arms?.B.correctNotAccepted).toBe(1);
    expect(r.arms?.B.verified).toBe(10);
  });

  it("parity and assignment failures are not shown", () => {
    const one = (f: (t: PTrial) => PTrial) => (t: PTrial) =>
      t.arm === "B" && t.taskId === "xa-v2-040" ? f(t) : t;
    const cases: [(t: PTrial) => PTrial, string][] = [
      [(t) => ({ ...t, instructionSha256: "x" }), "PARITY_INSTRUCTION xa-v2-040"],
      [(t) => ({ ...t, stepBudget: 60 }), "PARITY_STEP_BUDGET B:xa-v2-040"],
      [(t) => ({ ...t, steps: 31 }), "OVER_BUDGET B:xa-v2-040"],
      [(t) => ({ ...t, retryBudget: 1 }), "PARITY_RETRY_BUDGET B:xa-v2-040"],
      [(t) => ({ ...t, ordinal: t.ordinal === 0 ? 1 : 0 }), "ASSIGNMENT B:xa-v2-040"],
    ];
    for (const [edit, code] of cases) {
      const r = analyze(pack({ pOnly: 12, bOnly: 0, edit: one(edit) }));
      expect(r.decision, code).toBe("not-shown");
      expect(r.reasons, code).toContain(code);
    }
  });

  it("refuses a pack whose prereg hash, task set or manifest does not match, or whose commit is missing or malformed", () => {
    const good = pack({ pOnly: 8, bOnly: 0 });
    // The commit is format-checked only: any well-formed 40-hex SHA passes (not looked up in git).
    expect(analyze({ ...good, preregCommit: "f".repeat(40) }).decision).toBe("shown");
    const cases: [PPack, string][] = [
      [{ ...good, preregSha256: "f".repeat(64) }, "PREREG_HASH_MISMATCH"],
      [{ ...good, preregCommit: "" }, "PREREG_COMMIT_MISSING"],
      [{ ...good, preregCommit: "F".repeat(40) }, "PREREG_COMMIT_MISSING"],
      [{ ...good, preregCommit: "0".repeat(39) }, "PREREG_COMMIT_MISSING"],
      [{ ...good, preregCommit: 7 as unknown as string }, "PREREG_COMMIT_MISSING"],
      [{ ...good, taskSetVersion: "xa-v1" }, "TASK_SET_MISMATCH"],
      [{ ...good, manifestSha256: XA_BAR.manifestSha256 }, "MANIFEST_MISMATCH"],
      [{ ...good, schema: "x" as PPack["schema"] }, "PACK_SCHEMA"],
    ];
    for (const [p, code] of cases) {
      const r = analyze(p);
      expect(r.decision, code).toBe("refused");
      expect(r.reasons).toEqual([code]);
      expect(r.arms).toBeUndefined();
    }
  });

  it("refuses any simulated row: a marker that is not exactly false, or a planner other than the prereg's model", () => {
    const mark = (f: (t: PTrial) => PTrial) => (t: PTrial) => (t.ordinal === 5 ? f(t) : t);
    const markers: unknown[] = [true, "true", "false", 1, 0, null, {}, [], "yes"];
    for (const edit of [
      ...markers.map((m) => mark((t) => ({ ...t, simulated: m }) as PTrial)),
      mark((t) => ({ ...t, plannerModelId: "scripted" })),
    ]) {
      const r = analyze(pack({ pOnly: 8, bOnly: 0, edit }));
      expect(r.decision).toBe("refused");
      expect(r.reasons).toEqual(["SIMULATED_ROW"]);
    }
    // The marker on the last row only, carried through JSON as a string, is still refused.
    const p = pack({ pOnly: 8, bOnly: 0 });
    const last = p.trials.length - 1;
    const viaJson = JSON.parse(
      JSON.stringify({
        ...p,
        trials: p.trials.map((t, i) => (i === last ? { ...t, simulated: "true" } : t)),
      }),
    ) as PPack;
    expect(analyze(viaJson).reasons).toEqual(["SIMULATED_ROW"]);
    // A real row: no marker, or exactly false.
    expect(
      analyze(pack({ pOnly: 8, bOnly: 0, edit: (t) => ({ ...t, simulated: false }) })).decision,
    ).toBe("shown");
    expect(analyze(p).decision).toBe("shown");
  });

  it("incomplete: a missing, duplicated or malformed cell is never analysed", () => {
    const good = pack({ pOnly: 8, bOnly: 0 });
    const missing = { ...good, trials: good.trials.slice(1) };
    expect(analyze(missing).decision).toBe("incomplete");
    const dup = { ...good, trials: [...good.trials, good.trials[0] as PTrial] };
    expect(analyze(dup).reasons.some((x) => x.includes("ran 2 times"))).toBe(true);
    const bad = (f: (t: PTrial) => PTrial, code: string) => {
      const r = analyze({ ...good, trials: good.trials.map((t, i) => (i === 3 ? f(t) : t)) });
      expect(r.decision, code).toBe("incomplete");
      expect(
        r.reasons.some((x) => x.startsWith(code)),
        code,
      ).toBe(true);
    };
    bad((t) => ({ ...t, endGrade: "maybe" as PTrial["endGrade"] }), "END_GRADE");
    bad((t) => ({ ...t, stepGrades: ["pass", "pass"] }), "STEP_GRADES");
    bad(
      (t) => ({ ...t, gateEndVerdict: undefined as unknown as PTrial["gateEndVerdict"] }),
      "GATE_VERDICT",
    );
    bad((t) => ({ ...t, taskId: "xa-v1-001" }), "UNKNOWN_TASK");
    bad((t) => ({ ...t, arm: "myco" as PArm }), "UNKNOWN_ARM");
    const bp = good.trials.findIndex((t) => t.arm === "B+P");
    const r = analyze({
      ...good,
      trials: good.trials.map((t, i) => (i === bp ? { ...t, checkpointVerdicts: undefined } : t)),
    });
    expect(r.reasons.some((x) => x.startsWith("CHECKPOINT"))).toBe(true);
    const bIdx = good.trials.findIndex((t) => t.arm === "B");
    const cp = (i: number, cps: unknown) =>
      analyze({
        ...good,
        trials: good.trials.map((t, j) =>
          j === i ? ({ ...t, checkpointVerdicts: cps } as PTrial) : t,
        ),
      });
    for (const [i, cps] of [
      [bp, ["verified", "verified"]],
      [bp, ["not-reached", "verified", "verified"]],
      [bp, ["verified", "maybe", "verified"]],
      [bIdx, ["verified", "verified", "verified"]],
    ] as const) {
      const res = cp(i, cps);
      expect(res.decision, JSON.stringify(cps)).toBe("incomplete");
      expect(res.reasons.some((x) => x.startsWith("CHECKPOINT"))).toBe(true);
    }
    expect(cp(bp, ["refuted", "not-reached", "not-reached"]).decision).toBe("shown");
    const nul = analyze({
      ...good,
      trials: good.trials.map((t, i) => (i === 3 ? (null as unknown as PTrial) : t)),
    });
    expect(nul.decision).toBe("incomplete");
    expect(nul.reasons).toContain("TRIAL_NOT_OBJECT");
  });
});

describe("the CLI", () => {
  const cli = (...args: string[]) =>
    spawnSync("npx", ["tsx", P_ANALYSIS_SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });

  it("check passes on the committed prereg; analyze refuses a simulated pack", {
    timeout: 60_000,
  }, () => {
    const ok = cli("check");
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain(hash);
    const dir = mkdtempSync(join(tmpdir(), "p-pack-"));
    const file = join(dir, "pack.json");
    const sim = pack({ pOnly: 8, bOnly: 0, edit: (t) => ({ ...t, plannerModelId: "scripted" }) });
    writeFileSync(file, JSON.stringify({ ...sim, preregSha256: hash }));
    const r = cli("analyze", file);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).reasons).toEqual(["SIMULATED_ROW"]);
    // A strong real-model pack under the committed prereg: rulings pending, so not decided.
    const strong = join(dir, "strong.json");
    writeFileSync(strong, JSON.stringify({ ...pack({ pOnly: 8, bOnly: 0 }), preregSha256: hash }));
    const s = cli("analyze", strong);
    expect(s.status).toBe(1);
    expect(JSON.parse(s.stdout).decision).toBe("lead-ruling-pending");
  });

  it("analyze refuses to run under an inconsistent prereg", { timeout: 60_000 }, () => {
    // A temp copy of the pinned files with the hash file tampered; the copied script loads the
    // copied prereg (its root is the copy).
    const root = mkdtempSync(join(tmpdir(), "p-v1-cli-"));
    for (const rel of [
      P_PREREG_PATH,
      P_PREREG_HASH_PATH,
      prereg.taskSet.manifest,
      join(dirname(prereg.taskSet.manifest), "tasks.jsonl"),
      P_ANALYSIS_MODULE,
      P_ANALYSIS_SCRIPT,
    ]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      copyFileSync(join(ROOT, rel), join(root, rel));
    }
    const file = join(root, "pack.json");
    writeFileSync(file, JSON.stringify({ ...pack({ pOnly: 8, bOnly: 0 }), preregSha256: hash }));
    const run = () =>
      spawnSync("npx", ["tsx", join(root, P_ANALYSIS_SCRIPT), "analyze", file], {
        cwd: ROOT,
        encoding: "utf8",
      });
    const before = run();
    expect(before.stdout).toContain("lead-ruling-pending"); // the copy itself is consistent
    writeFileSync(join(root, P_PREREG_HASH_PATH), `${"f".repeat(64)}\n`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("prereg p-v1 inconsistent: PREREG_HASH_FILE");
    expect(r.stdout).toBe("");
  });
});
