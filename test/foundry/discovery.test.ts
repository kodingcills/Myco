import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { armRegistry, discoveryPlanner } from "../../src/foundry/baseline/registry.ts";
import { recoverSave } from "../../src/foundry/faults/index.ts";
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
    const comparison = createDiscoveryComparison(settings);
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

  it("pauses on quota without consuming the next trial", () => {
    const mutableSettings = structuredClone(settings);
    const comparison = createDiscoveryComparison(mutableSettings);
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
