/**
 * Corrections ON/OFF A/B under the independent grader (TIF-274 / track B; pre-registered in
 * #526 §7.2.1): pairing, the one-sided exact sign test, the Newcombe paired interval, Stage 0's
 * no-claim rule, and the integrity halt. Expected numbers were computed independently (Python,
 * from the binomial and Newcombe 1998 method 10 formulas), not by the code under test.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import { type BenchmarkGradeRow, gradeRow } from "../../src/benchmark/grade/row.ts";
import { type BenchmarkTask, buildTaskSet } from "../../src/benchmark/taskset.ts";
import {
  AB_ALPHA,
  AB_STAGES,
  type AbArm,
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
  });
});

describe("Stage 1: 100 fc-v1 pairs, confirmatory", () => {
  it("pairs the two runs, tests one-sided, and claims ON better only when p < 0.05", () => {
    const r = checkCorrectionsAb(stage1(), { stage: 1 });
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({
      ok: true,
      halted: false,
      pairs: 100,
      table: { both: 50, onOnly: 12, offOnly: 3, neither: 35 },
      falseDoneAccepted: { on: 0, off: 0 },
      effect: "on-better",
    });
    expect(r.onSuccess).toMatchObject({ numerator: 62, denominator: 100 });
    expect(r.offSuccess).toMatchObject({ numerator: 53, denominator: 100 });
    expect(r.signTestOneSidedP).toBeCloseTo(0.017578125, 12);
    expect(r.difference.estimate).toBeCloseTo(0.09, 12);
    expect(r.difference.ci95?.[0]).toBeCloseTo(0.01621993526115577, 10);
  });

  it("no evidence of effect when the discordant pairs are balanced", () => {
    const clean = new Set(TASKS.filter((t) => t.faultClass === "none").map((t) => t.taskId));
    const on = armLedger("on", TASKS, (t, i) =>
      clean.has(t.taskId) && i !== 0 && i !== 1
        ? "verified"
        : i === 70 || i === 71
          ? "verified"
          : "refuted",
    );
    const off = armLedger("off", TASKS, (t, i) => (clean.has(t.taskId) ? "verified" : "refuted"));
    const r = checkCorrectionsAb({ on, off }, { stage: 1 });
    expect(r.errors).toEqual([]);
    expect(r.table.onOnly).toBe(2);
    expect(r.table.offOnly).toBe(2);
    expect(r.effect).toBe("no-evidence-of-effect");
  });

  it("a false DONE accepted in either arm halts the run: an integrity incident, never data", () => {
    const r = checkCorrectionsAb(stage1({ onFalse: 1 }), { stage: 1 });
    expect(r.halted).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.effect).toBe("none");
    expect(r.falseDoneAccepted).toEqual({ on: 1, off: 0 });
    // A false DONE is never a verified task: the table (still reported) does not count it.
    expect(r.table).toEqual({ both: 50, onOnly: 12, offOnly: 3, neither: 35 });
    expect(r.errors.join("\n")).toMatch(
      /INTEGRITY INCIDENT: false DONE accepted \(corrections ON 1, OFF 0\)/,
    );
    const { on, off } = stage1();
    const offFalse = armLedger("off", TASKS, (t, i) => (i === 0 ? "false-done" : "refuted"));
    expect(checkCorrectionsAb({ on, off: offFalse }, { stage: 1 }).falseDoneAccepted.off).toBe(1);
    void off;
  });

  it("each arm must be exactly fc-v1: a missing task fails the binding and the pairing", () => {
    const { on, off } = stage1();
    const short: AbArm = { arm: off.arm.slice(1), grades: off.grades.slice(1) };
    const r = checkCorrectionsAb({ on, off: short }, { stage: 1 });
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
    expect(checkCorrectionsAb({ on: short, off }, { stage: 1 }).errors.join("\n")).toMatch(
      /corrections-OFF off-fc-v1-001 has no ON pair/,
    );
  });
});

describe("Stage 0: 30 pairs, plumbing only", () => {
  it("never claims an effect, whatever the numbers", () => {
    const on = armLedger("on", DEMO, () => "verified");
    const off = armLedger("off", DEMO, () => "refuted");
    const r = checkCorrectionsAb({ on, off }, { stage: 0 });
    expect(r.errors).toEqual([]);
    expect(r.pairs).toBe(30);
    expect(r.signTestOneSidedP).toBeLessThan(AB_ALPHA);
    expect(r.effect).toBe("not-claimed");
  });
  it("refuses a Stage-0 run with the wrong number of pairs", () => {
    const on = armLedger("on", DEMO.slice(0, 29), () => "verified");
    const off = armLedger("off", DEMO.slice(0, 29), () => "verified");
    expect(checkCorrectionsAb({ on, off }, { stage: 0 }).errors).toContain(
      "29 pairs, Stage 0 is pre-registered at 30",
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
    expect(checkCorrectionsAb({ on: onWrong, off }, { stage: 1 }).errors.join("\n")).toMatch(
      /corrections-ON: 1 row\(s\) ran with corrections off \(on-fc-v1-001\)/,
    );
    const offWrong: AbArm = {
      ...off,
      arm: (off.arm as BenchmarkArmRow[]).map((r, i) =>
        i === 0 && r.gate !== null ? { ...r, gate: { ...r.gate, corrections: "on" as const } } : r,
      ),
    };
    expect(checkCorrectionsAb({ on, off: offWrong }, { stage: 1 }).errors.join("\n")).toMatch(
      /corrections-OFF: 1 row\(s\) ran with corrections on \(off-fc-v1-001\)/,
    );
  });

  it("a pair must share the instruction and the model settings", () => {
    const { on } = stage1();
    const off = armLedger("off", TASKS, () => "refuted", { plannerModelId: "claude-opus-5-5" });
    expect(checkCorrectionsAb({ on, off }, { stage: 1 }).errors.join("\n")).toMatch(
      /pair fc-v1-001: the two arms ran different model settings/,
    );
    const off2 = armLedger("off", TASKS, () => "refuted", { outputCeiling: 1024 });
    expect(checkCorrectionsAb({ on, off: off2 }, { stage: 1 }).errors.join("\n")).toMatch(
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
    expect(checkCorrectionsAb({ on, off: shell }, { stage: 1 }).errors.join("\n")).toMatch(
      /corrections-OFF: the A\/B compares the gate with itself/,
    );
    const dupRow = { ...(off.arm[1] as BenchmarkArmRow), trialKey: "off-dup" };
    const dupGrade = { ...(off.grades[1] as BenchmarkGradeRow), trialKey: "off-dup" };
    const dup: AbArm = {
      arm: [...off.arm.slice(1), dupRow],
      grades: [...off.grades.slice(1), dupGrade],
    };
    expect(checkCorrectionsAb({ on, off: dup }, { stage: 1 }).errors.join("\n")).toMatch(
      /corrections-OFF: two rows for task fc-v1-002/,
    );
  });

  it("dry-run rows are refused as evidence and accepted as plumbing", () => {
    const on = armLedger("on", TASKS, () => "refuted", { plannerModelId: "simulated:x" });
    const off = armLedger("off", TASKS, () => "refuted", { plannerModelId: "simulated:x" });
    expect(checkCorrectionsAb({ on, off }, { stage: 1 }).ok).toBe(true);
    const ev = checkCorrectionsAb({ on, off }, { stage: 1, evidence: true });
    expect(ev.ok).toBe(false);
    expect(ev.errors.join("\n")).toMatch(
      /corrections-ON: 100 row\(s\) without evidence provenance/,
    );
  });

  it("the CLI exits 0 on a clean run, 1 on a halted one, 2 on a bad stage", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-ab-"));
    try {
      const write = (name: string, rows: readonly unknown[]) =>
        writeFileSync(join(dir, name), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
      const run = (stage: string) =>
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
            "--stage",
            stage,
          ],
          { cwd: ROOT, encoding: "utf8" },
        );
      const clean = stage1();
      write("on-arm.jsonl", clean.on.arm);
      write("on-grades.jsonl", clean.on.grades);
      write("off-arm.jsonl", clean.off.arm);
      write("off-grades.jsonl", clean.off.grades);
      const ok = run("1");
      expect(ok.status, ok.stderr).toBe(0);
      expect(JSON.parse(ok.stdout).effect).toBe("on-better");
      const halted = stage1({ onFalse: 1 });
      write("on-arm.jsonl", halted.on.arm);
      write("on-grades.jsonl", halted.on.grades);
      expect(run("1").status).toBe(1);
      expect(run("2").status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
