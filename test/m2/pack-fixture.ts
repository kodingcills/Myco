/**
 * Fixture M2 evidence packs (TIF-273): synthetic rows, private temp dirs, no VM, no model.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BenchmarkArmRow, expectedAccepted } from "../../src/benchmark/check.ts";
import type { BenchmarkGradeRow } from "../../src/benchmark/grade/row.ts";
import { type BenchmarkTask, buildTaskSet } from "../../src/benchmark/taskset.ts";
import {
  ATTEMPT_EVENT_SCHEMA,
  type AttemptEvent,
  eventSha256,
  GENESIS_SHA256,
  type LedgerHead,
} from "../../src/m2/attempt-ledger.ts";
import type { PackInput, PackManifest, TrialOps } from "../../src/m2/evidence.ts";

const FIX = "a".repeat(64);
const INSTR = "b".repeat(64);
export const doc = (n: number) => n.toString(16).padStart(64, "0");

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
    taskSetVersion: "fx-synthetic",
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
    faultLanded: arm.faultClass === "none" ? null : true,
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

/** The published fc-v1 tasks (the binding's own source, `buildTaskSet`). */
export const FC_V1_TASKS: readonly BenchmarkTask[] = buildTaskSet().tasks;
export const fcTasks = (cls: string) => FC_V1_TASKS.filter((t) => t.faultClass === cls);

/** Row fields that bind a trial to fc-v1 task `t`: id, faultClass and the REAL hashes. */
export const fcRow = (t: BenchmarkTask): Partial<BenchmarkArmRow> => ({
  taskSetVersion: t.taskSetVersion,
  taskId: t.taskId,
  faultClass: t.faultClass,
  fixtureSha256: t.fixtureSha256,
  instructionSha256: t.instructionSha256,
});

/** An unregistrable trial on fc-v1 invalid-target task `t`, claiming done, graded fail. */
export const unregistrable = (i: number, t: BenchmarkTask): Trial =>
  trial(
    i,
    {
      ...fcRow(t),
      gate: { called: false, verdict: null, unregistrable: true },
      accepted: false,
      cause: { kind: "oracle", detail: "unregistrable: the gate registry rejected the task spec" },
    },
    "fail",
    { faultLanded: true },
  );

/**
 * R1 pack: the real fc-v1 task set, each task exactly once (#506 round 2: R1 evidence must be
 * exactly a published task set). 60 clean verified-pass; 30 faulted (kill-app, delayed-save,
 * focus-change) refuted on a failed document; 10 invalid-target unregistrable. Expected: 90
 * eligible (30 faulted), 10 unregistrable, 100 counted, 60 accepted, 0 false DONE accepted.
 */
export function r1Trials(): Trial[] {
  const out: Trial[] = [];
  let i = 0;
  for (const t of fcTasks("none")) out.push(trial(i++, fcRow(t)));
  for (const cls of ["kill-app", "delayed-save", "focus-change"])
    for (const t of fcTasks(cls)) out.push(refuted(i++, fcRow(t)));
  for (const t of fcTasks("invalid-target")) out.push(unregistrable(i++, t));
  return out;
}

/**
 * A pack manifest. The default is the fc-v1 R1 pack (100 trials, 10 unregistrable). A manifest
 * for a pack that is not R1 evidence carries no split unless the caller gives one.
 */
export function manifest(over: Partial<PackManifest> = {}): PackManifest {
  const m: PackManifest = {
    schema: "myco.m2.pack/1",
    rows: ["R1"],
    expectTrials: { "myco-gate": 100 },
    expectUnregistrable: { "myco-gate": 10 },
    expectPairs: null,
    runs: null,
    ...over,
  };
  if (!m.rows.includes("R1") && over.expectUnregistrable === undefined) {
    const { expectUnregistrable: _drop, ...rest } = m;
    return rest;
  }
  return m;
}

/**
 * The attempt ledger an honest runner writes for `trials`, in order: a start and an end per
 * trial, the end a `harness-fault` exactly where the trial-ops row names a harness class.
 */
export function ledgerFor(trials: readonly Trial[]): { events: AttemptEvent[]; head: LedgerHead } {
  const events: AttemptEvent[] = [];
  let prev = GENESIS_SHA256;
  const push = (e: Omit<AttemptEvent, "schema" | "seq" | "prevSha256">) => {
    const event: AttemptEvent = {
      schema: ATTEMPT_EVENT_SCHEMA,
      seq: events.length,
      prevSha256: prev,
      ...e,
    };
    events.push(event);
    prev = eventSha256(event);
  };
  for (const t of trials) {
    const who = { trialKey: t.arm.trialKey, taskId: t.arm.taskId, arm: t.arm.arm };
    push({ kind: "start", ...who });
    push(
      t.ops.harnessClass === null
        ? { kind: "end", ...who, outcome: "completed" }
        : { kind: "end", ...who, outcome: "harness-fault", harnessClass: t.ops.harnessClass },
    );
  }
  return { events, head: { events: events.length, headSha256: prev } };
}

const isR1 = (m: unknown) =>
  m !== null &&
  typeof m === "object" &&
  Array.isArray((m as { rows?: unknown }).rows) &&
  (m as { rows: unknown[] }).rows.includes("R1");

/**
 * A pack input. An R1 pack gets the honest runner's attempt ledger, and its manifest the head
 * pin, unless the manifest already pins one (tests that forge a ledger pass their own).
 */
export function input(trials: Trial[], m: unknown = manifest()): PackInput {
  const base = {
    arm: trials.map((t) => t.arm),
    grades: trials.map((t) => t.grade),
    ops: trials.map((t) => t.ops),
    readErrors: [],
    runs: null,
  };
  // No ledger for a non-R1 pack, or for an empty one (a 0-event head cannot be pinned).
  if (!isR1(m) || trials.length === 0) return { manifest: m, ...base };
  const { events, head } = ledgerFor(trials);
  const pinned =
    (m as { attempts?: unknown }).attempts === undefined ? { ...(m as object), attempts: head } : m;
  return { manifest: pinned, ...base, attempts: events };
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
 * R3 pack: 32 faulted gated trials. kill-app 12 (10 refuted, 2 harness: ineligible),
 * tamper-oracle-inputs 10 (all refuted), injected-instruction 10 (8 refuted, 2 verified-pass:
 * the agent ignored the injection and did the task). 30 eligible. Plus 3 normal trials,
 * which are not faulted and so not R3 trials.
 */
export function r3Trials(): Trial[] {
  const out: Trial[] = [];
  let i = 0;
  for (let k = 0; k < 10; k++) out.push(refuted(i++, { faultClass: "kill-app" }));
  for (let k = 0; k < 2; k++) out.push(harnessFault(i++, { faultClass: "kill-app" }));
  for (let k = 0; k < 10; k++) out.push(refuted(i++, { faultClass: "tamper-oracle-inputs" }));
  for (let k = 0; k < 8; k++) out.push(refuted(i++, { faultClass: "injected-instruction" }));
  for (let k = 0; k < 2; k++) out.push(trial(i++, { faultClass: "injected-instruction" }));
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
  const { manifest: pinned, attempts } = input(trials, m);
  if (attempts !== undefined) writeFileSync(join(dir, "attempts.jsonl"), jsonl(attempts));
  writeFileSync(join(dir, "pack.json"), `${JSON.stringify(pinned, null, 2)}\n`);
  writeFileSync(join(dir, "arm.jsonl"), jsonl(trials.map((t) => t.arm)));
  writeFileSync(join(dir, "grades.jsonl"), jsonl(trials.map((t) => t.grade)));
  writeFileSync(join(dir, "ops.jsonl"), jsonl(trials.map((t) => t.ops)));
  return dir;
}
