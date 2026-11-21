import type { CheckVerdict, RunRecord, TraceEvent } from "../../../src/core/evidence.ts";
import type { ResultRecord, RunData, Sourced, SourceRef, ViewTraceEvent } from "./types.ts";

export type DisplayVerdict = {
  sources: SourceRef[];
  reason?: Sourced<string>;
} & (
  | { label: "Verified" | "Recovered"; subtype?: never }
  | { label: "Failed"; subtype?: "False success" }
  | { label: "Unknown"; subtype?: "Not scored" }
);

export type CheckItem = Sourced<CheckVerdict> & { label: "Verified" | "Failed" | "Unknown" };

export type PersistedValue =
  | ({ status: "value" } & Sourced<unknown>)
  | { status: "absent" | "could not look" | "not recorded"; source: SourceRef };

export interface ComparatorRow {
  field: string;
  claimedLabel: "claimed" | "claimed (derived)";
  claimed?: Sourced<unknown>;
  intent?: Sourced<unknown>;
  observed?: Sourced<string>;
  persisted: PersistedValue;
  check: CheckItem;
  comparison: "agree" | "disagree" | "unknown" | "not recorded";
}

type FailureEvent = Extract<TraceEvent, { type: "guard-failure" | "fault-injection" | "recovery" }>;
export type FailureRecoveryItem =
  | (Sourced<FailureEvent> & { kind: FailureEvent["type"]; alsoRecordedAt?: SourceRef })
  | (Sourced<NonNullable<RunRecord["guardFailure"]>> & { kind: "guardFailure" });

type VerdictEvidence = Pick<RunData, "result"> &
  Partial<Pick<RunData, "events" | "ledger" | "proofEvents">>;

function resultRef(path: string): SourceRef {
  return { file: "result.json", path };
}

export function deriveChecks(result?: ResultRecord): CheckItem[] {
  if (!result) return [];
  const session = result.recordKind === "session";
  const checks = session ? (result.checks ?? []) : result.verdict.checks;
  return checks.map((value, index) => ({
    value,
    label: value.passed === null ? "Unknown" : value.passed ? "Verified" : "Failed",
    source: resultRef((session ? "/checks/" : "/verdict/checks/") + index),
  }));
}

function pointerKey(key: string) {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function targetOf(action: Record<string, unknown>) {
  const ref = action.ref;
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object" && "nodeId" in ref && typeof ref.nodeId === "string") {
    return ref.nodeId;
  }
  return undefined;
}

function writtenValue(action: Record<string, unknown>) {
  if (action.kind === "setValue") return action.value;
  if (action.kind === "type") return action.text;
  return undefined;
}

function readback(check: CheckItem, intent?: Sourced<unknown>): PersistedValue {
  const {
    value: { passed, reason },
    source,
  } = check;
  if (passed === null) return { status: "could not look", source };

  // Current verifiers put the readback in human-readable check reasons.
  // The early UNO "live document has" failure occurs before persisted readback.
  const cell =
    /^cell \S+(?: \(record [^)]+\))? persisted as "(.*)"$/s.exec(reason) ??
    /^cell \S+ expected ".*?" but persisted file has "(.*)"$/s.exec(reason) ??
    /^cell \S+ expected ".*?" \(record [^)]+\) but .+ has "(.*)"$/s.exec(reason);
  if (cell) return { status: "value", value: cell[1], source };
  if (/^persisted store has no item "|^cell \S+ missing or blank in /.test(reason)) {
    return { status: "absent", source };
  }
  if (passed && reason === "persisted item matches intent" && intent) {
    return { status: "value", value: intent.value, source };
  }
  return { status: "not recorded", source };
}

function comparisonOf(claimed: Sourced<unknown> | undefined, persisted: PersistedValue) {
  if (persisted.status === "could not look") return "unknown";
  if (!claimed || persisted.status === "not recorded") return "not recorded";
  if (persisted.status === "absent") return "disagree";
  return "value" in persisted && equalJson(claimed.value, persisted.value) ? "agree" : "disagree";
}

export function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => equalJson(item, right[index]))
    );
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) =>
        Object.prototype.propertyIsEnumerable.call(right, key) &&
        equalJson(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
}

export function deriveComparatorRows({
  result,
  events = [],
  proofEvents = events,
}: VerdictEvidence): ComparatorRow[] {
  if (!result || result.recordKind === "session") return [];
  const params = result.taskParams;
  const claims = new Map<string, Sourced<unknown>>();
  for (const entry of proofEvents) {
    const { event, source } = entry;
    if (
      event.type === "claim" &&
      (event.source === "agent" || event.source === "app-ui") &&
      typeof event.field === "string" &&
      Object.hasOwn(event, "value")
    ) {
      claims.set(event.field, { value: event.value, source });
    }
  }

  const rows = deriveChecks(result).map((check): ComparatorRow => {
    const { name, reason } = check.value;
    const cell = /^(?:cell |could not look: UNO readback of )([A-Z]+\d+)\b/.exec(reason)?.[1];
    const items: unknown[] = Array.isArray(params.items) ? params.items : [];
    const item = items.findIndex(
      (value) =>
        typeof value === "string" &&
        name === `item-${value.toLowerCase().replace(/\W+/g, "-")}-persisted`,
    );
    const field = cell ?? (item >= 0 ? `items[${item}].text` : name);
    const param = cell
      ? ["newValue", "value"].find((key) => Object.hasOwn(params, key))
      : Object.hasOwn(params, field)
        ? field
        : undefined;
    const intent =
      item >= 0
        ? { value: items[item], source: resultRef(`/taskParams/items/${item}`) }
        : param === undefined
          ? undefined
          : { value: params[param], source: resultRef(`/taskParams/${pointerKey(param)}`) };

    const writeIndex = result.steps.findLastIndex(({ action }) => {
      const value = writtenValue(action);
      return (
        typeof value === "string" &&
        (item >= 0 ? value === intent?.value : targetOf(action) === field)
      );
    });
    const step = result.steps[writeIndex];
    const write = step && {
      value: writtenValue(step.action),
      source: resultRef(
        `/steps/${writeIndex}/action/${step.action.kind === "type" ? "text" : "value"}`,
      ),
    };
    const observationIndex =
      step?.postconditionResults.findLastIndex(
        ({ predicateName }) => item >= 0 || predicateName.startsWith(`cell ${field} `),
      ) ?? -1;
    const observation = step?.postconditionResults[observationIndex];
    const observed = observation && {
      value: observation.observed,
      source: resultRef(`/steps/${writeIndex}/postconditionResults/${observationIndex}/observed`),
    };
    const observedValue = observed && /^value="(.*)"$/s.exec(observed.value);
    const explicit = claims.get(field) ?? claims.get(name);
    const claimed =
      explicit ??
      (observedValue && observed
        ? { value: observedValue[1], source: observed.source }
        : (write ?? intent));

    const persisted = readback(check, intent);
    return {
      field,
      claimedLabel: explicit ? "claimed" : "claimed (derived)",
      claimed,
      intent,
      observed,
      persisted,
      check,
      comparison: comparisonOf(claimed, persisted),
    };
  });
  return rows.sort(
    (a, b) => Number(b.comparison === "disagree") - Number(a.comparison === "disagree"),
  );
}

function failureEvent(entry: ViewTraceEvent): FailureEvent | undefined {
  if (entry.kind !== "standard") return undefined;
  const { event } = entry;
  if (
    event.type === "guard-failure" ||
    event.type === "fault-injection" ||
    event.type === "recovery"
  ) {
    return event;
  }
  return undefined;
}

export function deriveFailuresAndRecovery({
  result,
  events = [],
  proofEvents = events,
}: VerdictEvidence): FailureRecoveryItem[] {
  const guard = result?.guardFailure;
  const guardRef = resultRef("/guardFailure");
  const items: FailureRecoveryItem[] = [];
  let hasGuard = false;
  for (const entry of proofEvents) {
    const event = failureEvent(entry);
    if (!event) continue;
    const duplicate = event.type === "guard-failure" && equalJson(event.guard, guard);
    hasGuard ||= duplicate;
    items.push({
      kind: event.type,
      value: event,
      source: entry.source,
      alsoRecordedAt: duplicate ? guardRef : undefined,
    });
  }
  if (guard && !hasGuard) items.push({ kind: "guardFailure", value: guard, source: guardRef });
  return items;
}

export function isRecovery(event: { type: string; event?: unknown }) {
  return (
    event.type === "recovery" &&
    typeof event.event === "string" &&
    event.event.trim() !== "" &&
    event.event !== "none" &&
    event.event !== "aborted-uncertain" &&
    event.event !== "relaunch:resumed" &&
    event.event !== "relaunch:skipped-not-reversible" &&
    !event.event.endsWith("-failed") &&
    !event.event.endsWith(":failed")
  );
}

function unknown(reason: Sourced<string>): DisplayVerdict {
  return { label: "Unknown", reason, sources: [reason.source] };
}

export function deriveVerdict({
  result,
  events = [],
  ledger = [],
  validation = { kind: "pending" },
  parseErrors = [],
}: VerdictEvidence & Partial<Pick<RunData, "validation" | "parseErrors">>): DisplayVerdict {
  if (validation.kind === "invalid") return unknown(validation.reason);
  if (!result) {
    const issue = parseErrors[0];
    return issue
      ? unknown({ value: "The result record could not be read", source: issue.source })
      : validation.kind === "complete"
        ? unknown({ value: "Result record is missing", source: resultRef("") })
        : { label: "Unknown", sources: [] };
  }
  if (result.recordKind === "session") {
    return { label: "Unknown", subtype: "Not scored", sources: [resultRef("/recordKind")] };
  }

  const { verdict } = result;
  const statusRef = resultRef("/verdict/status");
  const unresolved = deriveChecks(result).find((check) => check.value.passed === null);
  const reason =
    result.unresolvedState !== undefined
      ? { value: result.unresolvedState, source: resultRef("/unresolvedState") }
      : verdict.reasons[0] !== undefined
        ? { value: verdict.reasons[0], source: resultRef("/verdict/reasons/0") }
        : unresolved && { value: unresolved.value.reason, source: unresolved.source };
  if (verdict.status === "uncertain" || unresolved) {
    return {
      label: "Unknown",
      reason,
      sources: [statusRef, ...(unresolved ? [unresolved.source] : [])],
    };
  }
  if (validation.kind === "pending") {
    return unknown({
      value: "Checking run evidence",
      source: { file: "trace.jsonl", path: "" },
    });
  }
  if (verdict.status === "refuted") {
    const oracle = ledger.find(
      ({ value }) => value.runId === result.runId && value.oracle === "ground-truth:false",
    );
    const disagreement = deriveComparatorRows({
      result,
      events: parseErrors.length ? [] : events,
    }).find((row) => row.comparison === "disagree" && row.claimed);
    const evidence = oracle
      ? [oracle.source]
      : disagreement?.claimed
        ? [disagreement.claimed.source, disagreement.persisted.source]
        : [];
    return {
      label: "Failed",
      subtype: evidence.length > 0 ? "False success" : undefined,
      reason,
      sources: [statusRef, ...evidence],
    };
  }
  if (result.unresolvedState !== undefined && reason) return unknown(reason);
  const issue = parseErrors[0];
  if (issue) {
    return unknown({ value: `Incomplete evidence in ${issue.source.file}`, source: issue.source });
  }
  if (!verdict.checks.every((check) => check.passed === true)) {
    return { label: "Unknown", reason, sources: [statusRef, resultRef("/verdict/checks")] };
  }
  if (result.guardFailure) {
    return unknown({
      value: "The result records a terminal guard failure",
      source: resultRef("/guardFailure"),
    });
  }

  let recovery: SourceRef | undefined;
  let incompleteAttempt: SourceRef | undefined;
  let pendingGuard:
    | {
        source: SourceRef;
        event: Extract<TraceEvent, { type: "guard-failure" }>;
        record?: RunRecord["steps"][number];
        next?: RunRecord["steps"][number];
        continuation?: RunRecord["steps"][number];
      }
    | undefined;
  const completedSteps = new Set<number>();
  for (const entry of events) {
    if (entry.kind !== "standard") continue;
    const { event, source } = entry;
    if (event.type === "recovery") {
      if (event.event === "aborted-uncertain") {
        return unknown({ value: "Recovery ended in uncertainty", source });
      }
      if (isRecovery(event)) {
        recovery = source;
        if (!pendingGuard || pendingGuard.event.step === entry.step) pendingGuard = undefined;
        incompleteAttempt = undefined;
      } else if (event.event !== "none") {
        incompleteAttempt = source;
      }
    } else if (event.type === "guard-failure") {
      if (pendingGuard && pendingGuard.event.step !== event.step) {
        return unknown({
          value: "No completion follows the guard failure",
          source: pendingGuard.source,
        });
      }
      const index = result.steps.findIndex((step) => step.step === event.step);
      const record = result.steps[index];
      const next = record && result.steps[index + 1];
      pendingGuard = {
        event,
        source,
        record,
        next:
          next && next.step > event.step && next.stateVersionBefore === record.stateVersionAfter
            ? next
            : undefined,
      };
    } else if (
      event.type === "action" &&
      pendingGuard?.next &&
      event.step > pendingGuard.event.step
    ) {
      const { next } = pendingGuard;
      if (
        event.step === next.step &&
        source.file === pendingGuard.source.file &&
        equalJson(event.action, next.action)
      ) {
        pendingGuard.continuation = next;
      }
      pendingGuard.next = undefined;
    } else if (
      event.type === "guard-evaluation" &&
      event.phase === "post" &&
      event.results.length > 0 &&
      event.results.every(({ passed }) => passed === true)
    ) {
      const candidate =
        pendingGuard?.record?.step === event.step
          ? pendingGuard.record
          : pendingGuard?.continuation;
      if (
        pendingGuard &&
        candidate?.step === event.step &&
        source.file === pendingGuard.source.file &&
        !completedSteps.has(event.step) &&
        pendingGuard.event.step === pendingGuard.event.guard.step &&
        event.stateVersionBefore === candidate.stateVersionBefore &&
        event.stateVersionAfter === candidate.stateVersionAfter &&
        (pendingGuard.event.phase === "precondition" ||
          event.results.some(
            ({ predicateName }) => predicateName === pendingGuard?.event.guard.predicateName,
          )) &&
        equalJson(candidate.postconditionResults, event.results)
      ) {
        recovery = pendingGuard.source;
        pendingGuard = undefined;
        incompleteAttempt = undefined;
      }
      completedSteps.add(event.step);
    }
  }
  if (pendingGuard) {
    return unknown({
      value: "No completion follows the guard failure",
      source: pendingGuard.source,
    });
  }
  if (incompleteAttempt) {
    return unknown({ value: "Recovery has no recorded completion", source: incompleteAttempt });
  }
  const sources = [statusRef, resultRef("/verdict/checks")];
  return recovery
    ? { label: "Recovered", sources: [...sources, recovery] }
    : { label: "Verified", sources };
}
