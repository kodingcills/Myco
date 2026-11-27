/**
 * Track Q, #562 D1, with `node:os` MOCKED: a non-generic account name and a
 * `<name>-MacBook-Pro.local` hostname, as on a developer's Mac. CI's real account is the
 * generic `runner`, so this file makes the D1 check meaningful there too. The values are
 * synthetic (`zq` prefix), so they may appear in this file; no real identity is read.
 *
 * Every write path is called with fake host facts and with an empty identity: the mocked
 * host's account name, hostname and hostname label must still be digested in every field,
 * and verify must still refuse a forged bundle that carries them.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: () => ({ ...actual.userInfo(), username: "zqmariela" }),
    hostname: () => "Zqmariela-MacBook-Pro.local",
    homedir: () => "/Users/zqmariela",
  };
});

import { validateEpisode } from "../../src/episode/validate.ts";
import {
  assembleProofBundle,
  exportProofBundle,
  type ProofRunInput,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { hashedId } from "../../src/proof/closed.ts";
import { hostIdentity, type IdentityContext } from "../../src/proof/identity.ts";
import { clone, NO_CTX, rechain, sampleRun } from "./fixture.ts";
import { carriesIdentity } from "./identity-check.ts";
import { plantEverywhere, withoutEpisode } from "./plant.ts";

const FAKE: IdentityContext = { names: ["zqfakeacct", "zqfakehost"], homes: ["/home/zqfake"] };
const EMPTY: IdentityContext = { names: [], homes: [] };
const NEEDLES = ["zqmariela", "Zqmariela-MacBook-Pro.local", "Zqmariela-MacBook-Pro"];

const PLANTS = [
  "zqmariela",
  "ZQMARIELA",
  "ZqMariela",
  "zqmariela_trial",
  "run-zqmariela-1",
  "Zqmariela-MacBook-Pro",
  "zqmariela-macbook-pro.local",
  "ZQMARIELA-MACBOOK-PRO",
  "zqmarielamacbookpro",
];

const runFor = (value: string): ProofRunInput => {
  const run = plantEverywhere(value);
  return run.episode !== undefined && validateEpisode(run.episode).length > 0
    ? withoutEpisode(run)
    : run;
};
const NEUTRAL = runFor("zq-neutral-value");

describe("D1 with node:os mocked to a developer's Mac", () => {
  it("the mock is in effect", () => {
    const id = hostIdentity();
    expect(id.names).toContain("zqmariela");
    expect(id.names).toContain("Zqmariela-MacBook-Pro.local");
    expect(id.homes).toEqual(["/Users/zqmariela"]);
  });

  const writers: ReadonlyArray<
    readonly [string, (run: ProofRunInput) => ReturnType<typeof exportProofBundle>]
  > = [
    ["export, fake host facts", (r) => exportProofBundle(r, NO_CTX, FAKE)],
    ["export, empty identity", (r) => exportProofBundle(r, NO_CTX, EMPTY)],
    ["assemble, fake host facts", (r) => assembleProofBundle(r, FAKE)],
    ["assemble, empty identity", (r) => assembleProofBundle(r, EMPTY)],
  ];

  for (const [mode, write] of writers) {
    it(`${mode}: the mocked account name and hostname are digested in every field`, () => {
      const neutral = write(NEUTRAL);
      for (const value of PLANTS) {
        const b = write(runFor(value));
        expect(b.run.runId, value).toBe(hashedId(value));
        expect(carriesIdentity(b, neutral, NEEDLES), value).toBe(false);
        expect(serializeProofBundle(b).toLowerCase().includes("zqmariela"), value).toBe(false);
      }
    });
  }

  it("verify with fake host facts or an empty identity refuses the mocked host's name", () => {
    const honest = exportProofBundle(sampleRun(), NO_CTX, FAKE);
    for (const value of PLANTS) {
      const b = clone(honest);
      (b.records[0]?.body as { policyId: string }).policyId = value;
      const text = serializeProofBundle(rechain(b));
      for (const identity of [FAKE, EMPTY]) {
        const r = verifyProofBundle(text, { identity });
        expect(
          r.errors.map((e) => e.code),
          value,
        ).toEqual(["PROOF_IDENTITY"]);
        expect(JSON.stringify(r).toLowerCase().includes("zqmariela"), value).toBe(false);
      }
    }
  });
});
