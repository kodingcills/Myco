/**
 * MOCK watermark decision (spec #589 §2.6, issue #666): a run is mock unless it has a verified
 * real-run record this module issued. Nothing in this stack issues one, so the watermark cannot
 * be dropped for an unverified run, whatever a caller passes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as trust from "../../src/watch/run-trust.ts";
import { runTrust, type VerifiedRealRun } from "../../src/watch/run-trust.ts";

const MOCK = { mock: true, watermark: "MOCK · NOT EVIDENCE" };

describe("runTrust: mock unless verified real", () => {
  it("rendered frames (the mock demo) are mock", () => {
    expect(runTrust({ runId: "r", frames: "rendered" })).toEqual(MOCK);
  });

  it("file frames with no verified record are mock", () => {
    expect(runTrust({ runId: "r", frames: "file" })).toEqual(MOCK);
    expect(runTrust({ runId: "r", frames: "file", verified: null })).toEqual(MOCK);
    expect(runTrust({ runId: "r", frames: "file", simulated: false })).toEqual(MOCK);
  });

  it("simulated: true is mock", () => {
    expect(runTrust({ runId: "r", frames: "file", simulated: true })).toEqual(MOCK);
  });

  it("refuses to drop the watermark for an unverified run: a hand-built record of the right shape", () => {
    for (const forged of [
      { runId: "r", transport: "vm", simulated: false },
      Object.freeze({ runId: "r", transport: "vm", simulated: false }),
      Object.create({ runId: "r", transport: "vm", simulated: false }),
    ]) {
      const verified = forged as unknown as VerifiedRealRun;
      expect(runTrust({ runId: "r", frames: "file", simulated: false, verified })).toEqual(MOCK);
    }
    expect(
      runTrust({ runId: "r", frames: "file", verified: "vm" as unknown as VerifiedRealRun }),
    ).toEqual(MOCK);
  });

  it("the module exports no issuer: nothing outside it can mint a verified record", () => {
    expect(Object.keys(trust).sort()).toEqual(
      ["ISOLATED_TRANSPORTS", "MOCK_BAND", "MOCK_WATERMARK", "runTrust"].sort(),
    );
    const text = readFileSync(
      resolve(import.meta.dirname, "..", "..", "src", "watch", "run-trust.ts"),
      "utf8",
    );
    // No code path adds to the registry yet (the sealed-capture opener of B6 will).
    expect(text).not.toMatch(/issued\.add\(/);
    expect(trust.ISOLATED_TRANSPORTS).toEqual(["vm"]);
  });

  it("no flag marks a run real: the origin type has no such field", () => {
    // A caller-side flag like `real: true` or `evidence: true` is not part of RunOrigin.
    const origin = { runId: "r", frames: "file" as const, real: true, evidence: true };
    expect(runTrust(origin)).toEqual(MOCK);
  });
});
