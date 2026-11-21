import type { EvidenceStep, TraceEvent } from "../../../src/core/evidence.ts";
import type { RunData, Sourced, SourceRef, ViewTraceEvent } from "./types.ts";
import { isRecovery } from "./verdict.ts";

export const markerTypes = ["failed", "recovered", "unknown", "fault"] as const;
export type Marker = (typeof markerTypes)[number];
export const markerLabels: Record<Marker, string> = {
  failed: "Guard failure",
  recovered: "Recovery",
  unknown: "Unresolved check",
  fault: "Fault injection",
};

type EventOf<T extends TraceEvent["type"]> = Sourced<Extract<TraceEvent, { type: T }>>;
function asEvent<T extends TraceEvent["type"]>(
  entry: ViewTraceEvent,
  type: T,
): EventOf<T> | undefined {
  if (entry.kind !== "standard" || entry.event.type !== type) return undefined;
  return { value: entry.event, source: entry.source } as EventOf<T>;
}

export interface StepRow {
  step: number;
  record: EvidenceStep;
  path: string;
  events: ViewTraceEvent[];
  actions: EventOf<"action">[];
  observations: EventOf<"observation">[];
  guards: EventOf<"guard-evaluation">[];
  markers: Marker[];
  screenshot?: Sourced<string>;
  offset?: number;
  timestamp?: string;
  timestampSource?: SourceRef;
  recovers?: number;
}

export function joinSteps(data: RunData) {
  const result = data.result;
  const rows = (result?.steps ?? []).map(
    (record, index): StepRow => ({
      step: record.step,
      record,
      path: `/steps/${index}`,
      events: [],
      actions: [],
      observations: [],
      guards: [],
      markers: [],
      screenshot: data.screenshots?.get(record.step),
    }),
  );
  const index = new Map(rows.map((row, i) => [row.step, i]));
  const rowFor = (step: number | undefined) =>
    step === undefined ? undefined : rows[index.get(step) ?? -1];
  const latestObservation = new Map<number, ViewTraceEvent>();
  let active: StepRow | undefined;
  let failedStep: StepRow | undefined;
  let recovery: { row: StepRow; entries: ViewTraceEvent[] } | undefined;

  for (const entry of data.events) {
    const { event } = entry;
    const explicit = rowFor(entry.step);
    const observation = asEvent(entry, "observation");
    if (observation && entry.step === undefined) {
      latestObservation.set(observation.value.stateVersion, entry);
      continue;
    }
    if (entry.step !== undefined) active = explicit;
    const row =
      explicit ??
      (entry.step === undefined && (event.type === "recovery" || event.type === "fault-injection")
        ? active
        : undefined);
    if (!row) continue;
    row.events.push(entry);
    if (observation) row.observations.push(observation);
    const action = asEvent(entry, "action");
    if (action) {
      if (recovery && recovery.row.step !== row.step) {
        row.recovers = recovery.row.step;
        row.events.unshift(...recovery.entries);
        recovery = undefined;
      }
      row.actions.push(action);
    }
    const guard = asEvent(entry, "guard-evaluation");
    if (guard) row.guards.push(guard);
    if (row.observations.length === 0 && (action || guard)) {
      const preceding = latestObservation.get(row.record.stateVersionBefore);
      const joined = preceding && asEvent(preceding, "observation");
      if (preceding && joined) {
        row.events.splice(row.events.length - 1, 0, preceding);
        row.observations.push(joined);
      }
    }
    if (
      event.type === "guard-failure" ||
      guard?.value.results.some(({ passed }) => passed === false)
    )
      failedStep = row;
    if (isRecovery(event) && failedStep === row) {
      recovery = { row, entries: [entry] };
    }
  }

  const started = Date.parse(result?.startedAt ?? "");
  for (const row of rows) {
    row.markers = deriveMarkers(row, result?.guardFailure?.step === row.step);
    const first = row.actions[0] ?? row.guards[0] ?? row.observations[0];
    row.timestamp = first?.value.timestamp;
    row.timestampSource = first?.source;
    const timestamp = Date.parse(row.timestamp ?? "");
    if (Number.isFinite(timestamp - started)) row.offset = (timestamp - started) / 1000;
  }
  return { rows, index };
}

export function deriveMarkers(row: StepRow, terminalGuardFailure = false): Marker[] {
  const failed =
    terminalGuardFailure ||
    [...row.record.preconditionResults, ...row.record.postconditionResults].some(
      (guard) => guard.passed === false,
    ) ||
    row.guards.some(({ value }) => value.results.some((guard) => guard.passed === false)) ||
    row.events.some(({ event }) => event.type === "guard-failure");
  const recovered = row.events.some(({ event }) => isRecovery(event));
  const unknown =
    row.guards.some(({ value }) => value.results.some((guard) => guard.passed === null)) ||
    row.events.some(
      ({ event }) =>
        ("passed" in event && event.passed === null) ||
        (event.type === "recovery" && event.event === "aborted-uncertain"),
    );
  const fault = row.events.some(({ event }) => event.type === "fault-injection");
  return markerTypes.filter((type) => ({ failed, recovered, unknown, fault })[type]);
}

export function stepLabel(step: number, digits: number) {
  return `#${String(step).padStart(digits, "0")}`;
}

export function actionLabel(action: Record<string, unknown>) {
  const { kind, ref, text, value } = action;
  const target = typeof ref === "string" ? ` ${ref}` : "";
  const payload = text ?? value;
  return typeof kind === "string"
    ? kind + target + (payload === undefined ? "" : ` = ${JSON.stringify(payload)}`)
    : JSON.stringify(action);
}
