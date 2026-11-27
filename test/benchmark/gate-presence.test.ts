/**
 * #649 item 1: two consistency checks in `checkBenchmark` were keyed on `row.arm === "myco-gate"`,
 * so gated capability rows (C1+K, gated C1, C1+P, hcu+shell+V) skipped them:
 *  - "an invalid-target task cannot be gated";
 *  - "an accepted gated row must carry its captured bytes' sha256".
 * They now key on gate presence: a myco-gate row always (unchanged), and any row carrying a gate
 * record. Gate-less rows (hcu+shell, gate-less capability rows) are unchanged.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITY_ARMS } from "../../schemas/benchmark-ledger.ts";
import { checkBenchmark, expectedAccepted, type LedgerArmRow } from "../../src/benchmark/check.ts";

const H = (c: string) => c.repeat(64);
const INVALID = /an invalid-target task cannot be gated/;
const NO_SHA = /an accepted gated row must carry its captured bytes' sha256/;
const NO_GATE = /myco-gate row has no gate record/;

/** The gated capability rows #649 names. */
const GATED_ARMS = ["C1+K", "C1", "C1+P", "hcu+shell+V"] as const;

function row(over: Partial<LedgerArmRow>): LedgerArmRow {
  const base: LedgerArmRow = {
    schema: "myco.benchmark.arm-row/1",
    taskSetVersion: "cap-plumbing",
    arm: "C1+K",
    trialKey: "k",
    taskId: "task-k",
    faultClass: "none",
    fixtureSha256: H("a"),
    instructionSha256: H("b"),
    plannerModelId: "claude-sonnet-5-5",
    outputCeiling: null,
    claim: "done",
    gate: { called: true, verdict: "verified" },
    accepted: true,
    persistedSha256: H("c"),
    cause: null,
    cost: { modelUsd: 0.5, wallClockS: null, vmS: null },
  };
  const merged = { ...base, ...over };
  return { ...merged, accepted: over.accepted ?? expectedAccepted(merged) };
}

/** The errors one row produces (no grade rows: only the per-row checks are read). */
const errorsOf = (r: LedgerArmRow) =>
  checkBenchmark([r], [], { expectTrials: { [r.arm]: 1 } }).errors.filter(
    (e) => e.startsWith(`${r.trialKey}:`) && !e.endsWith("no grade row"),
  );

describe("#649 item 1: an accepted gated capability row must carry its captured bytes' sha256", () => {
  it("refuses it for every gated capability arm #649 names (the probe: C1+K, null sha)", () => {
    for (const arm of GATED_ARMS)
      expect(errorsOf(row({ arm, persistedSha256: null })), arm).toEqual([
        "k: an accepted gated row must carry its captured bytes' sha256",
      ]);
  });

  it("refuses it for every capability arm that carries a gate record", () => {
    for (const arm of CAPABILITY_ARMS)
      expect(
        errorsOf(row({ arm, persistedSha256: null })).some((e) => NO_SHA.test(e)),
        arm,
      ).toBe(true);
  });

  it("a gated row that was not accepted, or that carries its sha, is fine", () => {
    for (const arm of GATED_ARMS) {
      expect(errorsOf(row({ arm })), arm).toEqual([]);
      const refused = row({
        arm,
        gate: { called: true, verdict: "refuted" },
        persistedSha256: null,
      });
      expect(refused.accepted).toBe(false);
      expect(errorsOf(refused), arm).toEqual([]);
    }
  });

  it("a gate-less capability row is unchanged: accepted with no sha gives no such error", () => {
    for (const arm of CAPABILITY_ARMS) {
      const r = row({ arm, gate: null, persistedSha256: null });
      expect(r.accepted).toBe(true);
      expect(errorsOf(r), arm).toEqual([]);
    }
  });
});

describe("#649 item 1: an invalid-target task cannot be gated, on capability rows too", () => {
  it("refuses a gated capability row on an invalid-target task", () => {
    for (const arm of GATED_ARMS)
      expect(errorsOf(row({ arm, faultClass: "invalid-target" })), arm).toEqual([
        "k: an invalid-target task cannot be gated (it is unregistrable)",
      ]);
    for (const arm of CAPABILITY_ARMS)
      expect(
        errorsOf(row({ arm, faultClass: "invalid-target" })).some((e) => INVALID.test(e)),
        arm,
      ).toBe(true);
  });

  it("an unregistrable gate record on an invalid-target task is fine", () => {
    for (const arm of GATED_ARMS)
      expect(
        errorsOf(
          row({
            arm,
            faultClass: "invalid-target",
            gate: { called: false, verdict: null, unregistrable: true },
          }),
        ),
        arm,
      ).toEqual([]);
  });

  it("a gate-less capability row on an invalid-target task is unchanged (no gate, nothing to refuse)", () => {
    for (const arm of CAPABILITY_ARMS)
      expect(errorsOf(row({ arm, gate: null, faultClass: "invalid-target" })), arm).toEqual([]);
  });
});

describe("#649 item 1: myco-gate and hcu+shell rows are unchanged", () => {
  it("myco-gate: both checks fire as before, including on a row with no gate record", () => {
    expect(errorsOf(row({ arm: "myco-gate", persistedSha256: null }))).toEqual([
      "k: an accepted gated row must carry its captured bytes' sha256",
    ]);
    expect(errorsOf(row({ arm: "myco-gate", faultClass: "invalid-target" }))).toEqual([
      "k: an invalid-target task cannot be gated (it is unregistrable)",
    ]);
    // A myco-gate row with no gate record on an invalid-target task: both errors, as before.
    const bare = errorsOf(row({ arm: "myco-gate", gate: null, faultClass: "invalid-target" }));
    expect(bare.some((e) => NO_GATE.test(e))).toBe(true);
    expect(bare.some((e) => INVALID.test(e))).toBe(true);
    expect(
      errorsOf(
        row({
          arm: "myco-gate",
          faultClass: "invalid-target",
          gate: { called: false, verdict: null, unregistrable: true },
        }),
      ),
    ).toEqual([]);
  });

  it("hcu+shell: no gate record, so neither check applies (accepted with no sha, invalid-target)", () => {
    const r = row({
      arm: "hcu+shell",
      gate: null,
      persistedSha256: null,
      faultClass: "invalid-target",
    });
    expect(r.accepted).toBe(true);
    expect(errorsOf(r)).toEqual([]);
  });
});
