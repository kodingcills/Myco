/**
 * #612 on the episode export: hash look-alikes (`src/export-guard/hash-like.ts`).
 *
 *  - D1: in a closed-pattern field the exporter never hashes (`task.family`,
 *    `task.taskSetVersion`, `task.faultClass`, `gate.oracle.family`, and the `--task-set`
 *    filter), a value shaped exactly `h-<60 hex>` is identity-checked like any other value: a
 *    hex-letter identity (`cafe`) inside it refuses the export, and `validateDataset` reports it.
 *  - D2: an id field holding a hash look-alike that is not exactly `h-<60 hex>` (`H-<60 HEX>`,
 *    `h-<64 hex>`, `h-<59 hex>`) is re-hashed by the export, and `validateDataset` refuses it in a
 *    dataset (OPEN_STRING).
 *  - A 1,000-case seeded fuzz over both rules.
 *
 * Planted identities are fake hex-letter words; no real identity value is used or printed.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EpisodeDraft } from "../../src/episode/build.ts";
import {
  CLOSED_ID,
  closeEpisode,
  ExportInputError,
  FIELD_TREATMENT,
  HASHED,
  hashed,
  joinedIdentity,
  openStrings,
} from "../../src/episode/closed.ts";
import {
  exportDataset,
  filterIdentityIssues,
  NO_FILTER,
  validateDataset,
} from "../../src/episode/export.ts";
import { heldIdentity, identityEntries } from "../../src/episode/identity.ts";
import { EpisodeStore, readStoreDir } from "../../src/episode/store.ts";
import type { Episode } from "../../src/episode/types.ts";
import { canonicalJson } from "../../src/episode/validate.ts";
import { malformedHash } from "../../src/export-guard/hash-like.ts";
import { draft, HOST, scratch } from "./helpers.ts";

const made: string[] = [];
const dir = (p: string) => {
  const d = scratch(p);
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A hex-letter identity, and `h-<60 hex>` made of it (matches every closed grammar). */
const WORD = "cafe";
const CAFE = `h-${WORD.repeat(15)}`;
const USERS = { users: [WORD] } as const;
const HEX = "0123456789abcdef";
/** 60 hex holding no hex-letter identity of 4 letters. */
const PLAIN60 = HEX.repeat(4).slice(0, 60);
const MALFORMED = [
  ["H-<60 HEX>", `H-${PLAIN60.toUpperCase()}`],
  ["h-<64 hex>", `h-${HEX.repeat(4)}`],
  ["h-<59 hex>", `h-${PLAIN60.slice(0, 59)}`],
] as const;

function base(over: Partial<EpisodeDraft> = {}): Episode {
  const root = join(dir("hl-base"), "s");
  EpisodeStore.open(root, { simulated: true, host: HOST }).record(draft(over), new Map());
  return readStoreDir(root).episodes[0] as Episode;
}

const ORACLE = (family: string) => ({ family, version: "1", specSha256: "c".repeat(64) });
type Setter = (ep: Episode, v: string) => Episode;
const CLOSED_FIELDS: ReadonlyArray<readonly [string, Setter]> = [
  ["$.task.family", (ep, v) => ({ ...ep, task: { ...ep.task, family: v } })],
  ["$.task.taskSetVersion", (ep, v) => ({ ...ep, task: { ...ep.task, taskSetVersion: v } })],
  ["$.task.faultClass", (ep, v) => ({ ...ep, task: { ...ep.task, faultClass: v } })],
  [
    "$.gate.oracle.family",
    (ep, v) => ({ ...ep, gate: { ...ep.gate, oracle: ORACLE(v) } }) as Episode,
  ],
];
const ID_FIELDS: ReadonlyArray<readonly [string, Setter, (ep: Episode) => string]> = [
  ["$.task.id", (ep, v) => ({ ...ep, task: { ...ep.task, id: v } }), (ep) => ep.task.id],
  [
    "$.provenance.runId",
    (ep, v) => ({ ...ep, provenance: { ...ep.provenance, runId: v } }),
    (ep) => ep.provenance.runId,
  ],
  [
    "$.provenance.trialKey",
    (ep, v) => ({ ...ep, provenance: { ...ep.provenance, trialKey: v } }),
    (ep) => String(ep.provenance.trialKey),
  ],
  [
    "$.harness.plannerModelId",
    (ep, v) => ({ ...ep, harness: { ...ep.harness, plannerModelId: v } }),
    (ep) => String(ep.harness.plannerModelId),
  ],
];

describe("D1: an h-<60 hex> in a closed-pattern field is identity-checked", () => {
  const e = identityEntries(USERS);

  it("every closed-pattern field: an h-<60 hex> holding an identity is reported", () => {
    expect(HASHED.test(CAFE)).toBe(true);
    for (const [path, set] of CLOSED_FIELDS) {
      expect(FIELD_TREATMENT[path]?.kind, path).toBe("closed");
      const closed = closeEpisode(set(base(), CAFE), e);
      expect(
        joinedIdentity(closed, e).map((h) => h.path),
        path,
      ).toContain(path);
    }
  });

  it("the other look-alikes in taskSetVersion holding an identity are reported too", () => {
    for (const v of [`H-${WORD.toUpperCase().repeat(15)}`, `h-${WORD.repeat(15).slice(0, 59)}`]) {
      const closed = closeEpisode(CLOSED_FIELDS[1]![1](base(), v), e);
      expect(joinedIdentity(closed, e).map((h) => h.path)).toContain("$.task.taskSetVersion");
    }
  });

  it("an h-<60 hex> holding no identity in a closed field is still accepted (no false refusal)", () => {
    for (const [path, set] of CLOSED_FIELDS) {
      const closed = closeEpisode(set(base(), `h-${PLAIN60}`), e);
      expect(joinedIdentity(closed, e), path).toEqual([]);
      expect(openStrings(closed), path).toEqual([]);
    }
  });

  it("an h-<60 hex> in an id the exporter hashes still skips the check (harness or own output)", () => {
    const closed = closeEpisode(base(), e);
    const withHash = { ...closed, task: { ...closed.task, id: CAFE } };
    expect(joinedIdentity(withHash, e)).toEqual([]);
  });

  it("through the real export: taskSetVersion and the oracle family refuse; so does the filter", () => {
    for (const [path, over] of [
      ["$.task.taskSetVersion", { task: { ...draft().task, taskSetVersion: CAFE } }],
      [
        "$.gate.oracle.family",
        {
          gate: {
            verdict: "verified",
            accepted: true,
            reasonCodes: ["ORACLE_PASS"],
            oracle: ORACLE(CAFE),
          },
        },
      ],
    ] as const) {
      const root = join(dir("hl-e"), "s");
      EpisodeStore.open(root, { simulated: true, host: HOST }).record(
        draft(over as Partial<EpisodeDraft>),
        new Map(),
      );
      expect(() =>
        exportDataset({
          stores: [root],
          out: join(dir("hl-eo"), "ds"),
          simulated: true,
          host: HOST,
          identity: USERS,
        }),
      ).toThrow(new RegExp(`identity string \\(username at \\${path}\\)`));
    }
    expect(filterIdentityIssues({ ...NO_FILTER, taskSetVersion: CAFE }, e)).toEqual([
      { class: "username", path: "$.filter.taskSetVersion" },
    ]);
    const root = join(dir("hl-f"), "s");
    EpisodeStore.open(root, { simulated: true, host: HOST }).record(draft(), new Map());
    expect(() =>
      exportDataset({
        stores: [root],
        out: join(dir("hl-fo"), "ds"),
        simulated: true,
        host: HOST,
        filter: { ...NO_FILTER, taskSetVersion: CAFE },
        identity: USERS,
      }),
    ).toThrow(/identity string \(username at \$\.filter\.taskSetVersion\)/);
  });

  it("validateDataset reports an h-<60 hex> identity planted in a closed field of a dataset", () => {
    const root = join(dir("hl-v"), "s");
    EpisodeStore.open(root, { simulated: true, host: HOST }).record(draft(), new Map());
    const out = join(dir("hl-vo"), "ds");
    exportDataset({ stores: [root], out, simulated: true, host: HOST, identity: USERS });
    expect(validateDataset(out, HOST, USERS)).toEqual([]);
    const file = readdirSync(join(out, "episodes"))[0] as string;
    const ep = JSON.parse(readFileSync(join(out, "episodes", file), "utf8")) as Episode;
    const planted = { ...ep, task: { ...ep.task, taskSetVersion: CAFE } };
    writeFileSync(join(out, "episodes", file), `${canonicalJson(planted)}\n`);
    expect(validateDataset(out, HOST, USERS)).toContainEqual(
      expect.stringMatching(/IDENTITY username at \$\.task\.taskSetVersion$/),
    );
  });
});

describe("D2: a malformed hash look-alike in an id is re-hashed, and refused in a dataset", () => {
  it("every id field, every look-alike: the export writes hashed(v), never v", () => {
    for (const [, v] of MALFORMED)
      for (const [path, set, get] of ID_FIELDS) {
        expect(CLOSED_ID.test(v), `${v} is CLOSED_ID-shaped`).toBe(true);
        const closed = closeEpisode(set(base(), v));
        expect(get(closed), path).toBe(hashed(v));
        expect(openStrings(closed), path).toEqual([]);
      }
  });

  it("openStrings (the validator) refuses each look-alike at each id path", () => {
    for (const [, v] of MALFORMED)
      for (const [path, set] of ID_FIELDS) {
        const ep = set(closeEpisode(base()), v);
        expect(openStrings(ep), `${path}`).toEqual([path]);
      }
  });

  it("through the real export and validateDataset", () => {
    const [label, v] = MALFORMED[0];
    const root = join(dir("hl-d2"), "s");
    EpisodeStore.open(root, { simulated: true, host: HOST }).record(
      draft({
        task: { ...draft().task, id: v },
        provenance: { source: "gated-trial", runId: v, trialKey: v, attemptLedger: null },
      }),
      new Map(),
    );
    const out = join(dir("hl-d2o"), "ds");
    exportDataset({ stores: [root], out, simulated: true, host: HOST });
    expect(validateDataset(out, HOST)).toEqual([]);
    const file = readdirSync(join(out, "episodes"))[0] as string;
    const text = readFileSync(join(out, "episodes", file), "utf8");
    expect(text.includes(v), label).toBe(false);
    const ep = JSON.parse(text) as Episode;
    expect(ep.task.id).toBe(hashed(v));
    for (const [l, bad] of MALFORMED) {
      writeFileSync(
        join(out, "episodes", file),
        `${canonicalJson({ ...ep, task: { ...ep.task, id: bad } })}\n`,
      );
      expect(validateDataset(out, HOST), l).toContainEqual(
        expect.stringMatching(/OPEN_STRING at \$\.task\.id /),
      );
    }
  });
});

/** mulberry32: a small seeded PRNG, so the fuzz is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hash look-alike: a prefix, a hex-ish body of 55..66 characters, maybe an identity inside. */
function lookAlike(r: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  // A quarter of the cases are exactly h-<60 hex> with the identity inside (the D1 regression).
  if (r() < 0.25) {
    const body = Array.from({ length: 56 }, () => pick([...HEX])).join("");
    const at = Math.floor(r() * 57);
    return `h-${body.slice(0, at)}${WORD}${body.slice(at)}`;
  }
  const prefix = pick(["h-", "H-", "h-", "H-", "h_", "x-", ""]);
  const alphabet = pick([HEX, HEX.toUpperCase(), `${HEX}ABCDEF`, `${HEX}ghxyz`]);
  const len = 55 + Math.floor(r() * 12);
  let body = Array.from({ length: len }, () => pick([...alphabet])).join("");
  if (r() < 0.5) {
    const w = pick([WORD, WORD.toUpperCase()]);
    const at = Math.floor(r() * (body.length - w.length));
    body = `${body.slice(0, at)}${w}${body.slice(at + w.length)}`;
  }
  return `${prefix}${body}`;
}

describe("fuzz: 1,000 seeded look-alikes on the episode export", () => {
  it("D1 and D2 hold for every case", () => {
    const e = identityEntries(USERS);
    const r = rng(612);
    const ep0 = base();
    const tally = { closedHit: 0, closedHashedHit: 0, closedRefusedGrammar: 0, idMalformed: 0 };
    for (let i = 0; i < 1000; i++) {
      const v = lookAlike(r);
      const field = Math.floor(r() * (CLOSED_FIELDS.length + ID_FIELDS.length + 1));
      if (field < CLOSED_FIELDS.length) {
        const [path, set] = CLOSED_FIELDS[field]!;
        const t = FIELD_TREATMENT[path]!;
        if (t.kind !== "closed" || !t.grammar.test(v)) {
          expect(() => closeEpisode(set(ep0, v), e), `${i}`).toThrow(ExportInputError);
          tally.closedRefusedGrammar++;
          continue;
        }
        const hit = heldIdentity(v, e) !== undefined;
        const reported = joinedIdentity(closeEpisode(set(ep0, v), e), e).some(
          (h) => h.path === path,
        );
        expect(reported, `case ${i} at ${path}`).toBe(hit);
        if (hit) tally.closedHit++;
        if (hit && HASHED.test(v)) tally.closedHashedHit++;
      } else if (field < CLOSED_FIELDS.length + ID_FIELDS.length) {
        const [path, set, get] = ID_FIELDS[field - CLOSED_FIELDS.length]!;
        const closed = closeEpisode(set(ep0, v), e);
        const out = get(closed);
        expect(malformedHash(out), `case ${i} at ${path}`).toBe(false);
        if (malformedHash(v)) {
          expect(out, `case ${i}`).toBe(hashed(v));
          tally.idMalformed++;
        }
        expect(openStrings(closed), `case ${i}`).toEqual([]);
        expect(joinedIdentity(closed, e), `case ${i}`).toEqual([]);
        // The validator side: the raw value at this id path is refused iff it is not closed.
        const accept = !malformedHash(v) && (CLOSED_ID.test(v) || HASHED.test(v));
        expect(openStrings(set(closed, v)).includes(path), `case ${i}`).toBe(!accept);
      } else {
        const hit = heldIdentity(v, e) !== undefined;
        expect(
          filterIdentityIssues({ ...NO_FILTER, taskSetVersion: v }, e).length > 0,
          `case ${i} filter`,
        ).toBe(hit);
      }
    }
    // Every category was exercised.
    expect(tally.closedHashedHit).toBeGreaterThanOrEqual(20);
    expect(tally.closedHit).toBeGreaterThan(tally.closedHashedHit);
    expect(tally.closedRefusedGrammar).toBeGreaterThanOrEqual(20);
    expect(tally.idMalformed).toBeGreaterThanOrEqual(50);
  });
});
