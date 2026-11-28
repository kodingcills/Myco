/**
 * Test harness for the replay join (spec #589 §2.2): records one trial the way a trusted
 * harness does. A real gate (`createGate`, unchanged) bound to one (task, run) answers each
 * call, its `onDecision` appends the line to that trial's own in-memory log, and every frame
 * capture is bracketed by the log's anchor just before and just after. Nothing here is
 * hand-written gate output: every log line is the gate's own.
 */
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import {
  currentAnchor,
  type ManifestRead,
  type TimelineRecord,
  type TrialBinding,
  timelineRecord,
} from "../../src/watch/timeline.ts";
import { S02_PERSISTED, tempRoot, todoStore, writeState } from "../gate/helpers.ts";

export const STORE = ".myco-todo.json";

export type Step =
  /** Capture one frame (no call lands during it). */
  | { readonly frame: string }
  /** One gate call between captures. */
  | { readonly call: unknown }
  /** Capture one frame while a call lands (the frame straddles the call). */
  | { readonly straddle: string; readonly during: unknown };

export interface RecordedTrial {
  readonly binding: TrialBinding;
  readonly log: Buffer;
  readonly frames: readonly Buffer[];
  readonly records: readonly TimelineRecord[];
}

/** A clock that ticks one second per decision, so `checkedAt` is strictly increasing. */
function ticking(start = Date.parse("2026-11-27T09:00:00Z")) {
  let at = start;
  return () => {
    at += 1000;
    return new Date(at);
  };
}

export async function recordTrial(
  binding: TrialBinding,
  steps: readonly Step[],
  opts: {
    readonly root?: string;
    readonly sharedLog?: string[];
    /** How a captured frame's bytes are made (default: a short text). */
    readonly encode?: (index: number, label: string) => Buffer;
  } = {},
): Promise<RecordedTrial> {
  const root = opts.root ?? tempRoot();
  if (opts.root === undefined) writeState(root, binding.runId, STORE, todoStore(S02_PERSISTED));
  const lines: string[] = opts.sharedLog ?? [];
  const gate = createGate({
    tasks: buildRegistry(builtinTasks()),
    reader: fileEvidenceReader(root),
    assignment: binding,
    now: ticking(),
    onDecision: (result) => {
      lines.push(`${JSON.stringify(result)}\n`);
    },
  });
  const log = () => Buffer.from(lines.join(""));
  const frames: Buffer[] = [];
  const records: TimelineRecord[] = [];
  const capture = async (label: string, during?: unknown) => {
    const before = currentAnchor(log());
    if (during !== undefined) await gate.check(during);
    const bytes =
      opts.encode?.(frames.length, label) ?? Buffer.from(`frame ${frames.length}: ${label}`);
    frames.push(bytes);
    records.push(
      timelineRecord(binding.runId, frames.length - 1, bytes, before, currentAnchor(log())),
    );
  };
  for (const step of steps) {
    if ("frame" in step) await capture(step.frame);
    else if ("straddle" in step) await capture(step.straddle, step.during);
    else await gate.check(step.call);
  }
  return { binding, log: log(), frames, records };
}

export function manifestOf(records: readonly unknown[]): ManifestRead {
  return { kind: "records", records };
}

export function manifestBytes(records: readonly unknown[]): Buffer {
  return Buffer.from(records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

/** Re-record every anchor for a changed log (the same frames, the same line counts). */
export function reanchor(records: readonly TimelineRecord[], log: Buffer): TimelineRecord[] {
  const anchorAt = (lines: number) => {
    const all = log.toString("utf8").split("\n");
    let kept = 0;
    let text = "";
    for (const line of all) {
      if (kept === lines) break;
      text += `${line}\n`;
      if (line.trim().length > 0) kept += 1;
    }
    return currentAnchor(Buffer.from(text));
  };
  return records.map((r) => ({
    ...r,
    logBefore: anchorAt(r.logBefore.lines),
    logAfter: anchorAt(r.logAfter.lines),
  }));
}
