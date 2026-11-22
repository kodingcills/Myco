/**
 * TIF-58 EF-005 — the independent save observer and the ingest attestation.
 *
 * This is the piece `docs/foundry/s1-readiness.md` names as missing. The problem it solves
 * is narrow and worth stating plainly: today the only account of what was saved is the
 * arm's own recorder. "The arm says it saved" and "the store was saved" are the same
 * evidence, so a false success can be manufactured by the thing being measured.
 *
 * Two components, deliberately separate:
 *
 * 1. **`SaveObserver`** — a reader that is not the arm. It samples the persistence files at
 *    a point the arm does not control and records a hash. On the VM this is a second
 *    connection to the guest; offline it is a function over the same bytes, which is enough
 *    to test the *contract* (the ingest's behaviour) without pretending to test the
 *    *independence* (which only a real second process can provide).
 *
 * 2. **`attest()`** — the gate. It takes the arm's evidence, the observer's record, and the
 *    final bytes, and decides whether the run may be decision-eligible. It is deliberately
 *    strict: every binding must match, and a missing observation is a blocker rather than a
 *    pass. A gate that defaults to eligible is not a gate.
 *
 * What this does NOT do: it does not make a run trustworthy by itself. The observer's
 * independence is a property of *where it runs*, and this module cannot verify that. What it
 * can do is refuse to call a run eligible when the observer's record is absent, stale, or
 * disagrees — which is the difference between "we checked" and "we assumed".
 */

import { createHash } from "node:crypto";
import type { GuardTraceEvent, ScreenView } from "../types.ts";
import type { RecordedTrialEvidence } from "./recorder.ts";

/** One observation of one persistence file, taken by a reader that is not the arm. */
export interface SaveObservation {
  /** Which file was read. */
  readonly path: string;
  /** SHA-256 of the bytes at observation time. */
  readonly sha256: string;
  /** Byte length, so a truncated read is visible even if the hash collides. */
  readonly bytes: number;
  /** When the observer read it, ISO-8601. */
  readonly observedAt: string;
  /**
   * Whether the observer read the file *after* the arm's last recorded save. A read taken
   * before the save proves nothing about what was saved.
   */
  readonly afterLastSave: boolean;
}

/** A reader that is not the arm. */
export interface SaveObserver {
  readonly id: string;
  observe(
    paths: readonly string[],
    files: Readonly<Record<string, Uint8Array>>,
  ): readonly SaveObservation[];
}

/**
 * The offline observer: hashes the bytes it is given.
 *
 * It is honest about what it is. `id` says `offline`, and `attest()` treats an offline
 * observation as sufficient for *contract* testing but records the observer's identity in
 * the result, so a report can say which observer produced the evidence. A live run must
 * supply an observer whose `id` names the real second channel.
 */
export function offlineObserver(observedAt = "1970-01-01T00:00:00.000Z"): SaveObserver {
  return {
    id: "offline",
    observe(paths, files) {
      return paths.map((path) => {
        const bytes = files[path];
        if (bytes === undefined) {
          return { path, sha256: "", bytes: 0, observedAt, afterLastSave: false };
        }
        return {
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
          observedAt,
          afterLastSave: true,
        };
      });
    },
  };
}

export interface AttestInput {
  readonly evidence: RecordedTrialEvidence;
  readonly trace: readonly GuardTraceEvent[];
  readonly finalFiles: Readonly<Record<string, Uint8Array>>;
  readonly observations: readonly SaveObservation[];
  readonly screen: ScreenView;
  /** The observer that produced `observations`, so the result can name it. */
  readonly observerId: string;
  /**
   * The fixture's authoritative `persistenceFiles`. This must come from the fixture
   * manifest, never from the caller's convenience: a caller-supplied list with no lower
   * bound is how a gate ends up admitting a run that observed nothing.
   */
  readonly requiredPaths: readonly string[];
  /** Whether the screen reading came from the observer rather than the arm. */
  readonly screenObserved: boolean;
}

export interface Attestation {
  readonly eligible: boolean;
  /** Every reason the run is not eligible. Empty iff `eligible`. */
  readonly blockers: readonly string[];
  readonly observerId: string;
  /** The observation the gate accepted, for the report. */
  readonly accepted: readonly SaveObservation[];
  /** False when the screen oracle had no text to match, which is not the same as agreeing. */
  readonly screenConstrained: boolean;
}

/**
 * Decides whether a run may be decision-eligible.
 *
 * Strict by construction: an empty blocker list is the only path to `eligible: true`, and
 * every check below can only add a blocker. There is no "assume fine" branch.
 */
export function attest(input: AttestInput): Attestation {
  const blockers: string[] = [];
  const { evidence, observations, finalFiles } = input;

  // The set that must be observed is the fixture's list UNION whatever the final state
  // actually holds. A file present in the final state but absent from the fixture list is
  // still a file the run wrote, and an empty set is a caller error, not a clean run.
  const required = [...new Set([...input.requiredPaths, ...Object.keys(finalFiles)])].sort();
  if (required.length === 0)
    blockers.push("fixture: no persistence files are designated, so nothing can be attested");

  // 1. The recorder must be closed and internally consistent. An open or inconsistent
  //    recording means the arm's account of itself is incomplete.
  if (evidence.recordedCalls.length !== evidence.recordedCallCount)
    blockers.push("recorder: call count does not match the recorded calls");
  if (evidence.toolCallAudits.length !== evidence.recordedCalls.length)
    blockers.push("recorder: not every call has an audit");
  if (evidence.toolCallAudits.some((audit) => audit.status !== "complete"))
    blockers.push("recorder: an audit is incomplete");
  // Cardinality is not identity: an audit must name a call that was actually recorded, on
  // the same channel. Without this a ghost audit satisfies the count.
  const recorded = new Map(evidence.recordedCalls.map((call) => [call.callId, call.via]));
  for (const audit of evidence.toolCallAudits) {
    const via = recorded.get(audit.callId);
    if (via === undefined) blockers.push(`recorder: audit ${audit.callId} names no recorded call`);
    else if (via !== audit.via)
      blockers.push(`recorder: audit ${audit.callId} is ${audit.via}, recorded as ${via}`);
  }
  if (evidence.status !== "finished")
    blockers.push(`recorder: trial status is ${evidence.status}, not finished`);

  // 2. Every persistence file must have been observed, and the observation must match the
  //    final bytes. A missing observation is a blocker, never a pass.
  const accepted: SaveObservation[] = [];
  for (const path of required) {
    const observation = observations.find((candidate) => candidate.path === path);
    if (observation === undefined) {
      blockers.push(`observer: no observation of ${path}`);
      continue;
    }
    if (!observation.afterLastSave) {
      blockers.push(`observer: ${path} was read before the last save`);
      continue;
    }
    const bytes = finalFiles[path];
    if (bytes === undefined) {
      blockers.push(`observer: ${path} is absent from the final state`);
      continue;
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== observation.sha256) {
      blockers.push(`observer: ${path} changed after it was observed`);
      continue;
    }
    if (bytes.length !== observation.bytes) {
      blockers.push(`observer: ${path} length disagrees with the observation`);
      continue;
    }
    accepted.push(observation);
  }

  // 3. The screen reading must come from the observer, not the arm. A caller-supplied
  //    visibleText is an unchecked claim, and it feeds the screen oracle.
  if (!input.screenObserved)
    blockers.push("screen: the reading was supplied by the arm, not observed");
  // A pixel arm legitimately reads no text (Tk exposes no AT-SPI node), so an empty screen
  // is not a blocker. It is reported through `screenConstrained` so a reader can tell
  // "the screen oracle had nothing to match" from "the screen oracle agreed".
  const screenConstrained = input.screen.reachable && input.screen.visibleText.length > 0;

  // 4. The observation must be placeable against a save the trace actually recorded, and
  //    that save's bytes must agree with what the observer saw. Checking only the event
  //    type lets any fabricated event of the right shape satisfy the binding.
  const saves = input.trace.filter((event) => event.type === "save-observed");
  if (saves.length === 0) {
    blockers.push("trace: no save was observed, so the observation cannot be placed");
  } else {
    const lastSave = saves[saves.length - 1]!;
    for (const observation of accepted) {
      const saved = lastSave.files[observation.path];
      if (saved === undefined) {
        blockers.push(`trace: the last save does not include ${observation.path}`);
        continue;
      }
      const savedHash = createHash("sha256").update(saved).digest("hex");
      if (savedHash !== observation.sha256)
        blockers.push(`trace: ${observation.path} at the last save differs from the observation`);
    }
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    observerId: input.observerId,
    accepted,
    screenConstrained,
  };
}
