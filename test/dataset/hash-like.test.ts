/**
 * #612 on track U's container: hash look-alikes (`src/export-guard/hash-like.ts`), and N1.
 *
 *  - D1: in a closed-pattern field the exporter never hashes (`task.family`,
 *    `task.taskSetVersion`, `task.faultClass`, `gate.oracle.family`), a value shaped exactly
 *    `h-<60 hex>` is identity-checked like any other value: a hex-letter identity (`cafe`) inside
 *    it refuses the export (LEAK), and `validateContainer` reports it.
 *  - D2 (already held on this surface since #559 r3 S1; now the shared rule): an id holding a
 *    hash look-alike that is not exactly `h-<60 hex>` is re-hashed, and refused by the validator.
 *  - N1: a spaced ComputerName configured as an identity (`<Name>'s MacBook Pro`) no longer
 *    falsely refuses the harness's own backend name `local-process/1` (the word `pro`).
 *  - A 1,000-case seeded fuzz over D1 and D2.
 *
 * Planted identities are fake words; no real identity value is used or printed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOSED_ID,
  closeEpisode,
  closeRecordFields,
  EPISODE_FIELD_TREATMENT,
  HASHED,
  hashed,
  type JoinedIdentity,
  joinedIdentity,
  KNOWN_BACKENDS,
  OpenValueError,
  openEpisodeStrings,
  openRecordStrings,
  VERSIONED_NAME,
} from "../../src/dataset/closed.ts";
import { type Episode, episodeIdOf } from "../../src/dataset/episode.ts";
import { exportDataset, validateContainer } from "../../src/dataset/export.ts";
import { identityStrings } from "../../src/dataset/hygiene.ts";
import { LOCAL_PROCESS_BACKEND } from "../../src/desktops/local-process.ts";
import { malformedHash } from "../../src/export-guard/hash-like.ts";
import { heldEntries } from "../../src/export-guard/identity-words.ts";
import { attempt, candidate } from "./identity-fixture.ts";

const made: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `myco-u-hl-${p}-`));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const WORD = "cafe";
const CAFE = `h-${WORD.repeat(15)}`;
const HEX = "0123456789abcdef";
const PLAIN60 = HEX.repeat(4).slice(0, 60);
const MALFORMED = [
  ["H-<60 HEX>", `H-${PLAIN60.toUpperCase()}`],
  ["h-<64 hex>", `h-${HEX.repeat(4)}`],
  ["h-<59 hex>", `h-${PLAIN60.slice(0, 59)}`],
] as const;
/** The machine's own identity off (fake values), and `cafe` planted as an account name. */
const HYGIENE = { hostIdentity: false, identity: { user: WORD, host: "zz" } } as const;
const NO_HOST = { hostIdentity: false, identity: { user: "zz", host: "zz" } } as const;
const NOW = () => new Date("2026-11-27T00:00:00.000Z");
const held = (v: string, joined: readonly JoinedIdentity[]) => heldEntries(v, joined, 3).length > 0;

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
const record = (backend: string, image = "myco-linux-desktop/1") => ({
  episode: { id: "e".repeat(64) },
  desktop: { backend, image },
  capture: { path: hashed("doc.csv") },
});

describe("D1: an h-<60 hex> in a closed-pattern field is identity-checked", () => {
  const joined = identityStrings(HYGIENE);

  it("every closed-pattern field: an h-<60 hex> holding an identity is reported", () => {
    const ep0 = candidate().episode;
    for (const [path, set] of CLOSED_FIELDS) {
      expect(EPISODE_FIELD_TREATMENT[path]?.kind, path).toBe("closed");
      const closed = closeEpisode(set(ep0, CAFE), joined);
      expect(
        joinedIdentity(closed, joined).map((h) => h.path),
        path,
      ).toContain(path);
    }
  });

  it("an h-<60 hex> holding no identity in a closed field is still accepted", () => {
    const ep0 = candidate().episode;
    for (const [path, set] of CLOSED_FIELDS) {
      const closed = closeEpisode(set(ep0, `h-${PLAIN60}`), joined);
      expect(joinedIdentity(closed, joined), path).toEqual([]);
      expect(openEpisodeStrings(closed), path).toEqual([]);
    }
  });

  it("through the real export: each closed field refuses (LEAK), the value never printed", () => {
    const base = candidate();
    for (const [path, over] of [
      ["$.task.family", { task: { ...base.episode.task, family: CAFE } }],
      ["$.task.taskSetVersion", { task: { ...base.episode.task, taskSetVersion: CAFE } }],
      ["$.task.faultClass", { task: { ...base.episode.task, faultClass: CAFE } }],
    ] as const) {
      const r = attempt(candidate(over as Parameters<typeof candidate>[0]), HYGIENE);
      expect(r.refused?.code, path).toBe("LEAK");
      expect(r.refused?.message, path).toContain(path);
      expect(r.refused?.message.includes(CAFE), path).toBe(false);
    }
    // The drafter writes no oracle, so the oracle family is planted on the episode itself.
    const withOracle = CLOSED_FIELDS[3]![1](base.episode, CAFE);
    const r = attempt(
      { ...base, episode: { ...withOracle, episodeId: episodeIdOf(withOracle) } },
      HYGIENE,
    );
    expect(r.refused?.code).toBe("LEAK");
    expect(r.refused?.message).toContain("$.gate.oracle.family");
  });

  it("validateContainer reports an h-<60 hex> identity planted in a closed field", () => {
    const out = join(tmp("v"), "ds");
    exportDataset([candidate()], { outDir: out, hygiene: HYGIENE, now: NOW });
    expect(validateContainer(out, HYGIENE)).toEqual([]);
    const rec = JSON.parse(readFileSync(join(out, "records.jsonl"), "utf8").trim());
    const ep = JSON.parse(readFileSync(join(out, rec.episode.file), "utf8")) as Episode;
    writeFileSync(
      join(out, rec.episode.file),
      `${JSON.stringify({ ...ep, task: { ...ep.task, taskSetVersion: CAFE } })}\n`,
    );
    expect(validateContainer(out, HYGIENE)).toContainEqual(
      expect.stringMatching(/^LEAK .*:\$\.task\.taskSetVersion username$/),
    );
  });
});

describe("D2: a malformed hash look-alike in an id is re-hashed and refused", () => {
  it("every id and desktop field, every look-alike: the export writes hashed(v)", () => {
    const ep0 = candidate().episode;
    for (const [, v] of MALFORMED) {
      for (const [path, set, get] of ID_FIELDS) {
        const closed = closeEpisode(set(ep0, v));
        expect(get(closed), path).toBe(hashed(v));
        expect(openEpisodeStrings(closed), path).toEqual([]);
        expect(openEpisodeStrings(set(closed, v)), path).toEqual([path]);
      }
      const rec = closeRecordFields(record(v, v));
      expect([rec.desktop.backend, rec.desktop.image]).toEqual([hashed(v), hashed(v)]);
      expect(openRecordStrings(record(v, v))).toEqual(["$.desktop.backend", "$.desktop.image"]);
    }
  });
});

describe("N1: a spaced ComputerName does not falsely refuse local-process/1", () => {
  const identityFile = () => {
    const p = join(tmp("n1"), "identity.txt");
    // A fake ComputerName in the macOS default shape: `<Name>'s MacBook Pro`.
    writeFileSync(p, ["Qzname's", "MacBook", "Pro"].join(" ").concat("\n"));
    return p;
  };

  it("the backend list is exactly the harness's own backend name", () => {
    expect(KNOWN_BACKENDS).toEqual([LOCAL_PROCESS_BACKEND]);
    expect(VERSIONED_NAME.test(LOCAL_PROCESS_BACKEND)).toBe(true);
  });

  it("export and validate both keep local-process/1, with the ComputerName configured", () => {
    const hygiene = { ...NO_HOST, identityFile: identityFile() };
    const joined = identityStrings(hygiene);
    // The word `pro` is looked for alone (3+ characters), and it is inside the backend name.
    expect(held(LOCAL_PROCESS_BACKEND, joined)).toBe(true);
    expect(joinedIdentity(record(LOCAL_PROCESS_BACKEND), joined, "record")).toEqual([]);
    expect(closeRecordFields(record(LOCAL_PROCESS_BACKEND), joined).desktop.backend).toBe(
      LOCAL_PROCESS_BACKEND,
    );
    // Exported without the identity file, validated with it (the verifier's case).
    const out = join(tmp("n1o"), "ds");
    exportDataset([candidate()], { outDir: out, hygiene: NO_HOST, now: NOW });
    expect(validateContainer(out, hygiene)).toEqual([]);
    const r = attempt(candidate(), hygiene);
    expect(r.refused).toBeNull();
    expect(r.valid).toEqual([]);
  });

  it("only the exact name is exempt: another backend holding the word is still digested", () => {
    const joined = identityStrings({ ...NO_HOST, identityFile: identityFile() });
    for (const other of ["local-process/2", "proxy-desktop/1", `${LOCAL_PROCESS_BACKEND}x`]) {
      expect(closeRecordFields(record(other), joined).desktop.backend, other).toBe(hashed(other));
      expect(
        joinedIdentity(record(other), joined, "record").map((h) => h.path),
        other,
      ).toContain("$.desktop.backend");
    }
    // The image field has no exemption, even for the backend's own name.
    expect(
      joinedIdentity(record(LOCAL_PROCESS_BACKEND, LOCAL_PROCESS_BACKEND), joined, "record").map(
        (h) => h.path,
      ),
    ).toEqual(["$.desktop.image"]);
  });
});

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

function lookAlike(r: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
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

describe("fuzz: 1,000 seeded look-alikes on track U's container", () => {
  it("D1 and D2 hold for every case", () => {
    const joined = identityStrings(HYGIENE);
    const r = rng(6120);
    const ep0 = candidate().episode;
    const tally = { closedHashedHit: 0, closedRefusedGrammar: 0, idMalformed: 0, desktop: 0 };
    for (let i = 0; i < 1000; i++) {
      const v = lookAlike(r);
      const field = Math.floor(r() * (CLOSED_FIELDS.length + ID_FIELDS.length + 1));
      if (field < CLOSED_FIELDS.length) {
        const [path, set] = CLOSED_FIELDS[field]!;
        const t = EPISODE_FIELD_TREATMENT[path]!;
        if (t.kind !== "closed" || !t.grammar.test(v)) {
          expect(() => closeEpisode(set(ep0, v), joined), `${i}`).toThrow(OpenValueError);
          tally.closedRefusedGrammar++;
          continue;
        }
        const reported = joinedIdentity(closeEpisode(set(ep0, v), joined), joined).some(
          (h) => h.path === path,
        );
        expect(reported, `case ${i} at ${path}`).toBe(held(v, joined));
        if (held(v, joined) && HASHED.test(v)) tally.closedHashedHit++;
      } else if (field < CLOSED_FIELDS.length + ID_FIELDS.length) {
        const [path, set, get] = ID_FIELDS[field - CLOSED_FIELDS.length]!;
        const closed = closeEpisode(set(ep0, v), joined);
        const out = get(closed);
        expect(malformedHash(out), `case ${i} at ${path}`).toBe(false);
        if (malformedHash(v)) {
          expect(out, `case ${i}`).toBe(hashed(v));
          tally.idMalformed++;
        }
        expect(openEpisodeStrings(closed), `case ${i}`).toEqual([]);
        expect(joinedIdentity(closed, joined), `case ${i}`).toEqual([]);
        const accept = !malformedHash(v) && (CLOSED_ID.test(v) || HASHED.test(v));
        expect(openEpisodeStrings(set(closed, v)).includes(path), `case ${i}`).toBe(!accept);
      } else {
        // A record's desktop facts (ids with the versioned-name grammar).
        const rec = closeRecordFields(record(v, v), joined);
        expect(malformedHash(rec.desktop.backend), `case ${i}`).toBe(false);
        expect(malformedHash(rec.desktop.image), `case ${i}`).toBe(false);
        expect(openRecordStrings(rec), `case ${i}`).toEqual([]);
        expect(joinedIdentity(rec, joined, "record"), `case ${i}`).toEqual([]);
        tally.desktop++;
      }
    }
    expect(tally.closedHashedHit).toBeGreaterThanOrEqual(20);
    expect(tally.closedRefusedGrammar).toBeGreaterThanOrEqual(20);
    expect(tally.idMalformed).toBeGreaterThanOrEqual(50);
    expect(tally.desktop).toBeGreaterThanOrEqual(50);
  });
});
