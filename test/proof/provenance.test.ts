/**
 * #579 on track Q's proof bundles: PROVENANCE-BOUND `h-<60hex>` (O3) and ACCENT FOLDING (O2).
 *
 *  - an agent-supplied `h-<60hex>` in every hashed field (every id, tool, app, keys, subject,
 *    policy code, media type) is re-hashed, never written as is;
 *  - a harness-produced one (in the ledger `bundleHashLedger` builds from a bundle the harness
 *    wrote and that verified) is kept, only under the scope it was produced in;
 *  - export -> import (the bundle's ledger) -> export is byte-identical;
 *  - accented identities (and their accent-stripped forms) in every field are digested or refused.
 *
 * Every planted value is a fake word built at run time; no real identity value is printed.
 */
import { describe, expect, it } from "vitest";
import { HashLedger } from "../../src/export-guard/provenance.ts";
import {
  bundleHashLedger,
  exportProofBundle,
  type ProofBundle,
  ProofExportError,
  type ProofRunInput,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { hashedId, ID_SCOPE } from "../../src/proof/closed.ts";
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

describe("O3: a harness-produced h-<60hex> is kept, only where the harness produced it", () => {
  it("kept in every hashed field under the ledger of a bundle the harness wrote", () => {
    const ledger = bundleHashLedger(harnessBundle(AGENT_HEX));
    const b = exportProofBundle(everywhere(AGENT_HEX), NO_CTX, undefined, ledger);
    for (const [field, out] of hashedFields(b)) expect(out, field).toBe(AGENT_HEX);
    expect(verifyProofBundle(serializeProofBundle(b)).ok).toBe(true);
  });

  it("re-hashed when the ledger records it under another scope only", () => {
    const toolOnly = new HashLedger();
    toolOnly.record("action.tool", AGENT_HEX);
    const b = exportProofBundle(everywhere(AGENT_HEX), NO_CTX, undefined, toolOnly);
    for (const [field, out] of hashedFields(b))
      expect(out, field).toBe(field === "action.tool" ? AGENT_HEX : hashedId(AGENT_HEX));
    const idOnly = new HashLedger();
    idOnly.record(ID_SCOPE, AGENT_HEX);
    const c = exportProofBundle(everywhere(AGENT_HEX), NO_CTX, undefined, idOnly);
    const vocab = new Set([
      "policy.subject",
      "policy.reasonCode",
      "action.tool",
      "action.app",
      "action.keys",
      "evidence.mediaType",
    ]);
    for (const [field, out] of hashedFields(c))
      expect(out, field).toBe(vocab.has(field) ? hashedId(AGENT_HEX) : AGENT_HEX);
  });

  it("bundleHashLedger refuses a bundle that does not verify (codes only)", () => {
    const text = harnessBundle(AGENT_HEX);
    const tampered = text.replace('"seq": 1', '"seq": 7');
    let error: unknown = null;
    try {
      bundleHashLedger(tampered);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProofExportError);
    expect(String((error as Error).message).includes(SMUGGLED.slice(0, 20))).toBe(false);
  });
});

describe("O3: export -> import -> export is byte-identical", () => {
  it("re-exporting a run from a bundle's own values under its ledger writes the same bytes", () => {
    const first = exportProofBundle(everywhere(AGENT_HEX), NO_CTX);
    const firstText = serializeProofBundle(first);
    // Import: the bundle's ledger, and its emitted values back as the run's values.
    const ledger = bundleHashLedger(firstText);
    const emitted = hashedId(AGENT_HEX);
    const second = exportProofBundle(everywhere(emitted), NO_CTX, undefined, ledger);
    expect(serializeProofBundle(second)).toBe(firstText);
    const third = exportProofBundle(
      everywhere(emitted),
      NO_CTX,
      undefined,
      bundleHashLedger(serializeProofBundle(second)),
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
    const ledger = buildLedger([
      { kind: "start", trialKey: "QZJOSE_QZRENA-1", taskId: "df-s02", arm: "myco-gate" },
      {
        kind: "end",
        trialKey: "QZJOSE_QZRENA-1",
        taskId: "df-s02",
        arm: "myco-gate",
        outcome: "completed",
      },
    ]);
    let error: unknown = null;
    try {
      exportProofBundle({ ...base, ledger: { ...ledger, trialKey: "QZJOSE_QZRENA-1" } }, NO_CTX, {
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
