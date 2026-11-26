/**
 * Track M acceptance 6: $0 end to end with scripted agents. No model, no VM, no network.
 *
 * Every trial runs the REAL sealed gate (`runGatedTrial`, myco.gate/v1 unchanged) on the
 * document a scripted agent "saved", and the REAL independent grader on the same bytes.
 * Seed phase (cold, learning) -> pinned store -> measurement phase (cold vs warm on the
 * frozen repeat/similar pairs, no learning). Then a poisoning scenario: a verified skill
 * that misleads on later tasks is quarantined by its refuted uses and stops being served.
 *
 * The scripted agents are rigged so warm beats cold: this proves the plumbing, never the
 * effect. Rows are `simulated` and `never-r1`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { benchmarkArmRowSchema } from "../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import type { BenchmarkTask } from "../../src/benchmark/taskset.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import {
  pairedCounts,
  runSkillArmTrial,
  type SkillArmRow,
  type SkillTrialRun,
  skillTaskPairs,
  summarizeSkillArms,
  taskFeatures,
} from "../../src/skills/arm.ts";
import { retrieve } from "../../src/skills/retrieve.ts";
import { SkillStore } from "../../src/skills/store.ts";
import {
  docWith,
  forbiddenFor,
  GOOD_PRECONDITIONS,
  GOOD_STEPS,
  gatedRun,
  LEDGER_REF,
  pristine,
  taskById,
} from "./helpers.ts";

let base: string;
let vault: VerdictVault;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-skills-e2e-"));
  vault = new VerdictVault({
    root: join(base, "vault"),
    key: newVaultKey(),
    agentRoots: [join(base, "agent")],
  });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

type Behaviour = "correct" | "unsaved" | "wrong-value" | "wrong-column";

/** One scripted trial: the agent's behaviour decides the saved document; gate + grader judge it. */
function scripted(
  task: BenchmarkTask,
  runId: string,
  behaviour: Behaviour,
  steps: readonly string[] = GOOD_STEPS,
): () => Promise<SkillTrialRun> {
  return async () => {
    const doc =
      behaviour === "correct"
        ? docWith(task, task.intent.newValue)
        : behaviour === "wrong-value"
          ? docWith(task, "WRONG-VALUE")
          : behaviour === "wrong-column"
            ? docWith(task, task.intent.newValue, 1)
            : pristine(task);
    const run = await gatedRun(vault, base, task, runId, doc);
    if (run.outcome.status !== "decided") throw new Error("refused");
    return {
      gate: run.outcome.result,
      grade: run.grade,
      procedure: { preconditions: [...GOOD_PRECONDITIONS], steps: [...steps] },
      plannerModelId: "simulated:scripted",
      assisted: false,
      corrections: run.outcome.corrections,
      ledgerRef: LEDGER_REF,
      estimatedUsd: 0.01,
    };
  };
}

describe("track M end to end (scripted agents, real gate and grader)", () => {
  it("seed -> pinned store -> warm beats cold on repeat and similar; refuted seeds never stored", async () => {
    const pairs = skillTaskPairs().slice(0, 4);
    const store = SkillStore.open(join(base, "store"));
    const rows: SkillArmRow[] = [];

    // Seed phase: cold, learning. Pair 3's seed run saves a wrong value: refuted, not stored.
    for (const [i, p] of pairs.entries()) {
      const task = taskById(p.seedTaskId);
      const runId = `seed-${i}`;
      rows.push(
        await runSkillArmTrial({
          baseArm: "hcu-shell",
          arm: "cold",
          kind: "seed",
          pairId: p.pairId,
          task,
          runId,
          store,
          learn: true,
          forbidden: forbiddenFor(task),
          execute: scripted(task, runId, i === 3 ? "wrong-value" : "correct"),
        }),
      );
    }
    const seedRows = rows.filter((r) => r.kind === "seed");
    expect(seedRows.map((r) => r.verified)).toEqual([true, true, true, false]);
    expect(seedRows.map((r) => r.admittedSkillId !== null)).toEqual([true, true, true, false]);
    expect(seedRows[3]?.admissionCode).toBe("GATE_NOT_VERIFIED");
    expect(store.active()).toHaveLength(3);
    const pinned = store.head();

    // Measurement phase: the scripted agent follows advice when it gets it (saves with Keep
    // Current Format); cold, it forgets to save, except on the first pair.
    for (const [i, p] of pairs.entries()) {
      for (const kind of ["repeat", "similar"] as const) {
        const task = taskById(kind === "repeat" ? p.seedTaskId : p.similarTaskId);
        for (const arm of ["cold", "warm"] as const) {
          const runId = `${arm}-${kind}-${i}`;
          rows.push(
            await runSkillArmTrial({
              baseArm: "hcu-shell",
              arm,
              kind,
              pairId: p.pairId,
              task,
              runId,
              store: arm === "warm" ? store : null,
              learn: false,
              execute: (advice) =>
                scripted(
                  task,
                  runId,
                  advice?.includes("Keep Current Format") || (arm === "cold" && i === 0)
                    ? "correct"
                    : "unsaved",
                )(),
            }),
          );
        }
      }
    }

    const summary = summarizeSkillArms(rows);
    expect(summary.errors).toEqual([]);
    expect(summary.r1Evidence).toBe(false);
    const cell = (arm: string, kind: string) =>
      summary.cells.find((c) => c.arm === arm && c.kind === kind);
    expect(cell("cold", "repeat")?.verifiedRate).toBe(0.25);
    expect(cell("warm", "repeat")?.verifiedRate).toBe(1);
    expect(cell("cold", "similar")?.verifiedRate).toBe(0.25);
    expect(cell("warm", "similar")?.verifiedRate).toBe(1);
    expect(cell("warm", "repeat")?.estimatedCostPerVerified).toBeCloseTo(0.01);
    expect(pairedCounts(rows, "hcu-shell")).toEqual({
      both: 2,
      warmOnly: 6,
      coldOnly: 0,
      neither: 0,
      unpaired: 0,
    });

    // Warm rows retrieved from the pinned store; cold rows never touched it.
    for (const r of rows.filter((x) => x.arm === "warm")) {
      expect(r.retrievedSkillIds.length).toBeGreaterThan(0);
      expect(r.storeHead).not.toBeNull();
    }
    for (const r of rows.filter((x) => x.arm === "cold")) expect(r.storeHead).toBeNull();
    expect(rows.find((r) => r.runId === "warm-repeat-0")?.storeHead).toBe(pinned);
    // Learning is off in measurement: no new skills, and every use was verified.
    expect(store.active()).toHaveLength(3);
    for (const s of store.skills()) expect(s.uses.refuted).toBe(0);

    // Never R1 evidence.
    for (const r of rows) {
      expect(r.evidence).toBe("never-r1");
      expect(r.simulated).toBe(true);
      expect(validateSchema(r, benchmarkArmRowSchema).length).toBeGreaterThan(0);
    }
  });

  it("a misleading verified skill is quarantined by its refuted uses and stops being served", async () => {
    const [p0, p1] = skillTaskPairs();
    const store = SkillStore.open(join(base, "store"));
    const seedTask = taskById(p0?.seedTaskId as string);
    // The seed run itself is correct (verified, graded), but the procedure it left misleads.
    const poison = [
      "Open the spreadsheet named in the instruction in Calc",
      "Type the new value one column to the right of the named column",
      "Save with Keep Current Format",
    ];
    const seed = await runSkillArmTrial({
      baseArm: "c1-screenshot",
      arm: "cold",
      kind: "seed",
      pairId: p0?.pairId as string,
      task: seedTask,
      runId: "seed-poison",
      store,
      learn: true,
      forbidden: forbiddenFor(seedTask),
      execute: scripted(seedTask, "seed-poison", "correct", poison),
    });
    expect(seed.admittedSkillId).not.toBeNull();
    const poisonId = seed.admittedSkillId as string;

    // A later warm run follows the advice and writes to the wrong column: refuted.
    const t1 = taskById(p1?.similarTaskId as string);
    const warm = await runSkillArmTrial({
      baseArm: "c1-screenshot",
      arm: "warm",
      kind: "similar",
      pairId: p1?.pairId as string,
      task: t1,
      runId: "warm-poisoned",
      store,
      learn: false,
      execute: (advice) =>
        scripted(
          t1,
          "warm-poisoned",
          advice?.includes("to the right") ? "wrong-column" : "correct",
        )(),
    });
    expect(warm.retrievedSkillIds).toEqual([poisonId]);
    expect(warm.verified).toBe(false);
    expect(store.skills().find((s) => s.record.skillId === poisonId)?.status).toBe("quarantined");

    // The next warm run gets no advice from it (and survives a reopen).
    const reopened = SkillStore.open(join(base, "store"), { expectHead: store.head() });
    expect(
      retrieve(reopened, { taskFamily: t1.family, features: taskFeatures(t1) }).skills,
    ).toEqual([]);

    // Revocation works the same way for an operator-flagged skill.
    const t2 = taskById(p1?.seedTaskId as string);
    const second = await runSkillArmTrial({
      baseArm: "c1-screenshot",
      arm: "cold",
      kind: "seed",
      pairId: p1?.pairId as string,
      task: t2,
      runId: "seed-2",
      store,
      learn: true,
      forbidden: forbiddenFor(t2),
      execute: scripted(t2, "seed-2", "correct"),
    });
    store.revoke(second.admittedSkillId as string, "operator");
    expect(store.active()).toEqual([]);
  });
});
