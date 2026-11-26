/**
 * Corrections A/B evidence packs for tests (schemas/m2-ab-pack.ts): real fc-v1 tasks, both arms,
 * experiment-marked rows, run configs, trial-ops rows, and (Stage 1) Stage 0's ledgers and a
 * committed pre-registration file.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import { type BenchmarkGradeRow, gradeRow } from "../../src/benchmark/grade/row.ts";
import { type BenchmarkTask, buildTaskSet } from "../../src/benchmark/taskset.ts";
import type { TrialOps } from "../../src/m2/evidence.ts";

export const AB_TASKS = buildTaskSet().tasks;
const H = (n: number) => n.toString(16).padStart(64, "0");

export type Side = "on" | "off";
/** Whether a task's trial is verified (and graded pass) in an arm; a false DONE is gate-verified but graded fail. */
export type Outcome = "verified" | "refuted" | "false-done";

export interface AbArmFiles {
  arm: BenchmarkArmRow[];
  grades: BenchmarkGradeRow[];
  ops: TrialOps[];
}

export function abArm(
  side: Side,
  stage: 0 | 1,
  tasks: readonly BenchmarkTask[],
  outcome: (t: BenchmarkTask, i: number) => Outcome,
): AbArmFiles {
  const prefix = stage === 0 ? "s0" : "s1";
  const out: AbArmFiles = { arm: [], grades: [], ops: [] };
  tasks.forEach((t, i) => {
    const o = t.satisfiable ? outcome(t, i) : "refuted";
    const base = {
      schema: "myco.benchmark.arm-row/1" as const,
      taskSetVersion: t.taskSetVersion,
      arm: "myco-gate" as const,
      trialKey: `${prefix}-${side}-${t.taskId}`,
      taskId: t.taskId,
      faultClass: t.faultClass,
      fixtureSha256: t.fixtureSha256,
      instructionSha256: t.instructionSha256,
      plannerModelId: "claude-sonnet-5-5",
      outputCeiling: 8192,
      claim: "done" as const,
      persistedSha256: H(i + 1),
      cost: { modelUsd: 0.5, wallClockS: 100, vmS: 80 },
      experiment: { id: "corrections-ab" as const, stage, arm: side, seed: `${prefix}-${side}` },
    };
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
            gate: { called: true, verdict: "refuted", corrections: side },
            accepted: false,
            cause: { kind: "agent", detail: "gate refuted the agent's done" },
          }
        : {
            ...base,
            gate: { called: true, verdict: "verified", corrections: side },
            accepted: true,
            cause: null,
          };
    out.arm.push(row);
    const pass = o === "verified" && t.satisfiable;
    out.grades.push(
      gradeRow(row.trialKey, row.taskId, {
        graderVersion: "false-completion-grader/1",
        status: pass ? "pass" : "fail",
        reasons: pass ? [] : ["x"],
        fixtureSha256: row.fixtureSha256,
        persistedSha256: row.persistedSha256,
        target: "B2",
        targetSatisfied: pass,
        mismatches: [],
        mismatchCount: pass ? 0 : 1,
      }),
    );
    out.ops.push({
      schema: "myco.m2.trial-ops/1",
      trialKey: row.trialKey,
      hostLoad1mStart: 3.5,
      harnessClass: null,
      faultLanded: t.faultClass === "none" ? null : true,
      resetBootClass: "cold",
      resetGuestCpuFirstSshS: 280,
    });
  });
  return out;
}

export const abConfig = (corrections: Side) => ({
  corrections,
  retryBudget: 1,
  pacing: { perTrialGapS: 60 },
  plannerModelId: "claude-sonnet-5-5",
  outputCeiling: 8192,
});

/**
 * Stage 1: both 50, ON only 12, OFF only 3, neither 35 (the 10 invalid-target tasks included).
 * One-sided sign test p = 0.017578125; Newcombe 95% CI (0.01621993526115577, 0.16157233386670558),
 * the reference values pinned in test/m2/corrections-ab.test.ts.
 */
export function stage1Arms(): { on: AbArmFiles; off: AbArmFiles } {
  const clean = AB_TASKS.filter((t) => t.faultClass === "none").map((t) => t.taskId);
  const faulted = AB_TASKS.filter((t) => t.satisfiable && t.faultClass !== "none").map(
    (t) => t.taskId,
  );
  const both = new Set(clean.slice(0, 50));
  const onWins = new Set([...clean.slice(50, 60), ...faulted.slice(0, 2)]);
  const offWins = new Set(faulted.slice(2, 5));
  return {
    on: abArm("on", 1, AB_TASKS, (t) =>
      both.has(t.taskId) || onWins.has(t.taskId) ? "verified" : "refuted",
    ),
    off: abArm("off", 1, AB_TASKS, (t) =>
      both.has(t.taskId) || offWins.has(t.taskId) ? "verified" : "refuted",
    ),
  };
}

/** Stage 0: the pilot's 30 tasks; ON verifies all, OFF none (a strong split, still not claimed). */
export function stage0Arms(): { on: AbArmFiles; off: AbArmFiles } {
  const demo = AB_TASKS.filter((t) => t.inDemo);
  return {
    on: abArm("on", 0, demo, () => "verified"),
    off: abArm("off", 0, demo, () => "refuted"),
  };
}

const jsonl = (rows: readonly unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");

export interface AbPackSpec {
  stage: 0 | 1;
  arms?: { on: AbArmFiles; off: AbArmFiles };
  manifest?: Record<string, unknown>;
  configs?: { on: unknown; off: unknown };
  /** Written as `<repoRoot>/prereg/<name>.md`; the manifest declares its sha256 unless overridden. */
  prereg?: string;
  /** Use this already-committed repository file as the pre-registration instead (nothing written). */
  preregRepoFile?: { root: string; file: string };
}

/**
 * Writes an A/B pack `name` under `root`. Stage 1 also writes Stage 0's ledgers and a
 * pre-registration file under `repoRoot` (pass the same `repoRoot` to `readAbPack`).
 */
export function writeAbPack(
  name: string,
  spec: AbPackSpec,
  root: string = mkdtempSync(join(tmpdir(), "m2-ab-")),
  repoRoot: string = root,
): string {
  const dir = join(root, name);
  const arms = spec.arms ?? (spec.stage === 0 ? stage0Arms() : stage1Arms());
  const configs = spec.configs ?? { on: abConfig("on"), off: abConfig("off") };
  for (const side of ["on", "off"] as const) {
    mkdirSync(join(dir, side), { recursive: true });
    writeFileSync(join(dir, side, "arm.jsonl"), jsonl(arms[side].arm));
    writeFileSync(join(dir, side, "grades.jsonl"), jsonl(arms[side].grades));
    writeFileSync(join(dir, side, "ops.jsonl"), jsonl(arms[side].ops));
    writeFileSync(join(dir, side, "run-config.json"), `${JSON.stringify(configs[side])}\n`);
  }
  let manifest: Record<string, unknown> = {
    schema: "myco.m2.ab-pack/1",
    row: "AB",
    stage: spec.stage,
    evidenceUse: "experiment-only (never R1 evidence)",
  };
  if (spec.stage === 1) {
    const s0 = stage0Arms();
    for (const side of ["on", "off"] as const) {
      mkdirSync(join(dir, "stage0", side), { recursive: true });
      writeFileSync(join(dir, "stage0", side, "arm.jsonl"), jsonl(s0[side].arm));
    }
    if (spec.preregRepoFile !== undefined) {
      const { root: repo, file } = spec.preregRepoFile;
      manifest = {
        ...manifest,
        preregistration: {
          file,
          sha256: createHash("sha256")
            .update(readFileSync(join(repo, file)))
            .digest("hex"),
        },
      };
    } else {
      const text = spec.prereg ?? "# corrections A/B pre-registration (fixture)\n";
      mkdirSync(join(repoRoot, "prereg"), { recursive: true });
      writeFileSync(join(repoRoot, "prereg", `${name}.md`), text);
      manifest = {
        ...manifest,
        preregistration: {
          file: `prereg/${name}.md`,
          sha256: createHash("sha256").update(text).digest("hex"),
        },
      };
    }
  }
  writeFileSync(
    join(dir, "pack.json"),
    `${JSON.stringify({ ...manifest, ...spec.manifest }, null, 2)}\n`,
  );
  return dir;
}
