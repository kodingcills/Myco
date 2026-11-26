/**
 * Track Q (replayable proof): every host-path / username probe the verifiers ran on #533
 * (rounds 1-3) and #548 (rounds 1-3) is a test here, and passes because of the allowlist,
 * not because a pattern caught it.
 *
 * For each probe value:
 *  1. EXPORT: the value is planted in every free-text, path and id input field of a run
 *     (`plantEverywhere`); an episode carrying it that #542's `validateEpisode` refuses is
 *     refused (`PROOF_EPISODE`, no echo); the run itself exports, verifies (episode
 *     cross-checked when #542 accepts it) and renders, and no user word of the probe is in
 *     the bundle, the verify result or the HTML.
 *  2. VERIFY: a hand-edited bundle carrying the raw value where text used to be (a summary)
 *     or in an id field, re-chained like a forger would, is refused, and no refusal message
 *     carries a user word.
 *  3. BACKSTOP (only for the corpora the old scanner was pinned on): the scanner still flags
 *     the raw value. This is the backstop, not the guarantee.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findLeaks } from "../../src/proof/backstop.ts";
import {
  exportProofBundle,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { main } from "../../src/proof/cli.ts";
import { CLOSED_ID } from "../../src/proof/closed.ts";
import { clone, NO_CTX, rechain, sampleRun } from "./fixture.ts";
import { expectAbsent, exportVerifyReport, plantEverywhere } from "./plant.ts";
import {
  ANT_KEY,
  BOB,
  BYPASSES,
  FIRST,
  GUEST,
  j,
  LAST,
  LIMITS,
  type Probe,
  ROUND1_548_CLEAN,
  ROUND3_548,
  SMITH,
  SPACED,
  UNC_CLASS,
  USER,
} from "./probe-corpus.ts";

/**
 * Steps 1 and 2 for one probe. A value that itself matches the closed id grammar (a
 * key-shaped token such as `id_sk-...`) used to be written as is in id fields and refused by
 * the backstop. Since #553 r3 the identity guard digests it (key-like class), so every probe
 * now exports, verifies and reports with no planted word in any output.
 */
function battery(value: string, words: readonly string[]): void {
  exportVerifyReport(plantEverywhere(value), words);
  const honest = exportProofBundle(sampleRun(), NO_CTX);
  // A forger writes the raw value where the summary digest is.
  const asText = clone(honest);
  (asText.records[1]?.body as unknown as { summary: string }).summary = value;
  const r1 = verifyProofBundle(serializeProofBundle(rechain(asText)));
  expect(r1.ok).toBe(false);
  expect(r1.errors.map((e) => e.code)).toContain("PROOF_SCHEMA");
  expectAbsent(JSON.stringify(r1), words, "refusal (summary)");
  // ... or in an id field of a record, and of the run header.
  const asId = clone(honest);
  (asId.records[1]?.body as { tool: string }).tool = value;
  const r2 = verifyProofBundle(serializeProofBundle(rechain(asId)));
  expect(r2.ok).toBe(false);
  // Not a closed id: the schema refuses it. A closed id the backstop flags: the backstop does.
  expect(r2.errors.map((e) => e.code)).toContain(
    CLOSED_ID.test(value) ? "PROOF_REDACTION" : "PROOF_SCHEMA",
  );
  expectAbsent(JSON.stringify(r2), words, "refusal (tool)");
  const asRun = clone(honest) as unknown as { run: { runId: string } };
  asRun.run.runId = value;
  const r3 = verifyProofBundle(JSON.stringify(asRun));
  expect(r3.ok).toBe(false);
  expectAbsent(JSON.stringify(r3), words, "refusal (runId)");
}

const PLANTED_MARKERS = [USER, "PLANTED"];

describe("#533 rounds 1-2: leading-character and encoding bypasses (D1, R2-D1)", () => {
  for (const [name, value] of BYPASSES)
    it(name, () => {
      battery(value, PLANTED_MARKERS);
      expect(findLeaks(value), "backstop").not.toEqual([]);
    });
});

describe("#533 round 3 / #548 R2-D2: spaces, Documents and Settings, 8.3, UNC (R3-D1)", () => {
  for (const [name, value, words] of SPACED)
    it(name, () => {
      battery(value, [...words, "PLANTED"]);
      expect(findLeaks(value), "backstop").not.toEqual([]);
    });
});

describe("#548 rounds 1-2: the UNC class, encoded UNC, account names (D1-D3, R2-D1)", () => {
  for (const [name, value, words] of UNC_CLASS)
    it(name, () => {
      battery(value, [...words, "PLANTED"]);
      expect(findLeaks(value), "backstop").not.toEqual([]);
    });
});

const plain = (probes: readonly Probe[]) => {
  for (const [name, value, words] of probes) it(name, () => battery(value, [...words, "PLANTED"]));
};

describe("#548 round 3 (final verdict R3-D1): forms the pattern redactor missed", () =>
  plain(ROUND3_548));
describe("#548 round 1: the verifier's clean probes", () => plain(ROUND1_548_CLEAN));
describe("forms earlier rounds listed as scanner LIMITS: never exported either", () =>
  plain(LIMITS));

describe("#533 round 1 probes P3-P7 (beyond host paths)", () => {
  it("P3/P4: a path behind \\t or \\/ escapes in a hand-edited bundle FILE is refused", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[1]?.body as unknown as { summary: string }).summary = j(
      "see\t/",
      "Users/",
      USER,
      "/secret.txt",
    );
    const text = serializeProofBundle(rechain(b)).replace(/\//g, "\\/");
    expect(text).not.toContain(`/Users/${USER}`);
    const r = verifyProofBundle(text);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(expect.arrayContaining(["PROOF_REDACTION"]));
    expectAbsent(JSON.stringify(r), [USER], "refusal");
  });

  it("P5/P6: an hcu+shell run exports; a run arm that differs from the ledger trial's is refused", () => {
    // Pinned in bundle.test.ts ("the run's arm and the ledger trial's arm"); here as a probe.
    const { ledger: _l, ...run } = sampleRun();
    const b = exportProofBundle({ ...run, arm: "hcu+shell" }, NO_CTX);
    expect(b.run.arm).toBe("hcu+shell");
    expect(verifyProofBundle(serializeProofBundle(b)).ok).toBe(true);
  });

  it("a key-shaped value in a text field is replaced by its digest", () => {
    exportVerifyReport(plantEverywhere(`token ${ANT_KEY}`), [ANT_KEY, "PLANTED"]);
  });
});

/** Run the real CLI in-process. */
function cliRun(args: string[]): { code: number; out: string } {
  let out = "";
  const code = main(args, { out: (t) => (out += t), err: (t) => (out += t) });
  return { code, out };
}

describe("every probe through the real CLI: export -> verify -> report", () => {
  it("all probes at once, in a summary and in a tool id: no user word in any output", () => {
    const all = [
      ...BYPASSES.map(([n, v]) => [n, v, PLANTED_MARKERS] as const),
      ...SPACED,
      ...UNC_CLASS,
      ...ROUND3_548,
      ...ROUND1_548_CLEAN,
      ...LIMITS,
    ];
    const words = [
      ...new Set([...all.flatMap(([, , w]) => w), FIRST, LAST, GUEST, BOB, SMITH, "PLANTED"]),
    ];
    const dir = mkdtempSync(join(tmpdir(), "proof-probes-"));
    const run = sampleRun();
    const joined = all.map(([, v]) => v).join(" ; ");
    const steps = [
      { kind: "action", actor: "harness", tool: joined, summary: joined },
      ...run.steps.filter((s) => s.kind !== "evidence"),
    ].map((s) => (s.kind === "verdict" ? { ...s, evidence: [] } : s));
    const runPath = join(dir, "RUN.json");
    writeFileSync(runPath, JSON.stringify({ ...run, steps }));
    const bundle = join(dir, "b.json");
    const exp = cliRun(["export", runPath, "--out", bundle]);
    expect(exp.code).toBe(0);
    expectAbsent(exp.out, words, "export stdout");
    expectAbsent(readFileSync(bundle, "utf8"), words, "bundle file");
    const ver = cliRun(["verify", bundle]);
    expect(ver.code).toBe(0);
    expectAbsent(ver.out, words, "verify stdout");
    const html = join(dir, "r.html");
    const rep = cliRun(["report", bundle, "--out", html]);
    expect(rep.code).toBe(0);
    expectAbsent(rep.out, words, "report stdout");
    expectAbsent(readFileSync(html, "utf8"), words, "report file");
  });
});
