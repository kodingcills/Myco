/**
 * #579 / #599 / #602 on track Q's proof bundles: PROVENANCE-BOUND `h-<60hex>` (O3), the keyed
 * importer seal, and ACCENT FOLDING (O2).
 *
 *  - an agent-supplied `h-<60hex>` in every hashed field (every id, tool, app, keys, subject,
 *    policy code, media type) is re-hashed, never written as is;
 *  - a harness-produced one (in the ledger `bundleHashLedger` builds from a bundle the harness
 *    wrote, sealed under the harness key (#599) and that verified) is kept, only at the scope it
 *    was produced in: this run id and this exact bundle path, array index included (#599 O-a,
 *    #602 N-a); a hand-edited bundle that still verifies is refused by its seal;
 *  - export -> import (the bundle's ledger) -> export is byte-identical;
 *  - accented identities (and their accent-stripped forms) in every field are digested or refused.
 *
 * Every planted value is a fake word built at run time; no real identity value is printed.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HashLedger } from "../../src/export-guard/provenance.ts";
import { SealKey, sealArtifact } from "../../src/export-guard/seal.ts";
import {
  assembleProofBundle,
  bundleHashLedger,
  exportProofBundle,
  PROOF_SEAL_DOMAIN,
  type ProofBundle,
  ProofExportError,
  type ProofRunInput,
  sealProofBundle,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { hashedId, proofScope } from "../../src/proof/closed.ts";
import { identityNormal } from "../../src/proof/identity.ts";
import { buildLedger, NO_CTX, rechain, sampleRun } from "./fixture.ts";

/** A short home path (built at run time: no home-path literal is committed), hex-encoded. */
const SMUGGLED = Buffer.from(
  ["", "Users", "qzsmug", "Documents", "x.csv"].join("/"),
  "utf8",
).toString("hex");
const AGENT_HEX = `h-${SMUGGLED.padEnd(60, "0").slice(0, 60)}`;
const CAFE = `h-${"cafe".repeat(15)}`;

/** A run carrying `v` in every hashed field. */
function everywhere(v: string): ProofRunInput {
  return {
    ...sampleRun(),
    runId: v,
    taskId: v,
    arm: v,
    ledger: undefined,
    steps: [
      { kind: "policy", policyId: v, subject: v, decision: "allow", reasonCode: v },
      { kind: "action", actor: "agent", tool: v, summary: "s", app: v, keys: v },
      { kind: "handoff", from: v, to: v, summary: "s", checkpoint: 1 },
      { kind: "evidence", evidenceId: v, evidenceKind: v, mediaType: v, path: "p", content: "c" },
      {
        kind: "verdict",
        taskId: v,
        runId: v,
        verdict: "refuted",
        accepted: false,
        reasonCodes: ["ORACLE_FAIL", "CLAIM_RECORDED"],
        evidence: [v],
      },
    ],
  };
}

/** Every hashed field of a bundle, labelled. */
function hashedFields(b: ProofBundle): Array<readonly [string, unknown]> {
  const out: Array<readonly [string, unknown]> = [
    ["run.runId", b.run.runId],
    ["run.taskId", b.run.taskId],
    ["run.arm", b.run.arm],
  ];
  for (const r of b.records) {
    const body = r.body as unknown as Record<string, unknown>;
    for (const k of [
      "policyId",
      "subject",
      "reasonCode",
      "tool",
      "app",
      "keys",
      "from",
      "to",
      "evidenceId",
      "kind",
      "mediaType",
      "taskId",
      "runId",
    ])
      if (k in body) out.push([`${r.kind}.${k}`, body[k]]);
    if (Array.isArray(body.evidence)) out.push(["verdict.evidence", body.evidence[0]]);
  }
  return out;
}

/** A bundle the harness wrote carrying `v` as its hash in every hashed field (rechained). */
function harnessBundle(v: string): string {
  const agent = exportProofBundle(everywhere("raw value"), NO_CTX);
  const text = serializeProofBundle(agent).split(hashedId("raw value")).join(v);
  return serializeProofBundle(rechain(JSON.parse(text) as ProofBundle));
}

describe("O3: an agent-supplied h-<60hex> is re-hashed in every hashed field", () => {
  it.each([
    ["hex-encoded path", AGENT_HEX],
    ["hex-letter identity", CAFE],
  ])("%s: every field gets the hash of the value, and the bundle verifies", (_l, v) => {
    const b = exportProofBundle(everywhere(v), NO_CTX, { names: ["cafe"], homes: [] });
    const fields = hashedFields(b);
    expect(fields.length).toBe(17);
    for (const [field, out] of fields) expect(out, field).toBe(hashedId(v));
    const text = serializeProofBundle(b);
    expect(text.includes(v.slice(2))).toBe(false);
    expect(verifyProofBundle(text).ok).toBe(true);
  });
});

/** The harness key of these tests: random bytes made at run time (no key literal is committed). */
const KEY = new SealKey(randomBytes(32));
/** The seal the harness writes next to a bundle it wrote (`sealProofBundle`). */
const sealed = (text: string) => ({ key: KEY, seal: sealProofBundle(text, KEY) });
/** The ledger of a bundle the harness wrote and sealed. */
const ledgerOf = (text: string) => bundleHashLedger(text, sealed(text));

/** Every hashed field of a bundle, by its exact bundle JSON path (the ledger's scope path). */
function hashedPaths(b: ProofBundle): Array<readonly [string, unknown]> {
  const out: Array<readonly [string, unknown]> = [
    ["$.run.runId", b.run.runId],
    ["$.run.taskId", b.run.taskId],
    ["$.run.arm", b.run.arm],
  ];
  b.records.forEach((r, i) => {
    const body = r.body as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "string" && /^h-/.test(v)) out.push([`$.records[${i}].body.${k}`, v]);
      if (k === "evidence" && Array.isArray(v))
        for (const [j, e] of v.entries()) out.push([`$.records[${i}].body.evidence[${j}]`, e]);
    }
  });
  return out;
}

describe("O3: a harness-produced h-<60hex> is kept, only where the harness produced it", () => {
  it("kept in every hashed field under the ledger of a bundle the harness wrote and sealed", () => {
    const ledger = ledgerOf(harnessBundle(AGENT_HEX));
    const b = exportProofBundle(everywhere(AGENT_HEX), NO_CTX, undefined, ledger);
    for (const [field, out] of hashedFields(b)) expect(out, field).toBe(AGENT_HEX);
    expect(verifyProofBundle(serializeProofBundle(b)).ok).toBe(true);
  });

  it("scopes are the run id plus the exact bundle path; one recorded path keeps that field only", () => {
    const ref = exportProofBundle(everywhere(AGENT_HEX), NO_CTX);
    const paths = hashedPaths(ref);
    expect(paths.length).toBe(17);
    const one = new HashLedger();
    one.record(proofScope(AGENT_HEX, "$.records[1].body.tool"), AGENT_HEX);
    const b = exportProofBundle(everywhere(AGENT_HEX), NO_CTX, undefined, one);
    const got = new Map(hashedPaths(b));
    for (const [path] of paths)
      expect(got.get(path), path).toBe(
        path === "$.records[1].body.tool" ? AGENT_HEX : hashedId(AGENT_HEX),
      );
  });

  it("#599 O-a: a ledger for ANOTHER run keeps nothing (scope is bound to the run id)", () => {
    // Every path of this run's bundle recorded, but under another run id.
    const ref = exportProofBundle(everywhere(AGENT_HEX), NO_CTX);
    const otherRun = new HashLedger();
    for (const [path] of hashedPaths(ref))
      otherRun.record(proofScope("run-other", path), AGENT_HEX);
    // And the real ledger of a sealed bundle of another run (run id differs, same values).
    const other = JSON.parse(harnessBundle(AGENT_HEX)) as ProofBundle;
    (other.run as { runId: string }).runId = "run-other";
    for (const r of other.records)
      if (r.kind === "verdict") (r.body as unknown as { runId: string }).runId = "run-other";
    const otherBundle = serializeProofBundle(rechain(other));
    expect(verifyProofBundle(otherBundle).ok).toBe(true);
    expect((JSON.parse(otherBundle) as ProofBundle).run.runId).toBe("run-other");
    for (const ledger of [otherRun, ledgerOf(otherBundle)]) {
      const b = exportProofBundle(everywhere(AGENT_HEX), NO_CTX, undefined, ledger);
      for (const [field, out] of hashedFields(b)) expect(out, field).toBe(hashedId(AGENT_HEX));
    }
  });

  it("#602 N-a: a value recorded at one record index is re-hashed at another (same template)", () => {
    const run: ProofRunInput = {
      ...sampleRun(),
      runId: "run-1",
      ledger: undefined,
      steps: [
        { kind: "action", actor: "agent", tool: AGENT_HEX, summary: "s" },
        { kind: "action", actor: "agent", tool: AGENT_HEX, summary: "s" },
        {
          kind: "evidence",
          evidenceId: AGENT_HEX,
          evidenceKind: "k",
          mediaType: "text/plain",
          content: "c",
        },
        {
          kind: "evidence",
          evidenceId: CAFE,
          evidenceKind: "k",
          mediaType: "text/plain",
          content: "d",
        },
        {
          kind: "verdict",
          taskId: sampleRun().taskId,
          runId: "run-1",
          verdict: "refuted",
          accepted: false,
          reasonCodes: ["ORACLE_FAIL", "CLAIM_RECORDED"],
          evidence: [AGENT_HEX, CAFE],
        },
      ],
    };
    const ledger = new HashLedger();
    ledger.record(proofScope("run-1", "$.records[0].body.tool"), AGENT_HEX);
    // Recorded at evidence[1] of the verdict, but the value sits at evidence[0].
    ledger.record(proofScope("run-1", "$.records[4].body.evidence[1]"), AGENT_HEX);
    const a = assembleProofBundle(run, undefined, ledger);
    const body = (i: number) => a.records[i]?.body as unknown as Record<string, unknown>;
    expect(body(0).tool).toBe(AGENT_HEX);
    expect(body(1).tool).toBe(hashedId(AGENT_HEX));
    expect((body(4).evidence as string[])[0]).toBe(hashedId(AGENT_HEX));
    expect((body(4).evidence as string[])[1]).toBe(hashedId(CAFE));
  });

  it("re-hashed when the ledger holds a DIFFERENT h-<60hex> at the same run and path (V1)", () => {
    const harness = ledgerOf(harnessBundle(CAFE));
    const every = new HashLedger();
    for (const [path] of hashedPaths(exportProofBundle(everywhere(AGENT_HEX), NO_CTX)))
      every.record(proofScope(AGENT_HEX, path), CAFE);
    for (const ledger of [harness, every]) {
      const b = exportProofBundle(everywhere(AGENT_HEX), NO_CTX, undefined, ledger);
      for (const [field, out] of hashedFields(b)) expect(out, field).toBe(hashedId(AGENT_HEX));
    }
  });

  it("bundleHashLedger refuses a bundle that does not verify (codes only)", () => {
    const text = harnessBundle(AGENT_HEX);
    const tampered = text.replace('"seq": 1', '"seq": 7');
    let error: unknown = null;
    try {
      // Sealed AFTER the edit (a harness bug, not an agent): verify still refuses it.
      bundleHashLedger(tampered, {
        key: KEY,
        seal: sealArtifact(KEY, PROOF_SEAL_DOMAIN, tampered),
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProofExportError);
    expect((error as ProofExportError).code).not.toBe("PROOF_SEAL");
    expect(String((error as Error).message).includes(SMUGGLED.slice(0, 20))).toBe(false);
  });
});

describe("#599 follow-up 2: the importer trust boundary (keyed seal)", () => {
  /** The code `bundleHashLedger` refuses with, or null when it builds a ledger. */
  const refusal = (text: string, seal: { key: SealKey; seal: string }): string | null => {
    try {
      bundleHashLedger(text, seal);
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(ProofExportError);
      const msg = String((e as Error).message);
      if (seal.seal.length > 0) expect(msg.includes(seal.seal)).toBe(false);
      expect(msg.includes(SMUGGLED.slice(0, 20))).toBe(false);
      return (e as ProofExportError).code;
    }
  };

  it("a HAND-EDITED bundle that still verifies is refused: its seal does not hold (PROOF_SEAL)", () => {
    // The harness writes and seals a bundle with every hashed field the hash of a raw value.
    const real = serializeProofBundle(exportProofBundle(everywhere("raw value"), NO_CTX));
    const realSeal = sealed(real);
    expect(refusal(real, realSeal)).toBeNull();
    // An agent plants its own hex in every hashed field and recomputes the chain: it verifies.
    const edited = harnessBundle(AGENT_HEX);
    expect(verifyProofBundle(edited).ok).toBe(true);
    expect(refusal(edited, realSeal)).toBe("PROOF_SEAL");
    // So the agent's hex never reaches a ledger, and the next export re-hashes it.
    const b = exportProofBundle(everywhere(AGENT_HEX), NO_CTX);
    for (const [field, out] of hashedFields(b)) expect(out, field).toBe(hashedId(AGENT_HEX));
  });

  it("refused: a seal under another key, another domain, a malformed or empty seal, one byte changed", () => {
    const text = harnessBundle(AGENT_HEX);
    const good = sealProofBundle(text, KEY);
    const otherKey = new SealKey(randomBytes(32));
    expect(refusal(text, { key: KEY, seal: good })).toBeNull();
    expect(refusal(text, { key: otherKey, seal: good })).toBe("PROOF_SEAL");
    expect(refusal(text, { key: otherKey, seal: sealProofBundle(text, otherKey) })).toBeNull();
    const otherDomain = sealArtifact(KEY, "myco.dataset.seal/1", text);
    expect(refusal(text, { key: KEY, seal: otherDomain })).toBe("PROOF_SEAL");
    for (const bad of ["", good.toUpperCase(), `${good}0`, good.slice(1), "z".repeat(64)])
      expect(refusal(text, { key: KEY, seal: bad }), bad.length.toString()).toBe("PROOF_SEAL");
    const flipped = `${good.slice(0, -1)}${good.endsWith("0") ? "1" : "0"}`;
    expect(refusal(text, { key: KEY, seal: flipped })).toBe("PROOF_SEAL");
    // Trailing whitespace changes the bytes: the seal is over the exact text.
    expect(refusal(`${text} `, { key: KEY, seal: good })).toBe("PROOF_SEAL");
  });

  it("sealProofBundle refuses to seal a bundle that does not verify", () => {
    const text = harnessBundle(AGENT_HEX).replace('"seq": 1', '"seq": 7');
    expect(() => sealProofBundle(text, KEY)).toThrow(ProofExportError);
  });
});

describe("O3: export -> import -> export is byte-identical", () => {
  it("re-exporting a run from a bundle's own values under its sealed ledger writes the same bytes", () => {
    const first = exportProofBundle(everywhere(AGENT_HEX), NO_CTX);
    const firstText = serializeProofBundle(first);
    // Import: the bundle's ledger, and its emitted values back as the run's values.
    const ledger = ledgerOf(firstText);
    const emitted = hashedId(AGENT_HEX);
    const second = exportProofBundle(everywhere(emitted), NO_CTX, undefined, ledger);
    expect(serializeProofBundle(second)).toBe(firstText);
    const third = exportProofBundle(
      everywhere(emitted),
      NO_CTX,
      undefined,
      ledgerOf(serializeProofBundle(second)),
    );
    expect(serializeProofBundle(third)).toBe(firstText);
    // Without the ledger the import is re-hashed (the ledger is what keeps the values).
    expect(serializeProofBundle(exportProofBundle(everywhere(emitted), NO_CTX))).not.toBe(
      firstText,
    );
  });
});

describe("O2: accent folding (NFD, combining marks removed) on both sides", () => {
  it("identityNormal matches accent-stripped and transliterated forms, both ways", () => {
    for (const [configured, written] of [
      ["josé", "JOSE"],
      ["JOSE", "josé"],
      ["reña", "rena"],
      ["Søren", "SOREN"],
      ["Łukasz", "lukasz"],
      ["Ærø", "AERO"],
      ["josé", "JOSÉ"],
    ] as const)
      expect(identityNormal(written), `${configured} ~ ${written}`).toBe(
        identityNormal(configured),
      );
  });

  it("an accented identity's ASCII form, and the reverse, in every hashed field is digested", () => {
    for (const [configured, written] of [
      ["Qzjosé Qzreña", "QZJOSE_QZRENA"],
      ["Qzjose Qzrena", "QzJosé-QzReña"],
    ] as const) {
      const b = exportProofBundle(everywhere(written), NO_CTX, { names: [configured], homes: [] });
      for (const [field, out] of hashedFields(b)) expect(out, field).toBe(hashedId(written));
      expect(serializeProofBundle(b).toLowerCase().includes("qzjos")).toBe(false);
    }
  });

  it("an accented identity's ASCII form in a verbatim ledger id refuses the export (PROOF_IDENTITY)", () => {
    const base = sampleRun();
    // Built at run time (like test/episode/helpers.ts fakeKey()): no key-shaped literal is committed.
    const accentedTrial = `${["QZJOSE", "QZRENA"].join("_")}-1`;
    const ledger = buildLedger([
      { kind: "start", trialKey: accentedTrial, taskId: "df-s02", arm: "myco-gate" },
      {
        kind: "end",
        trialKey: accentedTrial,
        taskId: "df-s02",
        arm: "myco-gate",
        outcome: "completed",
      },
    ]);
    let error: unknown = null;
    try {
      exportProofBundle({ ...base, ledger: { ...ledger, trialKey: accentedTrial } }, NO_CTX, {
        names: ["Qzjosé Qzreña"],
        homes: [],
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProofExportError);
    expect((error as ProofExportError).code).toBe("PROOF_IDENTITY");
    expect(
      String((error as Error).message)
        .toLowerCase()
        .includes("qzjose"),
    ).toBe(false);
  });
});
