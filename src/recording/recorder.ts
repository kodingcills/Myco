/**
 * Track R: the recorder. Captures a human demonstration as semantic actions plus the
 * document's before and after state.
 *
 * Rules (each is tested, and each guard is mutation-proven in test/recording):
 *  - Operator-started: `startRecording` refuses unless the caller states
 *    `startedBy: "operator"` and supplies an indicator. The gate API has no field that could
 *    start a recording, and nothing in Myco's agent-facing surface calls this.
 *  - Visible: the indicator is called with a banner at start and at stop. A recorder whose
 *    indicator throws does not start (the operator would not have seen it).
 *  - Allowlist, not blocklist: of each raw event only the known fields of the known event
 *    types are kept. Window titles, key text, clipboard, coordinates, process names and
 *    anything else are dropped and counted, never stored.
 *  - No secrets or host paths: every kept string (cell values, refs, document cells) is
 *    scanned (`scrub.ts`); a hit is replaced by a redaction token and recorded as a
 *    redaction (path and kind only). `stop` runs `assertClean` over the whole recording
 *    and throws rather than return anything that still holds one.
 *  - The document is named logically (`document.csv`); its path is never stored.
 *  - Before and after state are the bytes on disk: before when the recording starts, after
 *    (what was saved) when it stops. Unreadable bytes stop the recording with an error.
 */
import { CsvDocumentError, parseA1, parseCsvRows, sha256Hex } from "./csv.ts";
import { assertClean, findSensitive, redactionToken, type SensitiveKind } from "./scrub.ts";
import {
  type DocumentSnapshot,
  RECORDING_SCHEMA,
  type RecordedAction,
  type Recording,
  type SourceEvent,
} from "./types.ts";

export const RECORDER_NAME = "myco-recorder";
export const RECORDER_VERSION = "1";

export class RecorderError extends Error {
  override readonly name = "RecorderError";
}

export interface OperatorStart {
  /** Must be exactly "operator". An agent, a gate request or a script cannot claim it implicitly. */
  readonly startedBy: string;
  /** Whether an interactive terminal confirmed the start. */
  readonly interactive: boolean;
}

export interface RecorderOptions {
  readonly start: OperatorStart;
  /** Shows the operator that recording is on. Called at start and at stop. Required. */
  readonly indicator: (line: string) => void;
  /** The document's bytes on disk when recording starts. */
  readonly before: Uint8Array;
  readonly simulated: boolean;
  readonly recordingId: string;
  /** Extra exact-substring markers to refuse (planted-marker tests, operator deny list). */
  readonly markers?: readonly string[];
  readonly now?: () => Date;
  readonly maxActions?: number;
}

export interface ActiveRecording {
  /** Feed one raw event from the demonstration source. Never throws on a bad event. */
  push(event: SourceEvent): void;
  /** Stop and return the recording, with `after` = the saved document bytes. */
  stop(after: Uint8Array): Recording;
}

export const START_BANNER =
  "● MYCO IS RECORDING this document: cell edits and saves are captured (no key text, window titles, clipboard or paths). Stop the recorder to end.";
export const STOP_BANNER = "■ MYCO RECORDING STOPPED.";

const MAX_VALUE = 1000;

export function startRecording(options: RecorderOptions): ActiveRecording {
  if (options.start?.startedBy !== "operator") {
    throw new RecorderError("a recording must be started by the operator");
  }
  if (typeof options.indicator !== "function") {
    throw new RecorderError("a recording must be visible: supply an indicator");
  }
  const markers = options.markers ?? [];
  const now = options.now ?? (() => new Date());
  const maxActions = options.maxActions ?? 10_000;
  const redactions: { field: string; kind: SensitiveKind }[] = [];
  let droppedFields = 0;
  const actions: RecordedAction[] = [];
  let stopped = false;

  /** Keep `value` only when it is clean; otherwise store a redaction token and log it. */
  const keep = (field: string, value: string): string => {
    const hit = findSensitive(value, markers);
    if (!hit) return value;
    redactions.push({ field, kind: hit.kind });
    return redactionToken(hit);
  };

  const snapshot = (bytes: Uint8Array, which: "before" | "after"): DocumentSnapshot => {
    let rows: string[][];
    try {
      rows = parseCsvRows(bytes);
    } catch (error) {
      const why = error instanceof CsvDocumentError ? error.message : "unreadable";
      throw new RecorderError(`the ${which} document could not be read: ${why}`);
    }
    return {
      sha256: sha256Hex(bytes),
      rows: rows.map((row, r) => row.map((cell, c) => keep(`${which}.rows[${r}][${c}]`, cell))),
    };
  };

  // Shown before anything is captured. A throwing indicator means the operator may not have
  // seen it, so the recorder does not start.
  try {
    options.indicator(START_BANNER);
  } catch {
    throw new RecorderError("the recording indicator failed, so recording did not start");
  }
  const startedAt = now().toISOString();
  const before = snapshot(options.before, "before");

  const cellOf = (value: unknown): string | null =>
    typeof value === "string" && parseA1(value) !== undefined ? value : null;

  return {
    push(event) {
      if (stopped || actions.length >= maxActions) return;
      if (typeof event !== "object" || event === null) return;
      const seq = actions.length + 1;
      const fields = Object.keys(event);
      const keepOnly = (allowed: readonly string[]) => {
        droppedFields += fields.filter((f) => !allowed.includes(f)).length;
      };
      switch (event.type) {
        case "cell-changed": {
          keepOnly(["type", "cell", "value"]);
          const cell = cellOf(event.cell);
          if (cell === null || typeof event.value !== "string") {
            droppedFields += 1;
            return;
          }
          const value = event.value.slice(0, MAX_VALUE);
          actions.push({
            seq,
            kind: "cell-edit",
            source: "app",
            cell,
            value: keep(`actions[${seq - 1}].value`, value),
          });
          return;
        }
        case "saved": {
          keepOnly(["type", "via"]);
          actions.push({ seq, kind: "save", source: event.via === "gui" ? "gui" : "app" });
          return;
        }
        case "gui": {
          keepOnly(["type", "event", "cell"]);
          if (event.event !== "key" && event.event !== "click") {
            droppedFields += 1;
            return;
          }
          actions.push({ seq, kind: "gui", event: event.event, cell: cellOf(event.cell) });
          return;
        }
        default:
          droppedFields += fields.length;
      }
    },
    stop(afterBytes) {
      if (stopped) throw new RecorderError("recording already stopped");
      stopped = true;
      const after = snapshot(afterBytes, "after");
      const recording: Recording = {
        schema: RECORDING_SCHEMA,
        recordingId: keep("recordingId", options.recordingId),
        app: "calc",
        documentName: "document.csv",
        simulated: options.simulated,
        consent: {
          startedBy: "operator",
          indicatorShown: true,
          interactive: options.start.interactive,
        },
        recorder: { name: RECORDER_NAME, version: RECORDER_VERSION },
        startedAt,
        stoppedAt: now().toISOString(),
        before,
        after,
        actions,
        redactions,
        droppedFields,
      };
      try {
        options.indicator(STOP_BANNER);
      } catch {
        // The stop banner is best effort; the recording already ended.
      }
      // Last net: nothing sensitive leaves the recorder, whatever the normalizer missed.
      assertClean(recording, markers);
      return recording;
    },
  };
}

/** Serialize a recording for disk, re-checking it first. */
export function serializeRecording(recording: Recording, markers: readonly string[] = []): string {
  assertClean(recording, markers);
  return `${JSON.stringify(recording, null, 2)}\n`;
}

/**
 * Record one demonstration from `source`: start (banner shown), feed every raw event, stop
 * with the bytes the source saved. A source that fails leaves no recording.
 */
export async function recordDemonstration(
  source: { demonstrate(push: (event: SourceEvent) => void): Promise<Uint8Array> },
  options: RecorderOptions,
): Promise<Recording> {
  const active = startRecording(options);
  const after = await source.demonstrate((event) => active.push(event));
  return active.stop(after);
}
