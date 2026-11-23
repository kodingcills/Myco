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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RecordedTrialEvidence } from "../baseline/recorder.ts";
import { commitment, fixtureHash, type HiddenFixture } from "../hidden-split/index.ts";
import { findTask } from "../tasks/bank.ts";
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
export const OFFLINE_OBSERVER_ID = "offline";

/**
 * Observers this gate will accept, and how an identity is proven.
 *
 * The previous design refused one forbidden string, which is a check the caller writes the
 * input to. This is the inverse: nothing is accepted unless it is registered here. The
 * offline observer is reachable only when the input carries the contract-test marker, so
 * production code has no string it can pass to be believed.
 */
const LIVE_OBSERVERS = new Map<string, SaveObserver>();
const CONTRACT_TEST_MARKER: unique symbol = Symbol("myco.contract-test");

/** Register a live observer. Called by the ingest once a second channel exists. */
export function registerLiveObserver(observer: SaveObserver): void {
  if (observer.id.trim() === "" || observer.id === OFFLINE_OBSERVER_ID)
    throw new Error("a live observer needs its own non-empty id");
  LIVE_OBSERVERS.set(observer.id, observer);
}

/** Test-only door for the offline observer. Not reachable by naming a string. */
export function offlineObserverForContractTest(observedAt = "1970-01-01T00:00:00.000Z"): {
  observer: SaveObserver;
  marker: typeof CONTRACT_TEST_MARKER;
} {
  return { observer: offlineObserver(observedAt), marker: CONTRACT_TEST_MARKER };
}

function safeObserverId(input: unknown): string {
  if (!input || typeof input !== "object" || !("observerId" in input)) return "(none)";
  const id = (input as { observerId?: unknown }).observerId;
  return typeof id === "string" ? id : "(none)";
}
function trustObservers(input: unknown, id: string): SaveObserver | null {
  if (!input || typeof input !== "object") return null;
  const bypass = (input as { [CONTRACT_TEST_MARKER]?: unknown })[CONTRACT_TEST_MARKER];
  if (bypass === CONTRACT_TEST_MARKER && id === OFFLINE_OBSERVER_ID) return offlineObserver();
  return LIVE_OBSERVERS.get(id) ?? null;
}

/** Reads the observer id without trusting it to be a string. */

export function offlineObserver(observedAt = "1970-01-01T00:00:00.000Z"): SaveObserver {
  return {
    id: OFFLINE_OBSERVER_ID,
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
   * Set only by contract tests, which need the gate to admit an `offline` observer so they
   * can exercise the other checks. A production caller MUST NOT set it: `offline` hashes
   * whatever it is handed, so a caller supplying both the bytes and the observation would be
   * vouching for itself — the recipe this gate exists to reject.
   */
  readonly allowOfflineObserver?: true;
  /** The hidden fixtures the run claims to have used. */
  readonly hiddenFixtures: readonly HiddenFixture[];
  /** The fixture hash the run claims. The gate resolves the fixture from this. */
  readonly claimedFixtureHash: string;
  /** Whether the screen reading came from the observer rather than the arm. */
  readonly screenObserved: boolean;
  /**
   * The row this attestation is FOR: the arm, task, prompt and planner the evidence
   * describes, plus a digest of the bundle being scored. Without it an attestation from one
   * bundle marked a different bundle eligible — evidence not tied to the thing it is
   * evidence of, which is the same defect class as a fabricated observer (TIF-125).
   */
  readonly bundle?: AttestedBundle;
}

/** Identity of the row an attestation covers. The digest covers the scored bytes. */
export interface AttestedBundle {
  readonly armId: string;
  readonly taskId: string;
  readonly promptHash: string;
  /** SHA-256 over the persisted files being scored. Binds the attestation to this bundle. */
  readonly bundleDigest: string;
}

/**
 * A digest of the persisted files, order-independent so a caller cannot be rejected for
 * building the map in a different order. This is the value the attestation is bound to.
 */
export function bundleDigest(files: Readonly<Record<string, Uint8Array>>): string {
  const entries = Object.entries(files)
    .map(([path, bytes]) => `${path}:${createHash("sha256").update(bytes).digest("hex")}`)
    .sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

const attestedBrand: unique symbol = Symbol("myco.attestation");

/**
 * KNOWN LIMIT (TIF-115) — the brand is forgeable in-process, and no fix inside this file
 * can close it.
 *
 * `attestedBrand` is an own symbol property of every attestation, and
 * `Object.getOwnPropertySymbols` is public API. A caller holding any real attestation can
 * copy the symbol onto a fresh `{ eligible: true }`, and `isAttestation` accepts it.
 * Nothing inside the process can distinguish a copied symbol from one this module set.
 *
 * Concretely: the gate raises the bar from "hardcoded false" to "you must already hold a
 * real attestation to forge one", and it refuses every forgery that does not. It is not a
 * sandbox. The fix is to run the gate out of the arm's process (TIF-115); until then the
 * boundary this file provides is a boundary, not isolation, and the exploit is recorded
 * rather than papered over.
 */

/**
 * Runtime counterpart to the brand. The type system stops a typed caller; this stops an
 * untyped one, which is the boundary the scorer actually owns.
 */
export function isAttestation(value: unknown): value is Attestation {
  // A Proxy whose `get` trap throws must not escape: the brand read is the first thing the
  // scorer does, and a throw there aborts the whole comparison batch (R6 round 2, finding 3).
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<symbol, unknown>)[attestedBrand] === true
    );
  } catch {
    return false;
  }
}

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
  /**
   * The row this attestation covers, so the scorer can re-derive the digest itself rather
   * than trusting `eligible` (R6 1a). `null` when the caller supplied no binding.
   */
  readonly binding: AttestedBundle | null;
}

/**
 * Decides whether a run may be decision-eligible.
 *
 * Strict by construction: an empty blocker list is the only path to `eligible: true`, and
 * every check below can only add a blocker. There is no "assume fine" branch.
 */
/**
 * The committed commitment, found by walking up from this module rather than by counting
 * `..` segments. Counting breaks under `tsc`: the compiled module sits one level deeper
 * (`dist/src/foundry/grader/`), so a fixed depth resolves to `dist/foundry/…` and every
 * compiled row is silently refused. Walking up finds the repo root in both layouts.
 *
 * A caller-supplied path is not a commitment: it lets a caller write a file that vouches
 * for a set they also wrote. So this is not an option.
 */
function findCommittedCommitment(): string | null {
  let dir = import.meta.dirname;
  for (;;) {
    const candidate = join(dir, "foundry", "hidden-commitment.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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

/**
 * Reads one field off a possibly-malformed input. `attest` must never throw: a gate that
 * crashes on bad input is a gate an arm can disable by sending bad input.
 */
function field<T>(input: unknown, key: string, fallback: T): T {
  if (!input || typeof input !== "object" || !(key in input)) return fallback;
  const value = (input as Record<string, unknown>)[key];
  return (value === undefined ? fallback : value) as T;
}

/**
 * Snapshot a caller-supplied binding into frozen primitives, or `null` when it is absent or
 * unreadable. Reading a hostile Proxy here is caught, so a trap cannot escape as a throw.
 */
function freezeBinding(bundle: AttestedBundle | undefined): AttestedBundle | null {
  if (bundle === null || typeof bundle !== "object") return null;
  try {
    const { armId, taskId, promptHash, bundleDigest: digest } = bundle;
    if (
      typeof armId !== "string" ||
      typeof taskId !== "string" ||
      typeof promptHash !== "string" ||
      typeof digest !== "string"
    )
      return null;
    return Object.freeze({ armId, taskId, promptHash, bundleDigest: digest });
  } catch {
    return null;
  }
}

/**
 * Snapshot the final file map into plain data, reading every field exactly once.
 *
 * `supplied` is carried out with the copy so the "was anything supplied" check does not need
 * a second read of the caller's object (round 2, finding 3).
 */
function snapshotFiles(value: unknown): { files: Record<string, unknown>; supplied: boolean } {
  if (value === null || typeof value !== "object") return { files: {}, supplied: false };
  try {
    const copy: unknown = structuredClone(value);
    return copy !== null && typeof copy === "object"
      ? { files: copy as Record<string, unknown>, supplied: true }
      : { files: {}, supplied: false };
  } catch {
    return { files: {}, supplied: false };
  }
}

/** Copy the caller's evidence into plain data, reading every field exactly once. */
function snapshotEvidence(value: unknown): RecordedTrialEvidence | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try {
    return structuredClone(value) as RecordedTrialEvidence;
  } catch {
    return undefined;
  }
}

/** Copy the caller's trace into plain data, reading every field exactly once. */
function snapshotTrace(value: unknown): readonly GuardTraceEvent[] {
  if (!Array.isArray(value)) return [];
  try {
    const copy: unknown = structuredClone(value);
    return Array.isArray(copy) ? (copy as GuardTraceEvent[]) : [];
  } catch {
    return [];
  }
}

/** Read one string field, once. */
function readStringField(input: unknown, key: string): string {
  try {
    const value = (input as Record<string, unknown> | null | undefined)?.[key];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** Read one observation into frozen primitives, or `null` when it is not one. */
function readObservation(value: unknown): SaveObservation | null {
  if (value === null || typeof value !== "object") return null;
  try {
    const { path, sha256, bytes, observedAt, afterLastSave } = value as SaveObservation;
    if (
      typeof path !== "string" ||
      typeof sha256 !== "string" ||
      typeof bytes !== "number" ||
      typeof observedAt !== "string" ||
      typeof afterLastSave !== "boolean"
    )
      return null;
    return Object.freeze({ path, sha256, bytes, observedAt, afterLastSave });
  } catch {
    return null;
  }
}

/** Snapshot the caller's observations, reading every field exactly once. */
function snapshotObservations(value: unknown): readonly SaveObservation[] | null {
  if (!Array.isArray(value)) return null;
  try {
    const out: SaveObservation[] = [];
    for (const entry of value) {
      const observation = readObservation(entry);
      if (observation === null) return null;
      out.push(observation);
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

/**
 * Copy the caller's hidden set into plain data, reading every field exactly once.
 *
 * `Array.isArray` is true for a Proxy, and a getter can answer differently on each read, so
 * the set must be snapshotted before any check uses it. A set that cannot be copied is not
 * a set.
 */
function snapshotFixtures(value: unknown): readonly HiddenFixture[] | null {
  if (!Array.isArray(value)) return null;
  try {
    const copy: unknown = structuredClone(value);
    return Array.isArray(copy) ? (copy as HiddenFixture[]) : null;
  } catch {
    return null;
  }
}

export function attest(input: AttestInput): Attestation {
  // Any throw becomes a blocker. The body below still guards its own fields for a precise
  // message; this is the backstop that makes "never throws" a property rather than a claim.
  try {
    return attestOrRefuse(input);
  } catch {
    // The backstop must not touch `input` either: reading a hostile Proxy's fields here
    // would throw again from inside the handler and defeat the whole property (R6 3).
    return Object.freeze({
      [attestedBrand]: true as const,
      eligible: false,
      blockers: Object.freeze([
        "input: malformed, could not be evaluated (the input could not be read)",
      ]),
      observerId: "(unreadable)",
      accepted: Object.freeze([]),
      screenConstrained: false,
      unexpectedFiles: Object.freeze([]),
      resolvedFixtureId: null,
      binding: null,
    });
  }
}

function attestOrRefuse(input: AttestInput): Attestation {
  const blockers: string[] = [];
  // Snapshot EVERY caller field exactly once, at entry. Each of these was read more than
  // once — `evidence.taskId` three times, `claimedFixtureHash` twice, `observerId` three
  // times, `trace` three times — so a getter could answer honestly for one check and
  // dishonestly for another (round 3, finding 3). structuredClone reads each field once and
  // yields plain data; a value that cannot be copied is treated as absent, which fails
  // closed.
  const evidence = snapshotEvidence(field<unknown>(input, "evidence", undefined));
  const claimedHash = readStringField(input, "claimedFixtureHash");
  const observerId = safeObserverId(input);
  const trace = snapshotTrace(field<unknown>(input, "trace", undefined));

  // Option 1: the fixture is resolved from the commitment, never taken from the caller.
  // A caller-supplied fixture could keep the real id and name a benign file; a fixture
  // resolved from a commitment-verified set cannot.
  // The trusted commitment is READ FROM THE COMMITTED FILE, never taken from the caller.
  // A caller-supplied commitment is not a commitment: it would let a forged set vouch for
  // itself, which is the hole this option exists to close.
  const commitmentPath = findCommittedCommitment();
  const trusted = commitmentPath === null ? null : readTrustedCommitment(commitmentPath);
  // Snapshot ONCE. The set was read at the commitment check, at the resolve, and again for
  // taskFixtureId and persistenceFiles; a Proxy array or a getter could answer differently
  // each time, admitting a fixture that is not in the commitment (R6 round 2, finding 1).
  // structuredClone reads every field exactly once and yields plain data.
  const hiddenFixtures = snapshotFixtures(input.hiddenFixtures);
  if (hiddenFixtures === null) {
    blockers.push("hidden fixtures: none supplied, so no fixture can be resolved");
  }
  const supplied = hiddenFixtures === null ? null : commitment(hiddenFixtures);
  if (trusted === null) {
    blockers.push("commitment: the committed commitment could not be read");
  } else if (
    supplied !== null &&
    (supplied.rootHash !== trusted.rootHash ||
      supplied.count !== trusted.count ||
      supplied.hiddenSplitVersion !== trusted.hiddenSplitVersion)
  ) {
    blockers.push("commitment: the supplied hidden set does not match the committed commitment");
  }

  const resolved = (hiddenFixtures ?? []).find(
    (candidate) => fixtureHash(candidate) === claimedHash,
  );
  if (resolved === undefined)
    blockers.push(`commitment: no hidden fixture hashes to ${claimedHash.slice(0, 12)}…`);

  // The required set is the resolved fixture's own list. Files the app wrote beyond it (a
  // log, a sidecar) are reported but not required to be observed: demanding an observation
  // for every file in the final state refuses honest runs, which is a worse failure than
  // the one it would prevent.
  // Every field a caller supplies is guarded: a gate that throws on malformed input is one
  // an arm can disable by sending malformed input.
  // Snapshot ONCE. `finalFiles` was read five times and each entry twice, so a getter could
  // show different bytes to different checks (round 1, finding 3).
  const finalState = snapshotFiles(input.finalFiles);
  const rawFiles: Record<string, unknown> = finalState.files;
  // A string where bytes belong is not persisted state. Accepting it let a caller pass
  // "content" and have the gate digest it as though it were a file.
  const malformed = Object.entries(rawFiles)
    .filter(([, bytes]) => !(bytes instanceof Uint8Array))
    .map(([path]) => path);
  if (malformed.length > 0)
    blockers.push(`final state: ${malformed.join(", ")} is not a byte array`);
  const safeFinalFiles: Readonly<Record<string, Uint8Array>> = Object.fromEntries(
    Object.entries(rawFiles).filter(([, bytes]) => bytes instanceof Uint8Array),
  ) as Record<string, Uint8Array>;
  if (!finalState.supplied)
    blockers.push("final state: none supplied, so no observation can be matched against it");
  // Snapshot ONCE, type-checked. The loop below used to read the caller's object at the
  // check and again to build the frozen copy, so a getter could answer honestly for the
  // check and dishonestly for the copy (round 1, finding 1).
  const safeObservations = snapshotObservations(input.observations);
  if (safeObservations === null)
    blockers.push("observations: none supplied, so nothing can be attested");

  // The fixture resolved from the commitment must be the fixture of the row being scored.
  // Round 5 showed the gate resolving f26bcd… while the scorer graded a different task
  // fixture, so the commitment evidence was about something else entirely.
  // Mandatory (R6 1d): an absent fixtureId used to skip the check entirely, and every real
  // row omitted it, so the binding never ran in production.
  //
  // The comparison is task-fixture to task-fixture. A hidden fixture's `fixtureId` is its
  // task fixture's id; the hidden fixture's own hash is `claimedFixtureHash`. Comparing the
  // hidden hash against a task fixture id refused the honest value and accepted any hidden
  // fixture for the same task.
  if (evidence?.fixtureId === undefined || evidence.fixtureId === "")
    blockers.push("binding: the row does not name the fixture it was run against");
  else {
    // The row's fixture must be the fixture of the task it claims. This is the check that
    // is NOT circular: `findTask` is the registry, and the caller does not write it. Without
    // it, a caller who claims a foreign hidden fixture consistently — fixtureId, fixtureHash
    // and claimedFixtureHash all matching each other — is admitted, because every other
    // comparison here is between two values the caller supplied (R6 round 2, finding 1).
    const claimedTask = typeof evidence.taskId === "string" ? findTask(evidence.taskId) : undefined;
    if (claimedTask === undefined)
      blockers.push(`binding: the row names no known task (${String(evidence.taskId)})`);
    else if (claimedTask.fixtureId !== evidence.fixtureId)
      blockers.push(
        `binding: task ${claimedTask.taskId} is fixture ${claimedTask.fixtureId}, the row scores ${evidence.fixtureId}`,
      );
    else if (resolved !== undefined && resolved.taskFixtureId !== claimedTask.fixtureId)
      blockers.push(
        `binding: the commitment resolves the fixture for ${resolved.taskFixtureId}, the task is ${claimedTask.fixtureId}`,
      );
  }
  if (evidence?.fixtureHash === undefined || evidence.fixtureHash === "")
    blockers.push("binding: the row does not name the fixture hash it was run against");
  else if (claimedHash !== evidence.fixtureHash)
    blockers.push("binding: the scored fixture hash differs from the attested one");

  const required: readonly string[] =
    resolved === undefined ? [] : [...new Set<string>(resolved.fixture.persistenceFiles)].sort();
  if (resolved !== undefined && required.length === 0)
    blockers.push(
      `fixture: ${resolved.fixture.fixtureId} designates no persistence files, so nothing can be attested`,
    );
  const unexpected = Object.keys(safeFinalFiles)
    .filter((path) => !required.includes(path))
    .sort();

  // 0. The attestation must name the row it is for, and the digest must match the bytes the
  //    gate just verified. Absent binding is a blocker, not a pass: an attestation that does
  //    not say what it attests cannot be evidence for anything.
  // Read the caller's binding exactly ONCE, into frozen primitives, and use that snapshot
  // for both this check and the returned attestation. Reading it twice let a getter answer
  // honestly for the gate and dishonestly for the scorer (R6 round 2, finding 3).
  const bundle = freezeBinding(input.bundle);
  if (bundle === null) {
    blockers.push("binding: the attestation does not name the row it is for");
  } else {
    if (bundle.armId !== evidence?.armId)
      blockers.push(`binding: attested arm ${bundle.armId}, scored ${evidence?.armId ?? "none"}`);
    if (bundle.taskId !== evidence?.taskId)
      blockers.push(
        `binding: attested task ${bundle.taskId}, scored ${evidence?.taskId ?? "none"}`,
      );
    if (bundle.promptHash !== evidence?.promptHash)
      blockers.push("binding: attested prompt differs from the scored prompt");
    const digest = bundleDigest(safeFinalFiles);
    if (bundle.bundleDigest !== digest)
      blockers.push("binding: the attested bundle digest does not match the scored bytes");
  }

  // 1. The recorder must be closed and internally consistent. An open or inconsistent
  //    recording means the arm's account of itself is incomplete.
  if (evidence === undefined) {
    blockers.push("recorder: no evidence supplied, so the arm's account of itself is missing");
  }
  if ((evidence?.recordedCalls ?? []).length !== evidence?.recordedCallCount)
    blockers.push("recorder: call count does not match the recorded calls");
  if ((evidence?.toolCallAudits ?? []).length !== (evidence?.recordedCalls ?? []).length)
    blockers.push("recorder: not every call has an audit");
  if ((evidence?.toolCallAudits ?? []).some((audit) => audit?.status !== "complete"))
    blockers.push("recorder: an audit is incomplete");
  // Cardinality is not identity: an audit must name a call that was actually recorded, on
  // the same channel. Without this a ghost audit satisfies the count.
  const recorded = new Map<string, string>();
  for (const call of evidence?.recordedCalls ?? []) {
    if (recorded.has(call.callId))
      blockers.push(`recorder: call ${call.callId} is recorded more than once`);
    else recorded.set(call.callId, call.via);
  }
  for (const audit of evidence?.toolCallAudits ?? []) {
    const via = recorded.get(audit.callId);
    if (via === undefined) blockers.push(`recorder: audit ${audit.callId} names no recorded call`);
    else if (via !== audit.via)
      blockers.push(`recorder: audit ${audit.callId} is ${audit.via}, recorded as ${via}`);
    if (audit.via !== "gui" && audit.accesses.length === 0)
      blockers.push(
        `recorder: ${audit.via} call ${audit.callId} reports no accesses, so a direct write cannot be ruled out`,
      );
  }
  if (evidence?.status !== "finished")
    blockers.push(`recorder: trial status is ${evidence?.status ?? "absent"}, not finished`);

  // 2. Every persistence file must have been observed, and the observation must match the
  //    final bytes. A missing observation is a blocker, never a pass.
  const accepted: SaveObservation[] = [];
  for (const path of required) {
    const observation = (safeObservations ?? []).find((candidate) => candidate.path === path);
    if (observation === undefined) {
      blockers.push(`observer: no observation of ${path}`);
      continue;
    }
    if (!observation.afterLastSave) {
      blockers.push(`observer: ${path} was read before the last save`);
      continue;
    }
    const bytes = safeFinalFiles[path];
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
    // `observation` is already the frozen snapshot, so the value checked above is the value
    // reported. No second read of the caller's object.
    accepted.push(observation);
  }

  // 3a. The observer must be one this gate can vouch for. Deny by default: `observerId` is
  //     a string the caller writes, so "refuse the literal offline" refuses nothing — the
  //     same fabrication with observerId "Offline" or "vm-guest" passed. Only an observer
  //     registered here, and only when it reports its own identity, counts.
  const registered = trustObservers(input, observerId);
  if (registered === null) {
    blockers.push(
      `observer: "${observerId}" is not a registered live observer; a caller cannot name its own provenance`,
    );
  } else if (registered.id !== observerId) {
    blockers.push("observer: the identity does not match the registered observer");
  }

  // 3b. The screen reading must come from the observer, not the arm. A caller-supplied
  //    visibleText is an unchecked claim, and it feeds the screen oracle.
  if (input.screenObserved !== true)
    blockers.push("screen: the reading was supplied by the arm, not observed");
  const screenValue: unknown = field<unknown>(input, "screen", undefined);
  // Read `visibleText` and `reachable` ONCE each, so the value checked is the value
  // reported (round 1, finding 4).
  const screenText: unknown =
    screenValue !== null && typeof screenValue === "object"
      ? (screenValue as { visibleText?: unknown }).visibleText
      : undefined;
  const screenReachable: unknown =
    screenValue !== null && typeof screenValue === "object"
      ? (screenValue as { reachable?: unknown }).reachable
      : undefined;
  const screenOk = Array.isArray(screenText) && typeof screenReachable === "boolean";
  if (!screenOk) blockers.push("screen: the reading is not a screen view");
  // A pixel arm legitimately reads no text (Tk exposes no AT-SPI node), so an empty screen
  // is not a blocker. It is reported through `screenConstrained` so a reader can tell
  // "the screen oracle had nothing to match" from "the screen oracle agreed".
  const safeScreen: ScreenView = screenOk
    ? { visibleText: screenText as string[], reachable: screenReachable as boolean }
    : { visibleText: [], reachable: false };
  const screenConstrained = safeScreen.reachable && safeScreen.visibleText.length > 0;

  // 4. The observation must be placeable against a save the trace actually recorded, and
  //    that save's bytes must agree with what the observer saw. Checking only the event
  //    type lets any fabricated event of the right shape satisfy the binding.
  const saves = trace.filter((event) => event.type === "save-observed");
  // A save the app did not perform is not a save. Require at least one GUI call, and
  // require the last save to follow a GUI action in the trace: bytes conjured out of band
  // with no act to explain them are the exact false success this gate exists to catch.
  const guiCalls = (evidence?.recordedCalls ?? []).filter((call) => call?.via === "gui");
  if (guiCalls.length === 0)
    blockers.push("recorder: no GUI call was recorded, so no save can be attributed to the app");
  if (saves.length === 0) {
    blockers.push("trace: no save was observed, so the observation cannot be placed");
  } else {
    const lastSaveIndex = trace.lastIndexOf(saves[saves.length - 1]!);
    const guiActBefore = trace
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

  return Object.freeze({
    [attestedBrand]: true as const,
    eligible: blockers.length === 0,
    // Freeze the arrays too: Object.freeze is shallow, so a caller could clear `blockers`
    // and break "empty iff eligible" (R6 round 3, finding 2).
    blockers: Object.freeze([...blockers]),
    observerId,
    accepted: Object.freeze([...accepted]),
    screenConstrained,
    unexpectedFiles: Object.freeze([...unexpected]),
    resolvedFixtureId: resolved?.fixture.fixtureId ?? null,
    // Copy the binding into frozen primitives. Returning the caller's own object let a
    // caller mutate it, or define a getter that answers honestly for the gate and
    // dishonestly for the scorer, after attest() had already said eligible (R6 round 2,
    // finding 3). A copy taken here cannot change afterwards.
    binding: bundle,
  });
}
