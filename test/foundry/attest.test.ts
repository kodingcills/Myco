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
  bundleDigest,
  offlineObserverForContractTest,
  registerLiveObserver,
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
/** The contract-test symbol, from the door itself, so a test can strip it to model production. */
const MARKER_KEY = offlineObserverForContractTest().marker;
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
      fixtureId: TASK.fixtureId,
      fixtureHash: fixtureHash(HIDDEN_FIXTURE),
      budget: 40,
      persistencePaths: ["store.json"],
    },
  );
  return run;
}

function baseInput(run: FinishedRun) {
  const { observer, marker } = offlineObserverForContractTest();
  const bound = run.evidence as { armId: string; taskId: string; promptHash: string };
  return {
    [marker]: marker,
    // TIF-125 R6 1d: the row must name the fixture it ran against. The honest value is the
    // TASK fixture's id — the same id the hidden fixture carries — and the hidden fixture's
    // own hash. Omitting these used to skip the binding entirely.
    evidence: {
      ...run.evidence,
      fixtureId: TASK.fixtureId,
      fixtureHash: fixtureHash(HIDDEN_FIXTURE),
    },
    trace: [...run.trace, saveEvent(run.files)],
    finalFiles: run.files,
    observations: observer.observe(["store.json"], run.files),
    screen: run.screen,
    observerId: observer.id,
    // Contract test: the marker is a symbol the caller cannot guess, so production code
    // cannot reach this door by naming a string.
    // The symbol IS the marker; spreading it in is what the gate checks.
    ...{ [marker]: marker },
    hiddenFixtures: HIDDEN,
    claimedFixtureHash: fixtureHash(HIDDEN_FIXTURE),
    // TIF-125: the attestation names the row it is for, bound to the scored bytes.
    bundle: {
      armId: bound.armId,
      taskId: bound.taskId,
      promptHash: bound.promptHash,
      bundleDigest: bundleDigest(run.files),
    },
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
    // Round 5 named these as surviving every test. Each removes one clause's input.
    {
      name: "duplicate call id",
      apply: (i) => ({
        ...i,
        evidence: {
          ...i.evidence,
          recordedCalls: [...i.evidence.recordedCalls, i.evidence.recordedCalls[0]!],
          recordedCallCount: i.evidence.recordedCallCount + 1,
          toolCallAudits: [...i.evidence.toolCallAudits, i.evidence.toolCallAudits[0]!],
        },
      }),
    },
    {
      name: "audit channel disagrees",
      apply: (i) => ({
        ...i,
        evidence: {
          ...i.evidence,
          toolCallAudits: i.evidence.toolCallAudits.map((a, n) =>
            n === 0
              ? { ...a, via: a.via === "gui" ? ("shell-exec" as const) : ("gui" as const) }
              : a,
          ),
        },
      }),
    },
    {
      name: "trial did not finish",
      apply: (i) => ({ ...i, evidence: { ...i.evidence, status: "quota-exhausted" as const } }),
    },
    {
      name: "observation length disagrees",
      apply: (i) => ({
        ...i,
        observations: i.observations.map((o: SaveObservation) => ({ ...o, bytes: o.bytes + 1 })),
      }),
    },
    {
      name: "saved bytes differ from the observation",
      apply: (i) => ({
        ...i,
        trace: [
          ...i.trace.filter((e) => e.type !== "save-observed"),
          saveEvent({ "store.json": new TextEncoder().encode('{"items":[]}') }),
        ],
      }),
    },
    {
      name: "last save includes no observed file",
      apply: (i) => ({
        ...i,
        trace: [...i.trace.filter((e) => e.type !== "save-observed"), saveEvent({})],
      }),
    },
    {
      name: "unregistered observer named",
      apply: (i) => {
        const { [MARKER_KEY]: _drop, ...production } = i as unknown as Record<
          string | symbol,
          unknown
        >;
        return { ...production, observerId: "some-live-observer" } as AttestInput;
      },
    },
    { name: "observations absent", apply: (i) => ({ ...i, observations: undefined as never }) },
    { name: "final state absent", apply: (i) => ({ ...i, finalFiles: undefined as never }) },
    {
      name: "hidden fixtures absent",
      apply: (i) => ({ ...i, hiddenFixtures: undefined as never }),
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

describe("TIF-95: a caller cannot name its own provenance", () => {
  /**
   * Round 5's finding, and the reason this design changed: the previous guard refused one
   * forbidden string. That is a check whose input the caller writes — the same fabrication
   * with `observerId: "Offline"` or `"vm-guest"` passed. These tests assert the inverse:
   * nothing is admitted unless it is registered, so there is no string to guess.
   */
  it("refuses a self-consistent fabrication for ANY unregistered observer id", async () => {
    const run = await finishedRun();
    const input = baseInput(run);
    // Fabricated end to end: no executeTrial, no guest, no file on disk. Only the caller's
    // own bytes and a matching observation.
    // Strip the contract-test door: this is the production shape, a plain caller.
    const { [MARKER_KEY]: _drop, ...production } = input as Record<string | symbol, unknown>;
    for (const id of [
      "offline",
      "Offline",
      "offline ",
      " vm-guest-second-connection",
      "x",
      "",
      "   ",
    ]) {
      const result = attest({ ...production, observerId: id } as AttestInput);
      expect(result.eligible, `observerId ${JSON.stringify(id)} was admitted`).toBe(false);
      expect(result.blockers.join(" ")).toContain("not a registered live observer");
    }
  });

  it("admits the contract-test door, so the refusals above are about provenance", async () => {
    // The door is a symbol the caller cannot name, and the input is otherwise identical.
    const input = baseInput(await finishedRun());
    expect(attest(input).eligible).toBe(true);
  });

  it("admits a registered live observer and only that observer", async () => {
    const input = baseInput(await finishedRun());
    const live = { id: "vm-second-connection", observe: () => [] };
    registerLiveObserver(live);
    expect(attest({ ...input, observerId: "vm-second-connection" }).eligible).toBe(true);
    // A different id is still refused even though one observer is registered.
    expect(attest({ ...input, observerId: "vm-second-connection " }).eligible).toBe(false);
  });
});

describe("TIF-125 R6: the scorer re-derives the binding, and malformed input is refused", () => {
  const scored = (run: FinishedRun, attestation: ReturnType<typeof attest> | undefined) =>
    scoreDiscoveryTrial(
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

  it("R6 1a positive control: an honest row passes the binding, withheld only by the flag", async () => {
    // The flag stays false until an independent PASS, so eligibility cannot be asserted
    // here. What CAN be asserted is that the binding admits the honest row: the blocker is
    // the flag, not the binding. Together with the negative test below — which asserts the
    // binding blocker — this pins both directions. A binding that did nothing would make
    // the negative test fail; a binding that refused everything would make this one fail.
    const run = await finishedRun();
    const result = scored(run, attest(baseInput(run)));
    if (result.status !== "scored") throw new Error("unreachable");
    const blockers = result.attestationBlockers.join(" ");
    expect(blockers).toContain("eligibility withheld");
    expect(blockers).not.toContain("does not cover this row");
    expect(result.decisionEligible).toBe(false);
  });

  it("R6 1a: attest(bundle A) cannot make bundle B decision-eligible", async () => {
    // The scorer holds the row, so it recomputes the digest rather than trusting `eligible`.
    const run = await finishedRun();
    const forA = attest(baseInput(run));
    expect(forA.eligible).toBe(true);

    const otherBundle = { "store.json": new TextEncoder().encode('{"items":[{"text":"else"}]}\n') };
    const result = scored({ ...run, files: otherBundle } as FinishedRun, forA);
    if (result.status !== "scored") throw new Error("unreachable");
    expect(result.decisionEligible).toBe(false);
    expect(result.attestationBlockers.join(" ")).toContain("does not cover this row");
  });

  it("R6 1a: a relabelled attestation is refused on arm, task and prompt", async () => {
    // The gate refuses a mismatched bundle, so the scorer's own arm/task/prompt checks are
    // only reachable by relabelling a VALID attestation. That is the attack: a caller who
    // holds an honest attestation for one row spreads it and rewrites the binding.
    const run = await finishedRun();
    const real = attest(baseInput(run));
    expect(real.eligible).toBe(true);
    for (const field of ["armId", "taskId", "promptHash"] as const) {
      const relabelled = {
        ...real,
        binding: { ...real.binding!, [field]: "relabelled" },
      };
      const result = scored(run, relabelled as typeof real);
      if (result.status !== "scored") throw new Error("unreachable");
      expect(result.decisionEligible, `relabelled ${field} was admitted`).toBe(false);
      expect(result.attestationBlockers.join(" ")).toContain("does not cover this row");
    }
  });

  it("R6 round 2 finding 3: the binding cannot be mutated or trapped after attest", async () => {
    const run = await finishedRun();
    const otherBundle = { "store.json": new TextEncoder().encode('{"items":[{"text":"else"}]}\n') };
    const otherRun = { ...run, files: otherBundle } as FinishedRun;

    // (i) Mutate the caller's own bundle object after attest() said eligible.
    const input = baseInput(run);
    const mutable = input.bundle!;
    const attested = attest(input);
    expect(attested.eligible).toBe(true);
    mutable.bundleDigest = bundleDigest(otherBundle);
    const afterMutation = scored(otherRun, attested);
    if (afterMutation.status !== "scored") throw new Error("unreachable");
    // Assert the BLOCKER, not just the flag: with the flag off, `decisionEligible` is false
    // either way, so only the blocker identity proves the binding caught it.
    expect(afterMutation.attestationBlockers.join(" ")).toContain("does not cover this row");

    // (ii) A getter that answers honestly for the gate and dishonestly for the scorer.
    let reads = 0;
    const trapped = {
      ...baseInput(run).bundle!,
      get bundleDigest() {
        reads += 1;
        return reads === 1 ? bundleDigest(run.files) : bundleDigest(otherBundle);
      },
    };
    const trappedAttestation = attest({ ...baseInput(run), bundle: trapped });
    const afterGetter = scored(otherRun, trappedAttestation);
    if (afterGetter.status !== "scored") throw new Error("unreachable");
    expect(afterGetter.attestationBlockers.join(" ")).toContain("does not cover this row");

    // (iii) A hostile binding must not throw out of the scorer and abort the batch.
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("trap");
        },
      },
    );
    const forged = { ...attested, binding: hostile } as typeof attested;
    expect(() => scored(run, forged)).not.toThrow();
  });

  it("R6 1d: an absent fixture identity is refused, not skipped", async () => {
    const run = await finishedRun();
    const input = baseInput(run);
    for (const field of ["fixtureId", "fixtureHash"] as const) {
      const result = attest({ ...input, evidence: { ...input.evidence, [field]: undefined } });
      expect(result.eligible, `${field} absent was admitted`).toBe(false);
      expect(result.blockers.join(" ")).toContain("does not name the fixture");
    }
  });

  it("R6 1d: the honest task fixture is accepted and a foreign one refused", async () => {
    const run = await finishedRun();
    const input = baseInput(run);
    // The honest value is the task fixture's id — the same id on the hidden fixture.
    expect(attest(input).eligible).toBe(true);
    const foreign = attest({
      ...input,
      evidence: { ...input.evidence, fixtureId: "ef-todo-other-v1" },
    });
    expect(foreign.eligible).toBe(false);
    expect(foreign.blockers.join(" ")).toContain("is fixture");
  });

  it("R6 4: the fixture-hash binding and the unaudited-call clause are each load-bearing", async () => {
    const input = baseInput(await finishedRun());
    // A wrong hash is refused by the hash clause alone: the fixture identity is otherwise
    // intact, so nothing else in the gate can be what rejects it.
    const wrongHash = attest({ ...input, claimedFixtureHash: "0".repeat(64) });
    expect(wrongHash.eligible).toBe(false);
    expect(wrongHash.blockers.join(" ")).toContain("fixture hash differs");

    // One recorded call with no audit is refused by the count clause alone.
    const unaudited = attest({
      ...input,
      evidence: { ...input.evidence, toolCallAudits: input.evidence.toolCallAudits.slice(1) },
    });
    expect(unaudited.eligible).toBe(false);
    expect(unaudited.blockers.join(" ")).toContain("not every call has an audit");
  });

  it("R6 round 2 finding 4 (A14): a claimed hash that names no fixture is refused", async () => {
    // Without the `resolved === undefined` clause, a made-up hash claimed consistently with
    // zero observations came out eligible with no blockers. The fixture-hash check alone
    // does not catch it, because the caller writes both sides of that comparison.
    const input = baseInput(await finishedRun());
    const madeUp = "a".repeat(64);
    const result = attest({
      ...input,
      claimedFixtureHash: madeUp,
      evidence: { ...input.evidence, fixtureHash: madeUp },
      observations: [],
    });
    expect(result.eligible, "a made-up hash was admitted").toBe(false);
    expect(result.blockers.join(" ")).toContain("no hidden fixture hashes to");
  });

  it("R6 round 2 finding 3: the scorer does not throw on a hostile accessor or bad files", async () => {
    const run = await finishedRun();
    const real = attest(baseInput(run));

    // (i) A throwing `binding` ACCESSOR, not just a hostile binding value.
    const throwingAccessor = Object.defineProperty({ ...real }, "binding", {
      get() {
        throw new Error("trap");
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => scored(run, throwingAccessor as typeof real)).not.toThrow();

    // (ii) A Proxy that throws on the FIRST read — the brand read inside isAttestation.
    const brandThrows = new Proxy(real, {
      get() {
        throw new Error("trap");
      },
    });
    expect(() => scored(run, brandThrows as typeof real)).not.toThrow();

    // (iii) Malformed files: `scoreTrial` handles these without throwing, so the scorer must
    // too. A throw here aborts the whole comparison batch.
    for (const files of [{ "store.json": undefined }, null]) {
      expect(() =>
        scoreDiscoveryTrial(
          { ...run.evidence, planner: { model: "claude-sonnet-5-5", settings: { t: 0 } } } as never,
          {
            fixture: taskFixture(TASK),
            actual: { kind: "myco-todo", files },
            screen: run.screen,
            trace: run.trace,
            selfReport: run.selfReport,
            faultVersion: 0,
          } as never,
          { t: 0 },
          real,
        ),
      ).not.toThrow();
    }
  });

  it("R6 round 2 finding 4: the returned attestation is frozen", async () => {
    const run = await finishedRun();
    const att = attest(baseInput(run));
    expect(Object.isFrozen(att)).toBe(true);
    // Reassigning `binding` or `eligible` after the fact must not take effect.
    expect(() => {
      (att as { eligible: boolean }).eligible = true;
    }).toThrow();
    expect(att.eligible).toBe(true);
    const refused = attest({} as never);
    expect(Object.isFrozen(refused)).toBe(true);
    expect(refused.eligible).toBe(false);
  });

  it("R6 round 2 finding 1: the hidden set is read once, so a Proxy cannot answer twice", async () => {
    // The set was read at the commitment check and again at the resolve. A Proxy array can
    // give the real set to the commitment and a forged fixture to the resolve, so the
    // commitment passes while the resolved fixture is not in it.
    const input = baseInput(await finishedRun());
    const forged = structuredClone(HIDDEN[0]!);
    (forged.fault as { version: number }).version = 999;
    const forgedHash = fixtureHash(forged);
    let indexReads = 0;
    const shifty = new Proxy(HIDDEN, {
      get(target, key, receiver) {
        if (key === "0") {
          indexReads += 1;
          // First index read is the commitment's map; later reads are the resolve's find.
          return indexReads === 1 ? target[0] : forged;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const result = attest({
      ...input,
      hiddenFixtures: shifty as never,
      claimedFixtureHash: forgedHash,
      evidence: { ...input.evidence, fixtureHash: forgedHash },
    });
    expect(result.eligible, "a Proxy set admitted a fixture outside the commitment").toBe(false);
  });

  it("R6 round 2 finding 1: a getter on taskFixtureId cannot answer differently per read", async () => {
    const input = baseInput(await finishedRun());
    const foreign = HIDDEN.find((h) => h.taskFixtureId !== TASK.fixtureId)!;
    let reads = 0;
    const shifty = structuredClone(foreign);
    Object.defineProperty(shifty, "taskFixtureId", {
      get() {
        reads += 1;
        // Honest for the first reads, the claimed task's value afterwards.
        return reads <= 2 ? foreign.taskFixtureId : TASK.fixtureId;
      },
      enumerable: true,
      configurable: true,
    });
    const result = attest({
      ...input,
      hiddenFixtures: [shifty, ...HIDDEN.slice(1)] as never,
      claimedFixtureHash: fixtureHash(foreign),
      evidence: { ...input.evidence, fixtureHash: fixtureHash(foreign) },
    });
    expect(result.eligible, "a getter fixture was admitted").toBe(false);
  });

  it("R6 round 2 finding 1: a row naming an unknown task is refused", async () => {
    // The registry is the only non-circular oracle here, so a task it does not know cannot
    // be bound to any fixture.
    const input = baseInput(await finishedRun());
    const result = attest({
      ...input,
      evidence: { ...input.evidence, taskId: "ef-no-such-task" },
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("names no known task");
  });

  it("R6 round 2 finding 1: a self-consistent foreign hidden fixture is refused", async () => {
    // The attack: claim a hidden fixture for a DIFFERENT task, consistently. fixtureId,
    // fixtureHash and claimedFixtureHash all agree with each other, so every comparison
    // between caller-supplied values passes. Only the task registry can catch it.
    const run = await finishedRun();
    const input = baseInput(run);
    const foreign = HIDDEN.find((h) => h.taskFixtureId !== TASK.fixtureId)!;
    const consistent = {
      ...input,
      claimedFixtureHash: fixtureHash(foreign),
      evidence: {
        ...input.evidence,
        fixtureId: foreign.taskFixtureId,
        fixtureHash: fixtureHash(foreign),
      },
    };
    const result = attest(consistent);
    expect(result.eligible, "a self-consistent foreign fixture was admitted").toBe(false);
    expect(result.blockers.join(" ")).toContain("is fixture");

    // And the scorer must refuse it too, not just the gate.
    const scoredResult = scored(run, result);
    if (scoredResult.status !== "scored") throw new Error("unreachable");
    expect(scoredResult.decisionEligible).toBe(false);
  });

  it("R6 3: every malformed screen shape is refused, and the Proxy trap does not throw", async () => {
    const input = baseInput(await finishedRun());
    for (const bad of [42, "x", {}, [], null]) {
      const result = attest({ ...input, screen: bad as never });
      expect(result.eligible, `screen ${JSON.stringify(bad)} was admitted`).toBe(false);
    }
    for (const bad of [42, "x", {}, [], undefined, null]) {
      const result = attest({ ...input, screenObserved: bad as never });
      expect(result.eligible, `screenObserved ${JSON.stringify(bad)} was admitted`).toBe(false);
    }
    // A Proxy whose traps throw must not escape: the catch handler examines nothing.
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("trap");
        },
        has: () => {
          throw new Error("trap");
        },
      },
    );
    expect(() => attest(hostile as never)).not.toThrow();
    expect(attest(hostile as never).eligible).toBe(false);
  });
});

describe("TIF-125: the attestation is bound to the row it scores", () => {
  /**
   * Round 5's finding 1. A valid attestation from one bundle marked a different bundle
   * decision-eligible, and the resolved hidden fixture was never compared to the scored task
   * fixture. Evidence not tied to the thing it is evidence of is the same defect class as a
   * fabricated observer: it looks like verification and checks nothing.
   */
  it("refuses a bundle whose bytes differ from the attested digest", async () => {
    const input = baseInput(await finishedRun());
    const otherBundle = {
      "store.json": new TextEncoder().encode('{"items":[{"text":"other"}]}\n'),
    };
    const result = attest({
      ...input,
      finalFiles: otherBundle,
      observations: [
        { path: "store.json", sha256: "whatever", bytes: 1, observedAt: "t", afterLastSave: true },
      ],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("attested bundle digest does not match");
  });

  it("refuses an attestation for a different arm, task or prompt", async () => {
    const input = baseInput(await finishedRun());
    for (const [field, value] of [
      ["armId", "hcu+shell"],
      ["taskId", "some-other-task"],
      ["promptHash", "0".repeat(64)],
    ] as const) {
      const result = attest({ ...input, bundle: { ...input.bundle!, [field]: value } });
      expect(result.eligible, `${field} mismatch was admitted`).toBe(false);
      expect(result.blockers.join(" ")).toContain("binding:");
    }
  });

  it("refuses an attestation that does not name the row at all", async () => {
    // Absent binding is a blocker, not a pass: an attestation that does not say what it
    // attests cannot be evidence for anything.
    const input = baseInput(await finishedRun());
    const result = attest({ ...input, bundle: undefined });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("does not name the row it is for");
  });

  it("refuses when the commitment resolves a fixture other than the scored one", async () => {
    const run = await finishedRun();
    const input = baseInput(run);
    const result = attest({
      ...input,
      evidence: { ...run.evidence, fixtureId: "ef-todo-something-else-v1" },
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("the row scores");
  });

  it("admits the bound run, so the refusals above are about the binding", async () => {
    const input = baseInput(await finishedRun());
    expect(attest(input).eligible).toBe(true);
  });

  it("refuses a string where file bytes belong", async () => {
    // Accepting a string meant a caller could pass "content" and have it digested as a file.
    const input = baseInput(await finishedRun());
    const result = attest({
      ...input,
      finalFiles: { "store.json": "not bytes" as never },
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("is not a byte array");
  });

  it("the digest is order-independent, so map construction order cannot refuse an honest run", () => {
    const a = {
      "store.json": new TextEncoder().encode("x"),
      "store.meta.json": new TextEncoder().encode("y"),
    };
    const b = {
      "store.meta.json": new TextEncoder().encode("y"),
      "store.json": new TextEncoder().encode("x"),
    };
    expect(bundleDigest(a)).toBe(bundleDigest(b));
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
    // state oracle said, and the gate must not have touched it. The eligibility flip itself
    // is still withheld (fail-closed) and is asserted in its own test.
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
    // The gate's own reason names the missing observation; the flip is withheld separately.
    expect(refused.blockers.join(" ")).toContain("no observation");
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

  it("refuses a hidden set that does not match the commitment", async () => {
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
    // Rebind: the extra file changes the bundle digest, and the binding is meant to notice.
    const result = attest({
      ...input,
      finalFiles: withExtra,
      bundle: { ...input.bundle!, bundleDigest: bundleDigest(withExtra) },
    });
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
