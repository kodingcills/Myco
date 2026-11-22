import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  attest,
  offlineObserver,
  type SaveObservation,
} from "../../src/foundry/baseline/attest.ts";
import { executeTrial } from "../../src/foundry/baseline/executor.ts";
import { fakeGuest, LAYOUT } from "../../src/foundry/baseline/guest.ts";
import type { RecordedTrialEvidence } from "../../src/foundry/baseline/recorder.ts";
import { ArmRecorder } from "../../src/foundry/baseline/recorder.ts";
import { todoTransport } from "../../src/foundry/baseline/todo-transport.ts";
import { findTask } from "../../src/foundry/tasks/bank.ts";
import { TODO_FIXTURE_SPECS } from "../../src/foundry/tasks/todo.ts";
import type { GuardTraceEvent, ScreenView } from "../../src/foundry/types.ts";

const TASK = findTask("ef-t01b-add-four-items-noverify")!;
const SPEC = TODO_FIXTURE_SPECS.find((s) => s.fixtureId === TASK.fixtureId)!;
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
    requiredPaths: ["store.json"],
    screenObserved: true,
  };
}

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
    const result = attest({ ...input, requiredPaths: [], finalFiles: {} });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("no persistence files are designated");
  });

  it("requires an observation for a file the final state holds but the list omits", async () => {
    // A file the run wrote is a file that must be observed, whatever the caller listed.
    const input = baseInput(await finishedRun());
    const withExtra = {
      ...input.finalFiles,
      "store.meta.json": new TextEncoder().encode('{"count":1}'),
    };
    const result = attest({ ...input, finalFiles: withExtra });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("no observation of store.meta.json");
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
