/**
 * Oracle mutation self-test (M2-09 / R5), part 1: the shared vocabulary.
 *
 * R5: "Every oracle (Calc, multi-step Calc, Writer) fails >= 1 seeded corruption per class
 * it claims. Agent-written oracles go through the same mutation self-test." So an oracle is
 * plugged in as a value: a function from (saved document, intent) to a three-valued verdict,
 * plus the corruption classes it claims to catch. Hand-written oracles and, later,
 * agent-written ones are judged by the same runner and the same bar.
 */
import type { VerdictStatus } from "../core/verify.ts";

/**
 * Seeded corruption classes. Each is built from a CORRECT saved document of the same case,
 * so a class tests one property of the oracle and nothing else.
 *
 * Value classes (the file is read in full; the postcondition provably fails, `refuted`):
 *  - `edit-missing`: the document as it was before the edit (a save that never happened);
 *  - `wrong-value`: the target holds a different value;
 *  - `wrong-target`: the right value was written to a neighbouring target;
 *  - `collateral`: the target is right but other content changed.
 * Read classes (the oracle cannot look; it must say so, `uncertain`):
 *  - `truncated`: the saved bytes cut short;
 *  - `corrupt-byte`: one byte flipped inside the container;
 *  - `partial-save`: a valid container whose main part holds only part of the document;
 *  - `missing-main-part`: a valid container with no document body;
 *  - `missing-file`: nothing was saved at the path.
 */
export const CORRUPTION_CLASSES = [
  "edit-missing",
  "wrong-value",
  "wrong-target",
  "collateral",
  "truncated",
  "corrupt-byte",
  "partial-save",
  "missing-main-part",
  "missing-file",
] as const;
export type CorruptionClass = (typeof CORRUPTION_CLASSES)[number];

/** The verdict a corruption of each class should produce. Anything but `verified` is a catch. */
export const EXPECTED_STATUS: Readonly<
  Record<CorruptionClass, Exclude<VerdictStatus, "verified">>
> = {
  "edit-missing": "refuted",
  "wrong-value": "refuted",
  "wrong-target": "refuted",
  collateral: "refuted",
  truncated: "uncertain",
  "corrupt-byte": "uncertain",
  "partial-save": "uncertain",
  "missing-main-part": "uncertain",
  "missing-file": "uncertain",
};

/**
 * A host-side random source: a uniform integer in `[0, n)` (`node:crypto` `randomInt`). Track C
 * draws its self-test corruptions from one so a check's author cannot compute them in advance.
 */
export type Draw = (n: number) => number;

/** A saved document handed to an oracle: its bytes, or null when nothing was saved. */
export interface SavedDocument {
  readonly fileName: string;
  readonly bytes: Uint8Array | null;
}

export interface OracleVerdict {
  readonly status: VerdictStatus;
  /** A short machine-readable code when the oracle has one, else a short reason. */
  readonly code: string;
}

/** One self-test case: an intent, its correct saved document, and its seeded corruptions. */
export interface SelfTestCase<Intent> {
  readonly id: string;
  readonly intent: Intent;
  readonly correct: SavedDocument;
  readonly corruptions: ReadonlyArray<{
    readonly cls: CorruptionClass;
    readonly doc: SavedDocument;
  }>;
}

/** An oracle under test. `verify` must never throw; a throw is recorded as a harness fault. */
export interface OracleUnderTest<Intent> {
  readonly name: string;
  readonly version: string;
  /** Classes this oracle claims to catch. Unclaimed classes are still run and reported. */
  readonly claims: ReadonlySet<CorruptionClass>;
  verify(doc: SavedDocument, intent: Intent): OracleVerdict;
}
