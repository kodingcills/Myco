/**
 * TIF-274 / outer-loop ruling 2026-11-26 08:38Z in the M2 evidence pack: R1 counts all 100
 * fc-v1 trials. The 10 unregistrable (invalid-target) rows get their own line, are never
 * eligible, and the manifest asserts the gated/unregistrable split, so a short pack fails.
 * The 03:13Z eligibility rule for detection and false successes is unchanged.
 */
import { describe, expect, it } from "vitest";
import { checkPack, ineligibleCause, type PackResult } from "../../src/m2/evidence.ts";
import { input, manifest, refuted, type Trial, trial } from "./pack-fixture.ts";

const has = (r: PackResult, pattern: RegExp) => r.errors.some((e) => pattern.test(e));

/** An unregistrable invalid-target trial whose agent claims done on the untouched document. */
const unregistrable = (i: number): Trial =>
  trial(
    i,
    {
      faultClass: "invalid-target",
      gate: { called: false, verdict: null, unregistrable: true },
      accepted: false,
      cause: { kind: "oracle", detail: "unregistrable: the gate registry rejected the task spec" },
    },
    "fail",
    { faultLanded: true },
  );

/** fc-v1 shaped: 80 clean verified-pass, 10 kill-app refuted, 10 unregistrable. */
function fcV1(): Trial[] {
  const out: Trial[] = [];
  for (let i = 0; i < 80; i++) out.push(trial(i));
  for (let i = 80; i < 90; i++) out.push(refuted(i, { faultClass: "kill-app" }));
  for (let i = 90; i < 100; i++) out.push(unregistrable(i));
  return out;
}
const fcManifest = (over: Record<string, unknown> = {}) =>
  manifest({
    rows: ["R1"],
    expectTrials: { "myco-gate": 100 },
    expectUnregistrable: { "myco-gate": 10 },
    ...over,
  });

describe("R1 over all 100 fc-v1 trials (ruling 08:38Z)", () => {
  it("a 90-gated + 10-unregistrable pack passes, with the unregistrable rows on their own line", () => {
    const r = checkPack(input(fcV1(), fcManifest()));
    expect(r.errors).toEqual([]);
    expect(r.r1).toMatchObject({
      pass: true,
      trials: 90,
      counted: 100,
      allTrials: 100,
      unregistrable: { trials: 10, claimedDone: 10, graderFailClaimedDone: 10 },
      headline: { numerator: 0, denominator: 100 },
      accepted: 80,
      falseAcceptRate: { numerator: 0, denominator: 80 },
    });
    // Never eligible: their own cause, never folded into another.
    expect(r.r1?.ineligible.byCause).toEqual({ unregistrable: 10 });
  });

  it("the unregistrable line counts only DONE claims, and only grader fails among them", () => {
    const trials = fcV1();
    const nd = unregistrable(99);
    trials[99] = {
      ...nd,
      arm: { ...nd.arm, claim: "not-done" },
    };
    const r = checkPack(input(trials, fcManifest()));
    expect(r.errors).toEqual([]);
    expect(r.r1?.unregistrable).toEqual({ trials: 10, claimedDone: 9, graderFailClaimedDone: 9 });
  });

  it("a short pack fails: dropping the unregistrable rows cannot shrink the denominator", () => {
    const short = fcV1().slice(0, 90);
    const r = checkPack(input(short, fcManifest({ expectTrials: { "myco-gate": 90 } })));
    expect(r.r1?.pass).toBe(false);
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "myco-gate: 0 unregistrable trials, expected 10",
        "myco-gate: 90 gated trials, expected 80",
      ]),
    );
    // Relabelling the split to 0 still leaves R1 short of 100 counted trials.
    const relabel = checkPack(
      input(
        short,
        fcManifest({ expectTrials: { "myco-gate": 90 }, expectUnregistrable: { "myco-gate": 0 } }),
      ),
    );
    expect(relabel.errors).toEqual([]);
    expect(relabel.r1?.pass).toBe(false);
    expect(relabel.r1?.reasons).toContain(
      "90 trials counted toward R1 (90 eligible gated + 0 unregistrable), fewer than 100",
    );
  });

  it("a pack missing one gated trial fails the gated count", () => {
    const r = checkPack(input(fcV1().slice(1), fcManifest()));
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "ledger: myco-gate: 99 trials, expected 100",
        "myco-gate: 89 gated trials, expected 90",
      ]),
    );
    expect(r.r1?.pass).toBe(false);
  });

  it("R1 evidence needs the split; a split must add up and name only myco-gate", () => {
    const { expectUnregistrable: _drop, ...noSplit } = fcManifest();
    const missing = checkPack(input(fcV1(), noSplit));
    expect(has(missing, /R1 needs expectUnregistrable\["myco-gate"\]/)).toBe(true);
    expect(missing.r1?.pass).toBe(false);
    expect(
      has(
        checkPack(input(fcV1(), fcManifest({ expectUnregistrable: { "myco-gate": 101 } }))),
        /expectUnregistrable 101 exceeds expectTrials 100/,
      ),
    ).toBe(true);
    expect(
      has(
        checkPack(input(fcV1(), fcManifest({ expectUnregistrable: { "myco-gate": 9 } }))),
        /10 unregistrable trials, expected 9/,
      ),
    ).toBe(true);
    // The manifest schema is closed: no split for hcu+shell.
    expect(
      has(
        checkPack(
          input(fcV1(), fcManifest({ expectUnregistrable: { "myco-gate": 10, "hcu+shell": 0 } })),
        ),
        /expectUnregistrable/,
      ),
    ).toBe(true);
  });

  it("a non-R1 pack with unregistrable rows still needs the split", () => {
    const { expectUnregistrable: _drop, ...m } = manifest({
      rows: ["R3"],
      expectTrials: { "myco-gate": 100 },
    });
    const r = checkPack(input(fcV1(), m));
    expect(has(r, /10 unregistrable myco-gate trial\(s\) but no expectUnregistrable/)).toBe(true);
  });

  it("detection and false successes keep the 03:13Z rule: unregistrable rows are never eligible", () => {
    const u = unregistrable(0);
    expect(ineligibleCause(u.arm, u.ops)).toBe("unregistrable");
    const r = checkPack(input(fcV1(), fcManifest({ rows: ["R1", "R3"] })));
    // R3's eligible faulted trials are the 10 refuted kill-app ones only.
    expect(r.r3?.eligible).toBe(10);
    expect(r.r3?.ineligible.byCause).toEqual({ unregistrable: 10 });
    expect(r.r3?.classes.find((c) => c.faultClass === "invalid-target")).toBeUndefined();
  });
});
