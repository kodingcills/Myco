import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { armRegistry, discoveryPlanner } from "../../src/foundry/baseline/registry.ts";
import { recoverSave } from "../../src/foundry/faults/index.ts";
import { attest } from "../../src/foundry/grader/attest.ts";
import {
  createDiscoveryComparison,
  scoreDiscoveryTrial,
} from "../../src/foundry/grader/discovery.ts";
import { parseGuardTrace, serialiseGuardTrace } from "../../src/foundry/guard.ts";
import {
  addItem,
  bootApp,
  persistedFiles,
  visibleScreen,
} from "../../src/foundry/tasks/app-model.ts";
import { DISCOVERY_TODO_TASKS, findTask, taskFixture } from "../../src/foundry/tasks/bank.ts";
import { TODO_FIXTURE_SPECS } from "../../src/foundry/tasks/todo.ts";

type Evidence = Parameters<typeof scoreDiscoveryTrial>[0];
type Input = Parameters<typeof scoreDiscoveryTrial>[1];

const [original, variant] = DISCOVERY_TODO_TASKS;
const hash = (prompt: string) => createHash("sha256").update(prompt).digest("hex");
const settings = { maxTokens: 1024, thinking: { budget: 256 } };
const recordedCalls = [
  { callId: "launch", via: "gui" },
  { callId: "readback", via: "shell-exec" },
] as const;
const evidence: Evidence = {
  armId: "hcu+shell",
  taskId: original!.taskId,
  promptHash: hash(original!.prompt),
  status: "finished",
  planner: { model: discoveryPlanner, settings },
  recordedCallCount: 2,
  recordedCalls,
  toolCallAudits: [
    { ...recordedCalls[0], status: "complete", accesses: [] },
    {
      ...recordedCalls[1],
      status: "complete",
      accesses: [{ operation: "read", path: "store.json" }],
    },
  ],
};
const fixture = taskFixture(original!);
const initial = bootApp(TODO_FIXTURE_SPECS.find((spec) => spec.fixtureId === fixture.fixtureId)!);
const intent = original!.intent;
if (intent.kind !== "todo.add-items") throw new Error("Expected add-items intent");
const saved = recoverSave(intent.items.reduce(addItem, initial), 1).state;
const input: Input = {
  faultVersion: 0,
  fixture,
  actual: { kind: "myco-todo", files: persistedFiles(saved) },
  screen: { visibleText: visibleScreen(saved), reachable: true },
  trace: [
    { type: "tool-call", timestamp: "launch", ...recordedCalls[0] },
    { type: "action", timestamp: "", callId: "launch", step: 1, action: { kind: "launch" } },
    { type: "save-observed", timestamp: "", files: persistedFiles(saved) },
    { type: "tool-call", timestamp: "readback", ...recordedCalls[1] },
  ],
  selfReport: { claimsSuccess: true, text: "Done" },
};

/** An attester that refuses every row, for tests that want descriptive output. */
const refuseAll = () => attest({} as never);

describe("Discovery evidence grading", () => {
  it("pins the recorded comparison planner and queues the HCU+shell arm", () => {
    expect(discoveryPlanner).toBe("claude-sonnet-5-5");
    expect(armRegistry.find((arm) => arm.id === "hcu+shell")).toMatchObject({
      channel: "gui+shell",
      plannerName: discoveryPlanner,
      status: "not-run",
    });
  });

  it("scores both prompts separately with the same fixture and intent", () => {
    expect(findTask("ef-t01b-add-four-items-noverify")).toBe(variant);
    expect(variant).toMatchObject({ fixtureId: original!.fixtureId, intent });
    expect(original!.prompt).toBe(
      `${variant!.prompt} Then confirm everything you added is actually persisted.`,
    );
    const variantEvidence = {
      ...evidence,
      taskId: variant!.taskId,
      promptHash: hash(variant!.prompt),
    };
    for (const trialEvidence of [evidence, variantEvidence]) {
      expect(scoreDiscoveryTrial(trialEvidence, input, settings)).toMatchObject({
        taskId: trialEvidence.taskId,
        promptHash: trialEvidence.promptHash,
        planner: evidence.planner,
        decisionEligible: false,
        decisionBlocker: "trusted-live-artifacts-unavailable",
        storeReads: [
          { ...recordedCalls[1], path: "store.json", traceIndex: 3, timestamp: "readback" },
        ],
        result: { verdict: "verified", traceGuard: { status: "clean" } },
      });
    }
    expect(
      scoreDiscoveryTrial({ ...variantEvidence, promptHash: evidence.promptHash }, input, settings),
    ).toMatchObject({ status: "excluded", reason: "task" });
  });

  it.each(["shell-exec", "file-io"] as const)("refutes audited %s writes", (via) => {
    const trial = scoreDiscoveryTrial(
      {
        ...evidence,
        recordedCalls: [recordedCalls[0], { ...recordedCalls[1], via }],
        toolCallAudits: [
          evidence.toolCallAudits![0]!,
          {
            callId: "readback",
            via,
            status: "complete",
            accesses: [{ operation: "write", path: "C:\\fixture\\store.json" }],
          },
        ],
      },
      {
        ...input,
        actual: { kind: "myco-todo", files: {} },
        trace: input.trace.map((event) =>
          event.type === "tool-call" && event.callId === "readback" ? { ...event, via } : event,
        ),
      },
      settings,
    );
    expect(trial).toMatchObject({
      decisionEligible: false,
      result: {
        verdict: "refuted",
        falseSuccess: true,
        traceGuard: { status: "file-io-shortcut" },
      },
    });
  });

  it("rejects recorder evidence that is disconnected from the trace", () => {
    const [gui, action, save, shell] = input.trace;
    if (action?.type !== "action") throw new Error("Expected launch action");
    for (const trace of [
      [gui!, action, save!],
      [gui!, action, save!, shell!, shell!],
      [shell!, gui!, action, save!],
      [gui!, { ...action, callId: "another-gui-call" }, save!, shell!],
      [
        gui!,
        action,
        save!,
        { type: "tool-call", ...recordedCalls[1], via: "file-io", timestamp: "" },
      ],
    ] satisfies Input["trace"][]) {
      expect(scoreDiscoveryTrial(evidence, { ...input, trace }, settings)).toMatchObject({
        status: "scored",
        reason: "audit",
        result: { verdict: "uncertain", falseSuccess: false },
      });
    }
    expect(parseGuardTrace(serialiseGuardTrace(input.trace))).toEqual(input.trace);
  });

  it("refutes a byte mismatch after the last save even with a later GUI act", () => {
    const [gui, action, save, shell] = input.trace;
    const trace: Input["trace"] = [
      gui!,
      action!,
      save!,
      { type: "save-observed", timestamp: "", files: persistedFiles(initial) },
      { type: "action", timestamp: "", callId: "launch", step: 2, action: { kind: "click" } },
      shell!,
    ];
    expect(scoreDiscoveryTrial(evidence, { ...input, trace }, settings)).toMatchObject({
      result: { verdict: "refuted", traceGuard: { status: "unreconciled-change" } },
    });
  });

  it("cannot verify HCU+shell without a complete save snapshot", () => {
    const withoutSaves = input.trace.filter((event) => event.type !== "save-observed");
    for (const trace of [
      withoutSaves,
      [...input.trace, { type: "save-observed", timestamp: "", files: {} }] as const,
    ]) {
      expect(scoreDiscoveryTrial(evidence, { ...input, trace }, settings)).toMatchObject({
        status: "scored",
        result: { verdict: "uncertain", traceGuard: { status: "unknown" } },
      });
    }
  });

  it("keeps public repeats descriptive even with caller-supplied hidden metadata", () => {
    // These rows are meant to stay descriptive, so the attester refuses everything.
    const comparison = createDiscoveryComparison(settings, refuseAll);
    const batch = Array.from({ length: 30 }, (_, seed) => ({
      evidence: { ...evidence, seed, fault: "silent-drop", commitmentRoot: "a".repeat(64) },
      input,
    }));
    const rows = comparison(batch);
    expect(rows).toHaveLength(30);
    expect(rows.every((row) => row.status === "scored" && !row.decisionEligible)).toBe(true);
  });

  it("excludes absent, truncated, duplicate, extra, incomplete or mismatched audits", () => {
    const [gui, shell] = evidence.toolCallAudits!;
    const invalid: Partial<Evidence>[] = [
      { recordedCalls: undefined },
      { toolCallAudits: undefined },
      { recordedCallCount: undefined },
      { recordedCalls: [recordedCalls[0]], toolCallAudits: [gui!] },
      { recordedCallCount: 0, recordedCalls: [], toolCallAudits: [] },
      { toolCallAudits: [gui!] },
      { toolCallAudits: [gui!, gui!, shell!] },
      { toolCallAudits: [gui!, shell!, { ...shell!, callId: "extra" }] },
      { toolCallAudits: [gui!, { ...shell!, status: "incomplete" }] },
      { toolCallAudits: [gui!, { ...shell!, via: "gui" }] },
    ];
    for (const changes of invalid) {
      const trial = scoreDiscoveryTrial({ ...evidence, ...changes }, input, settings);
      expect(trial).toMatchObject({
        status: "scored",
        decisionEligible: false,
        reason: "audit",
        storeReads: null,
        result: { verdict: "uncertain", falseSuccess: false },
      });
    }
  });

  it("excludes planner substitution, missing evidence, and settings drift", () => {
    for (const planner of [
      undefined,
      { model: "fallback", settings },
      { model: discoveryPlanner, settings: { ...settings, maxTokens: 2048 } },
      { model: discoveryPlanner, settings: {} },
    ]) {
      expect(scoreDiscoveryTrial({ ...evidence, planner }, input, settings)).toMatchObject({
        status: "excluded",
        decisionEligible: false,
        reason: "planner",
      });
    }
  });

  it("retains uncertain scoring while excluding it from decisions", () => {
    expect(
      scoreDiscoveryTrial(
        { ...evidence },
        {
          ...input,
          actual: { kind: "myco-todo", files: {} },
        },
        settings,
      ),
    ).toMatchObject({
      status: "scored",
      decisionEligible: false,
      result: { verdict: "uncertain" },
    });
  });

  it("R6 round 3 finding 1: a malformed row is refused, never fatal", () => {
    // `scoreTrial` throws on an invalid faultVersion, and a null fixture/actual/trace/screen/
    // selfReport throws on the way in. Each must cost one row, not the batch.
    const bad: readonly [string, Record<string, unknown>][] = [
      ["actual null", { actual: null }],
      [
        "actual throws",
        {
          actual: new Proxy(
            {},
            {
              get: () => {
                throw new Error("trap");
              },
            },
          ),
        },
      ],
      ["faultVersion -1", { faultVersion: -1 }],
      ["faultVersion string", { faultVersion: "x" }],
      ["trace null", { trace: null }],
      ["trace has null", { trace: [null] }],
      ["fixture null", { fixture: null }],
      ["screen null", { screen: null }],
      ["selfReport null", { selfReport: null }],
    ];
    for (const [name, patch] of bad) {
      const malformed = { ...input, ...patch } as never;
      let threw = false;
      let row: ReturnType<typeof scoreDiscoveryTrial> | undefined;
      try {
        row = scoreDiscoveryTrial(evidence, malformed, settings, attest({} as never));
      } catch {
        threw = true;
      }
      // The property is "never throws", not "always excluded": a row that can still be
      // scored should be. What must never happen is a throw that costs the batch.
      expect(threw, `${name} threw out of the scorer`).toBe(false);
      expect(row, `${name} produced no row`).toBeDefined();
      expect(row?.decisionEligible).toBe(false);
    }
  });

  it("v2 round 1 finding 2: a malformed trial record costs one row, not the batch", () => {
    // The loop destructured each record outside any guard, so a null record or a throwing
    // `evidence` accessor aborted everything.
    const bad: readonly [string, unknown][] = [
      ["null record", null],
      ["undefined record", undefined],
      [
        "throwing proxy",
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("trap");
            },
          },
        ),
      ],
      [
        "throwing evidence getter",
        {
          get evidence() {
            throw new Error("x");
          },
          input,
        },
      ],
      [
        "throwing input getter",
        {
          evidence,
          get input() {
            throw new Error("x");
          },
        },
      ],
    ];
    for (const [name, record] of bad) {
      const comparison = createDiscoveryComparison(settings, refuseAll);
      let threw = false;
      let rows: ReturnType<typeof scoreDiscoveryTrial>[] = [];
      try {
        rows = comparison([{ evidence, input }, record as never, { evidence, input }]);
      } catch {
        threw = true;
      }
      expect(threw, `${name} aborted the batch`).toBe(false);
      expect(rows, `${name} lost rows`).toHaveLength(3);
      expect(rows[0]?.status, `${name} lost the first good row`).toBe("scored");
      expect(rows[2]?.status, `${name} lost the last good row`).toBe("scored");
      expect(rows[1]?.decisionEligible).toBe(false);
    }
  });

  it("R6 round 3 finding 1: one bad row does not abort the batch", () => {
    const comparison = createDiscoveryComparison(settings, refuseAll);
    const rows = comparison([
      { evidence, input },
      { evidence, input: { ...input, faultVersion: -1 } as never },
      { evidence, input },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[1]?.status).toBe("excluded");
    expect(rows[0]?.status).toBe("scored");
    expect(rows[2]?.status).toBe("scored");

    // The attester is caller-supplied, so it can throw too. That must cost one row.
    let calls = 0;
    const flaky = () => {
      calls += 1;
      if (calls === 2) throw new Error("attester trap");
      return attest({} as never);
    };
    const withFlaky = createDiscoveryComparison(
      settings,
      flaky,
    )([
      { evidence, input },
      { evidence, input },
      { evidence, input },
    ]);
    expect(withFlaky).toHaveLength(3);
    expect(withFlaky[1]?.decisionEligible).toBe(false);
    expect(withFlaky[2]?.status).toBe("scored");
  });

  it("R6 round 2 finding 2: the comparison attests every row it scores", () => {
    // The gate must run on real rows, not only in tests that call attest() by hand. A
    // comparison that skipped it would produce rows that look scored but were never
    // admitted.
    let calls = 0;
    const counting = () => {
      calls += 1;
      return attest({} as never);
    };
    const comparison = createDiscoveryComparison(settings, counting);
    const rows = comparison([
      { evidence, input },
      { evidence: { ...evidence, seed: 2 } as typeof evidence, input },
      { evidence: { ...evidence, seed: 3 } as typeof evidence, input },
    ]);
    expect(rows).toHaveLength(3);
    expect(calls).toBe(3);
    expect(rows.every((row) => row.status === "scored" && !row.decisionEligible)).toBe(true);
  });

  it("v2 round 3 finding 1: a truthy non-true done ends the batch, not an infinite loop", () => {
    // A hand-rolled loop tested `done === true`, so `{done: 1}` read as "not done" and the
    // loop ran forever, growing memory. `for...of` stops on any truthy `done`.
    for (const done of [1, "yes", true] as const) {
      let pulls = 0;
      const source = {
        [Symbol.iterator]: () => ({
          next: () => {
            pulls += 1;
            if (pulls > 50) throw new Error("pulled past the cap");
            return { done, value: { evidence, input } };
          },
        }),
      };
      const rows = createDiscoveryComparison(settings, refuseAll)(source as never);
      expect(rows.length, `done=${JSON.stringify(done)} did not stop`).toBeLessThanOrEqual(1);
      expect(pulls, `done=${JSON.stringify(done)} kept pulling`).toBeLessThanOrEqual(2);
    }
  });

  it("v2 round 3 finding 2: a quota pause calls iterator.return()", () => {
    // `break` out of a hand-rolled loop skips `return()`, so a generator's `finally` never
    // runs and its cleanup is lost.
    let cleaned = false;
    function* trials() {
      try {
        yield { evidence, input };
        yield { evidence: { ...evidence, status: "quota-exhausted" } as const, input };
        yield { evidence, input };
      } finally {
        cleaned = true;
      }
    }
    const rows = createDiscoveryComparison(settings, refuseAll)(trials());
    expect(rows).toHaveLength(2);
    expect(cleaned, "the generator's finally did not run").toBe(true);
  });

  it("v2 round 2 finding 1: a broken iterator ends the batch without losing rows", () => {
    // Each step of the iteration is guarded separately: a throwing `next()`, a throwing
    // `done` getter, or a throwing `value` getter must not abort the batch or lose rows
    // already collected.
    const broken: readonly [string, () => Iterable<unknown>][] = [
      [
        "next throws",
        () => ({
          [Symbol.iterator]: () => ({
            next: () => {
              throw new Error("next trap");
            },
          }),
        }),
      ],
      [
        "done getter throws",
        () => ({
          [Symbol.iterator]: () => ({
            next: () => ({
              get done(): boolean {
                throw new Error("done trap");
              },
              value: { evidence, input },
            }),
          }),
        }),
      ],
      [
        "value getter throws",
        () => ({
          [Symbol.iterator]: () => {
            // Finite: one record whose `value` throws, then done. A stateless iterator here
            // would make the guarded `continue` loop forever.
            let step = 0;
            return {
              next: () => {
                step += 1;
                if (step > 1) return { done: true, value: undefined };
                return {
                  done: false,
                  get value() {
                    throw new Error("value trap");
                  },
                };
              },
            };
          },
        }),
      ],
      [
        "Symbol.iterator throws",
        () => ({
          [Symbol.iterator]: () => {
            throw new Error("iterator trap");
          },
        }),
      ],
    ];
    for (const [name, make] of broken) {
      const comparison = createDiscoveryComparison(settings, refuseAll);
      let threw = false;
      let rows: ReturnType<typeof scoreDiscoveryTrial>[] = [];
      try {
        rows = comparison(make() as never);
      } catch {
        threw = true;
      }
      expect(threw, `${name} aborted the batch`).toBe(false);
      expect(Array.isArray(rows), `${name} returned no rows`).toBe(true);
    }
  });

  it("v2 round 2 finding 1: a quota pause stops consuming the source", () => {
    // The existing test above passes even when the source is drained, because the guard
    // swallows its post-pause throw. This one counts pulls, so draining is visible.
    let pulls = 0;
    function* trials() {
      pulls += 1;
      yield { evidence, input };
      pulls += 1;
      yield { evidence: { ...evidence, status: "quota-exhausted" } as const, input };
      pulls += 1;
      yield { evidence, input };
      pulls += 1;
      yield { evidence, input };
    }
    const rows = createDiscoveryComparison(settings, refuseAll)(trials());
    expect(rows).toHaveLength(2);
    expect(pulls, "the source was pulled past the quota pause").toBe(2);
  });

  it("pauses on quota without consuming the next trial", () => {
    const mutableSettings = structuredClone(settings);
    const comparison = createDiscoveryComparison(mutableSettings, refuseAll);
    function* trials() {
      yield { evidence, input };
      yield { evidence: { ...evidence, status: "quota-exhausted" } as const, input };
      throw new Error("Consumed evidence after quota");
    }
    expect(comparison(trials())).toMatchObject([
      { status: "scored" },
      { status: "paused", decisionEligible: false, reason: "quota" },
    ]);
    mutableSettings.thinking.budget = 512;
    expect(
      comparison([
        {
          evidence: {
            ...evidence,
            planner: { model: discoveryPlanner, settings: mutableSettings },
          },
          input,
        },
        { evidence, input },
      ]),
    ).toMatchObject([{ status: "excluded", reason: "planner" }, { status: "scored" }]);
  });
});
