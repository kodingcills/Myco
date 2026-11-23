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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RecordedTrialEvidence } from "../baseline/recorder.ts";
import { commitment, fixtureHash, type HiddenFixture } from "../hidden-split/index.ts";
import type { GuardTraceEvent, ScreenView } from "../types.ts";

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
  /** The hidden fixtures the run claims to have used. */
  readonly hiddenFixtures: readonly HiddenFixture[];
  /** The fixture hash the run claims. The gate resolves the fixture from this. */
  readonly claimedFixtureHash: string;
  /** Whether the screen reading came from the observer rather than the arm. */
  readonly screenObserved: boolean;
}

const attestedBrand: unique symbol = Symbol("myco.attestation");

export interface Attestation {
  /**
   * Brand: only `attest()` can produce an `Attestation`. Without it, a caller could hand
   * `scoreDiscoveryTrial` a literal `{ eligible: true }` and skip the gate entirely.
   */
  readonly [attestedBrand]: true;
  readonly eligible: boolean;
  /** Every reason the run is not eligible. Empty iff `eligible`. */
  readonly blockers: readonly string[];
  readonly observerId: string;
  /** The observation the gate accepted, for the report. */
  readonly accepted: readonly SaveObservation[];
  /** False when the screen oracle had no text to match, which is not the same as agreeing. */
  readonly screenConstrained: boolean;
  /** Files the final state holds that the fixture does not designate. Reported, not required. */
  readonly unexpectedFiles: readonly string[];
  /** The fixture the gate resolved from the commitment, or null when it could not. */
  readonly resolvedFixtureId: string | null;
}

/**
 * Decides whether a run may be decision-eligible.
 *
 * Strict by construction: an empty blocker list is the only path to `eligible: true`, and
 * every check below can only add a blocker. There is no "assume fine" branch.
 */
export interface AttestOptions {
  /** Path to the committed commitment. Defaults to the repo's own file. */
  readonly commitmentPath?: string;
}

/** Reads the committed commitment, or null when it is absent or malformed. */
function readTrustedCommitment(path: string): ReturnType<typeof commitment> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || !("commitment" in parsed)) return null;
    const value = parsed.commitment;
    if (!value || typeof value !== "object") return null;
    if (
      !("rootHash" in value) ||
      typeof value.rootHash !== "string" ||
      !("count" in value) ||
      typeof value.count !== "number" ||
      !("hiddenSplitVersion" in value) ||
      typeof value.hiddenSplitVersion !== "number" ||
      !("perFixtureHash" in value) ||
      !Array.isArray(value.perFixtureHash)
    )
      return null;
    return {
      hiddenSplitVersion: value.hiddenSplitVersion,
      count: value.count,
      rootHash: value.rootHash,
      perFixtureHash: value.perFixtureHash as string[],
    };
  } catch {
    return null;
  }
}

export function attest(input: AttestInput, options: AttestOptions = {}): Attestation {
  const blockers: string[] = [];
  const { evidence, observations, finalFiles } = input;

  // Option 1: the fixture is resolved from the commitment, never taken from the caller.
  // A caller-supplied fixture could keep the real id and name a benign file; a fixture
  // resolved from a commitment-verified set cannot.
  // The trusted commitment is READ FROM THE COMMITTED FILE, never taken from the caller.
  // A caller-supplied commitment is not a commitment: it would let a forged set vouch for
  // itself, which is the hole this option exists to close.
  const trusted = readTrustedCommitment(
    options.commitmentPath ?? join(process.cwd(), "foundry", "hidden-commitment.json"),
  );
  const supplied = commitment(input.hiddenFixtures);
  if (trusted === null) {
    blockers.push("commitment: the committed commitment could not be read");
  } else if (
    supplied.rootHash !== trusted.rootHash ||
    supplied.count !== trusted.count ||
    supplied.hiddenSplitVersion !== trusted.hiddenSplitVersion
  ) {
    blockers.push("commitment: the supplied hidden set does not match the committed commitment");
  }

  const resolved = input.hiddenFixtures.find(
    (candidate) => fixtureHash(candidate) === input.claimedFixtureHash,
  );
  if (resolved === undefined)
    blockers.push(
      `commitment: no hidden fixture hashes to ${input.claimedFixtureHash.slice(0, 12)}…`,
    );

  // The required set is the resolved fixture's own list. Files the app wrote beyond it (a
  // log, a sidecar) are reported but not required to be observed: demanding an observation
  // for every file in the final state refuses honest runs, which is a worse failure than
  // the one it would prevent.
  const required =
    resolved === undefined ? [] : [...new Set(resolved.fixture.persistenceFiles)].sort();
  if (resolved !== undefined && required.length === 0)
    blockers.push(
      `fixture: ${resolved.fixture.fixtureId} designates no persistence files, so nothing can be attested`,
    );
  const unexpected = Object.keys(finalFiles)
    .filter((path) => !required.includes(path))
    .sort();

  // 1. The recorder must be closed and internally consistent. An open or inconsistent
  //    recording means the arm's account of itself is incomplete.
  if ((evidence.recordedCalls ?? []).length !== evidence.recordedCallCount)
    blockers.push("recorder: call count does not match the recorded calls");
  if ((evidence.toolCallAudits ?? []).length !== (evidence.recordedCalls ?? []).length)
    blockers.push("recorder: not every call has an audit");
  if ((evidence.toolCallAudits ?? []).some((audit) => audit.status !== "complete"))
    blockers.push("recorder: an audit is incomplete");
  // Cardinality is not identity: an audit must name a call that was actually recorded, on
  // the same channel. Without this a ghost audit satisfies the count.
  const recorded = new Map<string, string>();
  for (const call of evidence.recordedCalls ?? []) {
    if (recorded.has(call.callId))
      blockers.push(`recorder: call ${call.callId} is recorded more than once`);
    else recorded.set(call.callId, call.via);
  }
  for (const audit of evidence.toolCallAudits ?? []) {
    const via = recorded.get(audit.callId);
    if (via === undefined) blockers.push(`recorder: audit ${audit.callId} names no recorded call`);
    else if (via !== audit.via)
      blockers.push(`recorder: audit ${audit.callId} is ${audit.via}, recorded as ${via}`);
    if (audit.via !== "gui" && audit.accesses.length === 0)
      blockers.push(
        `recorder: ${audit.via} call ${audit.callId} reports no accesses, so a direct write cannot be ruled out`,
      );
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
  // A save the app did not perform is not a save. Require at least one GUI call, and
  // require the last save to follow a GUI action in the trace: bytes conjured out of band
  // with no act to explain them are the exact false success this gate exists to catch.
  const guiCalls = (evidence.recordedCalls ?? []).filter((call) => call.via === "gui");
  if (guiCalls.length === 0)
    blockers.push("recorder: no GUI call was recorded, so no save can be attributed to the app");
  if (saves.length === 0) {
    blockers.push("trace: no save was observed, so the observation cannot be placed");
  } else {
    const lastSaveIndex = input.trace.lastIndexOf(saves[saves.length - 1]!);
    const guiActBefore = input.trace
      .slice(0, lastSaveIndex)
      .some((event) => event.type === "action" && event.callId !== undefined);
    if (!guiActBefore)
      blockers.push("trace: the last save follows no GUI action, so the app did not perform it");
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
    [attestedBrand]: true as const,
    eligible: blockers.length === 0,
    blockers,
    observerId: input.observerId,
    accepted,
    screenConstrained,
    unexpectedFiles: unexpected,
    resolvedFixtureId: resolved?.fixture.fixtureId ?? null,
  };
}
