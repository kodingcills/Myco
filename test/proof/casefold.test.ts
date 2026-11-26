/**
 * Track Q, #562 D2 (from #553's final verdict): identity matching uses FULL Unicode case
 * folding, not `toLowerCase`, and matches JOINED forms of multi-word names. In #553 a
 * configured `Hans Zqgroß` let `ZQGROSS` (its JS upper case) out verbatim, because
 * `"gross".includes("groß")` is false; `Zqaydın` let `ZQAYDIN` out the same way.
 *
 * All names here are synthetic (`zq` prefix). They are configured as an identity file would
 * configure them, planted into EVERY input field (`plantEverywhere`), and written through
 * export (backstop ON), the allowlist step alone (`assembleProofBundle`, backstop OFF), verify
 * and the CLI. No planted form may reach an output, checked structurally in folded form.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateEpisode } from "../../src/episode/validate.ts";
import {
  assembleProofBundle,
  exportProofBundle,
  type ProofRunInput,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { main } from "../../src/proof/cli.ts";
import { CLOSED_ID } from "../../src/proof/closed.ts";
import {
  caseFold,
  compileIdentity,
  type IdentityContext,
  identityNormal,
} from "../../src/proof/identity.ts";
import { clone, NO_CTX, rechain, sampleRun } from "./fixture.ts";
import { carriesIdentity, foldForCheck } from "./identity-check.ts";
import { plantEverywhere, withoutEpisode } from "./plant.ts";

describe("the fold", () => {
  it("ß, ẞ and SS fold alike; dotless ı and I fold alike; final ς and Σ fold alike", () => {
    expect(caseFold("Groß")).toBe("gross");
    expect(caseFold("GROẞ")).toBe("gross");
    expect(caseFold("GROSS")).toBe("gross");
    expect(identityNormal("Zqaydın")).toBe(identityNormal("ZQAYDIN"));
    expect(identityNormal("Zqaydın")).toBe("zqaydin");
    expect(identityNormal("ΟΔΥΣΣΕΥΣ")).toBe(identityNormal("Οδυσσευς"));
    // NFKC first: a fullwidth or ligature spelling folds to the plain one.
    expect(identityNormal("ＺＱＧＲＯＳＳ")).toBe("zqgross");
    expect(identityNormal("Zqﬁnn")).toBe("zqfinn");
    // Joined forms of a full name all reduce to the same letters.
    for (const joined of ["ZqannaZqmeyer", "zqanna.zqmeyer", "zqanna_zqmeyer", "Zqanna-Zqmeyer"])
      expect(identityNormal(joined)).toBe(identityNormal("Zqanna Zqmeyer"));
  });

  it("a name ending in final ς matches it glued to more letters (#562 r1 nit)", () => {
    const g = compileIdentity({ names: ["Ζqνίκος"], homes: [] });
    for (const v of ["ΖqνίκοςTrial", "Ζqνίκος.trial", "ΖQΝΊΚΟΣ", "run-ζqνίκοσ-1"])
      expect(g.hit(v), v).toBe("identity");
  });

  it("plain lower-casing would NOT match (the D2 defect, pinned)", () => {
    expect("zqgross".includes("zqgroß")).toBe(false);
    expect("ZQGROSS".toLowerCase().includes("Zqgroß".toLowerCase())).toBe(false);
    expect("ZQAYDIN".toLowerCase().includes("Zqaydın".toLowerCase())).toBe(false);
  });

  it("the guard matches both directions", () => {
    const g = compileIdentity({ names: ["Hans Zqgroß"], homes: [] });
    for (const v of ["ZQGROSS", "zqgross-run", "ZqGross2", "zqgroẞ", "HANSZQGROSS"])
      expect(g.hit(v), v).toBe("identity");
    const g2 = compileIdentity({ names: ["ZQGROSS"], homes: [] });
    expect(g2.hit("zqgroß")).toBe("identity");
    expect(g2.hit("zqgroẞ-1")).toBe("identity");
    const g3 = compileIdentity({ names: ["Zqaydın"], homes: [] });
    expect(g3.hit("ZQAYDIN")).toBe("identity");
    expect(g3.hit("run-zqaydin")).toBe("identity");
  });
});

/** Configured names, each with the forms that must never go out (ASCII forms first). */
const CASES: ReadonlyArray<{ name: string; forms: readonly string[] }> = [
  { name: "Hans Zqgroß", forms: ["ZQGROSS", "zqgross-run", "ZqGross2", "HansZqgross", "zqgroß"] },
  { name: "Zqstraẞe", forms: ["ZQSTRASSE", "zqstrasse_1", "ZqStrasse", "zqstraße", "zqstraẞe"] },
  { name: "Zqaydın Zqkaya", forms: ["ZQAYDIN", "zqaydin-run", "ZqaydinZqkaya", "zqaydın"] },
  {
    name: "Zqanna Zqmeyer",
    forms: [
      "ZqannaZqmeyer",
      "zqanna.zqmeyer",
      "zqanna_zqmeyer",
      "Zqanna-Zqmeyer",
      "ZQANNAZQMEYER",
      "ZQANNA.ZQMEYER",
      "run-zqanna_zqmeyer-1",
    ],
  },
  {
    name: "Zqjürgen Zqstoß",
    forms: ["ZQJURGENZQSTOSS", "ZQSTOSS", "zqstoss.v2", "Zqjürgen-Zqstoß"],
  },
];

const IDENTITY: IdentityContext = { names: CASES.map((c) => c.name), homes: [] };
const NEEDLES = CASES.flatMap((c) => [c.name, ...c.name.split(" ").filter((w) => w.length >= 3)]);

const runFor = (value: string): ProofRunInput => {
  const run = plantEverywhere(value);
  return run.episode !== undefined && validateEpisode(run.episode).length > 0
    ? withoutEpisode(run)
    : run;
};
const NEUTRAL = runFor("zq-neutral-value");

describe("D2: every case-folded and joined form is digested in every field", () => {
  it("there are closed-id forms (the ones a grammar alone would write verbatim)", () => {
    const closed = CASES.flatMap((c) => c.forms).filter((f) => CLOSED_ID.test(f));
    expect(closed.length).toBeGreaterThan(15);
  });

  const writers = [
    ["export (backstop ON)", (r: ProofRunInput) => exportProofBundle(r, NO_CTX, IDENTITY)],
    ["assemble (backstop OFF)", (r: ProofRunInput) => assembleProofBundle(r, IDENTITY)],
  ] as const;

  for (const [mode, write] of writers) {
    it(`${mode}`, () => {
      const neutral = write(NEUTRAL);
      for (const c of CASES)
        for (const form of c.forms) {
          const b = write(runFor(form));
          expect(carriesIdentity(b, neutral, NEEDLES), `${c.name} / ${form}`).toBe(false);
          expect(b.run.runId === form, `${c.name} / ${form}: run.runId`).toBe(false);
          const r = verifyProofBundle(serializeProofBundle(b), { identity: IDENTITY });
          expect(r.ok, `${c.name} / ${form}: verify`).toBe(true);
        }
    });
  }

  it("verify refuses a forged bundle carrying a folded form (PROOF_IDENTITY)", () => {
    const honest = exportProofBundle(sampleRun(), NO_CTX);
    for (const c of CASES)
      for (const form of c.forms.filter((f) => CLOSED_ID.test(f))) {
        const b = clone(honest);
        (b.records[0]?.body as { policyId: string }).policyId = form;
        const r = verifyProofBundle(serializeProofBundle(rechain(b)), { identity: IDENTITY });
        expect(
          r.errors.map((e) => e.code),
          form,
        ).toEqual(["PROOF_IDENTITY"]);
      }
  });

  it("CLI export --identity-file digests the folded forms (bundle file and stdout)", () => {
    const dir = mkdtempSync(join(tmpdir(), "proof-casefold-"));
    const idFile = join(dir, "identity.txt");
    writeFileSync(idFile, `${CASES.map((c) => c.name).join("\n")}\n`);
    const io = () => {
      const out: string[] = [];
      return {
        out,
        io: {
          out: (s: string) => {
            out.push(s);
          },
          err: (s: string) => {
            out.push(s);
          },
        },
      };
    };
    for (const form of ["ZQGROSS", "ZQSTRASSE", "ZQAYDIN", "zqanna.zqmeyer", "ZQSTOSS"]) {
      const input = join(dir, "run.json");
      const run = withoutEpisode(plantEverywhere(form));
      const steps = run.steps.map((st) =>
        st.kind === "evidence" && st.content instanceof Uint8Array
          ? { ...st, content: new TextDecoder().decode(st.content) }
          : st,
      );
      writeFileSync(input, JSON.stringify({ ...run, steps }));
      const out = join(dir, "bundle.json");
      const c = io();
      const code = main(["export", input, "--out", out, "--identity-file", idFile], c.io);
      expect(code, form).toBe(0);
      const text = readFileSync(out, "utf8");
      expect(foldForCheck(text).includes(foldForCheck(form)), form).toBe(false);
      expect(foldForCheck(c.out.join("")).includes(foldForCheck(form)), form).toBe(false);
    }
  });
});
