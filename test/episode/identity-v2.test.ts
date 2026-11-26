/**
 * The episode export's identity check after #556's final verdict (B1-B3, S1-S3), #553's two
 * classes (host identity always merged; full Unicode case folding) and F1 (lead ruling 22:18Z).
 * Every planted value is a fake word built at run time; no real identity value is ever printed.
 */
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeEpisode,
  joinedIdentity,
  KNOWN_KEYS,
  openStrings,
  REGISTERED_APPS,
} from "../../src/episode/closed.ts";
import { exportDataset, NO_FILTER, validateDataset } from "../../src/episode/export.ts";
import {
  fold,
  GENERIC_ACCOUNTS,
  type IdentityEntry,
  identityEntries,
} from "../../src/episode/identity.ts";
import { EpisodeRecorder } from "../../src/episode/recorder.ts";
import { EpisodeStore, readStoreDir } from "../../src/episode/store.ts";
import type { Episode } from "../../src/episode/types.ts";
import { canonicalJson, episodeIdOf, sha256Hex } from "../../src/episode/validate.ts";
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

const PLANTED = ["qzplant", "user"].join("");
const planted = { users: [PLANTED] };
type Draft = ReturnType<typeof draft>;

/** One stored episode (built by `edit`), exported: the refusal message or the dataset dir. */
function exportEdited(edit: (d: Draft) => Draft, identity = {}) {
  const root = join(dir("v2-store"), "s");
  const store = EpisodeStore.open(root, { simulated: true, host: HOST });
  const r = store.record(draft(edit(draft())), new Map());
  expect(r.status).toBe("written");
  const out = join(dir("v2-out"), "ds");
  try {
    exportDataset({ stores: [root], out, simulated: true, host: HOST, identity });
    return { refused: null as string | null, out };
  } catch (e) {
    return { refused: (e as Error).message, out };
  }
}
const datasetText = (out: string) =>
  readdirSync(join(out, "episodes"))
    .map((f) => readFileSync(join(out, "episodes", f), "utf8"))
    .join("") + readFileSync(join(out, "manifest.json"), "utf8");

/** A stored episode as the export reads it. */
function baseEpisode(): Episode {
  const root = join(dir("v2-base"), "s");
  const rec = new EpisodeRecorder({ host: HOST });
  rec.action({ kind: "type", text: "x" });
  const snap = rec.snapshot();
  EpisodeStore.open(root, { simulated: true, host: HOST }).record(
    draft({ actions: snap.actions, observations: snap.observations }),
    snap.blobs,
  );
  return readStoreDir(root).episodes[0] as Episode;
}

/** Hand-edit a dataset's manifest (its filter), keeping it otherwise as written. */
function editManifest(out: string, edit: (m: Record<string, unknown>) => void) {
  const p = join(out, "manifest.json");
  const m = JSON.parse(readFileSync(p, "utf8"));
  edit(m);
  writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
}

/** Hand-edit a dataset's first episode, re-addressing it and making every hash consistent. */
function rewriteFirstEpisode(out: string, edit: (ep: Episode) => Episode): void {
  const manifestPath = join(out, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.files.find((f: { path: string }) => f.path.startsWith("episodes/"));
  const ep = JSON.parse(readFileSync(join(out, entry.path), "utf8")) as Episode;
  const { episodeId: _x, ...rest } = edit(ep);
  const withId = { ...rest, episodeId: episodeIdOf(rest) } as Episode;
  const bytes = Buffer.from(`${canonicalJson(withId)}\n`);
  const path = `episodes/${withId.episodeId}.json`;
  renameSync(join(out, entry.path), join(out, path));
  writeFileSync(join(out, path), bytes);
  Object.assign(entry, { path, sha256: sha256Hex(bytes), bytes: bytes.length });
  manifest.files.sort((a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1));
  manifest.datasetSha256 = sha256Hex(canonicalJson(manifest.files));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("B1: validateDataset checks the manifest's filter (grammar and identity)", () => {
  it("a hand-edited filter carrying a path, or an identity in the arm or task set, is refused, never by value", () => {
    const root = join(dir("v2-empty"), "s");
    EpisodeStore.open(root, { simulated: true, host: HOST });
    const out = join(dir("v2-empty-out"), "ds");
    exportDataset({ stores: [root], out, simulated: true, host: HOST });
    expect(validateDataset(out, HOST, planted)).toEqual([]);
    const spaced = ["C:", "\\Users\\", "First Last", "\\x"].join("");
    editManifest(out, (m) => {
      (m.filter as Record<string, unknown>).taskSetVersion = spaced;
    });
    const ps1 = validateDataset(out, HOST, planted);
    expect(ps1).toContain(
      "manifest filter: invalid filter: taskSetVersion is not a closed task-set id",
    );
    expect(ps1.some((p) => p.includes("First"))).toBe(false);
    for (const [field, value] of [
      ["arm", `myco-gate:${PLANTED}`],
      ["taskSetVersion", PLANTED.toUpperCase()],
      ["taskSetVersion", `xx${PLANTED}9`],
    ] as const) {
      editManifest(out, (m) => {
        m.filter = { ...NO_FILTER, [field]: value };
      });
      const ps = validateDataset(out, HOST, planted);
      expect(ps).toContain(`manifest filter: IDENTITY username at $.filter.${field}`);
      expect(ps.some((p) => p.toLowerCase().includes(PLANTED))).toBe(false);
    }
  });

  it("the export's filter check covers the arm and any case (K3, K4)", () => {
    const root = join(dir("v2-f"), "s");
    EpisodeStore.open(root, { simulated: true, host: HOST }).record(draft(), new Map());
    for (const [field, value] of [
      ["arm", `myco-gate:${PLANTED}`],
      ["taskSetVersion", PLANTED.toUpperCase()],
      ["taskSetVersion", "QzPlantUser"],
    ] as const)
      expect(() =>
        exportDataset({
          stores: [root],
          out: join(dir("v2-fo"), "ds"),
          simulated: true,
          host: HOST,
          identity: planted,
          filter: { ...NO_FILTER, [field]: value },
        }),
      ).toThrow(`(username at $.filter.${field})`);
  });
});

describe("B2: a spaced full name matches every joined form of it", () => {
  const full = ["Qzvfirst", " ", "Plantlast"].join("");
  const forms = [
    "QzvfirstPlantlast",
    "qzvfirst.plantlast",
    "qzvfirst_plantlast",
    "Qzvfirst-Plantlast",
    "QZVFIRSTPLANTLAST",
    "xxqzvfirstplantlast9",
  ];

  it("digested in an id, refused in a closed field, refused by validateDataset", () => {
    const file = join(dir("v2-full"), "identity.txt");
    writeFileSync(file, `${full}\n`);
    const identity = { identityFile: file };
    for (const v of forms) {
      const id = exportEdited((d) => ({ ...d, task: { ...d.task, id: v } }), identity);
      expect(id.refused, v).toBeNull();
      expect(datasetText(id.out).toLowerCase().includes(v.toLowerCase()), v).toBe(false);
      const closed = exportEdited(
        (d) => ({ ...d, task: { ...d.task, taskSetVersion: v.replace(/[^A-Za-z0-9._-]/g, "") } }),
        identity,
      );
      expect((closed.refused ?? "").includes("(identity at $.task.taskSetVersion)"), v).toBe(true);
    }
    const r = exportEdited((d) => d);
    rewriteFirstEpisode(r.out, (ep) => ({ ...ep, task: { ...ep.task, id: "qzvfirst.plantlast" } }));
    expect(validateDataset(r.out, HOST, identity)).toEqual([
      expect.stringMatching(/: IDENTITY identity at \$\.task\.id$/),
    ]);
  });
});

describe("B3 (K1, K2): every non-exempt closed field refuses an identity, in the cases its grammar allows", () => {
  const joined: IdentityEntry[] = [["username", PLANTED]];
  const fields: [string, (ep: Episode, v: string) => Episode, string[]][] = [
    ["$.task.family", (ep, v) => ({ ...ep, task: { ...ep.task, family: v } }), [PLANTED]],
    [
      "$.task.taskSetVersion",
      (ep, v) => ({ ...ep, task: { ...ep.task, taskSetVersion: v } }),
      [PLANTED, PLANTED.toUpperCase(), "QzPlantUser"],
    ],
    ["$.task.faultClass", (ep, v) => ({ ...ep, task: { ...ep.task, faultClass: v } }), [PLANTED]],
    [
      "$.gate.oracle.family",
      (ep, v) => ({
        ...ep,
        gate: {
          verdict: "verified",
          accepted: true,
          reasonCodes: ["ORACLE_PASS"],
          oracle: { family: v, version: "1", specSha256: "c".repeat(64) },
        },
      }),
      [PLANTED],
    ],
    [
      "$.gate.oracle.version",
      (ep, v) => ({
        ...ep,
        gate: {
          verdict: "verified",
          accepted: true,
          reasonCodes: ["ORACLE_PASS"],
          oracle: { family: "calc", version: v, specSha256: "c".repeat(64) },
        },
      }),
      [PLANTED, PLANTED.toUpperCase(), "QzPlantUser"],
    ],
    [
      "$.groundTruth.graderVersion",
      (ep, v) => ({
        ...ep,
        groundTruth: {
          source: "independent-grader",
          graderVersion: `${v}/1`,
          status: "pass",
          targetSatisfied: true,
          mismatchCount: 0,
          fixtureSha256: "d".repeat(64),
          persistedSha256: null,
        },
      }),
      [PLANTED],
    ],
    [
      "$.harness.arm",
      (ep, v) => ({ ...ep, harness: { ...ep.harness, arm: v } }),
      [`myco-gate:${PLANTED}`, `hcu+shell:x${PLANTED}9`],
    ],
    [
      "$.harness.fault.code",
      (ep, v) => ({ ...ep, harness: { ...ep.harness, fault: { class: "timeout", code: v } } }),
      [PLANTED.toUpperCase(), `X_${PLANTED.toUpperCase()}_9`],
    ],
  ];
  for (const [path, put, values] of fields)
    it(path, () => {
      for (const v of values) {
        const closed = closeEpisode(put(baseEpisode(), v), joined);
        expect(
          joinedIdentity(closed, joined).some((x) => x.path === path && x.class === "username"),
          v,
        ).toBe(true);
      }
    });
});

describe("the identity file, the floor and the generic list", () => {
  it("CRLF lines and a byte-order mark are read cleanly (K5)", () => {
    const file = join(dir("v2-crlf"), "identity.txt");
    writeFileSync(file, "﻿qzbomalias\r\n# comment\r\nqzcrlfalias\r\n\r\n");
    const ids = identityEntries({ identityFile: file })
      .filter(([c]) => c === "identity")
      .map(([, v]) => v);
    expect(ids).toEqual(["qzbomalias", "qzcrlfalias"]);
  });

  it("a missing identity file refuses without naming its path", () => {
    const missing = join(dir("v2-miss"), "QzPLANTEDsecretdir", "identity.txt");
    let message = "";
    try {
      identityEntries({ identityFile: missing });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("export refused: the identity file cannot be read");
  });

  it("the floor is 3 folded characters; the generic list is #560's exactly", () => {
    expect(
      closeEpisode({ ...baseEpisode(), task: { ...baseEpisode().task, id: "zqx-1" } }, [
        ["username", "zqx"],
      ]).task.id,
    ).toMatch(/^h-/);
    expect(identityEntries({ users: ["zq"] }).some(([, v]) => v === "zq")).toBe(false);
    expect(identityEntries({ users: ["zqx"] }).some(([, v]) => v === "zqx")).toBe(true);
    expect([...GENERIC_ACCOUNTS].sort()).toEqual([
      "admin",
      "codespace",
      "nobody",
      "node",
      "root",
      "runner",
      "ubuntu",
      "user",
      "vscode",
    ]);
    expect(
      identityEntries({ users: ["runner", "ROOT"] }).some(
        ([, v]) => v === "runner" || v === "ROOT",
      ),
    ).toBe(false);
  });
});

describe("S1-S3 and #553's full Unicode case folding", () => {
  it("S1: a hex-letter identity inside a blob file name or a digest is not a false refusal", () => {
    const joined: IdentityEntry[] = [["username", "abc"]];
    const ep = baseEpisode();
    const withBlob: Episode = {
      ...ep,
      observations: {
        capture: "recorded",
        withheld: 0,
        items: [
          {
            seq: 0,
            afterAction: 0,
            kind: "state",
            label: "persisted",
            mediaType: "text/csv",
            sha256: `abc${"0".repeat(61)}`,
            bytes: 9,
            file: `blobs/abc${"0".repeat(61)}.csv`,
          },
        ],
      },
    };
    expect(joinedIdentity(closeEpisode(withBlob, joined), joined)).toEqual([]);
  });

  it("S2: an already-hashed id or token stays as it is, even when an identity's letters occur in the hash", () => {
    const ep = baseEpisode();
    const id = `h-${"abcd".repeat(15)}`;
    const key = `h-${"abcd".repeat(15)}`;
    const closed = closeEpisode(
      {
        ...ep,
        provenance: { ...ep.provenance, trialKey: id },
        actions: {
          capture: "recorded",
          truncated: false,
          items: [{ seq: 0, atMs: null, kind: "key", keys: key }],
        },
        observations: { capture: "recorded", withheld: 0, items: [] },
      },
      [["username", "abcd"]],
    );
    expect(closed.provenance.trialKey).toBe(id);
    expect((closed.actions.items[0] as { keys: string }).keys).toBe(key);
  });

  it("full Unicode case folding: ß, ẞ, ı, İ and NFKC forms match their ASCII spellings, both ways", () => {
    expect(fold("Groß")).toBe("gross");
    expect(fold("GROẞ")).toBe("gross");
    expect(fold("Yıldız")).toBe("yildiz");
    expect(fold("İpek")).toBe("ipek");
    for (const [configured, written] of [
      ["Groß", "GROSS"],
      ["GROẞ", "gross-1"],
      ["Yıldız", "YILDIZ2"],
      ["yildiz", "xx-yildiz"],
      ["Ｇｒｏß", "GROSS"],
      ["ﬁlip", "FILIP-1"],
    ] as const) {
      const joined: IdentityEntry[] = [["identity", configured]];
      const closed = closeEpisode(
        { ...baseEpisode(), task: { ...baseEpisode().task, id: written } },
        joined,
      );
      expect(/^h-[0-9a-f]{60}$/.test(closed.task.id), `${configured} / ${written}`).toBe(true);
      expect(closeEpisode(baseEpisode(), joined).task.id).toBe(baseEpisode().task.id);
    }
  });
});

describe("F1 (lead ruling 22:18Z): key and app names are verbatim only from a closed vocabulary", () => {
  const closeActions = (items: Episode["actions"]["items"]) =>
    closeEpisode({
      ...baseEpisode(),
      actions: { capture: "recorded", truncated: false, items },
      observations: { capture: "recorded", withheld: 0, items: [] },
    }).actions.items as unknown as readonly { keys?: string; app?: string }[];
  const hashed = /^h-[0-9a-f]{60}$/;

  it("a known key (or combination) and a registered app pass verbatim", () => {
    for (const keys of ["ctrl+s", "Return", "F5", "ctrl+shift+Tab", "a", "escape", "pagedown"])
      expect(closeActions([{ seq: 0, atMs: null, kind: "key", keys }])[0]?.keys, keys).toBe(keys);
    for (const app of ["localc", "lowriter", "soffice", "libreoffice", "scalc", "swriter"])
      expect(closeActions([{ seq: 0, atMs: null, kind: "launch", app }])[0]?.app, app).toBe(app);
  });

  it("an unknown key, an identity-like value, a path and a near-miss spelling are hashed", () => {
    for (const k of [
      "hyperkey",
      "jsmith",
      "Users.jsmith.Documents",
      "C:Users",
      "ctrl+ss",
      "f13",
      "retrun",
      "localc",
    ])
      expect(
        hashed.test(closeActions([{ seq: 0, atMs: null, kind: "key", keys: k }])[0]?.keys ?? ""),
        k,
      ).toBe(true);
    for (const a of [
      "jsmith",
      "Users.jsmith.Documents",
      "localc fixture.csv",
      "locaIc",
      "localc2",
      "LOCALC",
      "soffice.bin",
      "bash",
    ])
      expect(
        hashed.test(closeActions([{ seq: 0, atMs: null, kind: "launch", app: a }])[0]?.app ?? ""),
        a,
      ).toBe(true);
  });

  it("the vocabularies are anchored; an identity that is a vocabulary word is still hashed; openStrings holds them to it", () => {
    expect(KNOWN_KEYS.test("xctrl+s") || KNOWN_KEYS.test("ctrl+sx")).toBe(false);
    expect(REGISTERED_APPS.test("xlocalc") || REGISTERED_APPS.test("localcx")).toBe(false);
    const withId = closeEpisode(
      {
        ...baseEpisode(),
        actions: {
          capture: "recorded",
          truncated: false,
          items: [{ seq: 0, atMs: null, kind: "launch", app: "localc" }],
        },
        observations: { capture: "recorded", withheld: 0, items: [] },
      },
      [["identity", "localc"]],
    );
    expect(hashed.test((withId.actions.items[0] as { app: string }).app)).toBe(true);
    const ep = closeEpisode({
      ...baseEpisode(),
      actions: {
        capture: "recorded",
        truncated: false,
        items: [{ seq: 0, atMs: null, kind: "launch", app: "localc" }],
      },
      observations: { capture: "recorded", withheld: 0, items: [] },
    });
    expect(openStrings(ep)).toEqual([]);
    expect(
      openStrings({
        ...ep,
        actions: { ...ep.actions, items: [{ ...ep.actions.items[0], app: "jsmith" }] },
      }),
    ).toEqual(["$.actions.items[0].app"]);
  });
});

describe("the one hashed form, h-<60 hex> (lead ruling 23:06Z)", () => {
  const exact = `h-${"0123456789abcdef".repeat(4).slice(0, 60)}`;
  const old64 = `h-${"0123456789abcdef".repeat(4)}`;
  const withAll = (v: string): Episode => ({
    ...baseEpisode(),
    task: { ...baseEpisode().task, instruction: v, id: v },
    actions: {
      capture: "recorded",
      truncated: false,
      items: [
        { seq: 0, atMs: null, kind: "shell", command: v },
        { seq: 1, atMs: null, kind: "key", keys: v.slice(0, 64) },
      ],
    },
    observations: { capture: "recorded", withheld: 0, items: [] },
  });

  it("every hashed field is exactly h- and 60 hex (text, id and token alike)", () => {
    const closed = closeEpisode(withAll("C:\\Users\\First Last\\x"));
    const items = closed.actions.items as unknown as readonly { command?: string; keys?: string }[];
    for (const v of [closed.task.instruction, closed.task.id, items[0]?.command, items[1]?.keys])
      expect(/^h-[0-9a-f]{60}$/.test(v ?? "") && (v ?? "").length === 62, String(v?.length)).toBe(
        true,
      );
  });

  it("an exact h-<60 hex> is kept as is everywhere; no other h- form is treated as already hashed", () => {
    const kept = closeEpisode(withAll(exact));
    const items = kept.actions.items as unknown as readonly { command?: string; keys?: string }[];
    expect([kept.task.instruction, kept.task.id, items[0]?.command, items[1]?.keys]).toEqual([
      exact,
      exact,
      exact,
      exact,
    ]);
    for (const other of [
      old64,
      `h-${"0".repeat(59)}`,
      `h-${"0".repeat(61)}`,
      `h-${"A".repeat(60)}`,
    ]) {
      const closed = closeEpisode(withAll(other));
      expect(closed.task.instruction, String(other.length)).not.toBe(other);
      expect(/^h-[0-9a-f]{60}$/.test(closed.task.instruction ?? "")).toBe(true);
    }
  });
});
