/**
 * The self-correcting loop end to end on the mock transport (M2 scope add B, acceptance 3
 * and 4). No VM, no model, no network.
 *
 * The gate runs as its own MCP process (`myco-gate mcp ... --corrections calc-multi-step`),
 * exactly as Claude Code would start it; the harness is `runMultiStepTrial` (one retry from
 * the last verified checkpoint); a scripted agent drives the fake Calc app. The agent
 * misreads one step's value. It is told nothing but its instruction and, on the retry, the
 * gate's `corrections` (what `AttemptContext.corrections` carries).
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Correction, GateResult } from "../../src/gate/api.ts";
import { type CellEdit, documentCsv, targetRef } from "../../src/gate/calc-document.ts";
import { openBoundGate } from "../../src/gate/demo.ts";
import {
  type AttemptContext,
  type MultiStepTrialRecord,
  runMultiStepTrial,
} from "../../src/gate/multistep.ts";
import { MS_SPEC, scriptedAgent } from "../../src/gate/multistep-demo.ts";
import { tempRoot } from "./helpers.ts";

const TASK = "calc-ms-correct";
const STATE = "sheet.csv";
const key = (record: string, column: string) => `${record}/${column}`;
const QTY = MS_SPEC.steps[1] as CellEdit;

interface Agent {
  /** What the agent does on one attempt. */
  run(context: AttemptContext): Promise<{ readonly claim: string }>;
  readonly contexts: AttemptContext[];
}

/**
 * An agent that misreads step 2's value (4224 for 4242) and believes a correction: each
 * target correction sets its belief for that record and column to the correction's
 * `expected`. With `ignoreCorrections`, it never updates. With `echoOnly`, on the retry it
 * changes nothing in the document and puts the corrections into its claim.
 */
function misreadingAgent(
  guestFile: string,
  mode: { ignoreCorrections?: boolean; echoOnly?: boolean } = {},
): Agent {
  const belief = new Map(MS_SPEC.steps.map((s) => [key(s.rowKey, s.column), s.newValue]));
  belief.set(key(QTY.rowKey, QTY.column), "4224");
  const contexts: AttemptContext[] = [];
  return {
    contexts,
    async run(context) {
      contexts.push(context);
      if (mode.echoOnly && context.attempt === 2) {
        await scriptedAgent(guestFile, []);
        return { claim: `Fixed: ${JSON.stringify(context.corrections)}` };
      }
      if (!mode.ignoreCorrections)
        for (const c of context.corrections)
          if (c.kind === "target_value_mismatch" || c.kind === "target_unchanged")
            belief.set(key(c.record, c.column), c.expected);
      const edits = MS_SPEC.steps
        .slice(context.fromCheckpoint)
        .map((s) => ({ ...s, newValue: belief.get(key(s.rowKey, s.column)) as string }));
      await scriptedAgent(guestFile, edits);
      return { claim: "All steps done and saved." };
    },
  };
}

async function trial(opts: {
  corrections: boolean;
  retryBudget: 0 | 1;
  mode?: Parameters<typeof misreadingAgent>[1];
  extraCalls?: (call: (args: Record<string, unknown>) => Promise<GateResult>) => Promise<void>;
}): Promise<{ trial: MultiStepTrialRecord; agent: Agent; results: GateResult[]; runId: string }> {
  const out = tempRoot();
  const evidence = join(out, "evidence");
  const runId = "loop-1";
  const guestFile = join(out, "guest", runId, STATE);
  const captured = join(evidence, runId, STATE);
  const tasksFile = join(out, "tasks.json");
  mkdirSync(dirname(guestFile), { recursive: true });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    tasksFile,
    JSON.stringify({
      tasks: [{ id: TASK, family: "calc-multi-step", stateFile: STATE, spec: MS_SPEC }],
    }),
  );
  const gate = await openBoundGate(evidence, join(out, "audit.jsonl"), { taskId: TASK, runId }, [
    "--tasks",
    tasksFile,
    "--no-builtin",
    ...(opts.corrections ? ["--corrections", "calc-multi-step"] : []),
  ]);
  const agent = misreadingAgent(guestFile, opts.mode);
  const results: GateResult[] = [];
  try {
    const record = await runMultiStepTrial(
      {
        async restore(checkpoint) {
          writeFileSync(
            guestFile,
            documentCsv(MS_SPEC.fixtureSeed, MS_SPEC.steps.slice(0, checkpoint)),
          );
        },
        runAgent: (context) => agent.run(context),
        async capture() {
          mkdirSync(dirname(captured), { recursive: true });
          copyFileSync(guestFile, captured);
        },
        async checkGate(claim) {
          const result = await gate.call({ taskId: TASK, runId, claim });
          results.push(result);
          return result;
        },
      },
      { retryBudget: opts.retryBudget },
    );
    await opts.extraCalls?.((args) => gate.call(args));
    return { trial: record, agent, results, runId };
  } finally {
    await gate.close();
  }
}

const QTY_CORRECTION: Correction = {
  kind: "target_value_mismatch",
  step: 2,
  cell: targetRef(MS_SPEC.fixtureSeed, QTY),
  record: QTY.rowKey,
  column: QTY.column,
  expected: QTY.newValue,
  observed: "4224",
};

describe("3. the loop: wrong value -> correction -> fixed in the document -> verified on the re-check", () => {
  it("corrections on, budget 1: verified on the retry, from the last verified checkpoint", {
    timeout: 60_000,
  }, async () => {
    const { trial: t, agent, results } = await trial({ corrections: true, retryBudget: 1 });
    expect(t.attempts.map((a) => a.verdict)).toEqual(["refuted", "verified"]);
    expect(t.accepted).toBe(true);
    expect(t.repaired).toBe(true);
    expect(t.attempts[1]?.fromCheckpoint).toBe(1);
    expect(t.attempts.map((a) => a.correctionKinds)).toEqual([["target_value_mismatch"], []]);
    // The agent saw the correction and only on the retry.
    expect(agent.contexts.map((c) => c.corrections)).toEqual([[], [QTY_CORRECTION]]);
    expect(results[0]?.corrections).toEqual([QTY_CORRECTION]);
    // The second capture is a different document: the fix was made in the app and saved.
    expect(t.attempts[0]?.stateSha256).not.toBe(t.attempts[1]?.stateSha256);
  });

  it("the same agent with corrections off repeats its slip: refuted after the retry", {
    timeout: 60_000,
  }, async () => {
    const { trial: t, agent } = await trial({ corrections: false, retryBudget: 1 });
    expect(t.attempts.map((a) => a.verdict)).toEqual(["refuted", "refuted"]);
    expect(t.accepted).toBe(false);
    expect(agent.contexts.map((c) => c.corrections)).toEqual([[], []]);
  });

  it("budget 0: the correction is returned but grants no attempt", {
    timeout: 60_000,
  }, async () => {
    const { trial: t, agent, results } = await trial({ corrections: true, retryBudget: 0 });
    expect(results[0]?.corrections).toEqual([QTY_CORRECTION]);
    expect(agent.contexts).toHaveLength(1);
    expect(t.attempts).toHaveLength(1);
    expect(t.accepted).toBe(false);
  });

  it("budget exhausted: no third attempt, and later gate calls cannot turn it verified", {
    timeout: 60_000,
  }, async () => {
    const later: GateResult[] = [];
    const {
      trial: t,
      agent,
      runId,
    } = await trial({
      corrections: true,
      retryBudget: 1,
      mode: { ignoreCorrections: true },
      extraCalls: async (call) => {
        later.push(await call({ taskId: TASK, runId: "loop-1", claim: "please re-check" }));
      },
    });
    expect(agent.contexts).toHaveLength(2);
    expect(t.attempts).toHaveLength(2);
    expect(t.accepted).toBe(false);
    // The harness captures no more: the gate decides from the last capture, still refuted.
    expect(later[0]?.request.runId).toBe(runId);
    expect(later[0]?.verdict).toBe("refuted");
    expect(later[0]?.accepted).toBe(false);
  });

  it("a budget other than 0 or 1 is refused before anything runs", async () => {
    let touched = false;
    const harness = {
      async restore() {
        touched = true;
      },
      async runAgent() {
        touched = true;
        return { claim: "" };
      },
      async capture() {
        touched = true;
      },
      async checkGate(): Promise<GateResult> {
        touched = true;
        throw new Error("unreachable");
      },
    };
    await expect(runMultiStepTrial(harness, { retryBudget: 2 as never })).rejects.toThrow(
      /retryBudget must be 0 or 1/,
    );
    expect(touched).toBe(false);
  });
});

describe("4. gaming through the spawned MCP gate", () => {
  it("an agent that only echoes the correction (document unchanged) stays refuted", {
    timeout: 60_000,
  }, async () => {
    const { trial: t, agent } = await trial({
      corrections: true,
      retryBudget: 1,
      mode: { echoOnly: true },
    });
    expect(agent.contexts[1]?.corrections).toEqual([QTY_CORRECTION]);
    expect(t.attempts.map((a) => a.verdict)).toEqual(["refuted", "refuted"]);
    expect(t.attempts[1]?.claim).toContain("target_value_mismatch");
    expect(t.accepted).toBe(false);
  });

  it("asking for another taskId or runId: ASSIGNMENT_MISMATCH and no correction", {
    timeout: 60_000,
  }, async () => {
    const other: GateResult[] = [];
    await trial({
      corrections: true,
      retryBudget: 0,
      extraCalls: async (call) => {
        other.push(await call({ taskId: TASK, runId: "loop-2" }));
        other.push(await call({ taskId: "calc-ms-other", runId: "loop-1" }));
        other.push(await call({ taskId: TASK, runId: "loop-1", corrections: [QTY_CORRECTION] }));
      },
    });
    expect(other.map((r) => r.reasonCodes)).toEqual([
      ["ASSIGNMENT_MISMATCH"],
      ["ASSIGNMENT_MISMATCH"],
      ["UNKNOWN_FIELD"],
    ]);
    for (const r of other) expect(r).not.toHaveProperty("corrections");
  });
});
