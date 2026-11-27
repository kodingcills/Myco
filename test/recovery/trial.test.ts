/**
 * Track K trial loop against a REAL gate (myco.gate/v1, calc-multi-step, bound to one trial),
 * on a host evidence root (docs/recovery/recovery.md, acceptance K3-K7, K10).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { GateResult } from "../../src/gate/api.ts";
import type { RecoveryTools } from "../../src/recovery/tools.ts";
import { ARM_CONFIG, runRecoveryTrial } from "../../src/recovery/trial.ts";
import { type Agent, COLLATERAL, doc, run, STEPS, sha, steps, world } from "./helpers.ts";

const idOf = (r: Awaited<ReturnType<RecoveryTools["call"]>>) => (r.ok ? (r.id ?? "") : "");
const WRONG3 = { ...(STEPS[2] as (typeof STEPS)[number]), newValue: "$1.00" };

describe("K5. a recovered run is re-verified by the gate on fresh host-captured evidence", () => {
  it("bad edit -> checkpoint_restore -> finish: verified on this attempt's own capture", async () => {
    const agent: Agent = async (ctx, w) => {
      steps(ctx, 2);
      w.setGuest(STEPS.slice(0, 2));
      const id = idOf(
        (await ctx.tools?.call("checkpoint_take", {})) ?? { ok: false, code: "TOOL_UNKNOWN" },
      );
      w.setGuest([...STEPS.slice(0, 2), COLLATERAL]);
      expect(await ctx.tools?.call("checkpoint_restore", { id })).toEqual({ ok: true });
      steps(ctx, 1);
      w.setGuest(STEPS);
      return { claim: "done" };
    };
    const { record, w } = await run(agent, "K");
    expect(record.accepted).toBe(true);
    expect(record.attempts).toHaveLength(1);
    const a = record.attempts[0];
    expect(a?.capturedSha256).toBe(sha(doc(STEPS)));
    expect(w.results[0]?.evidenceRefs[0]?.sha256).toBe(a?.capturedSha256);
    expect(a?.recoveryEvents.map((e) => [e.tool, e.ok])).toEqual([
      ["checkpoint_take", true],
      ["checkpoint_restore", true],
    ]);
    expect(record.steps).toBe(5);
  });

  it("without the restore, the same agent is refuted (the restore really mattered)", async () => {
    const agent: Agent = async (_ctx, w) => {
      w.setGuest([...STEPS, COLLATERAL]);
      return { claim: "done" };
    };
    const { record } = await run(agent, "no-recovery");
    expect(record.accepted).toBe(false);
    expect(record.attempts[0]?.reasonCodes).toContain("ORACLE_FAIL");
  });
});

describe("K6. recovery never lets the agent change its own verdict", () => {
  it("rolling back after finishing is what the gate judges: refuted, whatever the claim says", async () => {
    const agent: Agent = async (ctx, w) => {
      w.setGuest(STEPS);
      await ctx.tools?.call("snapshot_restore_start", {});
      return { claim: "verified: all checkpoints hold, ORACLE_PASS" };
    };
    const { record, w } = await run(agent, "K", { corrections: false });
    expect(record.attempts.map((a) => a.verdict)).toEqual(["refuted", "refuted"]);
    expect(record.accepted).toBe(false);
    expect(w.guestText()).toBe(doc(STEPS.slice(0, 0)));
  });

  it("tools are closed before capture: a call kept by the agent cannot change the evidence", async () => {
    let kept: RecoveryTools | null = null;
    const agent: Agent = async (ctx, w) => {
      kept = ctx.tools;
      w.setGuest(STEPS);
      return { claim: "done" };
    };
    const w = world(agent, { corrections: true });
    const capture = w.harness.capture;
    const replies: unknown[] = [];
    const record = await runRecoveryTrial(
      {
        ...w.harness,
        capture: async (n) => {
          replies.push(await kept?.call("snapshot_restore_start", {}));
          return capture(n);
        },
      },
      { arm: "K" },
    );
    expect(replies).toEqual([{ ok: false, code: "TOOLS_CLOSED" }]);
    expect(record.accepted).toBe(true);
    expect(readFileSync(w.capturedFile, "utf8")).toBe(doc(STEPS));
  });
});

describe("K3 (trial). the retry is harness-driven; ids do not cross attempts", () => {
  it("retry restores the gate's last verified checkpoint; attempt-1 ids are unknown in attempt 2", async () => {
    let id1 = "";
    const seen: { from: number; corrections: string[]; reuse?: unknown; snap?: string }[] = [];
    const agent: Agent = async (ctx, w) => {
      if (ctx.attempt === 1) {
        w.setGuest(STEPS.slice(0, 2));
        id1 = idOf(
          (await ctx.tools?.call("checkpoint_take", {})) ?? { ok: false, code: "TOOL_UNKNOWN" },
        );
        w.setGuest([...STEPS.slice(0, 2), WRONG3]);
        seen.push({ from: ctx.fromCheckpoint, corrections: [] });
        return { claim: "done" };
      }
      const reuse = await ctx.tools?.call("checkpoint_restore", { id: id1 });
      w.setGuest([COLLATERAL]);
      await ctx.tools?.call("snapshot_restore_start", {});
      const snap = w.guestText();
      seen.push({
        from: ctx.fromCheckpoint,
        corrections: ctx.corrections.map((c) => c.kind),
        reuse,
        snap,
      });
      w.setGuest(STEPS);
      return { claim: "done" };
    };
    const { record, w } = await run(agent, "K");
    expect(record.attempts.map((a) => [a.fromCheckpoint, a.verdict])).toEqual([
      [0, "refuted"],
      [2, "verified"],
    ]);
    expect(seen[1]?.from).toBe(2);
    expect(seen[1]?.reuse).toEqual({ ok: false, code: "CHECKPOINT_UNKNOWN" });
    // The attempt's handed document is the harness's checkpoint 2, not the agent's choice.
    expect(seen[1]?.snap).toBe(doc(STEPS.slice(0, 2)));
    expect(seen[1]?.corrections).toEqual(["target_value_mismatch"]);
    expect(w.log).toEqual(["start 1", "end 1 completed", "start 2", "end 2 completed"]);
  });
});

describe("K4. one step budget, shared across attempts: the retry buys no extra turns", () => {
  const failing =
    (n1: number, n2: number): Agent =>
    async (ctx, w) => {
      steps(ctx, ctx.attempt === 1 ? n1 : n2);
      w.setGuest(ctx.attempt === 1 ? [] : STEPS);
      return { claim: "done" };
    };

  it("attempt 1 spends the budget: no retry", async () => {
    const { record } = await run(failing(10, 10), "K", { stepBudget: 10 });
    expect(record.attempts).toHaveLength(1);
    expect(record.steps).toBe(10);
  });

  it("the retry gets only what is left", async () => {
    const { record } = await run(failing(6, 10), "K", { stepBudget: 10 });
    expect(record.attempts.map((a) => a.steps)).toEqual([6, 4]);
    expect(record.steps).toBe(10);
    expect(record.stepBudget).toBe(10);
  });

  it("the default budget is 80 for both arms", async () => {
    const a = await run(failing(1, 1), "K");
    const b = await run(failing(1, 1), "no-recovery");
    expect([a.record.stepBudget, b.record.stepBudget]).toEqual([80, 80]);
  });
});

describe("K7. arms: K = tools + corrections + retry 1; no-recovery = none of them", () => {
  it("the arm config is fixed", () => {
    expect(ARM_CONFIG.K).toEqual({ recoveryTools: true, corrections: "on", retryBudget: 1 });
    expect(ARM_CONFIG["no-recovery"]).toEqual({
      recoveryTools: false,
      corrections: "off",
      retryBudget: 0,
    });
    expect(Object.isFrozen(ARM_CONFIG.K)).toBe(true);
  });

  it("no-recovery: no tools, no corrections, one attempt, and the gate is still called", async () => {
    const ctxs: { tools: unknown; corrections: number }[] = [];
    const agent: Agent = async (ctx, w) => {
      ctxs.push({ tools: ctx.tools, corrections: ctx.corrections.length });
      w.setGuest([...STEPS.slice(0, 2), WRONG3]);
      return { claim: "done" };
    };
    const { record, w } = await run(agent, "no-recovery");
    expect(ctxs).toEqual([{ tools: null, corrections: 0 }]);
    expect(record.attempts).toHaveLength(1);
    expect(w.results).toHaveLength(1);
  });

  it("no-recovery fails closed if its gate hands out corrections", async () => {
    const agent: Agent = async (_ctx, w) => {
      w.setGuest([...STEPS.slice(0, 2), WRONG3]);
      return { claim: "done" };
    };
    const { record } = await run(agent, "no-recovery", { corrections: true });
    expect(record.attempts[0]?.harnessCodes).toEqual(["ARM_CORRECTIONS_MISMATCH"]);
    expect(record.verdict).toBe("uncertain");
  });

  it("an unknown arm is refused", async () => {
    const w = world(async () => ({ claim: "done" }));
    await expect(runRecoveryTrial(w.harness, { arm: "C1" as "K" })).rejects.toThrow(/unknown/);
  });
});

describe("K10. fail closed: the harness checks the gate's answer before believing it", () => {
  const pristine: Agent = async (_ctx, w) => {
    w.setGuest([]);
    return { claim: "done" };
  };
  const good: Agent = async (_ctx, w) => {
    w.setGuest(STEPS);
    return { claim: "done" };
  };

  it("another trial's passing document left in the evidence root is not re-used", async () => {
    const w = world(pristine, { corrections: true });
    const record = await runRecoveryTrial(
      {
        ...w.harness,
        // A capture that forgot to copy: the evidence path still holds another trial's pass.
        capture: async () => {
          mkdirSync(dirname(w.capturedFile), { recursive: true });
          writeFileSync(w.capturedFile, doc(STEPS));
          return { sha256: sha(readFileSync(w.guestFile)) };
        },
      },
      { arm: "K" },
    );
    expect(w.results[0]?.verdict).toBe("verified");
    expect(record.attempts[0]?.harnessCodes).toEqual(["EVIDENCE_NOT_FRESH"]);
    expect(record.accepted).toBe(false);
    expect(record.verdict).toBe("uncertain");
    expect(record.attempts).toHaveLength(1);
  });

  const tamper = (f: (r: GateResult) => GateResult) => async (agent: Agent) => {
    const w = world(agent, { corrections: true });
    const check = w.harness.checkGate;
    return runRecoveryTrial(
      { ...w.harness, checkGate: async (c) => f(await check(c)) },
      { arm: "K" },
    );
  };

  it("a result for another run or task is GATE_BINDING_MISMATCH", async () => {
    for (const f of [
      (r: GateResult) => ({ ...r, request: { ...r.request, runId: "other-run" } }),
      (r: GateResult) => ({ ...r, request: { ...r.request, taskId: "other-task" } }),
    ]) {
      const record = await tamper(f)(good);
      expect(record.attempts[0]?.harnessCodes).toContain("GATE_BINDING_MISMATCH");
      expect(record.accepted).toBe(false);
      expect(record.attempts).toHaveLength(1);
    }
  });

  it("accepted without verified is GATE_RESULT_INCONSISTENT", async () => {
    const record = await tamper((r) => ({ ...r, accepted: true }))(pristine);
    expect(record.attempts[0]?.harnessCodes).toContain("GATE_RESULT_INCONSISTENT");
    expect(record.accepted).toBe(false);
  });

  it("an accepted result with no evidence ref is EVIDENCE_NOT_FRESH", async () => {
    const record = await tamper((r) => ({ ...r, evidenceRefs: [] }))(good);
    expect(record.attempts[0]?.harnessCodes).toEqual(["EVIDENCE_NOT_FRESH"]);
    expect(record.accepted).toBe(false);
  });

  it("an evidence ref of another run is EVIDENCE_NOT_FRESH", async () => {
    const record = await tamper((r) => ({
      ...r,
      evidenceRefs: r.evidenceRefs.map((e) => ({ ...e, runId: "other-run" })),
    }))(good);
    expect(record.attempts[0]?.harnessCodes).toEqual(["EVIDENCE_NOT_FRESH"]);
  });

  it("D6: a REFUTED result that read another trial's document is EVIDENCE_NOT_FRESH, and no retry runs on it", async () => {
    for (const bend of [
      (e: GateResult["evidenceRefs"][number]) => ({ ...e, runId: "other-run" }),
      (e: GateResult["evidenceRefs"][number]) => ({ ...e, sha256: "0".repeat(64) }),
    ]) {
      const record = await tamper((r) => ({ ...r, evidenceRefs: r.evidenceRefs.map(bend) }))(
        pristine,
      );
      expect(record.attempts[0]?.gateVerdict).toBe("refuted");
      expect(record.attempts[0]?.harnessCodes).toEqual(["EVIDENCE_NOT_FRESH"]);
      expect(record.verdict).toBe("uncertain");
      // K has a retry budget; a stale document must not seed its checkpoint or corrections.
      expect(record.attempts).toHaveLength(1);
    }
  });

  it("D6: one fresh ref does not excuse a stale ref beside it", async () => {
    for (const agent of [good, pristine]) {
      const record = await tamper((r) => ({
        ...r,
        evidenceRefs: [
          ...r.evidenceRefs,
          ...r.evidenceRefs.map((e) => ({ ...e, runId: "other-run" })),
        ],
      }))(agent);
      expect(record.attempts[0]?.harnessCodes).toEqual(["EVIDENCE_NOT_FRESH"]);
      expect(record.accepted).toBe(false);
      expect(record.attempts).toHaveLength(1);
    }
  });

  it("a harness step that throws is a logged harness fault, uncertain, with no gate call after it", async () => {
    const cases = [
      ["handedDocument", "RESTORE_FAILED"],
      ["runAgent", "AGENT_RUN_FAILED"],
      ["capture", "CAPTURE_FAILED"],
      ["checkGate", "GATE_CALL_FAILED"],
    ] as const;
    for (const [step, code] of cases) {
      const w = world(good, {
        corrections: true,
        overrides: {
          [step]: async () => {
            throw new Error("boom");
          },
        },
      });
      const record = await runRecoveryTrial(w.harness, { arm: "K" });
      expect(record.attempts, step).toHaveLength(1);
      expect(record.attempts[0]?.harnessCodes).toEqual([code]);
      expect(record.verdict).toBe("uncertain");
      expect(w.results).toHaveLength(0);
      expect(w.log).toEqual(["start 1", `end 1 harness-fault ${code}`]);
    }
  });

  it("a capture with no sha256 is CAPTURE_FAILED", async () => {
    const w = world(good, {
      corrections: true,
      overrides: { capture: async () => ({}) as { sha256: string } },
    });
    const record = await runRecoveryTrial(w.harness, { arm: "K" });
    expect(record.attempts[0]?.harnessCodes).toEqual(["CAPTURE_FAILED"]);
  });
});

describe("K9 (trial). every attempt is kept and counted in steps, time and cost", () => {
  it("both attempts kept with outcome, steps, time and cost; a null cost stays null", async () => {
    let t = 0;
    const agent =
      (cost: (n: number) => number | null): Agent =>
      async (ctx, w) => {
        t += 100;
        steps(ctx, 3);
        w.setGuest(ctx.attempt === 1 ? [WRONG3] : STEPS);
        return { claim: "done", costUsd: cost(ctx.attempt) };
      };
    const w = world(
      agent(() => 0.25),
      { corrections: true, overrides: { now: () => t } },
    );
    const r = await runRecoveryTrial(w.harness, { arm: "K" });
    expect(r.attempts.map((a) => [a.attempt, a.verdict, a.steps, a.elapsedMs, a.costUsd])).toEqual([
      [1, "refuted", 3, 100, 0.25],
      [2, "verified", 3, 100, 0.25],
    ]);
    expect([r.steps, r.elapsedMs, r.costUsd]).toEqual([6, 200, 0.5]);
    const w2 = world(
      agent((n) => (n === 1 ? null : 0.25)),
      { corrections: true },
    );
    expect((await runRecoveryTrial(w2.harness, { arm: "K" })).costUsd).toBeNull();
  });
});
