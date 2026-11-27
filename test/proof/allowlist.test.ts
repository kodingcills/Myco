/**
 * Track Q (replayable proof): the allowlist guarantee, as a property.
 *
 * Acceptance bar 1 (#553): no host path or username can reach the bundle by construction.
 * A seeded generator (`path-fuzz.ts`) produces arbitrary path strings: spaces, `Documents
 * and Settings`, UNC `\\server\share` and `//server` forms, `\\?\` and `\??\` prefixes, 8.3
 * short names, mixed separators, unicode and RTL, percent / JSON / URL / entity escapes,
 * `~user`, very long strings, behind arbitrary prefixes. Each one is planted in EVERY input
 * field of a run; the run is exported, verified and reported, and no planted word (user,
 * host, share, domain or folder name) may appear in any output byte. Fields of a closed type
 * (enum, boolean, integer, digest, the ledger) are planted separately: the exporter must
 * refuse them, and the refusal must not carry the value either.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../../schemas/validate.ts";
import { validateEpisode } from "../../src/episode/validate.ts";
import { verifyAttemptLedger } from "../../src/m2/attempt-ledger.ts";
import { findLeaks } from "../../src/proof/backstop.ts";
import {
  BODY_SCHEMAS,
  BUNDLE_SCHEMA,
  exportProofBundle,
  ProofExportError,
  type ProofRunInput,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { main } from "../../src/proof/cli.ts";
import {
  CLOSED_ID,
  closedArm,
  closedId,
  closedMediaType,
  closedPolicyCode,
  FIELD_TREATMENT,
  hashedId,
  MEDIA_TYPES,
  TEXT_DIGEST_TAG,
  textDigest,
  textRef,
} from "../../src/proof/closed.ts";
import { renderProofReport } from "../../src/proof/report.ts";
import { buildLedger, clone, NO_CTX, rechain, sampleLedger, sampleRun } from "./fixture.ts";
import { makePathFuzzer } from "./path-fuzz.ts";
import { expectAbsent, exportVerifyReport, PLANTED_FIELDS, plantEverywhere } from "./plant.ts";

/** Paths planted in every string field (library export -> verify -> report). */
const FUZZ_CASES = 600;
/** Of those, how many also go through the real CLI (export -> verify -> report). */
const FUZZ_CLI_CASES = 40;
/** Paths planted in each closed-type field (export must refuse, without echo). */
const FUZZ_CLOSED_CASES = 60;
const SEED = 0x51533;

describe("property: an arbitrary host path planted in every input field never reaches an output", {
  timeout: 120_000,
}, () => {
  it(`${FUZZ_CASES} generated paths x ${PLANTED_FIELDS.length} fields: export, verify, report, no planted word`, () => {
    const next = makePathFuzzer(SEED);
    const shapes = new Set<string>();
    for (let i = 0; i < FUZZ_CASES; i++) {
      const p = next();
      shapes.add(p.shape.split(" / ")[0] as string);
      // The generator never produces a closed id (a path always has a separator, space or
      // escape); if it did, the value would be written as is and only the backstop would stand.
      expect(CLOSED_ID.test(p.value), `case ${i} (${p.shape}) is a closed id`).toBe(false);
      try {
        const { bundle } = exportVerifyReport(plantEverywhere(p.value), p.words);
        // Every string in the bundle is a closed value: a fixed constant, a closed id, a
        // code, a media type or a digest.
        for (const s of stringsOf(bundle))
          expect(isClosedString(s), `case ${i}: an open string in the bundle`).toBe(true);
      } catch (e) {
        throw new Error(`fuzz case ${i} (${p.shape}): ${(e as Error).message}`);
      }
    }
    // The generator really covers the template space, including the lower-case relative
    // `dir/<user>` class a `type/subtype` grammar admits (#553 r1 D1).
    expect(shapes.size).toBeGreaterThanOrEqual(30);
    expect([...shapes].filter((t) => t.startsWith("relative ")).length).toBeGreaterThanOrEqual(3);
  });

  it(`${FUZZ_CLI_CASES} of them through the real CLI: no planted word in any file or stdout/stderr`, () => {
    const next = makePathFuzzer(SEED);
    const dir = mkdtempSync(join(tmpdir(), "proof-fuzz-cli-"));
    for (let i = 0; i < FUZZ_CLI_CASES; i++) {
      const p = next();
      const run = plantEverywhere(p.value);
      // An episode #542 refuses: export with it must fail closed with no echo (then the run
      // is exported alone). One #542 accepts is exported and cross-checked.
      const episodeValid = run.episode !== undefined && validateEpisode(run.episode).length === 0;
      const runPath = join(dir, `RUN-${i}.json`);
      const episodePath = join(dir, `EP-${i}.json`);
      writeFileSync(episodePath, JSON.stringify(run.episode));
      const steps = run.steps.map((s) =>
        s.kind === "evidence" && s.content instanceof Uint8Array
          ? { ...s, content: new TextDecoder().decode(s.content) }
          : s,
      );
      const { episode: _e, ...rest } = run;
      writeFileSync(runPath, JSON.stringify({ ...rest, steps, episodeFile: `EP-${i}.json` }));
      const bundle = join(dir, `b-${i}.json`);
      const html = join(dir, `r-${i}.html`);
      const outs: string[] = [];
      const io = { out: (t: string) => outs.push(t), err: (t: string) => outs.push(t) };
      if (!episodeValid) {
        expect(main(["export", runPath, "--out", bundle], io), `case ${i} refused`).not.toBe(0);
        expect(outs.join(""), `case ${i}`).toContain("PROOF_EPISODE");
        writeFileSync(runPath, JSON.stringify({ ...rest, steps }));
      }
      expect(main(["export", runPath, "--out", bundle], io), `case ${i} export`).toBe(0);
      const verifyArgs = episodeValid ? ["--episode", episodePath] : [];
      expect(main(["verify", bundle, ...verifyArgs], io), `case ${i} verify`).toBe(0);
      expect(main(["report", bundle, "--out", html], io), `case ${i} report`).toBe(0);
      expectAbsent(readFileSync(bundle, "utf8"), p.words, `case ${i} bundle file`);
      expectAbsent(readFileSync(html, "utf8"), p.words, `case ${i} report file`);
      expectAbsent(outs.join(""), p.words, `case ${i} CLI output`);
    }
  });

  it(`closed-type fields: ${FUZZ_CLOSED_CASES} paths x each field: refused, and the refusal carries no planted word`, () => {
    const next = makePathFuzzer(SEED + 1);
    let refusals = 0;
    for (let i = 0; i < FUZZ_CLOSED_CASES; i++) {
      const p = next();
      for (const [field, plant] of CLOSED_FIELD_PLANTS) {
        let message = "";
        try {
          exportProofBundle(plant(p.value), NO_CTX);
        } catch (e) {
          expect(e, `${field}: not a ProofExportError`).toBeInstanceOf(ProofExportError);
          message = (e as Error).message;
        }
        expect(message, `case ${i} ${field}: exported a non-closed value`).not.toBe("");
        // Refused by the allowlist's own type check (or #518's ledger check), not only by the
        // self-verify behind it.
        expect(message, `case ${i} ${field}`).toMatch(/^PROOF_(INPUT|LEDGER_CHAIN|LEDGER_ANCHOR):/);
        expectAbsent(message, p.words, `case ${i} ${field} refusal`);
        refusals++;
      }
    }
    expect(refusals).toBe(FUZZ_CLOSED_CASES * CLOSED_FIELD_PLANTS.length);
  });
});

/** Plant a value into one closed-type field of an otherwise valid run. */
type Plant = (v: string) => ProofRunInput;
const withStep = (i: number, over: Record<string, unknown>): ProofRunInput => {
  const run = sampleRun();
  const steps = [...run.steps];
  steps[i] = { ...steps[i], ...over } as (typeof steps)[number];
  return { ...run, steps };
};
const ledgerWith = (over: Record<string, unknown>): ProofRunInput => {
  const base = sampleLedger();
  const events = base.lines.map((e, k) => (k === 2 ? { ...e, ...over } : e));
  const l = buildLedger(
    events.map(({ schema: _s, seq: _q, prevSha256: _p, ...rest }) => rest) as never,
  );
  return { ...sampleRun(), ledger: { lines: l.lines, head: l.head, trialKey: "t-ours" } };
};
const CLOSED_FIELD_PLANTS: ReadonlyArray<readonly [string, Plant]> = [
  ["run.simulated", (v) => ({ ...sampleRun(), simulated: v as never })],
  ["action.actor", (v) => withStep(1, { actor: v })],
  ["verdict.verdict", (v) => withStep(8, { verdict: v })],
  ["verdict.accepted", (v) => withStep(8, { accepted: v })],
  ["verdict.reasonCodes", (v) => withStep(8, { reasonCodes: ["ORACLE_FAIL", v] })],
  [
    "verdict.oracle.specSha256",
    (v) => withStep(8, { oracle: { family: "f", version: "1", specSha256: v } }),
  ],
  ["checkpoint.checkpoint", (v) => withStep(3, { checkpoint: v })],
  ["checkpoint.verdict", (v) => withStep(3, { verdict: v })],
  ["handoff.checkpoint", (v) => withStep(4, { checkpoint: v })],
  ["policy.decision", (v) => withStep(0, { decision: v })],
  ["ledger.trialKey", (v) => ({ ...sampleRun(), ledger: { ...sampleRun().ledger!, trialKey: v } })],
  ["ledger.lines (trialKey)", (v) => ledgerWith({ trialKey: v })],
  ["ledger.lines (taskId)", (v) => ledgerWith({ taskId: v })],
  ["ledger.lines (arm)", (v) => ledgerWith({ arm: v })],
];

/** Every string value and key in a JSON value. */
function stringsOf(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(stringsOf);
  if (v !== null && typeof v === "object")
    return Object.entries(v).flatMap(([k, x]) => [k, ...stringsOf(x)]);
  return [];
}

/** No `type/subtype` grammar here: a media type is closed only as a `MEDIA_TYPES` member (D1). */
const CLOSED_STRING =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|[0-9a-f]{64}|[A-Z][A-Z0-9_]{1,63}|hcu\+shell|myco\.[a-z0-9.-]+\/v?\d+)$/;
function isClosedString(s: string): boolean {
  return (
    CLOSED_STRING.test(s) ||
    (MEDIA_TYPES as readonly string[]).includes(s) ||
    s.startsWith("Tamper-evident, not tamper-proof:")
  );
}

describe("the closed schema has no free-text string anywhere", () => {
  /** Every string-typed node must carry a pattern, an enum or a const. */
  function openStrings(schema: JsonSchema, path: string, out: string[]): void {
    const s = schema as Record<string, unknown>;
    if (s.type === "string" && s.pattern === undefined && s.enum === undefined) out.push(path);
    for (const [k, sub] of Object.entries((s.properties as Record<string, JsonSchema>) ?? {}))
      openStrings(sub, `${path}.${k}`, out);
    if (s.items !== undefined) openStrings(s.items as JsonSchema, `${path}[]`, out);
    for (const b of (s.anyOf as JsonSchema[]) ?? []) openStrings(b, path, out);
  }

  it("bundle schema and every record body schema: no unpatterned string type", () => {
    const out: string[] = [];
    openStrings(BUNDLE_SCHEMA, "$", out);
    for (const [kind, schema] of Object.entries(BODY_SCHEMAS)) openStrings(schema, kind, out);
    expect(out).toEqual([]);
  });

  it("every object in the schema is closed (additionalProperties: false)", () => {
    const open: string[] = [];
    const walk = (schema: JsonSchema, path: string) => {
      const s = schema as Record<string, unknown>;
      if (s.properties !== undefined && s.additionalProperties !== false) open.push(path);
      for (const [k, sub] of Object.entries((s.properties as Record<string, JsonSchema>) ?? {}))
        walk(sub, `${path}.${k}`);
      if (s.items !== undefined) walk(s.items as JsonSchema, `${path}[]`);
      for (const b of (s.anyOf as JsonSchema[]) ?? []) walk(b, path);
    };
    walk(BUNDLE_SCHEMA, "$");
    for (const [kind, schema] of Object.entries(BODY_SCHEMAS)) walk(schema, kind);
    expect(open).toEqual([]);
  });

  it("a forger's free-text string in place of a digest is refused, even re-chained", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[1]?.body as unknown as { summary: unknown }).summary = "typed hello";
    expect(verifyProofBundle(serializeProofBundle(rechain(b))).errors.map((e) => e.code)).toEqual([
      "PROOF_SCHEMA",
    ]);
    const p = clone(exportProofBundle(sampleRun(), NO_CTX));
    (p.records[6]?.body as unknown as { path: unknown }).path = "run-1/x.json";
    expect(verifyProofBundle(serializeProofBundle(rechain(p))).errors.map((e) => e.code)).toEqual([
      "PROOF_SCHEMA",
    ]);
    const id = clone(exportProofBundle(sampleRun(), NO_CTX));
    (id.records[1]?.body as { tool: string }).tool = "type text";
    expect(verifyProofBundle(serializeProofBundle(rechain(id))).errors.map((e) => e.code)).toEqual([
      "PROOF_SCHEMA",
    ]);
  });
});

describe("every input field has a stated treatment, and the property test plants each one", () => {
  it("FIELD_TREATMENT = the planted string fields + the refused closed-type fields", () => {
    const planted = new Set<string>(PLANTED_FIELDS);
    const refused = new Set(CLOSED_FIELD_PLANTS.map(([f]) => f.split(" ")[0] as string));
    for (const [field, treatment] of Object.entries(FIELD_TREATMENT)) {
      const covered = planted.has(field) || refused.has(field);
      expect(covered, `${field} (${treatment}) is planted by no test`).toBe(true);
    }
    for (const f of planted) expect(f in FIELD_TREATMENT, f).toBe(true);
  });
});

describe("the structural replacements themselves", () => {
  it("textRef: a tagged sha256 of the raw value and its length; equal in, equal out", () => {
    const v = "C:\\Users\\Qzfirst Qzlast\\x";
    expect(textRef(v)).toEqual({ sha256: textDigest(v), chars: v.length });
    expect(textDigest(v)).toMatch(/^[0-9a-f]{64}$/);
    // Known-answer vector (r1 nit V3): sha256 over `myco.proof.text/1`, a NUL byte, the raw
    // value. Computed outside this code (`printf 'myco.proof.text/1\0/home/qzjdoe/x' | sha256sum`).
    expect(textDigest("/home/qzjdoe/x")).toBe(
      "31b4394e7d31bb13a3399df1a02e522088b8c4a173e16c2f0ed8fca68438e503",
    );
    expect(textDigest(v)).toBe(textDigest(`${v}`));
    expect(textDigest(v)).not.toBe(textDigest(`${v} `));
    expect(TEXT_DIGEST_TAG).toBe("myco.proof.text/1");
  });

  it("closedId: a closed id stays, anything else becomes h-<digest> (itself a closed id)", () => {
    expect(closedId("run-1")).toBe("run-1");
    expect(closedId("df-s02.v2_x")).toBe("df-s02.v2_x");
    for (const bad of ["a b", "a/b", "a\\b", "-lead", ".lead", "a:b", "é", "", "x".repeat(129)]) {
      expect(closedId(bad), bad).toBe(hashedId(bad));
      expect(CLOSED_ID.test(closedId(bad))).toBe(true);
    }
  });

  it("closedPolicyCode, closedMediaType, closedArm: closed values stay, others are hashed", () => {
    expect(closedPolicyCode("POLICY_ALLOW")).toBe("POLICY_ALLOW");
    expect(closedPolicyCode("policy allow")).toBe(hashedId("policy allow"));
    // r3 N1: a code-SHAPED value outside the enum is hashed (the old grammar wrote it as is).
    expect(closedPolicyCode("ZQGPTRR")).toBe(hashedId("ZQGPTRR"));
    expect(closedMediaType("image/png")).toBe("image/png");
    expect(closedMediaType("C:\\x")).toBe(hashedId("C:\\x"));
    expect(closedArm("hcu+shell")).toBe("hcu+shell");
    expect(closedArm("myco-gate")).toBe("myco-gate");
    expect(closedArm("my arm")).toBe(hashedId("my arm"));
  });

  it("D1: the media type is a CLOSED ENUM, not a grammar (pinned list; adding one is reviewed)", () => {
    expect([...MEDIA_TYPES]).toEqual([
      "application/json",
      "image/jpeg",
      "image/png",
      "text/csv",
      "text/plain",
    ]);
    for (const m of MEDIA_TYPES) expect(closedMediaType(m)).toBe(m);
    // Media-type-shaped values outside the enum are hashed too: shape alone never passes.
    for (const m of ["text/html", "application/xml", "TEXT/CSV", "text/csv ", "text/csv\n"])
      expect(closedMediaType(m)).toBe(hashedId(m));
  });

  it("D1: a lower-case relative dir/<user> path in mediaType never reaches an output, with no help from the backstop", () => {
    const values = [
      "srv/qzjdoe",
      "mnt/qz.doe",
      "data/qzjdoe-1",
      "opt/qzjdoe/out.csv",
      "text/qzjdoe",
      "image/qzjdoe",
    ];
    for (const v of values) {
      // The backstop does not recognise these: only the allowlist keeps them out.
      expect(findLeaks(v), v).toEqual([]);
      const run = sampleRun();
      const steps = run.steps.map((st) => (st.kind === "evidence" ? { ...st, mediaType: v } : st));
      const bundle = exportProofBundle({ ...run, steps }, NO_CTX);
      const text = serializeProofBundle(bundle);
      const evidence = bundle.records.filter((r) => r.kind === "evidence");
      expect(evidence.length).toBeGreaterThan(0);
      for (const r of evidence)
        expect((r.body as { mediaType: string }).mediaType).toBe(hashedId(v));
      expect(text.toLowerCase()).not.toContain("qzjdoe");
      expect(text.toLowerCase()).not.toContain("qz.doe");
      const result = verifyProofBundle(text);
      expect(result.ok).toBe(true);
      const html = renderProofReport(bundle, result, NO_CTX);
      expect(html.toLowerCase()).not.toContain("qzjdoe");
      expect(html.toLowerCase()).not.toContain("qz.doe");
    }
  });

  it("D1: a forged bundle carrying a raw dir/<user> mediaType is refused by the schema", () => {
    const honest = exportProofBundle(sampleRun(), NO_CTX);
    const f = clone(honest);
    const ev = f.records.find((r) => r.kind === "evidence");
    if (ev === undefined) throw new Error("fixture");
    (ev.body as { mediaType: string }).mediaType = "srv/qzjdoe";
    const r = verifyProofBundle(serializeProofBundle(rechain(f)));
    expect(r.errors.map((e) => e.code)).toContain("PROOF_SCHEMA");
    expect(JSON.stringify(r)).not.toContain("qzjdoe");
  });

  it("re-audit: a ledger id #518 admits but that spells a path (C:<user>, ..) is refused, export and verify", () => {
    for (const bad of ["C:qzjdoe", "..", "-C:qzjdoe", "a:qzjdoe"]) {
      for (const field of ["trialKey", "taskId"] as const) {
        const ledger = buildLedger([
          { kind: "start", trialKey: "t-ours", taskId: "df-s02", arm: "myco-gate", [field]: bad },
          {
            kind: "end",
            trialKey: "t-ours",
            taskId: "df-s02",
            arm: "myco-gate",
            outcome: "completed",
            [field]: bad,
          },
        ]);
        // #518's own check accepts it: the narrowing is Q's.
        expect(verifyAttemptLedger(ledger.lines).errors, `${field}=${bad}`).toEqual([]);
        const run: ProofRunInput = {
          ...sampleRun(),
          ...(field === "taskId" ? { taskId: bad } : {}),
          ledger: {
            lines: ledger.lines,
            head: ledger.head,
            trialKey: field === "trialKey" ? bad : "t-ours",
          },
        };
        let message = "";
        try {
          exportProofBundle(run, NO_CTX);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message, `${field}=${bad}`).toMatch(/^PROOF_LEDGER_CHAIN: .*closed id grammar/);
        expect(message).not.toContain("qzjdoe");
        // A forger who swaps such a ledger into an honest bundle is refused too.
        const f = clone(exportProofBundle(sampleRun(), NO_CTX)) as unknown as {
          ledger: { events: unknown[] };
        };
        f.ledger.events = ledger.lines;
        const r = verifyProofBundle(serializeProofBundle(rechain(f as never)));
        expect(
          r.errors.map((e) => e.code),
          `${field}=${bad}`,
        ).toContain("PROOF_LEDGER_CHAIN");
        expect(JSON.stringify(r)).not.toContain("qzjdoe");
      }
    }
  });

  it("re-audit: the anchor's trialKey schema is the closed id grammar, not #518's", () => {
    const f = clone(exportProofBundle(sampleRun(), NO_CTX));
    const anchor = f.records.find((r) => r.kind === "ledger-anchor");
    if (anchor === undefined) throw new Error("fixture");
    (anchor.body as { trialKey: string }).trialKey = "C:qzjdoe";
    const r = verifyProofBundle(serializeProofBundle(rechain(f)));
    expect(r.errors.map((e) => e.code)).toContain("PROOF_SCHEMA");
    expect(JSON.stringify(r)).not.toContain("qzjdoe");
  });

  it("a planted path in a hashed id still binds: the verdict's runId equals the run's", () => {
    const v = "\\\\nas\\homes\\Qzfirst Qzlast";
    const { bundle } = exportVerifyReport(plantEverywhere(v), ["Qzfirst", "Qzlast"]);
    const verdict = bundle.records.find((r) => r.kind === "verdict")?.body as { runId: string };
    expect(bundle.run.runId).toBe(hashedId(v));
    expect(verdict.runId).toBe(bundle.run.runId);
    // And a forged runId that is not the same digest is still refused (binding intact).
    const f = clone(bundle);
    (f.records.find((r) => r.kind === "verdict")?.body as { runId: string }).runId = hashedId("x");
    expect(verifyProofBundle(serializeProofBundle(rechain(f))).errors.map((e) => e.code)).toContain(
      "PROOF_VERDICT",
    );
  });
});
