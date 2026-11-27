/**
 * Track Q, #562 D1 (from #553's final verdict): the HOST's identity is always in the guard.
 * In #553 an identity passed to `exportProofBundle` REPLACED the host's, so fake host facts
 * (or an empty identity) let the real account name and hostname out verbatim. Here the
 * CURRENT host's real account name and hostname (read at test time, never printed: every
 * check is a boolean) are planted into every input field, and every write path is called
 * with fake host facts and with an empty identity. Each must still digest them.
 *
 * On CI the account name is the generic `runner`; `host-merge-mocked.test.ts` repeats the
 * check with `node:os` mocked to a non-generic account and a `<name>-MacBook-Pro.local` host.
 */
import { hostname, userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { validateEpisode } from "../../src/episode/validate.ts";
import {
  assembleProofBundle,
  exportProofBundle,
  type ProofRunInput,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { CLOSED_ID, hashedId } from "../../src/proof/closed.ts";
import type { IdentityContext } from "../../src/proof/identity.ts";
import * as identityModule from "../../src/proof/identity.ts";
import { clone, NO_CTX, rechain, sampleRun } from "./fixture.ts";
import { carriesIdentity } from "./identity-check.ts";
import { plantEverywhere, withoutEpisode } from "./plant.ts";

const HOST_USER = (() => {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
})();
const HOST_NAME = hostname();
const HOST_LABEL = HOST_NAME.split(".")[0] ?? "";

/** Fake host facts: synthetic names a caller might pass, none of them this host's. */
const FAKE: IdentityContext = {
  names: ["zqfakeacct", "zqfakehost"],
  homes: ["/home/zqfakeacct"],
};
const EMPTY: IdentityContext = { names: [], homes: [] };

const NEEDLES = [HOST_USER, HOST_NAME, HOST_LABEL].filter((s) => s.length > 0);

/** Planted values derived from this host's identity (labels never carry a value). */
const PLANTS: ReadonlyArray<readonly [string, string]> = (
  [
    ["account name", HOST_USER],
    ["account name, upper case", HOST_USER.toUpperCase()],
    ["account name in an id", `${HOST_USER}_trial`],
    ["account name in a token", `run-${HOST_USER}-1`],
    ["hostname", HOST_NAME],
    ["hostname, upper case", HOST_NAME.toUpperCase()],
    ["hostname label in an id", `run-${HOST_LABEL}-1`],
  ] as const
).filter(([, v]) => v.length > 0 && CLOSED_ID.test(v));

const runFor = (value: string): ProofRunInput => {
  const run = plantEverywhere(value);
  return run.episode !== undefined && validateEpisode(run.episode).length > 0
    ? withoutEpisode(run)
    : run;
};
const NEUTRAL = runFor("zq-neutral-value");

describe("D1: a caller's identity is merged with the host's, never used instead of it", () => {
  it("there is something to test: the host's identity yields closed-id plants", () => {
    expect(NEEDLES.length > 0).toBe(true);
    expect(PLANTS.length > 0).toBe(true);
  });

  it("NO_IDENTITY is no longer exported (no 'no identity' argument exists)", () => {
    expect("NO_IDENTITY" in identityModule).toBe(false);
  });

  const writers: ReadonlyArray<
    readonly [string, (run: ProofRunInput) => ReturnType<typeof exportProofBundle>]
  > = [
    ["export, fake host facts", (r) => exportProofBundle(r, NO_CTX, FAKE)],
    ["export, empty identity", (r) => exportProofBundle(r, NO_CTX, EMPTY)],
    ["export, no identity", (r) => exportProofBundle(r, NO_CTX)],
    ["assemble, fake host facts", (r) => assembleProofBundle(r, FAKE)],
    ["assemble, empty identity", (r) => assembleProofBundle(r, EMPTY)],
    ["assemble, no identity", (r) => assembleProofBundle(r)],
  ];

  for (const [mode, write] of writers) {
    it(`${mode}: the host's real account name and hostname are digested in every field`, () => {
      const neutral = write(NEUTRAL);
      for (const [label, value] of PLANTS) {
        const b = write(runFor(value));
        // Booleans only: whether the value went out as is, never the value.
        expect(b.run.runId === value, `${label}: run.runId`).toBe(false);
        expect(b.run.runId === hashedId(value), `${label}: run.runId hashed`).toBe(true);
        expect(carriesIdentity(b, neutral, NEEDLES), `${label}: structural`).toBe(false);
      }
    });
  }

  it("verify with fake host facts or an empty identity still refuses the host's name", () => {
    const honest = exportProofBundle(sampleRun(), NO_CTX);
    for (const [label, value] of PLANTS) {
      const b = clone(honest);
      (b.records[0]?.body as { policyId: string }).policyId = value;
      const text = serializeProofBundle(rechain(b));
      for (const identity of [FAKE, EMPTY]) {
        const r = verifyProofBundle(text, { identity });
        expect(r.ok, label).toBe(false);
        expect(
          r.errors.map((e) => e.code),
          label,
        ).toEqual(["PROOF_IDENTITY"]);
      }
    }
  });
});
