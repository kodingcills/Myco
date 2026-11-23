import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executeTrial } from "../../src/foundry/baseline/executor.ts";
import { fakeGuest, LAYOUT } from "../../src/foundry/baseline/guest.ts";
import type { RecordedTrialEvidence } from "../../src/foundry/baseline/recorder.ts";
import { ArmRecorder } from "../../src/foundry/baseline/recorder.ts";
import { todoTransport } from "../../src/foundry/baseline/todo-transport.ts";
import {
  type AttestInput,
  attest,
  offlineObserver,
  type SaveObservation,
} from "../../src/foundry/grader/attest.ts";
import { scoreDiscoveryTrial } from "../../src/foundry/grader/discovery.ts";
import {
  type commitment,
  fixtureHash,
  generateHiddenFixtures,
} from "../../src/foundry/hidden-split/index.ts";
import { findTask, taskFixture } from "../../src/foundry/tasks/bank.ts";
import { TODO_FIXTURE_SPECS } from "../../src/foundry/tasks/todo.ts";
import type { GuardTraceEvent, ScreenView } from "../../src/foundry/types.ts";

const TASK = findTask("ef-t01b-add-four-items-noverify")!;
const SPEC = TODO_FIXTURE_SPECS.find((s) => s.fixtureId === TASK.fixtureId)!;

/**
 * The gate reads `foundry/hidden-commitment.json` at a fixed path, so the test must use the
 * set that file commits to. That is the point: a test that could substitute its own
 * commitment would not be testing the gate.
 */
const COMMITTED = JSON.parse(readFileSync("foundry/hidden-commitment.json", "utf8")) as {
  meta: { count: number };
  commitment: ReturnType<typeof commitment>;
};
const HIDDEN = generateHiddenFixtures(new Uint8Array(32).fill(42), COMMITTED.meta.count);
const HIDDEN_FIXTURE = HIDDEN[0]!;
const PROMPT_HASH = createHash("sha256").update(TASK.prompt).digest("hex");

/** A save event carrying the bytes the observer will see, so the binding can be placed. */
function saveEvent(files: Readonly<Record<string, Uint8Array>>): GuardTraceEvent {
  return { type: "save-observed", timestamp: "2026-11-22T00:00:00.000Z", files };
}

interface FinishedRun {
  evidence: RecordedTrialEvidence;
  trace: readonly GuardTraceEvent[];
  files: Readonly<Record<string, Uint8Array>>;
  screen: ScreenView;
  selfReport: { readonly claimsSuccess: boolean; readonly text: string };
}

/** A finished, internally consistent recording, so each test can vary one thing. */
async function finishedRun(): Promise<FinishedRun> {
  const guest = fakeGuest({ spec: SPEC });
  const run = await executeTrial(
    new ArmRecorder(),
    todoTransport({ guest, channel: "pixel", argv: ["python3", "myco_todo.py"] }),
    async (surface) => {
      await surface.act({ kind: "click", target: `${LAYOUT.add.x},${LAYOUT.add.y}` });
      await surface.act({ kind: "typeText", detail: "buy milk" });
      await surface.act({ kind: "click", target: `${LAYOUT.add.x},${LAYOUT.add.y}` });
      await surface.act({ kind: "click", target: `${LAYOUT.save.x},${LAYOUT.save.y}` });
      return { claimsSuccess: true, text: "saved" };
    },
    {
      armId: "screenshot-only",
      taskId: TASK.taskId,
      promptHash: PROMPT_HASH,
      budget: 40,
      persistencePaths: ["store.json"],
    },
  );
  return run;
}

function baseInput(run: FinishedRun) {
  const observer = offlineObserver();
  return {
    evidence: run.evidence,
    trace: [...run.trace, saveEvent(run.files)],
    finalFiles: run.files,
    observations: observer.observe(["store.json"], run.files),
    screen: run.screen,
    observerId: observer.id,
    // Contract test: opt in explicitly, because the gate refuses an offline observer in
    // production. That refusal is asserted separately.
    allowOfflineObserver: true as const,
    hiddenFixtures: HIDDEN,
    claimedFixtureHash: fixtureHash(HIDDEN_FIXTURE),
    screenObserved: true,
  };
}

describe("TIF-95: mutation check — each gate check is load-bearing", () => {
  /**
   * A gate whose checks are not individually necessary is a gate that would still pass if
   * one were deleted. Each case below removes exactly one check from the input side and
   * asserts the gate refuses, so a future edit that drops a check fails here.
   */
  const mutations: readonly { name: string; apply: (i: AttestInput) => AttestInput }[] = [
    {
      name: "no commitment match",
      apply: (i) => ({ ...i, hiddenFixtures: i.hiddenFixtures.slice(1) }),
    },
    {
      name: "claimed hash names no fixture",
      apply: (i) => ({ ...i, claimedFixtureHash: "0".repeat(64) }),
    },
    { name: "no observation", apply: (i) => ({ ...i, observations: [] }) },
    {
      name: "observation predates the save",
      apply: (i) => ({
        ...i,
        observations: i.observations.map((o) => ({ ...o, afterLastSave: false })),
      }),
    },
    { name: "screen supplied by the arm", apply: (i) => ({ ...i, screenObserved: false }) },
    {
      name: "no save in the trace",
      apply: (i) => ({ ...i, trace: i.trace.filter((e) => e.type !== "save-observed") }),
    },
    {
      name: "no recorder calls",
      apply: (i) => ({
        ...i,
        evidence: { ...i.evidence, recordedCalls: [], recordedCallCount: 0, toolCallAudits: [] },
      }),
    },
  ];

  it("the unmutated run is eligible, and every single-check removal is refused", async () => {
    const run = await finishedRun();
    const base = baseInput(run);
    expect(attest(base).eligible, "baseline must be eligible or the mutations prove nothing").toBe(
      true,
    );
    for (const mutation of mutations) {
      const result = attest(mutation.apply(base));
      expect(result.eligible, `${mutation.name} was not refused`).toBe(false);
      expect(result.blockers.length, `${mutation.name} gave no reason`).toBeGreaterThan(0);
    }
  });
});

describe("TIF-95: an offline observer cannot vouch for a live run", () => {
  it("refuses offlineObserver unless the caller declares a contract test", async () => {
    // The finding that made this the most important round: a caller can supply the bytes AND
    // a matching observation, and a match between two things one caller controls proves
    // nothing. The offline observer hashes whatever it is handed, so it cannot vouch for a
    // live run.
    const run = await finishedRun();
    const input = baseInput(run);
    const production = { ...input, allowOfflineObserver: undefined };
    const result = attest(production);
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("an offline observer cannot vouch for a live run");

    // The same input with the explicit test opt-in is admitted, so the refusal above is a
    // decision about provenance and not a blanket rejection of the offline observer.
    expect(attest(input).eligible).toBe(true);
  });

  it("refuses an unnamed observer", async () => {
    const input = baseInput(await finishedRun());
    const result = attest({ ...input, observerId: "  " });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("no observer was named");
  });
});

describe("TIF-95: the gate decides eligibility, never the verdict", () => {
  it("an eligible run is not thereby verified, and a refuted run stays refuted", async () => {
    const run = await finishedRun();
    const input = baseInput(run);
    const attestation = attest(input);
    expect(attestation.eligible).toBe(true);

    const scored = scoreDiscoveryTrial(
      { ...run.evidence, planner: { model: "claude-sonnet-5-5", settings: { t: 0 } } } as never,
      {
        fixture: taskFixture(TASK),
        actual: { kind: "myco-todo", files: run.files },
        screen: run.screen,
        trace: run.trace,
        selfReport: run.selfReport,
        faultVersion: 0,
      } as never,
      { t: 0 },
      attestation,
    );
    expect(scored.status).toBe("scored");
    if (scored.status !== "scored") throw new Error("unreachable");
    // Eligibility is about admissibility, not correctness: the verdict is whatever the
    // state oracle said, and the gate must not have touched it.
    expect(scored.decisionEligible).toBe(true);
    expect(scored.result.verdict).toBe("refuted");
  });

  it("a runtime literal is refused even though the type system was bypassed", async () => {
    // The round-2 finding: passing an unbranded object as `never` satisfied the scorer,
    // because the brand was compile-time only. The runtime check is what the scorer owns.
    const run = await finishedRun();
    const forged = { eligible: true, blockers: [], observerId: "forged" };
    const scored = scoreDiscoveryTrial(
      { ...run.evidence, planner: { model: "claude-sonnet-5-5", settings: { t: 0 } } } as never,
      {
        fixture: taskFixture(TASK),
        actual: { kind: "myco-todo", files: run.files },
        screen: run.screen,
        trace: run.trace,
        selfReport: run.selfReport,
        faultVersion: 0,
      } as never,
      { t: 0 },
      forged as never,
    );
    if (scored.status !== "scored") throw new Error("unreachable");
    expect(scored.decisionEligible).toBe(false);
    expect(scored.attestationBlockers).toEqual(["no attestation supplied"]);
  });

  it("without an attestation the row stays descriptive", async () => {
    const run = await finishedRun();
    const scored = scoreDiscoveryTrial(
      { ...run.evidence, planner: { model: "claude-sonnet-5-5", settings: { t: 0 } } } as never,
      {
        fixture: taskFixture(TASK),
        actual: { kind: "myco-todo", files: run.files },
        screen: run.screen,
        trace: run.trace,
        selfReport: run.selfReport,
        faultVersion: 0,
      } as never,
      { t: 0 },
    );
    if (scored.status !== "scored") throw new Error("unreachable");
    expect(scored.decisionEligible).toBe(false);
    expect(scored.attestationBlockers).toEqual(["no attestation supplied"]);
  });

  it("a refused attestation keeps the row descriptive and names why", async () => {
    const run = await finishedRun();
    const refused = attest({ ...baseInput(run), observations: [] });
    const scored = scoreDiscoveryTrial(
      { ...run.evidence, planner: { model: "claude-sonnet-5-5", settings: { t: 0 } } } as never,
      {
        fixture: taskFixture(TASK),
        actual: { kind: "myco-todo", files: run.files },
        screen: run.screen,
        trace: run.trace,
        selfReport: run.selfReport,
        faultVersion: 0,
      } as never,
      { t: 0 },
      refused,
    );
    if (scored.status !== "scored") throw new Error("unreachable");
    expect(scored.decisionEligible).toBe(false);
    expect(scored.attestationBlockers?.join(" ")).toContain("no observation");
  });
});

describe("EF-005 attestation gate", () => {
  it("admits a run whose observation matches the final bytes", async () => {
    const result = attest(baseInput(await finishedRun()));
    expect(result.blockers).toEqual([]);
    expect(result.eligible).toBe(true);
    expect(result.accepted).toHaveLength(1);
  });

  it("refuses a run with no observation at all", async () => {
    const input = baseInput(await finishedRun());
    const result = attest({ ...input, observations: [] });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("no observation of store.json");
  });

  it("refuses an observation taken before the last save", async () => {
    const input = baseInput(await finishedRun());
    const stale: SaveObservation[] = input.observations.map((o) => ({
      ...o,
      afterLastSave: false,
    }));
    const result = attest({ ...input, observations: stale });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("read before the last save");
  });

  it("refuses bytes that changed after they were observed", async () => {
    const input = baseInput(await finishedRun());
    const tampered = {
      ...input.finalFiles,
      "store.json": new TextEncoder().encode('{"items":[]}'),
    };
    const result = attest({ ...input, finalFiles: tampered });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("changed after it was observed");
  });

  it("refuses a screen reading the arm supplied rather than the observer", async () => {
    const input = baseInput(await finishedRun());
    const result = attest({ ...input, screenObserved: false });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("supplied by the arm");
  });

  it("refuses a trace with no save to place the observation against", async () => {
    const input = baseInput(await finishedRun());
    const result = attest({
      ...input,
      trace: input.trace.filter((e) => e.type !== "save-observed"),
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("no save was observed");
  });

  it("refuses an incomplete audit, because the arm's account of itself is partial", async () => {
    const input = baseInput(await finishedRun());
    const evidence = {
      ...input.evidence,
      toolCallAudits: input.evidence.toolCallAudits.map((a, i) =>
        i === 0 ? { ...a, status: "incomplete" as const } : a,
      ),
    };
    const result = attest({ ...input, evidence });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("an audit is incomplete");
  });

  it("refuses a call count that disagrees with the recorded calls", async () => {
    const input = baseInput(await finishedRun());
    const result = attest({
      ...input,
      evidence: { ...input.evidence, recordedCallCount: input.evidence.recordedCalls.length + 1 },
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("call count does not match");
  });

  it("refuses a trial that did not finish", async () => {
    const input = baseInput(await finishedRun());
    const result = attest({
      ...input,
      evidence: { ...input.evidence, status: "quota-exhausted" as const },
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("not finished");
  });

  it("reports an empty screen as unconstrained, not as agreement", async () => {
    // A pixel arm reads no text. That is not a blocker, but a report must not read it as
    // "the screen oracle agreed".
    const input = baseInput(await finishedRun());
    const result = attest(input);
    expect(result.eligible).toBe(true);
    expect(result.screenConstrained).toBe(false);
  });

  it("reports a screen with text as constrained", async () => {
    const input = baseInput(await finishedRun());
    const result = attest({
      ...input,
      screen: { visibleText: ["saved 1 item(s)"], reachable: true },
    });
    expect(result.screenConstrained).toBe(true);
  });

  it("names the observer, so a report can say which channel produced the evidence", async () => {
    const input = baseInput(await finishedRun());
    expect(attest(input).observerId).toBe("offline");
  });

  it("refuses an empty required set instead of admitting a run that observed nothing", async () => {
    // The P1 the verifier found: a caller-supplied list with no lower bound let
    // `requiredPaths: []` pass with zero observations.
    const input = baseInput(await finishedRun());
    const result = attest({
      ...input,
      hiddenFixtures: [],
      claimedFixtureHash: "0".repeat(64),
      finalFiles: {},
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("does not match the committed commitment");
  });

  it("reports an app-written file the fixture does not designate, without refusing the run", async () => {
    // Demanding an observation for every file in the final state refuses honest runs that
    // wrote a log. The fixture says what matters; anything else is reported.
    const input = baseInput(await finishedRun());
    const withExtra = { ...input.finalFiles, "app.log": new TextEncoder().encode("started\n") };
    const result = attest({ ...input, finalFiles: withExtra });
    expect(result.eligible).toBe(true);
    expect(result.unexpectedFiles).toEqual(["app.log"]);
  });

  it("refuses an audit that names no recorded call", async () => {
    // Cardinality is not identity: a ghost audit used to satisfy the count.
    const input = baseInput(await finishedRun());
    const evidence = {
      ...input.evidence,
      toolCallAudits: input.evidence.toolCallAudits.map((a, i) =>
        i === 0 ? { ...a, callId: "ghost" } : a,
      ),
    };
    const result = attest({ ...input, evidence });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("names no recorded call");
  });

  it("refuses an audit whose channel disagrees with the recorded call", async () => {
    const input = baseInput(await finishedRun());
    const evidence = {
      ...input.evidence,
      toolCallAudits: input.evidence.toolCallAudits.map((a, i) =>
        i === 0 ? { ...a, via: a.via === "gui" ? ("shell-exec" as const) : ("gui" as const) } : a,
      ),
    };
    const result = attest({ ...input, evidence });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("recorded as");
  });

  it("refuses a save no GUI act can explain", async () => {
    // The round-3 P1: an arm that did nothing could append a fabricated save-observed event
    // and be admitted, because checkTrace is clean when nothing changed and reconcileAudit
    // accepts an empty call set. Bytes conjured out of band are the false success itself.
    const input = baseInput(await finishedRun());
    const result = attest({
      ...input,
      evidence: {
        ...input.evidence,
        recordedCalls: [],
        recordedCallCount: 0,
        toolCallAudits: [],
      },
      trace: [saveEvent(input.finalFiles)],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("no GUI call was recorded");
    expect(result.blockers.join(" ")).toContain("follows no GUI action");
  });

  it("refuses a save that precedes every GUI action", async () => {
    const input = baseInput(await finishedRun());
    const save = saveEvent(input.finalFiles);
    const actions = input.trace.filter((e) => e.type === "action");
    const result = attest({ ...input, trace: [save, ...actions] });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("follows no GUI action");
  });

  it("returns a blocker rather than throwing on malformed evidence", async () => {
    // A gate that crashes on bad input is a gate an arm can disable by sending bad input.
    const input = baseInput(await finishedRun());
    const result = attest({
      ...input,
      evidence: {
        ...input.evidence,
        recordedCalls: undefined,
        toolCallAudits: undefined,
      } as never,
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("refuses a duplicate call id instead of letting the map hide it", async () => {
    const input = baseInput(await finishedRun());
    const first = input.evidence.recordedCalls[0]!;
    const evidence = {
      ...input.evidence,
      recordedCalls: [...input.evidence.recordedCalls, first],
      recordedCallCount: input.evidence.recordedCalls.length + 1,
      toolCallAudits: [...input.evidence.toolCallAudits, input.evidence.toolCallAudits[0]!],
    };
    const result = attest({ ...input, evidence });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("recorded more than once");
  });

  it("refuses a non-GUI audit that reports no accesses", async () => {
    // Empty accesses erase the only signal that identifies a direct write to a persistence
    // path, which is exactly what a file-io audit exists to expose.
    const input = baseInput(await finishedRun());
    const evidence = {
      ...input.evidence,
      recordedCalls: [...input.evidence.recordedCalls, { callId: "io-1", via: "file-io" as const }],
      recordedCallCount: input.evidence.recordedCalls.length + 1,
      toolCallAudits: [
        ...input.evidence.toolCallAudits,
        { callId: "io-1", via: "file-io" as const, status: "complete" as const, accesses: [] },
      ],
    };
    const result = attest({ ...input, evidence });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("reports no accesses");
  });

  it("refuses a save event whose bytes disagree with the observation", async () => {
    // Checking only the event's type let any fabricated event satisfy the binding.
    const input = baseInput(await finishedRun());
    const wrongSave = saveEvent({ "store.json": new TextEncoder().encode('{"items":[]}') });
    const result = attest({
      ...input,
      trace: [...input.trace.filter((e) => e.type !== "save-observed"), wrongSave],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("differs from the observation");
  });

  it("refuses a save event that omits a file the observation covers", async () => {
    const input = baseInput(await finishedRun());
    const result = attest({
      ...input,
      trace: [...input.trace.filter((e) => e.type !== "save-observed"), saveEvent({})],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("does not include store.json");
  });

  it("collects every blocker rather than stopping at the first", async () => {
    const input = baseInput(await finishedRun());
    const result = attest({
      ...input,
      observations: [],
      screenObserved: false,
      trace: [],
    });
    expect(result.blockers.length).toBeGreaterThanOrEqual(3);
  });
});
