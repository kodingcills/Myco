/**
 * Corrections ON/OFF A/B under the independent grader (TIF-274 / track B; pre-registered in
 * #526 §7.2.1): pairing, the one-sided exact sign test, the Newcombe paired interval, Stage 0's
 * no-claim rule, and the integrity halt. Expected numbers were computed independently (Python,
 * from the binomial and Newcombe 1998 method 10 formulas), not by the code under test.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import { type BenchmarkGradeRow, gradeRow } from "../../src/benchmark/grade/row.ts";
import { type BenchmarkTask, buildTaskSet } from "../../src/benchmark/taskset.ts";
import {
  AB_ALPHA,
  AB_EVIDENCE_USE,
  AB_STAGES,
  type AbArm,
  type AbInput,
  checkCorrectionsAb,
  newcombePairedCi,
  signTestOneSided,
} from "../../src/m2/corrections-ab.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const TASKS = buildTaskSet().tasks;
const DEMO = TASKS.filter((t) => t.inDemo);
const H = (n: number) => n.toString(16).padStart(64, "0");

type Outcome = "verified" | "refuted" | "false-done";

/** One arm's ledgers: a row per task, its outcome chosen by `outcome(task, i)`. */
function armLedger(
  side: "on" | "off",
  tasks: readonly BenchmarkTask[],
  outcome: (t: BenchmarkTask, i: number) => Outcome,
  over: Partial<BenchmarkArmRow> = {},
): AbArm {
  const arm: BenchmarkArmRow[] = [];
  const grades: BenchmarkGradeRow[] = [];
  tasks.forEach((t, i) => {
    const o = t.satisfiable ? outcome(t, i) : "refuted";
    const base = {
      schema: "myco.benchmark.arm-row/1" as const,
      taskSetVersion: t.taskSetVersion,
      arm: "myco-gate" as const,
      trialKey: `${side}-${t.taskId}`,
      taskId: t.taskId,
      faultClass: t.faultClass,
      fixtureSha256: t.fixtureSha256,
      instructionSha256: t.instructionSha256,
      plannerModelId: "claude-sonnet-5-5",
      outputCeiling: 8192,
      claim: "done" as const,
      persistedSha256: H(i + 1),
      cost: { modelUsd: null, wallClockS: null, vmS: null },
    };
    const corrections = side;
    const row: BenchmarkArmRow = !t.satisfiable
      ? {
          ...base,
          gate: { called: false, verdict: null, unregistrable: true },
          accepted: false,
          cause: {
            kind: "oracle",
            detail: "unregistrable: the gate registry rejected the task spec",
          },
        }
      : o === "refuted"
        ? {
            ...base,
            gate: { called: true, verdict: "refuted", corrections },
            accepted: false,
            cause: { kind: "agent", detail: "gate refuted the agent's done" },
          }
        : {
            ...base,
            gate: { called: true, verdict: "verified", corrections },
            accepted: true,
            cause: null,
          };
    const r = { ...row, ...over };
    arm.push(r);
    const pass = o === "verified" && t.satisfiable;
    grades.push(
      gradeRow(r.trialKey, r.taskId, {
        graderVersion: "false-completion-grader/1",
        status: pass ? "pass" : "fail",
        reasons: pass ? [] : ["x"],
        fixtureSha256: r.fixtureSha256,
        persistedSha256: r.persistedSha256,
        target: "B2",
        targetSatisfied: pass,
        mismatches: [],
        mismatchCount: pass ? 0 : 1,
      }),
    );
  });
  return { arm, grades };
}

/**
 * The Stage-1 fixture: both 50, ON only 12, OFF only 3, neither 35 (the 10 invalid-target
 * tasks included). Clean tasks 0-49 both; 50-59 ON only; faulted: 2 ON only, 3 OFF only.
 */
function stage1(opts: { onFalse?: number } = {}) {
  const clean = TASKS.filter((t) => t.faultClass === "none").map((t) => t.taskId);
  const faulted = TASKS.filter((t) => t.satisfiable && t.faultClass !== "none").map(
    (t) => t.taskId,
  );
  const onWins = new Set([...clean.slice(50, 60), ...faulted.slice(0, 2)]);
  const offWins = new Set(faulted.slice(2, 5));
  const bothWin = new Set(clean.slice(0, 50));
  const on = armLedger("on", TASKS, (t) =>
    opts.onFalse !== undefined && t.taskId === faulted[10]
      ? "false-done"
      : bothWin.has(t.taskId) || onWins.has(t.taskId)
        ? "verified"
        : "refuted",
  );
  const off = armLedger("off", TASKS, (t) =>
    bothWin.has(t.taskId) || offWins.has(t.taskId) ? "verified" : "refuted",
  );
  return { on, off };
}

const PREREG = "c".repeat(64);
const config = (corrections: "on" | "off") => ({
  corrections,
  retryBudget: 1,
  pacing: { perTrialGapS: 60 },
  plannerModelId: "claude-sonnet-5-5",
  outputCeiling: 8192,
});
const s0 = (side: "on" | "off") =>
  armLedger(side, DEMO, () => "verified").arm.map((r) => ({
    ...(r as BenchmarkArmRow),
    trialKey: `s0-${(r as BenchmarkArmRow).trialKey}`,
  }));
/** Stage-0 ledgers whose trial keys differ from Stage 1's (`s0-` prefix). */
const STAGE0 = { on: s0("on"), off: s0("off") };
/** A complete input: identical run configs, Stage 0's ledgers, a matching pre-registration. */
const ab = (arms: { on: AbArm; off: AbArm }, over: Partial<AbInput> = {}): AbInput => ({
  ...arms,
  runConfigs: { on: config("on"), off: config("off") },
  stage0: STAGE0,
  preregistration: { committedSha256: PREREG, declaredSha256: PREREG },
  ...over,
});

describe("the pre-registered statistics (independent reference values)", () => {
  it("one-sided exact sign test", () => {
    expect(signTestOneSided(12, 3)).toBeCloseTo(0.017578125, 12);
    expect(signTestOneSided(10, 2)).toBeCloseTo(0.019287109375, 12);
    expect(signTestOneSided(2, 2)).toBeCloseTo(11 / 16, 12);
    expect(signTestOneSided(0, 0)).toBe(1);
    // One-sided: OFF better is never evidence for ON.
    expect(signTestOneSided(3, 12)).toBeGreaterThan(0.99);
  });
  it("Newcombe method 10 paired interval", () => {
    const ci = newcombePairedCi(50, 12, 3, 35) as readonly [number, number];
    expect(ci[0]).toBeCloseTo(0.01621993526115577, 10);
    expect(ci[1]).toBeCloseTo(0.16157233386670558, 10);
    const ci2 = newcombePairedCi(12, 9, 2, 21) as readonly [number, number];
    expect(ci2[0]).toBeCloseTo(0.018210226243591948, 10);
    expect(ci2[1]).toBeCloseTo(0.28915665958827236, 10);
    expect(newcombePairedCi(0, 0, 0, 0)).toBeNull();
  });
  it("the pre-registered constants", () => {
    expect(AB_STAGES).toEqual({
      0: { pairs: 30, effectClaim: false },
      1: { pairs: 100, effectClaim: true },
    });
    expect(AB_ALPHA).toBe(0.05);
    expect(AB_EVIDENCE_USE).toBe("experiment-only (never R1 evidence)");
  });
});

describe("Stage 1: 100 fc-v1 pairs, confirmatory", () => {
  it("pairs the two runs, tests one-sided, and reports corrections help only when p < 0.05", () => {
    const r = checkCorrectionsAb(ab(stage1()), { stage: 1 });
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({
      ok: true,
      halted: false,
      integrityIncidents: [],
      pairs: 100,
      table: { both: 50, onOnly: 12, offOnly: 3, neither: 35 },
      discordant: { onOnly: 12, offOnly: 3, total: 15 },
      effect: "corrections-help",
      evidenceUse: AB_EVIDENCE_USE,
    });
    expect(r.onSuccess).toMatchObject({ numerator: 62, denominator: 100 });
    expect(r.offSuccess).toMatchObject({ numerator: 53, denominator: 100 });
    expect(r.signTestOneSidedP).toBeCloseTo(0.017578125, 12);
    expect(r.difference.estimate).toBeCloseTo(0.09, 12);
    expect(r.difference.ci95?.[0]).toBeCloseTo(0.01621993526115577, 10);
  });

  it("a miss reads 'corrections not shown to help', and the run is still ok", () => {
    const clean = new Set(TASKS.filter((t) => t.faultClass === "none").map((t) => t.taskId));
    const on = armLedger("on", TASKS, (t, i) =>
      (clean.has(t.taskId) && i !== 0 && i !== 1) || i === 70 || i === 71 ? "verified" : "refuted",
    );
    const off = armLedger("off", TASKS, (t) => (clean.has(t.taskId) ? "verified" : "refuted"));
    const r = checkCorrectionsAb(ab({ on, off }), { stage: 1 });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.discordant).toEqual({ onOnly: 2, offOnly: 2, total: 4 });
    expect(r.effect).toBe("corrections-not-shown-to-help");
  });

  it("a gate miss in either arm halts the run with its own record, never data", () => {
    const r = checkCorrectionsAb(ab(stage1({ onFalse: 1 })), { stage: 1 });
    expect(r.halted).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.effect).toBe("none");
    expect(r.integrityIncidents).toEqual([
      expect.objectContaining({ arm: "on", accepted: true, grade: "fail" }),
    ]);
    expect(r.errors.join("\n")).toMatch(
      /INTEGRITY INCIDENT: the gate verified 1 trial\(s\) the grader fails \(corrections ON 1, OFF 0\)/,
    );
    // A false DONE is never a verified task: the table (still reported) does not count it.
    expect(r.table).toEqual({ both: 50, onOnly: 12, offOnly: 3, neither: 35 });
    const { on } = stage1();
    const offMiss = armLedger("off", TASKS, (_t, i) => (i === 0 ? "false-done" : "refuted"));
    expect(
      checkCorrectionsAb(ab({ on, off: offMiss }), { stage: 1 }).integrityIncidents.map(
        (i) => i.arm,
      ),
    ).toEqual(["off"]);
  });

  it("a gate miss without an accepted DONE (claim not done) still halts", () => {
    const { off } = stage1();
    const on = armLedger("on", TASKS, (_t, i) => (i === 0 ? "verified" : "refuted"));
    const missed: AbArm = {
      arm: (on.arm as BenchmarkArmRow[]).map((r, i) =>
        i === 0
          ? {
              ...r,
              claim: "not-done" as const,
              accepted: false,
              cause: { kind: "agent" as const, detail: "agent reported not done" },
            }
          : r,
      ),
      grades: (on.grades as BenchmarkGradeRow[]).map((g, i) =>
        i === 0 ? { ...g, status: "fail" as const, reasons: ["x"] } : g,
      ),
    };
    const r = checkCorrectionsAb(ab({ on: missed, off }), { stage: 1 });
    expect(r.halted).toBe(true);
    expect(r.integrityIncidents).toEqual([
      { arm: "on", trialKey: "on-fc-v1-001", taskId: "fc-v1-001", accepted: false, grade: "fail" },
    ]);
  });

  it("each arm must be exactly fc-v1: a missing task fails the binding and the pairing", () => {
    const { on, off } = stage1();
    const short: AbArm = { arm: off.arm.slice(1), grades: off.grades.slice(1) };
    const r = checkCorrectionsAb(ab({ on, off: short }), { stage: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(
      /corrections-OFF ledger: myco-gate task set: 99 rows is not a whole number of runs/,
    );
    expect(r.errors.join("\n")).toMatch(/corrections-ON on-fc-v1-001 has no OFF pair/);
    expect(r.errors).toContain("99 pairs, Stage 1 is pre-registered at 100");
  });

  it("and the mirror: an OFF task with no ON pair is refused", () => {
    const { on, off } = stage1();
    const short: AbArm = { arm: on.arm.slice(1), grades: on.grades.slice(1) };
    expect(checkCorrectionsAb(ab({ on: short, off }), { stage: 1 }).errors.join("\n")).toMatch(
      /corrections-OFF off-fc-v1-001 has no ON pair/,
    );
  });
});

describe("Stage 0: 30 pairs, plumbing only", () => {
  it("never claims an effect, whatever the numbers", () => {
    const on = armLedger("on", DEMO, () => "verified");
    const off = armLedger("off", DEMO, () => "refuted");
    const r = checkCorrectionsAb(ab({ on, off }), { stage: 0 });
    expect(r.errors).toEqual([]);
    expect(r.pairs).toBe(30);
    expect(r.signTestOneSidedP).toBeLessThan(AB_ALPHA);
    expect(r.effect).toBe("not-claimed");
  });
  it("refuses a Stage-0 run with the wrong number of pairs", () => {
    const on = armLedger("on", DEMO.slice(0, 29), () => "verified");
    const off = armLedger("off", DEMO.slice(0, 29), () => "verified");
    expect(checkCorrectionsAb(ab({ on, off }), { stage: 0 }).errors).toContain(
      "29 pairs, Stage 0 is pre-registered at 30",
    );
  });
});

describe("the lead's preconditions (#524, comment 7196445749)", () => {
  it("refuses arms whose run configs differ apart from corrections (retry budget, pacing)", () => {
    const r = checkCorrectionsAb(
      ab(stage1(), {
        runConfigs: {
          on: config("on"),
          off: { ...config("off"), retryBudget: 2, pacing: { perTrialGapS: 30 } },
        },
      }),
      { stage: 1 },
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toContain(
      "the arms ran differently apart from corrections: pacing, retryBudget",
    );
    // Key order does not matter.
    const reordered = {
      outputCeiling: 8192,
      plannerModelId: "claude-sonnet-5-5",
      pacing: { perTrialGapS: 60 },
      retryBudget: 1,
      corrections: "off",
    };
    expect(
      checkCorrectionsAb(ab(stage1(), { runConfigs: { on: config("on"), off: reordered } }), {
        stage: 1,
      }).ok,
    ).toBe(true);
    // Each config must name its own arm's corrections.
    const mislabel = checkCorrectionsAb(
      ab(stage1(), { runConfigs: { on: config("off"), off: config("on") } }),
      { stage: 1 },
    );
    expect(mislabel.errors).toEqual(
      expect.arrayContaining([
        'the ON run config does not say corrections: "on"',
        'the OFF run config does not say corrections: "off"',
      ]),
    );
  });

  it("Stage 1 needs the pre-registration hash, and it must match the committed file", () => {
    const { preregistration: _p, ...noPrereg } = ab(stage1());
    expect(checkCorrectionsAb(noPrereg, { stage: 1 }).errors).toContain(
      "Stage 1 needs the pre-registration hash (committed and declared)",
    );
    const mismatch = checkCorrectionsAb(
      ab(stage1(), {
        preregistration: { committedSha256: PREREG, declaredSha256: "d".repeat(64) },
      }),
      { stage: 1 },
    );
    expect(mismatch.errors).toContain(
      "the pack's pre-registration hash is not the committed file's",
    );
    // Stage 0 may run before the file exists, and is checked when given.
    const on = armLedger("on", DEMO, () => "refuted");
    const off = armLedger("off", DEMO, () => "refuted");
    const { preregistration: _q, stage0: _s, ...bare } = ab({ on, off });
    expect(checkCorrectionsAb(bare, { stage: 0 }).ok).toBe(true);
    const s0Mismatch = checkCorrectionsAb(
      ab(
        { on, off },
        { preregistration: { committedSha256: PREREG, declaredSha256: "e".repeat(64) } },
      ),
      { stage: 0 },
    );
    expect(s0Mismatch.errors).toContain(
      "the pack's pre-registration hash is not the committed file's",
    );
  });

  it("Stage-0 rows are excluded from Stage 1, and Stage 1 needs Stage 0's ledgers", () => {
    const reuse = checkCorrectionsAb(
      ab(stage1(), {
        stage0: { on: [...STAGE0.on, { trialKey: "on-fc-v1-001" }], off: STAGE0.off },
      }),
      { stage: 1 },
    );
    expect(reuse.errors.join("\n")).toMatch(
      /1 Stage-1 trial\(s\) reuse Stage-0 trials \(on-fc-v1-001\)/,
    );
    const { stage0: _s, ...noStage0 } = ab(stage1());
    expect(checkCorrectionsAb(noStage0, { stage: 1 }).errors).toContain(
      "Stage 1 needs the Stage-0 ledgers (to exclude their trials)",
    );
  });
});

describe("arm identity, pairing rules and provenance", () => {
  it("every gate-called ON row says corrections on, and no OFF row does", () => {
    const { on, off } = stage1();
    const onWrong: AbArm = {
      ...on,
      arm: (on.arm as BenchmarkArmRow[]).map((r, i) =>
        i === 0 && r.gate !== null ? { ...r, gate: { ...r.gate, corrections: "off" as const } } : r,
      ),
    };
    expect(checkCorrectionsAb(ab({ on: onWrong, off }), { stage: 1 }).errors.join("\n")).toMatch(
      /corrections-ON: 1 row\(s\) ran with corrections off \(on-fc-v1-001\)/,
    );
    const offWrong: AbArm = {
      ...off,
      arm: (off.arm as BenchmarkArmRow[]).map((r, i) =>
        i === 0 && r.gate !== null ? { ...r, gate: { ...r.gate, corrections: "on" as const } } : r,
      ),
    };
    expect(checkCorrectionsAb(ab({ on, off: offWrong }), { stage: 1 }).errors.join("\n")).toMatch(
      /corrections-OFF: 1 row\(s\) ran with corrections on \(off-fc-v1-001\)/,
    );
  });

  it("a pair must share the instruction and the model settings", () => {
    const { on } = stage1();
    const off = armLedger("off", TASKS, () => "refuted", { plannerModelId: "claude-opus-5-5" });
    expect(checkCorrectionsAb(ab({ on, off }), { stage: 1 }).errors.join("\n")).toMatch(
      /pair fc-v1-001: the two arms ran different model settings/,
    );
    const off2 = armLedger("off", TASKS, () => "refuted", { outputCeiling: 1024 });
    expect(checkCorrectionsAb(ab({ on, off: off2 }), { stage: 1 }).errors.join("\n")).toMatch(
      /the two arms ran different model settings/,
    );
  });

  it("refuses an hcu+shell row and a duplicated task in an arm", () => {
    const { on, off } = stage1();
    const shell: AbArm = {
      ...off,
      arm: (off.arm as BenchmarkArmRow[]).map((r, i) =>
        i === 0 ? { ...r, arm: "hcu+shell" as const, gate: null } : r,
      ),
    };
    expect(checkCorrectionsAb(ab({ on, off: shell }), { stage: 1 }).errors.join("\n")).toMatch(
      /corrections-OFF: the A\/B compares the gate with itself/,
    );
    const dupRow = { ...(off.arm[1] as BenchmarkArmRow), trialKey: "off-dup" };
    const dupGrade = { ...(off.grades[1] as BenchmarkGradeRow), trialKey: "off-dup" };
    const dup: AbArm = {
      arm: [...off.arm.slice(1), dupRow],
      grades: [...off.grades.slice(1), dupGrade],
    };
    expect(checkCorrectionsAb(ab({ on, off: dup }), { stage: 1 }).errors.join("\n")).toMatch(
      /corrections-OFF: two rows for task fc-v1-002/,
    );
  });

  it("dry-run rows are refused as evidence and accepted as plumbing", () => {
    const on = armLedger("on", TASKS, () => "refuted", { plannerModelId: "simulated:x" });
    const off = armLedger("off", TASKS, () => "refuted", { plannerModelId: "simulated:x" });
    expect(checkCorrectionsAb(ab({ on, off }), { stage: 1 }).ok).toBe(true);
    const ev = checkCorrectionsAb(ab({ on, off }), { stage: 1, evidence: true });
    expect(ev.ok).toBe(false);
    expect(ev.errors.join("\n")).toMatch(
      /corrections-ON: 100 row\(s\) without evidence provenance/,
    );
  });
});

describe("the CLI", () => {
  it("exits 0 on a clean run, 1 on a halted or unconfigured one, 2 on a bad stage", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-ab-"));
    try {
      const write = (name: string, rows: readonly unknown[]) =>
        writeFileSync(join(dir, name), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
      const prereg = join(dir, "prereg.md");
      writeFileSync(prereg, "pre-registration\n");
      const preregSha = createHash("sha256").update("pre-registration\n").digest("hex");
      writeFileSync(join(dir, "on.json"), JSON.stringify(config("on")));
      writeFileSync(join(dir, "off.json"), JSON.stringify(config("off")));
      write("s0-on.jsonl", STAGE0.on);
      write("s0-off.jsonl", STAGE0.off);
      const run = (stage: string, extra: string[] = []) =>
        spawnSync(
          "npx",
          [
            "tsx",
            join(ROOT, "scripts", "m2-corrections-ab.ts"),
            "--on-arm",
            join(dir, "on-arm.jsonl"),
            "--on-grades",
            join(dir, "on-grades.jsonl"),
            "--off-arm",
            join(dir, "off-arm.jsonl"),
            "--off-grades",
            join(dir, "off-grades.jsonl"),
            "--on-config",
            join(dir, "on.json"),
            "--off-config",
            join(dir, "off.json"),
            "--stage0-on-arm",
            join(dir, "s0-on.jsonl"),
            "--stage0-off-arm",
            join(dir, "s0-off.jsonl"),
            "--stage",
            stage,
            ...extra,
          ],
          { cwd: ROOT, encoding: "utf8" },
        );
      const clean = stage1();
      write("on-arm.jsonl", clean.on.arm);
      write("on-grades.jsonl", clean.on.grades);
      write("off-arm.jsonl", clean.off.arm);
      write("off-grades.jsonl", clean.off.grades);
      const preregArgs = ["--prereg-file", prereg, "--prereg-declared", preregSha];
      const ok = run("1", preregArgs);
      expect(ok.status, ok.stderr).toBe(0);
      expect(JSON.parse(ok.stdout).effect).toBe("corrections-help");
      // Without the pre-registration Stage 1 refuses to run.
      expect(run("1").status).toBe(1);
      expect(run("1", ["--prereg-file", prereg, "--prereg-declared", "f".repeat(64)]).status).toBe(
        1,
      );
      const halted = stage1({ onFalse: 1 });
      write("on-arm.jsonl", halted.on.arm);
      write("on-grades.jsonl", halted.on.grades);
      expect(run("1", preregArgs).status).toBe(1);
      expect(run("2").status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
