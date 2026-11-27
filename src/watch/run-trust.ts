/**
 * Replay and export (spec #589 §2.6): is a run mock? Every view and export of a mock run is
 * watermarked `MOCK · NOT EVIDENCE` and machine-marked `mock: true`.
 *
 * Mock is decided by where the run came from, never by a flag a caller passes. A run is
 * mock when any of these holds:
 *  - its frames were drawn in this process (provenance `rendered`, the mock demo);
 *  - its episode or bundle header says `simulated: true` (or does not say `false`);
 *  - it has no verified real-run record.
 *
 * A verified real-run record (`VerifiedRealRun`) is the only thing that can turn the
 * watermark off. It is a branded object that this module registers when it issues one, and
 * a run counts as real only when its record is one this module registered. This module
 * exports no issuer: the only producer will be the sealed-capture opener of build PR B6
 * (`openSealedTimeline`, receipt-bound, after the vault checks the seal, the capture hashes
 * and a sealed `myco.run-provenance/1` with an isolated transport and `simulated: false`).
 * Until that lands, every run is mock. A hand-built object of the same shape is not
 * registered, so it never drops the watermark (`test/watch/run-trust.test.ts`).
 *
 * The later real-run path is this same code: the watermark comes off only for a run whose
 * record this module issued.
 */
import { isSafeId } from "../gate/api.ts";

/** Transports whose trials are counted (§2.6): the agent ran in a guest. `vm` only. */
export const ISOLATED_TRANSPORTS: readonly string[] = ["vm"];

declare const VERIFIED: unique symbol;

/** A sealed, verified real run. No exported constructor; see the module comment. */
export interface VerifiedRealRun {
  readonly [VERIFIED]: true;
  readonly runId: string;
  readonly transport: string;
  readonly simulated: false;
}

/** Records this module issued. A record not in here is never trusted, whatever its shape. */
const issued = new WeakSet<object>();

/** The fixed watermark text, burned into every frame of a mock run. */
export const MOCK_WATERMARK = "MOCK";
export const MOCK_BAND = "MOCK · NOT EVIDENCE";

export interface RunOrigin {
  readonly runId: string;
  /** Where the run's frames come from: `rendered` (drawn in this process) or `file`. */
  readonly frames: "file" | "rendered";
  /** The run's episode or bundle header `simulated` flag, if one was given. */
  readonly simulated?: boolean;
  /** The run's verified real-run record, if any. */
  readonly verified?: VerifiedRealRun | null;
}

export interface RunTrust {
  /** True unless every check below passes. Machine mark for metadata. */
  readonly mock: boolean;
  /** The watermark to draw: `MOCK · NOT EVIDENCE` for a mock run, null only for a real one. */
  readonly watermark: typeof MOCK_BAND | null;
}

const MOCK: RunTrust = Object.freeze({ mock: true, watermark: MOCK_BAND });
const REAL: RunTrust = Object.freeze({ mock: false, watermark: null });

/** Decide a run's trust from its origin. Total; anything unexpected is mock. */
export function runTrust(origin: RunOrigin): RunTrust {
  const record = origin.verified;
  if (origin.frames !== "file") return MOCK;
  if (origin.simulated === true) return MOCK;
  if (record === undefined || record === null || typeof record !== "object") return MOCK;
  if (!issued.has(record)) return MOCK;
  if (!isSafeId(origin.runId) || record.runId !== origin.runId) return MOCK;
  if (!ISOLATED_TRANSPORTS.includes(record.transport) || record.simulated !== false) return MOCK;
  return REAL;
}
