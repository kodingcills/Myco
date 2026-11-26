/**
 * Live watch view (TIF-265 follow-up, scope add A): turn one line of the gate's decision log
 * into the public event the page shows.
 *
 * This is the redaction boundary. A decision-log line is a full `GateResult` and carries
 * text the view must never stream: the agent's free-text `claim`, the human-readable
 * `reasons` (not a stable contract), evidence paths and digests, and any field a future
 * version adds. So the projection is an allowlist, never a denylist: every output field is
 * rebuilt from a closed vocabulary (verdict, reason codes from `REASON_CODES`, checkpoint
 * numbers) or a strict pattern (operator-listed ids, ISO timestamps), and anything
 * that does not match is dropped. Nothing is copied through as-is. (The oracle family and
 * version are left out on purpose: they are free-form operator strings.)
 *
 * Ids are agent-influenced (an ASSIGNMENT_MISMATCH line records the run the agent named),
 * so a run id is shown only when the operator listed it, and a task id only when the
 * operator listed it; an event for any other run is dropped and counted, never shown.
 */
import { type GateVerdict, isSafeId, REASON_CODES, type ReasonCode } from "../gate/api.ts";

export interface WatchCheckpoints {
  readonly total: number;
  readonly lastVerified: number;
  readonly verdicts: readonly { readonly checkpoint: number; readonly verdict: GateVerdict }[];
}

/** One gate decision as the page shows it. Every field is rebuilt, none copied. */
export interface WatchEvent {
  /** 1-based position among the shown events, in decision-log order. */
  readonly seq: number;
  readonly runId: string;
  /** The task id, only when the operator listed it; otherwise null. */
  readonly taskId: string | null;
  /** The nth gate call recorded for this run (1 = first). */
  readonly call: number;
  /** True for every call after the first on the same run (a retry or a repeat). */
  readonly retry: boolean;
  readonly verdict: GateVerdict;
  /** True only when the log says accepted AND the verdict is verified. */
  readonly accepted: boolean;
  readonly reasonCodes: readonly ReasonCode[];
  readonly checkpoints: WatchCheckpoints | null;
  readonly checkedAt: string | null;
}

export interface Projection {
  readonly events: readonly WatchEvent[];
  /** Lines that were not a usable decision (malformed, unknown verdict, unlisted run). */
  readonly skipped: number;
}

const VERDICTS: ReadonlySet<string> = new Set(["verified", "refuted", "uncertain"]);
const CODES: ReadonlySet<string> = new Set(REASON_CODES);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const MAX_CHECKPOINTS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function smallInt(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

function checkpointsOf(raw: unknown): WatchCheckpoints | null {
  if (!isRecord(raw) || !Array.isArray(raw.verdicts)) return null;
  const total = smallInt(raw.total, MAX_CHECKPOINTS);
  const lastVerified = smallInt(raw.lastVerified, MAX_CHECKPOINTS);
  if (total === null || lastVerified === null || raw.verdicts.length > MAX_CHECKPOINTS) return null;
  const verdicts: { checkpoint: number; verdict: GateVerdict }[] = [];
  for (const entry of raw.verdicts) {
    if (!isRecord(entry)) return null;
    const checkpoint = smallInt(entry.checkpoint, MAX_CHECKPOINTS);
    const verdict = entry.verdict;
    if (checkpoint === null || (verdict !== "verified" && verdict !== "refuted")) return null;
    verdicts.push({ checkpoint, verdict });
  }
  return { total, lastVerified, verdicts };
}

export interface ProjectOptions {
  /** Runs the operator listed. Events for any other run are dropped. */
  readonly runs: ReadonlySet<string>;
  /** Tasks the operator listed. Any other task id is shown as null. */
  readonly tasks: ReadonlySet<string>;
}

/** Project decision-log records (already JSON-parsed) to watch events. Never throws. */
export function projectDecisions(records: readonly unknown[], opts: ProjectOptions): Projection {
  const events: WatchEvent[] = [];
  const calls = new Map<string, number>();
  let skipped = 0;
  for (const record of records) {
    if (!isRecord(record) || !isRecord(record.request)) {
      skipped += 1;
      continue;
    }
    const { runId, taskId } = record.request;
    const verdict = record.verdict;
    if (
      typeof runId !== "string" ||
      !isSafeId(runId) ||
      !opts.runs.has(runId) ||
      typeof verdict !== "string" ||
      !VERDICTS.has(verdict)
    ) {
      skipped += 1;
      continue;
    }
    const reasonCodes = Array.isArray(record.reasonCodes)
      ? (record.reasonCodes.filter(
          (code) => typeof code === "string" && CODES.has(code),
        ) as ReasonCode[])
      : [];
    const call = (calls.get(runId) ?? 0) + 1;
    calls.set(runId, call);
    const checkedAt =
      typeof record.checkedAt === "string" && ISO.test(record.checkedAt) ? record.checkedAt : null;
    events.push({
      seq: events.length + 1,
      runId,
      taskId:
        typeof taskId === "string" && isSafeId(taskId) && opts.tasks.has(taskId) ? taskId : null,
      call,
      retry: call > 1,
      verdict: verdict as GateVerdict,
      accepted: record.accepted === true && verdict === "verified",
      reasonCodes: [...new Set(reasonCodes)],
      checkpoints: checkpointsOf(record.checkpoints),
      checkedAt,
    });
  }
  return { events, skipped };
}
