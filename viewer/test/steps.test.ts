import { beforeEach, expect, test } from "vitest";
import type { EvidenceStep, TraceEvent } from "../../src/core/evidence.ts";
import { joinSteps } from "../src/data/steps.ts";
import type { RunData, ViewTraceEvent } from "../src/data/types.ts";
import { useViewer } from "../src/store.ts";

const timestamp = "2026-11-21T12:00:01Z";
const action = { kind: "click", ref: "button" };
const observation = { type: "observation", timestamp, stateVersion: 1, nodeCount: 7 } as const;

function event(event: TraceEvent, line: number): ViewTraceEvent {
  return {
    kind: "standard",
    event,
    source: { file: "trace.jsonl", line },
    step: "step" in event ? event.step : undefined,
  };
}

function runData(events: ViewTraceEvent[] = []): RunData {
  const steps: EvidenceStep[] = [4, 8, 9].map((step, index) => ({
    step,
    action,
    stateVersionBefore: index + 1,
    stateVersionAfter: index + 2,
    preconditionResults: [],
    postconditionResults: [],
  }));
  return {
    result: { recordKind: "session", runId: "test", startedAt: "2026-11-21T12:00:00Z", steps },
    validation: { kind: "complete", manifestChecked: false },
    events,
    byStep: new Map(),
    ledger: [],
    artifactPaths: [],
    parseErrors: [],
  };
}

test("joins sparse step IDs and leaves absent action and observation joins empty", () => {
  const firstAction = event({ type: "action", timestamp, step: 4, action }, 2);
  const explicitObservation = { ...event({ ...observation, stateVersion: 3 }, 4), step: 9 };
  const { rows, index } = joinSteps(
    runData([
      event(observation, 1),
      firstAction,
      event(
        {
          type: "guard-evaluation",
          timestamp,
          step: 4,
          phase: "pre",
          results: [],
          stateVersionBefore: 1,
          stateVersionAfter: 1,
        },
        3,
      ),
      explicitObservation,
    ]),
  );
  expect(index.get(8)).toBe(1);
  expect(rows[0]?.path).toBe("/steps/0");
  expect(rows[0]?.actions[0]).toEqual({ source: firstAction.source, value: firstAction.event });
  expect(rows[0]?.guards).toHaveLength(1);
  expect(rows[0]?.observations[0]?.value.nodeCount).toBe(7);
  expect(rows[0]?.offset).toBe(1);
  expect(rows[1]?.actions).toEqual([]);
  expect(rows[1]?.observations).toEqual([]);
  expect(rows[2]?.observations[0]?.source).toEqual(explicitObservation.source);
});

test("marks guard failure, fault, recovery and unresolved separately", () => {
  const { rows } = joinSteps(
    runData([
      event({ type: "action", timestamp, step: 4, action }, 1),
      event({ type: "fault-injection", timestamp, fault: "fixture", detail: "injected" }, 2),
      event(
        {
          type: "guard-failure",
          timestamp,
          step: 4,
          phase: "postcondition",
          guard: {
            step: 4,
            phase: "postcondition",
            predicateName: "visible",
            observed: "hidden",
            reason: "hidden",
          },
        },
        3,
      ),
      event({ type: "recovery", timestamp, stateVersion: 1, event: "retry" }, 4),
      event({ type: "action", timestamp, step: 8, action }, 5),
      {
        kind: "extended",
        event: { type: "step-check", passed: null },
        step: 9,
        source: { file: "trace.extended.jsonl", line: 1 },
      },
    ]),
  );
  expect(rows.map((row) => row.markers)).toEqual([
    ["failed", "recovered", "fault"],
    ["recovered"],
    ["unknown"],
  ]);
  expect(rows[1]?.recovers).toBe(4);
});

beforeEach(() => {
  const data = runData([event({ type: "action", timestamp, step: 4, action }, 1)]);
  useViewer.setState({
    runs: [{ key: "test", name: "test", files: [], opened: 0, loading: false, data }],
    selection: { run: "test" },
    mode: "proof",
    inspectorOpen: true,
    inspectorTab: "detail",
  });
});

test("one selection drives mode changes and repeated seeks are no-ops", () => {
  const store = useViewer.getState();
  store.selectStep(8);
  const selection = useViewer.getState().selection;
  store.setMode("why");
  store.selectStep(8);
  expect(useViewer.getState().selection).toBe(selection);
  store.selectStep(9);
  expect(useViewer.getState().selection).toEqual({ run: "test", step: 9 });
  store.setMode("proof");
  expect(useViewer.getState().selection.step).toBe(9);
});

test("a Proof trace chip opens Why Detail and a Why trace chip opens Raw", () => {
  const source = { file: "trace.jsonl", line: 1 };
  useViewer.getState().inspect(source);
  expect(useViewer.getState()).toMatchObject({
    mode: "why",
    inspectorOpen: true,
    inspectorTab: "detail",
    selection: { run: "test", step: 4, source },
  });
  useViewer.getState().inspect(source);
  expect(useViewer.getState().inspectorTab).toBe("raw");
});
