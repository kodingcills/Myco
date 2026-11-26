/**
 * Where a trial's handoff events go (capability track N).
 *
 * `HandoffEventSink` (broker.ts) receives `requested`, `resolved` and `attempt-ended` events as
 * they happen. Two implementations:
 *
 *  - `jsonlHandoffEventSink(path)`: append-only `handoffs.jsonl` in the trial's run directory,
 *    one event per line, opened with `a` (O_APPEND) and written synchronously, so a crash
 *    mid-handoff still leaves the request on disk.
 *  - `attemptLedgerSink(writer, trialKey)`: writes through #518's append-only attempt ledger
 *    once it merges. #518 is an open PR, so this module depends only on the interface below
 *    (`AttemptLedgerEventWriter`), never on its code.
 *    TO FILE (Linear limit): implement `AttemptLedgerEventWriter` over src/m2/attempt-ledger.ts
 *    after #518 merges, and switch the trial harness to `attemptLedgerSink`.
 */
import { appendFileSync } from "node:fs";
import type { HandoffEvent, HandoffEventSink } from "./broker.ts";

export function jsonlHandoffEventSink(path: string): HandoffEventSink {
  return {
    append(event) {
      appendFileSync(path, `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o644 });
    },
  };
}

/** In-memory sink, for tests and for harnesses that persist events themselves. */
export function memoryHandoffEventSink(): HandoffEventSink & { readonly events: HandoffEvent[] } {
  const events: HandoffEvent[] = [];
  return { events, append: (e) => void events.push(e) };
}

/**
 * The slice of #518's attempt ledger this track needs: append one event, keyed by the attempt's
 * trial key, never rewrite. Implemented after #518 merges (see the TO FILE above).
 */
export interface AttemptLedgerEventWriter {
  appendAttemptEvent(trialKey: string, kind: "handoff", event: HandoffEvent): void;
}

export function attemptLedgerSink(
  writer: AttemptLedgerEventWriter,
  trialKey: string,
): HandoffEventSink {
  return { append: (event) => writer.appendAttemptEvent(trialKey, "handoff", event) };
}
