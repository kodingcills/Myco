/**
 * Track Q, #562 round 2 (D-H, lead ruling 23:06Z): every hashed VALUE is `h-<60hex>`, the
 * first 60 hex characters (240 bits) of the tagged sha256 of the full raw value, on every
 * export surface. Idempotence matches EXACTLY `h-<60hex>`, and only a harness-produced one
 * (#579 O3: recorded in the harness's hash ledger) is kept as is by the id and vocabulary
 * closers; every other `h-` form (64, 59, 61 hex, upper case, `H-`) is a plain value and is
 * hashed. A bundle carrying any other `h-` form is refused. Full content
 * digests are not truncated (64 hex).
 *
 * Mutants this file kills: the hashed form restored to 64 hex; any `h-` prefix accepted as
 * already hashed.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HashLedger } from "../../src/export-guard/provenance.ts";
import {
  bundleHashLedger,
  exportProofBundle,
  type ProofBundle,
  type ProofRunInput,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import {
  closedId,
  closedMediaType,
  closedPolicyCode,
  hashedId,
  hashValue,
  isHashed,
  TEXT_DIGEST_TAG,
} from "../../src/proof/closed.ts";
import { closedApp, closedKeys, closedSubject, closedTool } from "../../src/proof/vocab.ts";
import { clone, NO_CTX, rechain, sampleRun } from "./fixture.ts";

const H60 = /^h-[0-9a-f]{60}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The reference computation, independent of `src/proof`. */
const reference = (raw: string): string =>
  `h-${createHash("sha256").update(`${TEXT_DIGEST_TAG}\u0000${raw}`, "utf8").digest("hex").slice(0, 60)}`;

const hexOf = (seed: string, n: number): string => {
  let out = "";
  for (let i = 0; out.length < n; i++)
    out += createHash("sha256").update(`${seed}/${i}`).digest("hex");
  return out.slice(0, n);
};

/** Exactly `h-<60hex>`: kept as is. */
const EXACT = `h-${hexOf("exact", 60)}`;
/** Every other `h-` form: a plain value, hashed. */
const NOT_EXACT: ReadonlyArray<readonly [string, string]> = [
  ["h-<64hex> (the round-1 form)", `h-${hexOf("a", 64)}`],
  ["h-<59hex>", `h-${hexOf("b", 59)}`],
  ["h-<61hex>", `h-${hexOf("c", 61)}`],
  [
    "h-<60HEX> upper-case hex",
    `h-${hexOf("d", 60)
      .toUpperCase()
      .replace(/^[0-9]/, "A")}`,
  ],
  ["H-<60hex> upper-case prefix", `H-${hexOf("e", 60)}`],
  ["h-<60hex> with a suffix", `h-${hexOf("f", 60)}x`],
  ["h- with a word", "h-jsmith"],
];

describe("D-H: the hashed form is h-<60hex>, a truncated tagged sha256 of the full value", () => {
  it("matches ^h-[0-9a-f]{60}$ and equals the first 60 hex of the reference digest", () => {
    for (const raw of ["x", "run 1", "/home/jsmith/a b.txt", "Zqgroß", "", "a".repeat(5000)]) {
      const h = hashedId(raw);
      expect(h).toMatch(H60);
      expect(h).toHaveLength(62);
      expect(h).toBe(reference(raw));
    }
  });

  it("every closer emits that form for a value it may not write as is", () => {
    const raw = "com.apple.Safari/jsmith";
    for (const close of [
      closedId,
      closedTool,
      closedApp,
      closedSubject,
      closedKeys,
      closedPolicyCode,
      closedMediaType,
    ])
      expect(close(raw)).toBe(reference(raw));
  });

  it("an exported bundle carries every hashed value in that form", () => {
    const b = exportProofBundle(run({ tool: "jsmith", app: "jsmith-app", keys: "j s m" }), NO_CTX);
    const body = b.records[0]?.body as unknown as Record<string, unknown>;
    expect(body.tool).toBe(reference("jsmith"));
    expect(body.app).toBe(reference("jsmith-app"));
    expect(body.keys).toBe(reference("j s m"));
    expect(verifyProofBundle(serializeProofBundle(b)).ok).toBe(true);
  });

  it("full content digests are not truncated: TextRef and evidence sha256 stay 64 hex", () => {
    const b = exportProofBundle(sampleRun(), NO_CTX);
    const bodyOf = (kind: string) =>
      b.records.find((r) => r.kind === kind)?.body as unknown as Record<string, unknown>;
    const summary = bodyOf("action").summary as { sha256: string };
    expect(summary.sha256).toMatch(HEX64);
    const ev = bodyOf("evidence") as { sha256: string; path: { sha256: string } };
    expect(ev.sha256).toMatch(HEX64);
    expect(ev.path.sha256).toMatch(HEX64);
    for (const r of b.records) expect(r.prevSha256).toMatch(HEX64);
    expect(b.head.headSha256).toMatch(HEX64);
  });
});

describe("D-H: idempotence matches exactly h-<60hex>", () => {
  it("isHashed / hashValue: exact h-<60hex> kept only when the ledger records it (#579 O3), every other h- form hashed", () => {
    expect(isHashed(EXACT)).toBe(true);
    expect(hashValue(EXACT)).toBe(reference(EXACT));
    const ledger = new HashLedger();
    ledger.record("f", EXACT);
    expect(hashValue(EXACT, "f", ledger)).toBe(EXACT);
    expect(hashValue(EXACT, "g", ledger)).toBe(reference(EXACT));
    for (const [label, raw] of NOT_EXACT) {
      expect(isHashed(raw), label).toBe(false);
      expect(hashValue(raw), label).toBe(reference(raw));
    }
  });

  it("a harness-produced exact h-<60hex> is kept as is in every id and vocabulary field, and verifies; an agent's is re-hashed (#579 O3)", () => {
    const agent = exportProofBundle(everywhere(EXACT), NO_CTX);
    for (const [field, value] of hashedFields(agent)) expect(value, field).toBe(reference(EXACT));
    expect(verifyProofBundle(serializeProofBundle(agent)).ok).toBe(true);
    // A bundle that carries EXACT as a harness hash (forged here), verified, gives the ledger.
    const harness = rechain(
      JSON.parse(serializeProofBundle(agent).split(reference(EXACT)).join(EXACT)) as ProofBundle,
    );
    const ledger = bundleHashLedger(serializeProofBundle(harness));
    const b = exportProofBundle(everywhere(EXACT), NO_CTX, undefined, ledger);
    for (const [field, value] of hashedFields(b)) expect(value, field).toBe(EXACT);
    expect(b.run.runId).toBe(EXACT);
    expect(verifyProofBundle(serializeProofBundle(b)).ok).toBe(true);
  });

  it("every other h- form is hashed in every id and vocabulary field (never kept)", () => {
    for (const [label, raw] of NOT_EXACT) {
      const b = exportProofBundle(everywhere(raw), NO_CTX);
      for (const [field, value] of hashedFields(b))
        expect(value, `${label} in ${field}`).toBe(reference(raw));
      expect(b.run.runId, label).toBe(reference(raw));
      expect(serializeProofBundle(b).includes(raw), `${label}: verbatim`).toBe(false);
      expect(verifyProofBundle(serializeProofBundle(b)).ok, label).toBe(true);
    }
  });
});

describe("D-H: verify refuses a forged bundle with any hashed form but h-<60hex>", () => {
  const FIELDS: ReadonlyArray<readonly [number, string]> = [
    [0, "policyId"],
    [0, "subject"],
    [0, "reasonCode"],
    [1, "tool"],
    [4, "from"],
    [4, "to"],
    [6, "evidenceId"],
    [6, "kind"],
    [6, "mediaType"],
  ];
  const forge = (at: number, field: string, value: string) => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[at]?.body as unknown as Record<string, unknown>)[field] = value;
    return verifyProofBundle(serializeProofBundle(rechain(b)));
  };

  it("h-<64hex>, h-<59hex>, h-<61hex>, upper case and H- in each hashed field: PROOF_SCHEMA", () => {
    for (const [at, field] of FIELDS)
      for (const [label, raw] of NOT_EXACT.slice(0, 5)) {
        const r = forge(at, field, raw);
        expect(r.ok, `${label} in ${field}`).toBe(false);
        expect(
          r.errors.map((e) => e.code),
          `${label} in ${field}`,
        ).toContain("PROOF_SCHEMA");
        expect(JSON.stringify(r.errors).includes(raw), `${label} in ${field}: echo`).toBe(false);
      }
  });

  it("the same fields holding exactly h-<60hex>: accepted", () => {
    // (`evidenceId` is left out: a verdict cites it, so changing it alone breaks the citation.)
    for (const [at, field] of FIELDS.filter(([, f]) => f !== "evidenceId"))
      expect(forge(at, field, EXACT).ok, field).toBe(true);
  });

  it("app and keys holding a non-60 hashed form: PROOF_SCHEMA", () => {
    for (const field of ["app", "keys"]) {
      const b = clone(exportProofBundle(run({ app: "calc", keys: "Return" }), NO_CTX));
      (b.records[0]?.body as unknown as Record<string, unknown>)[field] = `h-${hexOf(field, 64)}`;
      const r = verifyProofBundle(serializeProofBundle(rechain(b)));
      expect(
        r.errors.map((e) => e.code),
        field,
      ).toContain("PROOF_SCHEMA");
    }
  });
});

describe("round-1 nits: the identity scan's digest exemption cannot carry an identity", () => {
  const ID = { names: ["zqvarnok"], homes: [] };
  it("an identity glued to a digest (<id>-<64hex>, <64hex><id>, h-<60hex><id>) is refused", () => {
    const b0 = exportProofBundle(sampleRun(), NO_CTX);
    for (const v of [
      `zqvarnok-${hexOf("g", 64)}`,
      `${hexOf("g", 64)}zqvarnok`,
      `h-${hexOf("g", 60)}zqvarnok`,
      `h-${hexOf("g", 60)}-zqvarnok`,
    ]) {
      const b = clone(b0);
      (b.records[0]?.body as unknown as Record<string, unknown>).policyId = v;
      const r = verifyProofBundle(serializeProofBundle(rechain(b)), { identity: ID });
      expect(r.errors.map((e) => e.code)).toContain("PROOF_IDENTITY");
      expect(JSON.stringify(r).includes("zqvarnok")).toBe(false);
    }
  });

  it("an identity in an object KEY is refused with PROOF_IDENTITY", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX)) as unknown as Record<string, unknown>;
    b.zqvarnok = 1;
    const r = verifyProofBundle(JSON.stringify(b), { identity: ID });
    expect(r.errors.map((e) => e.code)).toContain("PROOF_IDENTITY");
    expect(JSON.stringify(r).includes("zqvarnok")).toBe(false);
  });

  it("a joined full name whose words are all under 3 characters is still matched", () => {
    const input = sampleRun();
    const steps = input.steps.map((s) => (s.kind === "policy" ? { ...s, policyId: "JoLi_x" } : s));
    const b = exportProofBundle({ ...input, steps }, NO_CTX, { names: ["Jo Li"], homes: [] });
    const policy = b.records.find((r) => r.kind === "policy")?.body as unknown as {
      policyId: string;
    };
    expect(policy.policyId).toBe(reference("JoLi_x"));
  });
});

// ---------------------------------------------------------------------------------------

const run = (over: Record<string, string>): ProofRunInput => ({
  ...sampleRun(),
  ledger: undefined,
  steps: [{ kind: "action", actor: "agent", tool: "launch", summary: "s", ...over }],
});

/** One run that puts `v` in every id field and every vocabulary or enum-coded field. */
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
      {
        kind: "evidence",
        evidenceId: v,
        evidenceKind: v,
        mediaType: v,
        path: "p",
        content: "c",
      },
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

/** Every hashed-value field of a bundle built by `everywhere`, with its emitted value. */
function hashedFields(b: ProofBundle): Array<readonly [string, unknown]> {
  const out: Array<readonly [string, unknown]> = [
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
      "mediaType",
      "taskId",
      "runId",
    ])
      if (k in body) out.push([`${r.kind}.${k}`, body[k]]);
    if (r.kind === "evidence") out.push(["evidence.kind", body.kind]);
    if (Array.isArray(body.evidence)) out.push(["verdict.evidence", body.evidence[0]]);
  }
  return out;
}
