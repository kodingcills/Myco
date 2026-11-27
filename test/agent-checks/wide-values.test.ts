/**
 * Track C, #610 item 1: checks that lie only on out-of-grammar wrong values (the verifier's A4
 * and A5 on #590), or on any two-error document (A9), are refused by R5's wider draw. The
 * two-error and structural attacks, and what every case carries, are in
 * `wide-selftest.test.ts`; the split lets the sandboxed proposals run in parallel.
 */
import { afterAll, describe, it } from "vitest";
import { cleanupPlugins } from "./helpers.ts";
import { ATTACKS, type Attack, refusedNow, T } from "./wide-attacks.ts";

afterAll(cleanupPlugins);

describe("#610 item 1: checks that lie only on out-of-grammar values or two errors are refused", () => {
  for (const name of ["A4", "A5", "A9"]) {
    const a = ATTACKS[name] as Attack;
    it(
      `${name}, lies on ${a.what}: accepted by the single-error self-test; refused now`,
      () => refusedNow(a),
      T,
    );
  }
});
