/**
 * TIF-50 EF-001 trace guard — closes "solved without the GUI" at the task level.
 *
 * The guard replays the evidence stream and refuses a result it cannot reconcile with
 * recorded GUI acts. It lives with the fixture rather than the runtime so that every
 * arm is measured by the same rule — including arms that have no file tool at all, for
 * which the first clause simply never fires.
 *
 * The guard is intentionally *conservative in the direction that matters*: it can only
 * refute a run that otherwise verified. It never turns a refuted run into a pass, so a
 * guard bug costs a false refutation (visible, auditable) rather than a false success.
 */

import type { FixtureManifest, GuardTraceEvent, TraceGuardResult } from "./types.ts";

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Reconciles the final persisted bytes with the trace.
 *
 * 1. `not-launched` — the target files changed but the trace records no launch at all.
 * 2. `file-io-shortcut` — a recorded write touched a persistence file directly.
 * 3. `unreconciled-change` — a persistence file differs from the last save the trace
 *    observed, with no GUI act recorded between that observation and the end.
 */
export function checkTrace(
  fixture: FixtureManifest,
  events: readonly GuardTraceEvent[],
  finalFiles: Readonly<Record<string, Uint8Array>>,
): TraceGuardResult {
  const watched = new Set(fixture.persistenceFiles);
  let launched = false;
  let actsAfterLastSave = 0;
  let lastSave: Readonly<Record<string, Uint8Array>> | undefined;
  const directWrites: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case "action":
        if (event.action.kind === "launch") launched = true;
        if (lastSave) actsAfterLastSave += 1;
        break;
      case "save-observed":
        lastSave = event.files;
        actsAfterLastSave = 0;
        break;
      case "file-write":
        if (watched.has(event.path) || watched.has(basename(event.path)))
          directWrites.push(event.path);
        break;
      default:
        break;
    }
  }

  if (directWrites.length > 0) {
    return {
      status: "file-io-shortcut",
      reasons: [
        `persistence file written directly (${directWrites.join(", ")}) instead of through the app`,
      ],
    };
  }

  // A file is "changed" only when the trace shows it existed and its bytes differ at the end.
  // Bytes that first appear in the final read are not a change we can attribute, so the guard
  // does not claim to explain them — pass/fail still belongs to the state oracle.
  const changed = fixture.persistenceFiles.filter(
    (path) => lastSave !== undefined && !sameBytes(finalFiles[path], lastSave[path]),
  );

  if (changed.length === 0) return { status: "clean", reasons: [] };

  if (!launched) {
    return {
      status: "not-launched",
      reasons: [`${changed.join(", ")} changed but the app was never launched`],
    };
  }
  if (actsAfterLastSave === 0) {
    return {
      status: "unreconciled-change",
      reasons: [`${changed.join(", ")} changed after the last save with no GUI act recorded`],
    };
  }
  // A GUI act after the save explains the change; the trace is reconcilable.
  return { status: "clean", reasons: [] };
}

function basename(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * Serialises the guard's events to one JSON object per line, matching the
 * `trace.jsonl` convention M1-012 established. File bytes travel as base64 so a
 * binary persistence format (xlsx) survives the round trip.
 */
export function serialiseGuardTrace(events: readonly GuardTraceEvent[]): string {
  return `${events.map((event) => JSON.stringify(withBase64(event))).join("\n")}\n`;
}

function withBase64(event: GuardTraceEvent): unknown {
  if (event.type !== "save-observed") return event;
  const files: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(event.files)) files[path] = toBase64(bytes);
  return { ...event, files };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Inverse of `serialiseGuardTrace`; unmapped lines are skipped rather than throwing. */
export function parseGuardTrace(content: string): GuardTraceEvent[] {
  const events: GuardTraceEvent[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const event = decodeEvent(JSON.parse(line));
    if (event) events.push(event);
  }
  return events;
}

function decodeEvent(raw: unknown): GuardTraceEvent | null {
  if (!raw || typeof raw !== "object" || !("type" in raw) || typeof raw.type !== "string")
    return null;
  switch (raw.type) {
    case "run-start":
      return { type: "run-start", timestamp: timestampOf(raw) };
    case "action": {
      if (!("step" in raw) || typeof raw.step !== "number" || !("action" in raw)) return null;
      const action = raw.action;
      if (
        !action ||
        typeof action !== "object" ||
        !("kind" in action) ||
        typeof action.kind !== "string"
      ) {
        return null;
      }
      if (!isTraceActKind(action.kind)) return null;
      return {
        type: "action",
        timestamp: timestampOf(raw),
        step: raw.step,
        action: { kind: action.kind },
      };
    }
    case "save-observed": {
      if (!("files" in raw) || !raw.files || typeof raw.files !== "object") return null;
      const files: Record<string, Uint8Array> = {};
      for (const [path, encoded] of Object.entries(raw.files)) {
        if (typeof encoded === "string") files[path] = fromBase64(encoded);
      }
      return { type: "save-observed", timestamp: timestampOf(raw), files };
    }
    case "file-write": {
      if (!("path" in raw) || typeof raw.path !== "string") return null;
      const via =
        "via" in raw && (raw.via === "shell-exec" || raw.via === "file-io") ? raw.via : "file-io";
      return { type: "file-write", timestamp: timestampOf(raw), path: raw.path, via };
    }
    default:
      return null;
  }
}

const TRACE_ACT_KINDS = ["click", "typeText", "setValue", "keyPress", "waitFor", "launch"] as const;

function isTraceActKind(kind: string): kind is (typeof TRACE_ACT_KINDS)[number] {
  return (TRACE_ACT_KINDS as readonly string[]).includes(kind);
}

function timestampOf(raw: object): string {
  return "timestamp" in raw && typeof raw.timestamp === "string" ? raw.timestamp : "";
}

function fromBase64(encoded: string): Uint8Array {
  if (typeof atob !== "function") {
    // Node without the web globals; Buffer is the portable fallback here.
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Convenience: the guard verdict for a run, from raw trace text. */
export function checkTraceFile(
  fixture: FixtureManifest,
  traceContent: string,
  finalFiles: Readonly<Record<string, Uint8Array>>,
): TraceGuardResult {
  return checkTrace(fixture, parseGuardTrace(traceContent), finalFiles);
}
