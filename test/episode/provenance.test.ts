/**
 * #579 on the episode export: PROVENANCE-BOUND `h-<60 hex>` (O3) and ACCENT FOLDING (O2).
 *
 *  - an agent-supplied `h-<60 hex>` in every hashed field (text, the four ids, key and app names)
 *    is re-hashed, never written as is;
 *  - a harness-produced one (recorded in the store's hash ledger by `importDataset`, for this
 *    episode id and this exact path) is kept; the same value at another path or in another
 *    episode is re-hashed;
 *  - export -> import -> export is byte-identical, with an agent `h-<60 hex>` planted;
 *  - accented identities (and their accent-stripped forms) in every field are digested or refused.
 *
 * Every planted value is a fake word built at run time; no real identity value is printed.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeEpisode, hashed, joinedIdentity } from "../../src/episode/closed.ts";
import {
  exportDataset,
  importDataset,
  NO_FILTER,
  validateDataset,
} from "../../src/episode/export.ts";
import { fold, heldIdentity, identityEntries } from "../../src/episode/identity.ts";
import { EpisodeRecorder } from "../../src/episode/recorder.ts";
import {
  EpisodeStore,
  HASH_LEDGER_FILE,
  readHashLedger,
  readStoreDir,
} from "../../src/episode/store.ts";
import type { Episode } from "../../src/episode/types.ts";
import { canonicalJson } from "../../src/episode/validate.ts";
import { episodeScope, HashLedger } from "../../src/export-guard/provenance.ts";
import { draft, HOST, ledgerOf, scratch } from "./helpers.ts";

const made: string[] = [];
const dir = (p: string) => {
  const d = scratch(p);
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A short home path (built at run time: no home-path literal is committed), hex-encoded. */
const SMUGGLED = Buffer.from(
  ["", "Users", "qzsmug", "Documents", "x.csv"].join("/"),
  "utf8",
).toString("hex");
const AGENT_HEX = `h-${SMUGGLED.padEnd(60, "0").slice(0, 60)}`;
/** A hashed-form value made of a hex-letter identity (`cafe`). */
const CAFE = `h-${"cafe".repeat(15)}`;

/** Every hashed field of an episode carrying `v` (text, ids, key and app names). */
function everywhere(v: string): Episode {
  const root = join(dir("pv-base"), "s");
  const rec = new EpisodeRecorder({ host: HOST });
  rec.action({ kind: "type", text: "x" });
  const snap = rec.snapshot();
  EpisodeStore.open(root, { simulated: true, host: HOST }).record(
    draft({ actions: snap.actions, observations: snap.observations }),
    snap.blobs,
  );
  const base = readStoreDir(root).episodes[0] as Episode;
  return {
    ...base,
    task: { ...base.task, id: v, instruction: v },
    harness: { ...base.harness, plannerModelId: v },
    provenance: { ...base.provenance, runId: v, trialKey: v },
    actions: {
      capture: "recorded",
      truncated: false,
      items: [
        { seq: 0, atMs: null, kind: "type", text: v },
        { seq: 1, atMs: null, kind: "shell", command: v },
        { seq: 2, atMs: null, kind: "key", keys: v },
        { seq: 3, atMs: null, kind: "launch", app: v },
      ],
    },
    observations: {
      capture: "recorded",
      withheld: 0,
      items: [{ seq: 0, afterAction: 0, kind: "ui-status", text: v }],
    },
  };
}

/** The hashed fields of a closed `everywhere` episode, by path. */
function hashedFields(ep: Episode): Array<readonly [string, string | null | undefined]> {
  const a = ep.actions.items as unknown as Array<Record<string, string>>;
  const o = ep.observations.items as unknown as Array<Record<string, string>>;
  return [
    ["$.task.id", ep.task.id],
    ["$.task.instruction", ep.task.instruction],
    ["$.harness.plannerModelId", ep.harness.plannerModelId],
    ["$.provenance.runId", ep.provenance.runId],
    ["$.provenance.trialKey", ep.provenance.trialKey],
    ["$.actions.items[0].text", a[0]?.text],
    ["$.actions.items[1].command", a[1]?.command],
    ["$.actions.items[2].keys", a[2]?.keys],
    ["$.actions.items[3].app", a[3]?.app],
    ["$.observations.items[0].text", o[0]?.text],
  ];
}

describe("O3: an agent-supplied h-<60 hex> is re-hashed in every hashed field", () => {
  it.each([
    ["hex-encoded path", AGENT_HEX],
    ["hex-letter identity", CAFE],
  ])("%s: every field gets the hash of the value, never the value", (_label, v) => {
    const closed = closeEpisode(everywhere(v), [["username", "cafe"]]);
    const fields = hashedFields(closed);
    expect(fields.length).toBe(10);
    for (const [path, out] of fields) expect(out, path).toBe(hashed(v));
    expect(canonicalJson(closed).includes(v.slice(2))).toBe(false);
  });

  it("through the real export: a recorded agent h-<60 hex> never reaches the dataset", () => {
    const root = join(dir("pv-store"), "s");
    const store = EpisodeStore.open(root, { simulated: true, host: HOST });
    const rec = new EpisodeRecorder({ host: HOST });
    rec.action({ kind: "type", text: AGENT_HEX });
    rec.action({ kind: "shell", command: CAFE });
    rec.uiStatus(AGENT_HEX);
    const snap = rec.snapshot();
    expect(
      store.record(
        draft({
          actions: snap.actions,
          observations: snap.observations,
          task: { ...draft().task, id: CAFE, instruction: AGENT_HEX },
          provenance: { ...draft().provenance, runId: AGENT_HEX },
        }),
        snap.blobs,
      ).status,
    ).toBe("written");
    // A raw recording writes no ledger: only an import does.
    expect(readdirSync(root)).not.toContain(HASH_LEDGER_FILE);
    const out = join(dir("pv-out"), "ds");
    exportDataset({ stores: [root], out, simulated: true, host: HOST });
    const text = readdirSync(join(out, "episodes"))
      .map((f) => readFileSync(join(out, "episodes", f), "utf8"))
      .join("");
    expect(text.includes(SMUGGLED.slice(0, 40))).toBe(false);
    expect(text.includes("cafe".repeat(15))).toBe(false);
    expect(text.includes(hashed(AGENT_HEX))).toBe(true);
    expect(validateDataset(out, HOST)).toEqual([]);
  });
});

describe("O3: a harness-produced h-<60 hex> is kept, only where the harness produced it", () => {
  it("kept in every hashed field when the ledger records it for this episode and path", () => {
    const input = everywhere(AGENT_HEX);
    const kept = closeEpisode(input, [], ledgerOf(input));
    for (const [path, out] of hashedFields(kept)) expect(out, path).toBe(AGENT_HEX);
  });

  it("re-hashed when the ledger records it for another path, or for another episode", () => {
    const input = everywhere(AGENT_HEX);
    const otherPath = new HashLedger();
    otherPath.record(episodeScope(input.episodeId, "$.task.description"), AGENT_HEX);
    const otherEpisode = new HashLedger();
    for (const [path] of hashedFields(input))
      otherEpisode.record(episodeScope("f".repeat(64), path), AGENT_HEX);
    for (const ledger of [otherPath, otherEpisode]) {
      const closed = closeEpisode(input, [], ledger);
      for (const [path, out] of hashedFields(closed)) expect(out, path).toBe(hashed(AGENT_HEX));
    }
    // Recorded at ONE path: kept there only.
    const one = new HashLedger();
    one.record(episodeScope(input.episodeId, "$.actions.items[1].command"), AGENT_HEX);
    const closed = closeEpisode(input, [], one);
    for (const [path, out] of hashedFields(closed))
      expect(out, path).toBe(path === "$.actions.items[1].command" ? AGENT_HEX : hashed(AGENT_HEX));
  });

  it("the ledger records only the hashed form", () => {
    expect(() => new HashLedger().record("s", "plain")).toThrow(/only an h-<60 hex>/);
    expect(() => new HashLedger().record("s", `h-${"0".repeat(64)}`)).toThrow();
  });
});

describe("O3: export -> import -> export is byte-identical", () => {
  it("with agent h-<60 hex> values and hex-letter identities planted", () => {
    const a = join(dir("rt-a"), "s");
    const store = EpisodeStore.open(a, { simulated: true, host: HOST });
    for (const [i, name] of ["ada", "cafe", "beef"].entries()) {
      const rec = new EpisodeRecorder({ host: HOST });
      rec.action({ kind: "type", text: AGENT_HEX });
      rec.action({ kind: "shell", command: `echo ${name}` });
      rec.action({ kind: "key", keys: CAFE });
      rec.uiStatus(`h-${name.repeat(60).slice(0, 60)}`);
      const snap = rec.snapshot();
      store.record(
        draft({
          actions: snap.actions,
          observations: snap.observations,
          provenance: { ...draft().provenance, runId: `run-${name}-${i}`, trialKey: CAFE },
        }),
        snap.blobs,
      );
    }
    const identity = { users: ["ada", "cafe", "beef"] };
    const first = join(dir("rt-1"), "ds");
    exportDataset({ stores: [a], out: first, simulated: true, host: HOST, identity });
    const b = join(dir("rt-b"), "s");
    expect(importDataset(first, b, HOST).every((r) => r.status === "written")).toBe(true);
    expect(readdirSync(b)).toContain(HASH_LEDGER_FILE);
    const second = join(dir("rt-2"), "ds");
    exportDataset({ stores: [b], out: second, simulated: true, host: HOST, identity });
    const bytes = (d: string) =>
      [
        readFileSync(join(d, "manifest.json"), "utf8"),
        ...readdirSync(join(d, "episodes"))
          .sort()
          .map((f) => readFileSync(join(d, "episodes", f), "utf8")),
      ].join("\u0000");
    expect(bytes(second)).toBe(bytes(first));
    // A third round (import the re-export, export again) is still identical.
    const c = join(dir("rt-c"), "s");
    importDataset(second, c, HOST);
    const third = join(dir("rt-3"), "ds");
    exportDataset({ stores: [c], out: third, simulated: true, host: HOST, identity });
    expect(bytes(third)).toBe(bytes(first));
  });

  it("without the import's ledger the imported values would be re-hashed (the ledger is what keeps them)", () => {
    const a = join(dir("nl-a"), "s");
    const rec = new EpisodeRecorder({ host: HOST });
    rec.action({ kind: "type", text: "anything" });
    const snap = rec.snapshot();
    EpisodeStore.open(a, { simulated: true, host: HOST }).record(
      draft({ actions: snap.actions, observations: snap.observations }),
      snap.blobs,
    );
    const first = join(dir("nl-1"), "ds");
    exportDataset({ stores: [a], out: first, simulated: true, host: HOST });
    const b = join(dir("nl-b"), "s");
    importDataset(first, b, HOST);
    rmSync(join(b, HASH_LEDGER_FILE));
    const second = join(dir("nl-2"), "ds");
    exportDataset({ stores: [b], out: second, simulated: true, host: HOST });
    expect(readFileSync(join(second, "manifest.json"), "utf8")).not.toBe(
      readFileSync(join(first, "manifest.json"), "utf8"),
    );
  });

  it("a malformed ledger line refuses the read (fail closed)", () => {
    const a = join(dir("ml-a"), "s");
    EpisodeStore.open(a, { simulated: true, host: HOST }).record(draft(), new Map());
    const good = canonicalJson({
      episodeId: "a".repeat(64),
      path: "$.task.instruction",
      schema: "myco.episode-hash-ledger/1",
      value: AGENT_HEX,
    });
    writeFileSync(join(a, HASH_LEDGER_FILE), `${good}\n`);
    expect(
      readHashLedger(a).holds(episodeScope("a".repeat(64), "$.task.instruction"), AGENT_HEX),
    ).toBe(true);
    for (const bad of [
      "not json",
      good.replace(AGENT_HEX, `h-${"0".repeat(64)}`),
      good.replace(AGENT_HEX, "plain"),
      good.replace('"a', '"A'),
      good.replace("$.task.instruction", "$.task.C:\\\\Users"),
      good.replace("myco.episode-hash-ledger/1", "other/1"),
      good.replace("{", '{"extra":1,'),
    ]) {
      writeFileSync(join(a, HASH_LEDGER_FILE), `${bad}\n`);
      expect(() => readStoreDir(a), bad.slice(0, 20)).toThrow(/hash ledger is malformed/);
    }
    // recordHashed refuses an entry that names no stored episode.
    const store = EpisodeStore.open(a, { simulated: true, host: HOST });
    expect(() =>
      store.recordHashed("e".repeat(64), [{ path: "$.task.instruction", value: AGENT_HEX }]),
    ).toThrow(/names no stored episode/);
  });
});

describe("O2: accent folding (NFD, combining marks removed) on both sides", () => {
  it("fold matches accent-stripped and transliterated forms, both ways", () => {
    for (const [configured, written] of [
      ["josé", "JOSE"],
      ["JOSE", "josé"],
      ["reña", "rena"],
      ["Zoë", "zoe"],
      ["Søren", "SOREN"],
      ["Łukasz", "lukasz"],
      ["Ærøskøbing", "aeroskobing"],
      ["Đorđe", "DORDE"],
      ["jose\u0301", "JOSÉ"],
    ] as const)
      expect(fold(written), `${configured} ~ ${written}`).toBe(fold(configured));
  });

  // A configured full name with accents; the value in every field is its ASCII joined form.
  const NAME = ["Qzjosé", "Qzreña"].join(" ");
  const ASCII = "QZJOSE_QZRENA";
  const entries = (file: string) => identityEntries({ identityFile: file });
  const identityFile = (lines: string) => {
    const p = join(dir("pv-id"), "identity.txt");
    writeFileSync(p, lines);
    return p;
  };

  it("an accented identity's ASCII form in every hashed field is digested", () => {
    const e = entries(identityFile(`${NAME}\n`));
    expect(heldIdentity(ASCII, e)?.[0]).toBe("identity");
    const closed = closeEpisode(everywhere(ASCII), e);
    for (const [path, out] of hashedFields(closed)) expect(out, path).toBe(hashed(ASCII));
    expect(canonicalJson(closed).toLowerCase().includes("qzjose")).toBe(false);
    expect(joinedIdentity(closed, e)).toEqual([]);
  });

  it("an ASCII identity's accented form in every hashed field is digested (the other side)", () => {
    const e = entries(identityFile("Qzjose Qzrena\n"));
    const accented = "QzJosé-QzReña";
    const closed = closeEpisode(everywhere(accented), e);
    for (const [path, out] of hashedFields(closed)) expect(out, path).toBe(hashed(accented));
  });

  it("an accented identity in every closed pattern field, and in the filter, refuses the export", () => {
    const file = identityFile(`${NAME}\n`);
    const e = entries(file);
    const ep = everywhere("x");
    const closedFields: Array<[string, (v: string) => Episode]> = [
      ["$.task.family", (v) => ({ ...ep, task: { ...ep.task, family: v.toLowerCase() } })],
      ["$.task.taskSetVersion", (v) => ({ ...ep, task: { ...ep.task, taskSetVersion: v } })],
      ["$.task.faultClass", (v) => ({ ...ep, task: { ...ep.task, faultClass: v.toLowerCase() } })],
      [
        "$.harness.arm",
        (v) => ({ ...ep, harness: { ...ep.harness, arm: `myco-gate:${v.toLowerCase()}` } }),
      ],
    ];
    for (const [path, edit] of closedFields) {
      const hit = joinedIdentity(closeEpisode(edit("qzjose-qzrena"), e), e);
      expect(
        hit.map((h) => h.path),
        path,
      ).toContain(path);
    }
    // The export filter.
    const root = join(dir("pv-f"), "s");
    EpisodeStore.open(root, { simulated: true, host: HOST }).record(draft(), new Map());
    expect(() =>
      exportDataset({
        stores: [root],
        out: join(dir("pv-fo"), "ds"),
        simulated: true,
        host: HOST,
        filter: { ...NO_FILTER, taskSetVersion: "QZJOSE.QZRENA" },
        identity: { identityFile: file },
      }),
    ).toThrow(/identity string \(identity at \$\.filter\.taskSetVersion\)/);
  });
});
