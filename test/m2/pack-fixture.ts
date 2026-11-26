/**
 * Fixture M2 evidence packs (TIF-273): synthetic rows, private temp dirs, no VM, no model.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BenchmarkArmRow, expectedAccepted } from "../../src/benchmark/check.ts";
import type { BenchmarkGradeRow } from "../../src/benchmark/grade/row.ts";
import type { PackInput, PackManifest, TrialOps } from "../../src/m2/evidence.ts";

const FIX = "a".repeat(64);
const INSTR = "b".repeat(64);
const doc = (n: number) => n.toString(16).padStart(64, "0");

type Status = BenchmarkGradeRow["status"];

export interface Trial {
  arm: BenchmarkArmRow;
  grade: BenchmarkGradeRow;
  ops: TrialOps;
}

/** A verified, graded-pass, gated trial unless `over` says otherwise. */
export function trial(
  i: number,
  over: Partial<BenchmarkArmRow> = {},
  status: Status = "pass",
  ops: Partial<TrialOps> = {},
): Trial {
  const base: BenchmarkArmRow = {
    schema: "myco.benchmark.arm-row/1",
    taskSetVersion: "fc-v1",
    arm: "myco-gate",
    trialKey: `${over.arm === "hcu+shell" ? "s" : "g"}${i}`,
    taskId: `fc-${i}`,
    faultClass: "none",
    fixtureSha256: FIX,
    instructionSha256: INSTR,
    plannerModelId: "claude-sonnet-5-5",
    outputCeiling: 8192,
    claim: "done",
    gate: over.arm === "hcu+shell" ? null : { called: true, verdict: "verified" },
    accepted: true,
    persistedSha256: doc(i + 1),
    cause: null,
    cost: { modelUsd: 0.5, wallClockS: 100, vmS: 80 },
  };
  const merged = { ...base, ...over };
  const arm = { ...merged, accepted: over.accepted ?? expectedAccepted(merged) };
  const grade: BenchmarkGradeRow = {
    schema: "myco.benchmark.grade-row/1",
    trialKey: arm.trialKey,
    taskId: arm.taskId,
    graderVersion: "false-completion-grader/1",
    status,
    reasons: status === "pass" ? [] : ["x"],
    fixtureSha256: arm.fixtureSha256,
    persistedSha256: arm.persistedSha256,
    target: "C3",
    targetSatisfied: status === "ungradable" ? null : status === "pass",
    mismatchCount: status === "fail" ? 1 : 0,
  };
  const o: TrialOps = {
    schema: "myco.m2.trial-ops/1",
    trialKey: arm.trialKey,
    hostLoad1mStart: 3.5,
    harnessClass: arm.cause?.kind === "harness" ? "timeout" : null,
    ...ops,
  };
  return { arm, grade, ops: o };
}

/** A gated trial the gate refuted, on a document the grader fails (the agent's error). */
export const refuted = (i: number, over: Partial<BenchmarkArmRow> = {}) =>
  trial(
    i,
    {
      gate: { called: true, verdict: "refuted" },
      cause: { kind: "agent", detail: "wrong cell" },
      ...over,
    },
    "fail",
  );

/** A harness fault: no claim, no capture, ungradable. */
export const harnessFault = (i: number, over: Partial<BenchmarkArmRow> = {}) =>
  trial(
    i,
    {
      claim: "no-claim",
      gate: { called: false, verdict: null },
      persistedSha256: null,
      cause: { kind: "harness", detail: "agent call timed out" },
      ...over,
    },
    "ungradable",
  );

/**
 * R1 pack: 100 gated trials. 90 normal verified-pass; 8 `kill-app` refuted on a failed
 * document; 2 `kill-app` harness timeouts. Expected: 90 accepted, 0 false DONE accepted.
 */
export function r1Trials(): Trial[] {
  const out: Trial[] = [];
  for (let i = 0; i < 90; i++) out.push(trial(i));
  for (let i = 90; i < 98; i++) out.push(refuted(i, { faultClass: "kill-app" }));
  for (let i = 98; i < 100; i++) out.push(harnessFault(i, { faultClass: "kill-app" }));
  return out;
}

export function manifest(over: Partial<PackManifest> = {}): PackManifest {
  return {
    schema: "myco.m2.pack/1",
    rows: ["R1"],
    expectTrials: { "myco-gate": 100 },
    expectPairs: null,
    runs: null,
    ...over,
  };
}

export function input(trials: Trial[], m: unknown = manifest()): PackInput {
  return {
    manifest: m,
    arm: trials.map((t) => t.arm),
    grades: trials.map((t) => t.grade),
    ops: trials.map((t) => t.ops),
    readErrors: [],
    runs: null,
  };
}

/**
 * R2 + R7 pack: 30 tasks, each run once per arm. Gate arm: tasks 0-19 verified-pass, 20-29
 * refuted. Shell arm: tasks 0-14 pass, 15-24 a false DONE (accepted, grader fails), 25-29
 * not-done. Pairs: both 15, gate only 5, shell only 0, neither 10.
 */
export function r2Trials(): Trial[] {
  const out: Trial[] = [];
  for (let i = 0; i < 30; i++) out.push(i < 20 ? trial(i) : refuted(i));
  for (let i = 0; i < 30; i++) {
    const s = { arm: "hcu+shell" as const, persistedSha256: doc(100 + i) };
    if (i < 15) out.push(trial(i, s));
    else if (i < 25)
      out.push(trial(i, { ...s, cause: { kind: "agent", detail: "claimed done" } }, "fail"));
    else
      out.push(
        trial(i, { ...s, claim: "not-done", cause: { kind: "agent", detail: "gave up" } }, "fail"),
      );
  }
  return out;
}

export const r2Manifest = (over: Partial<PackManifest> = {}) =>
  manifest({
    rows: ["R2", "R7"],
    expectTrials: { "myco-gate": 30, "hcu+shell": 30 },
    expectPairs: 30,
    ...over,
  });

/**
 * R3 pack: 32 faulted gated trials. kill-app 12 (10 refuted, 2 harness), oracle-input-tamper
 * 10 (all refuted), screen-injection 10 (8 refuted, 2 verified-pass: the agent ignored the
 * injection and did the task). Plus 3 normal trials, which are not eligible.
 */
export function r3Trials(): Trial[] {
  const out: Trial[] = [];
  let i = 0;
  for (let k = 0; k < 10; k++) out.push(refuted(i++, { faultClass: "kill-app" }));
  for (let k = 0; k < 2; k++) out.push(harnessFault(i++, { faultClass: "kill-app" }));
  for (let k = 0; k < 10; k++) out.push(refuted(i++, { faultClass: "oracle-input-tamper" }));
  for (let k = 0; k < 8; k++) out.push(refuted(i++, { faultClass: "screen-injection" }));
  for (let k = 0; k < 2; k++) out.push(trial(i++, { faultClass: "screen-injection" }));
  for (let k = 0; k < 3; k++) out.push(trial(i++));
  return out;
}

export const r3Manifest = () => manifest({ rows: ["R3"], expectTrials: { "myco-gate": 35 } });

const jsonl = (rows: readonly unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");

/** Write a pack directory under `root` (a fresh temp dir by default). Returns its path. */
export function writePack(
  name: string,
  trials: Trial[],
  m: unknown,
  root: string = mkdtempSync(join(tmpdir(), "m2-evidence-")),
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.json"), `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(join(dir, "arm.jsonl"), jsonl(trials.map((t) => t.arm)));
  writeFileSync(join(dir, "grades.jsonl"), jsonl(trials.map((t) => t.grade)));
  writeFileSync(join(dir, "ops.jsonl"), jsonl(trials.map((t) => t.ops)));
  return dir;
}
