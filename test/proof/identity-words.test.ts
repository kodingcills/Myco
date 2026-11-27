/**
 * #580 O1 on track Q's proof bundles (lead ruling 02:55Z): a SINGLE WORD of a configured full
 * name (`<first>_trial`, `<Last>2`, `xx<first>`, `<first>Trial`, camelCase joins, accented and
 * case variants) is caught through the one rule shared with the episode export and the track U
 * container (`src/export-guard/identity-words.ts`): digested in every id and token field,
 * refused (PROOF_IDENTITY) in a verbatim ledger id and by verify. Words of 1 or 2 characters are
 * not looked for alone. O4 (unconfigured names) is a documented residual; a test pins it.
 *
 * Every planted value is a fake word built at run time; no value is printed (booleans compared).
 */
import { describe, expect, it } from "vitest";
import { IDENTITY_WORD_MIN_CHARS } from "../../src/export-guard/identity-words.ts";
import type { RedactionContext } from "../../src/proof/backstop.ts";
import {
  assembleProofBundle,
  exportProofBundle,
  type ProofBundle,
  ProofExportError,
  type ProofRunInput,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { hashedId } from "../../src/proof/closed.ts";
import { compileIdentity, type IdentityContext, MIN_NAME_PART } from "../../src/proof/identity.ts";
import { buildLedger, NO_CTX, rechain, sampleRun } from "./fixture.ts";
import { makePathFuzzer, mulberry32 } from "./path-fuzz.ts";

const FIRST = ["Qzq", "first"].join("");
const LAST = ["Qzq", "last"].join("");
const FULL = `${FIRST} ${LAST}`;
const THREE = ["Zq", "q"].join("");
const TWO = ["Z", "w"].join("");
const ACCENTED = ["Qzqjosé", "Qzqreña"].join(" ");
const ASCII_NAME = ["Qzqjose", "Qzqrena"].join(" ");
const ident = (...names: string[]): IdentityContext => ({ names, homes: [] });

const WORD_FORMS: readonly string[] = [
  `${FIRST.toLowerCase()}_trial`,
  `${LAST}2`,
  `xx${FIRST.toLowerCase()}`,
  `${FIRST.toLowerCase()}Trial`,
  `run${FIRST}`,
  `agent${LAST}Run`,
  FIRST.toUpperCase(),
  LAST.toLowerCase(),
  `${[...FIRST].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join("")}-7`,
];

/** A run carrying `v` in every id and token field (`text` in the free-text fields). */
function everywhere(v: string, text = "s"): ProofRunInput {
  return {
    ...sampleRun(),
    runId: v,
    taskId: v,
    arm: v,
    ledger: undefined,
    steps: [
      { kind: "policy", policyId: v, subject: v, decision: "allow", reasonCode: v },
      { kind: "action", actor: "agent", tool: v, summary: text, app: v, keys: v },
      { kind: "handoff", from: v, to: v, summary: text, checkpoint: 1 },
      { kind: "evidence", evidenceId: v, evidenceKind: v, mediaType: v, path: text, content: "c" },
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

const anyWordIn = (text: string, words: readonly string[]) =>
  words.some((w) => text.toLowerCase().includes(w.toLowerCase()));

/** A run whose verbatim ledger trial key is `key`. */
function ledgerRun(key: string): ProofRunInput {
  const ledger = buildLedger([
    { kind: "start", trialKey: key, taskId: "df-s02", arm: "myco-gate" },
    { kind: "end", trialKey: key, taskId: "df-s02", arm: "myco-gate", outcome: "completed" },
  ]);
  return { ...sampleRun(), ledger: { ...ledger, trialKey: key } };
}
function refusalCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (!(e instanceof ProofExportError)) throw e;
    // The message carries a class and a location only.
    expect(anyWordIn(e.message, [FIRST, LAST])).toBe(false);
    return e.code;
  }
}

describe("#580 O1: a single word of a configured full name, in every id and token field", () => {
  it("the minimum word length is pinned at 3 (as the episode export and track U)", () => {
    expect(IDENTITY_WORD_MIN_CHARS).toBe(3);
    expect(MIN_NAME_PART).toBe(3);
  });

  it("each word form is digested in every hashed field, backstop ON and OFF", () => {
    for (const [i, v] of WORD_FORMS.entries()) {
      for (const [mode, b] of [
        ["ON", exportProofBundle(everywhere(v), NO_CTX, ident(FULL))],
        ["OFF", assembleProofBundle(everywhere(v), ident(FULL))],
      ] as const) {
        for (const [field, out] of hashedFields(b))
          expect(out === hashedId(v), `form ${i} ${mode} ${field}`).toBe(true);
        expect(anyWordIn(serializeProofBundle(b), [FIRST, LAST]), `form ${i} ${mode}`).toBe(false);
      }
    }
  });

  it("a word of exactly 3 characters is matched; one of 2 is not looked for alone", () => {
    const g = compileIdentity(ident(`${THREE} ${LAST}`, `${TWO} ${LAST}`));
    for (const v of [`${THREE.toLowerCase()}_trial`, `xx${THREE}2`, `run${THREE.toUpperCase()}`])
      expect(g.hit(v), "3-char").toBe("identity");
    expect(g.hit(`${TWO.toLowerCase()}_trial`), "2-char").toBeNull();
  });

  it("accented and ASCII variants of a word match both ways (accent folding applies to words)", () => {
    for (const [configured, written] of [
      [ACCENTED, "qzqjose_trial"],
      [ACCENTED, "QZQRENA2"],
      [ASCII_NAME, "xxQzqJosé"],
      [ASCII_NAME, "qzqreñaTrial"],
    ] as const) {
      const b = exportProofBundle(everywhere(written), NO_CTX, ident(configured));
      for (const [field, out] of hashedFields(b))
        expect(out === hashedId(written), field).toBe(true);
    }
  });
});

describe("#580 O1: a single word in a verbatim ledger id, or in a forged bundle, refuses", () => {
  it("export refuses a word in the ledger's trial key (PROOF_IDENTITY), ON and OFF", () => {
    for (const [i, v] of WORD_FORMS.entries()) {
      const key = `t-${v.replace(/[^A-Za-z0-9._-]/g, "")}`;
      expect(
        refusalCode(() => exportProofBundle(ledgerRun(key), NO_CTX, ident(FULL))),
        `form ${i} ON`,
      ).toBe("PROOF_IDENTITY");
      expect(
        refusalCode(() => assembleProofBundle(ledgerRun(key), ident(FULL))),
        `form ${i} OFF`,
      ).toBe("PROOF_IDENTITY");
    }
  });

  it("verify refuses a forged, re-chained bundle with a word in a closed id, codes only", () => {
    const honest = exportProofBundle(sampleRun(), NO_CTX);
    for (const [i, v] of WORD_FORMS.entries()) {
      const b = JSON.parse(serializeProofBundle(honest)) as { run: { runId: string } };
      b.run.runId = v.replace(/[^A-Za-z0-9._-]/g, "");
      const text = serializeProofBundle(rechain(b as unknown as ProofBundle));
      const r = verifyProofBundle(text, { identity: ident(FULL) });
      expect(r.ok, `form ${i}`).toBe(false);
      expect(
        r.errors.map((e) => e.code),
        `form ${i}`,
      ).toEqual(["PROOF_IDENTITY"]);
      expect(anyWordIn(JSON.stringify(r), [FIRST, LAST]), `form ${i}`).toBe(false);
    }
  });
});

describe("O4 residual (accepted, documented): unconfigured names are not caught", () => {
  const OTHER_HOST = ["Qzother", "MacBook", "Pro"].join("-");
  const PATH_ID = [["Us", "ers"].join(""), "qzjsmith", "Documents"].join(".");

  it("another machine's host name and a dotted path-like id with unconfigured names are kept verbatim", () => {
    for (const v of [OTHER_HOST, PATH_ID]) {
      const run = { ...sampleRun(), runId: v, taskId: v };
      const b = assembleProofBundle(run, ident(FULL));
      expect(b.run.runId === v && b.run.taskId === v, "kept").toBe(true);
      // Once configured, the same name is caught (the documented remedy).
      const c = assembleProofBundle(run, ident("Qzother", "qzjsmith"));
      expect(c.run.runId === hashedId(v), "configured: digested").toBe(true);
    }
  });
});

describe("fuzz: 1,000 generated full names and paths, backstop ON and OFF", () => {
  const CASES = 1000;
  function cases() {
    const next = makePathFuzzer(0x580);
    const rnd = mulberry32(0x5803);
    const out: Array<{ name: string; words: string[]; form: string; path: string }> = [];
    for (let i = 0; i < CASES; i++) {
      const f = next();
      const g = next();
      const words = [f.words[0] as string, g.words[0] as string];
      const w = words[Math.floor(rnd() * 2)] as string;
      const forms = [
        `${w.toLowerCase()}_trial`,
        `${w}2`,
        `xx${w}`,
        `${w.toLowerCase()}Trial`,
        w.toUpperCase(),
      ];
      out.push({
        name: words.join(" "),
        words,
        form: forms[i % forms.length] as string,
        path: f.value,
      });
    }
    return out;
  }

  it("every word form digested in every hashed field; no word (nor the path's words) in the bundle", () => {
    for (const [i, c] of cases().entries()) {
      const run = everywhere(c.form, c.path);
      const ctx: RedactionContext = { ...NO_CTX, usernames: [c.name] };
      for (const [mode, build] of [
        ["ON", () => exportProofBundle(run, ctx, ident(c.name))],
        ["OFF", () => assembleProofBundle(run, ident(c.name))],
      ] as const) {
        const b = build();
        for (const [field, out] of hashedFields(b))
          if (out !== hashedId(c.form)) expect.fail(`case ${i} ${mode}: ${field} not digested`);
        if (anyWordIn(serializeProofBundle(b), c.words))
          expect.fail(`case ${i} ${mode}: a word survived`);
      }
    }
  }, 120_000);
});
