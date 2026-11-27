/**
 * #580 O1 on the episode export (lead ruling 02:55Z): a SINGLE WORD of a configured full name
 * (`<first>_trial`, `<Last>2`, `xx<first>`, `<first>Trial`, camelCase joins, accented and case
 * variants) is caught exactly as Q bundles and the track U container catch it, through the one
 * shared rule (`src/export-guard/identity-words.ts`): digested in every id and token field,
 * refused in every other closed field, the export filter and `validateDataset`. Words of 1 or 2
 * characters are not looked for alone. O4 (unconfigured names) is a documented residual; a test
 * pins it so the docs stay true.
 *
 * Every planted value is a fake word built at run time; no value is printed (booleans compared).
 */
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeEpisode, hashed, joinedIdentity, openStrings } from "../../src/episode/closed.ts";
import { exportDataset, NO_FILTER, validateDataset } from "../../src/episode/export.ts";
import { heldIdentity, identityEntries } from "../../src/episode/identity.ts";
import { EpisodeRecorder } from "../../src/episode/recorder.ts";
import { EpisodeStore, readStoreDir } from "../../src/episode/store.ts";
import type { Episode } from "../../src/episode/types.ts";
import { canonicalJson, episodeIdOf, sha256Hex } from "../../src/episode/validate.ts";
import { IDENTITY_WORD_MIN_CHARS } from "../../src/export-guard/identity-words.ts";
import { draft, HOST, scratch } from "./helpers.ts";
import { makePathFuzzer, mulberry32 } from "./path-fuzz.ts";

const made: string[] = [];
const dir = (p: string) => {
  const d = scratch(p);
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FIRST = ["Qzw", "first"].join("");
const LAST = ["Qzw", "last"].join("");
const FULL = `${FIRST} ${LAST}`;
/** A 3-character word (the pinned minimum) and a 2-character one (below it). */
const THREE = ["Zq", "v"].join("");
const TWO = ["Z", "y"].join("");
/** An accented full name and the ASCII full name it folds to. */
const ACCENTED = ["Qzwjosé", "Qzwreña"].join(" ");
const ASCII_NAME = ["Qzwjose", "Qzwrena"].join(" ");

/** Single-word forms of `FULL` (alone and joined), every one a closed id. */
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

function identityFile(...lines: string[]): string {
  const p = join(dir("iw-id"), "identity.txt");
  writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
}

/** A stored episode as the export reads it. */
function baseEpisode(): Episode {
  const root = join(dir("iw-base"), "s");
  const rec = new EpisodeRecorder({ host: HOST });
  rec.action({ kind: "type", text: "x" });
  const snap = rec.snapshot();
  EpisodeStore.open(root, { simulated: true, host: HOST }).record(
    draft({ actions: snap.actions, observations: snap.observations }),
    snap.blobs,
  );
  return readStoreDir(root).episodes[0] as Episode;
}

/** Every id, token and text field of an episode carrying `v`. */
function everywhere(base: Episode, v: string): Episode {
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

/** The id and token fields (verbatim when closed and identity-free) of a closed episode. */
function idTokenFields(ep: Episode): Array<readonly [string, unknown]> {
  const a = ep.actions.items as unknown as Array<Record<string, string>>;
  return [
    ["$.task.id", ep.task.id],
    ["$.harness.plannerModelId", ep.harness.plannerModelId],
    ["$.provenance.runId", ep.provenance.runId],
    ["$.provenance.trialKey", ep.provenance.trialKey],
    ["$.actions.items[2].keys", a[2]?.keys],
    ["$.actions.items[3].app", a[3]?.app],
  ];
}

/** Every non-exempt closed pattern field, shaped to its grammar. */
const CLOSED_FIELDS: ReadonlyArray<readonly [string, (ep: Episode, v: string) => Episode]> = [
  ["$.task.family", (ep, v) => ({ ...ep, task: { ...ep.task, family: v.toLowerCase() } })],
  ["$.task.taskSetVersion", (ep, v) => ({ ...ep, task: { ...ep.task, taskSetVersion: v } })],
  ["$.task.faultClass", (ep, v) => ({ ...ep, task: { ...ep.task, faultClass: v.toLowerCase() } })],
  [
    "$.gate.oracle.family",
    (ep, v) => ({
      ...ep,
      gate: {
        verdict: "verified",
        accepted: true,
        reasonCodes: ["ORACLE_PASS"],
        oracle: { family: v.toLowerCase(), version: "1", specSha256: "c".repeat(64) },
      },
    }),
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
  ],
  [
    "$.groundTruth.graderVersion",
    (ep, v) => ({
      ...ep,
      groundTruth: {
        source: "independent-grader",
        graderVersion: `${v.toLowerCase()}/1`,
        status: "pass",
        targetSatisfied: true,
        mismatchCount: 0,
        fixtureSha256: "d".repeat(64),
        persistedSha256: null,
      },
    }),
  ],
  [
    "$.harness.arm",
    (ep, v) => ({ ...ep, harness: { ...ep.harness, arm: `myco-gate:${v.toLowerCase()}` } }),
  ],
  [
    "$.harness.fault.code",
    (ep, v) => ({
      ...ep,
      harness: { ...ep.harness, fault: { class: "timeout", code: v.toUpperCase() } },
    }),
  ],
];

/** Closed-field-safe forms (letters and digits only: every closed grammar admits them). */
const closedForm = (v: string) => v.replace(/[^A-Za-z0-9]/g, "");

/** Whether any of `words` occurs, case-insensitively, in `text` (a boolean, never the word). */
const anyWordIn = (text: string, words: readonly string[]) =>
  words.some((w) => text.toLowerCase().includes(w.toLowerCase()));

/** One stored episode (built by `edit`), exported: the refusal message or the dataset dir. */
function exportEdited(
  edit: (d: ReturnType<typeof draft>) => ReturnType<typeof draft>,
  file: string,
) {
  const root = join(dir("iw-store"), "s");
  const store = EpisodeStore.open(root, { simulated: true, host: HOST });
  expect(store.record(draft(edit(draft())), new Map()).status).toBe("written");
  const out = join(dir("iw-out"), "ds");
  try {
    exportDataset({
      stores: [root],
      out,
      simulated: true,
      host: HOST,
      identity: { identityFile: file },
    });
    return { refused: null as string | null, out };
  } catch (e) {
    return { refused: (e as Error).message, out };
  }
}
const datasetText = (out: string) =>
  readdirSync(join(out, "episodes"))
    .map((f) => readFileSync(join(out, "episodes", f), "utf8"))
    .join("") + readFileSync(join(out, "manifest.json"), "utf8");

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

describe("#580 O1: a single word of a configured full name, in every id and token field", () => {
  it("the minimum word length is pinned at 3 (as Q)", () => {
    expect(IDENTITY_WORD_MIN_CHARS).toBe(3);
  });

  it("each word form is held (closeEpisode digests it in every id, token and text field)", () => {
    const e = identityEntries({ identityFile: identityFile(FULL) });
    const base = baseEpisode();
    for (const [i, v] of WORD_FORMS.entries()) {
      expect(heldIdentity(v, e)?.[0], `form ${i}`).toBe("identity");
      const closed = closeEpisode(everywhere(base, v), e);
      for (const [path, out] of idTokenFields(closed))
        expect(out === hashed(v), `form ${i} ${path}`).toBe(true);
      expect(anyWordIn(canonicalJson(closed), [FIRST, LAST]), `form ${i}`).toBe(false);
      expect(joinedIdentity(closed, e), `form ${i}`).toEqual([]);
      expect(openStrings(closed), `form ${i}`).toEqual([]);
    }
  });

  it("a word of exactly 3 characters is matched; one of 2 is not looked for alone", () => {
    const e = identityEntries({ identityFile: identityFile(`${THREE} ${LAST}`, `${TWO} ${LAST}`) });
    const base = baseEpisode();
    for (const v of [`${THREE.toLowerCase()}_trial`, `xx${THREE}2`, `run${THREE.toUpperCase()}`]) {
      const closed = closeEpisode(everywhere(base, v), e);
      expect(closed.task.id === hashed(v), "3-char word digested").toBe(true);
    }
    const two = `${TWO.toLowerCase()}_trial`;
    expect(heldIdentity(two, e)).toBeUndefined();
    expect(closeEpisode(everywhere(base, two), e).task.id === two, "2-char word kept").toBe(true);
  });

  it("accented and ASCII variants of a word match both ways (accent folding applies to words)", () => {
    const base = baseEpisode();
    for (const [configured, written] of [
      [ACCENTED, "qzwjose_trial"],
      [ACCENTED, "QZWRENA2"],
      [ASCII_NAME, "xxQzwJosé"],
      [ASCII_NAME, "qzwreñaTrial"],
    ] as const) {
      const e = identityEntries({ identityFile: identityFile(configured) });
      const closed = closeEpisode(everywhere(base, written), e);
      for (const [path, out] of idTokenFields(closed))
        expect(out === hashed(written), `${path}`).toBe(true);
    }
  });

  it("through the real export: digested, and no word reaches any dataset byte", () => {
    const file = identityFile(FULL);
    for (const [i, v] of WORD_FORMS.entries()) {
      const r = exportEdited(
        (d) => ({ ...d, task: { ...d.task, id: v }, provenance: { ...d.provenance, runId: v } }),
        file,
      );
      expect(r.refused === null, `form ${i} exported`).toBe(true);
      expect(anyWordIn(datasetText(r.out), [FIRST, LAST]), `form ${i}`).toBe(false);
      expect(validateDataset(r.out, HOST, { identityFile: file }), `form ${i}`).toEqual([]);
    }
  });
});

describe("#580 O1: a single word in a closed pattern field, the filter or a hand-edited dataset refuses", () => {
  it("every non-exempt closed field refuses each word form (joinedIdentity, class identity)", () => {
    const e = identityEntries({ identityFile: identityFile(FULL) });
    const base = baseEpisode();
    for (const [path, put] of CLOSED_FIELDS)
      for (const [i, v] of WORD_FORMS.entries()) {
        const hits = joinedIdentity(closeEpisode(put(base, closedForm(v)), e), e);
        expect(
          hits.some((h) => h.path === path && h.class === "identity"),
          `${path} form ${i}`,
        ).toBe(true);
      }
  });

  it("the export refuses a word in taskSetVersion and in the filter, naming no value", () => {
    const file = identityFile(FULL);
    const r = exportEdited(
      (d) => ({ ...d, task: { ...d.task, taskSetVersion: `${LAST}2` } }),
      file,
    );
    expect((r.refused ?? "").includes("(identity at $.task.taskSetVersion)")).toBe(true);
    expect(anyWordIn(r.refused ?? "", [FIRST, LAST])).toBe(false);
    const root = join(dir("iw-f"), "s");
    EpisodeStore.open(root, { simulated: true, host: HOST }).record(draft(), new Map());
    let message = "";
    try {
      exportDataset({
        stores: [root],
        out: join(dir("iw-fo"), "ds"),
        simulated: true,
        host: HOST,
        filter: { ...NO_FILTER, taskSetVersion: `xx${FIRST.toLowerCase()}` },
        identity: { identityFile: file },
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.includes("identity string (identity at $.filter.taskSetVersion)")).toBe(true);
  });

  it("validateDataset refuses a hand-edited id holding one word", () => {
    const file = identityFile(FULL);
    const r = exportEdited((d) => d, file);
    expect(r.refused).toBeNull();
    rewriteFirstEpisode(r.out, (ep) => ({
      ...ep,
      task: { ...ep.task, id: `${FIRST.toLowerCase()}_trial` },
    }));
    const problems = validateDataset(r.out, HOST, { identityFile: file });
    expect(problems.some((p) => /: IDENTITY identity at \$\.task\.id$/.test(p))).toBe(true);
    expect(anyWordIn(problems.join("\n"), [FIRST, LAST])).toBe(false);
  });
});

describe("O4 residual (accepted, documented): unconfigured names are not caught", () => {
  // Built at run time: no path- or host-shaped literal is committed.
  const OTHER_HOST = ["Qzother", "MacBook", "Pro"].join("-");
  const PATH_ID = [["Us", "ers"].join(""), "qzjsmith", "Documents"].join(".");

  it("another machine's host name and a dotted path-like id with unconfigured names are kept verbatim", () => {
    const e = identityEntries({ identityFile: identityFile(FULL) });
    const base = baseEpisode();
    for (const v of [OTHER_HOST, PATH_ID]) {
      const closed = closeEpisode({ ...base, task: { ...base.task, id: v, taskSetVersion: v } }, e);
      expect(closed.task.id === v, "kept in task.id").toBe(true);
      expect(closed.task.taskSetVersion === v, "kept in taskSetVersion").toBe(true);
      expect(joinedIdentity(closed, e)).toEqual([]);
    }
    // Once configured, the same name is caught (the documented remedy).
    const configured = identityEntries({ identityFile: identityFile("Qzother", "qzjsmith") });
    for (const v of [OTHER_HOST, PATH_ID])
      expect(
        closeEpisode({ ...base, task: { ...base.task, id: v } }, configured).task.id === hashed(v),
      ).toBe(true);
  });
});

describe("fuzz: 1,000 generated full names and paths (allowlist alone, and the full export)", () => {
  const CASES = 1000;
  /** Case `i`: a configured full name of two fuzzed words, a word form and the fuzzed path. */
  function cases() {
    const next = makePathFuzzer(0x580);
    const rnd = mulberry32(0x5801);
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

  it("OFF (closeEpisode alone): every word form digested in every id, no word anywhere", () => {
    const base = baseEpisode();
    for (const [i, c] of cases().entries()) {
      const e = identityEntries({ users: [], identityFile: undefined }).concat([
        ["identity", c.name],
      ]);
      const ep = everywhere(base, c.form);
      const closed = closeEpisode({ ...ep, task: { ...ep.task, instruction: c.path } }, e);
      for (const [path, out] of idTokenFields(closed))
        if (out !== hashed(c.form)) expect.fail(`case ${i}: ${path} not digested`);
      if (anyWordIn(canonicalJson(closed), c.words)) expect.fail(`case ${i}: a word survived`);
    }
  });

  it("ON (the full export, then validateDataset): 1,000 episodes, one identity file", () => {
    const all = cases();
    const file = identityFile(...all.map((c) => c.name));
    const root = join(dir("iw-fz"), "s");
    const store = EpisodeStore.open(root, { simulated: true, host: HOST });
    const put = (i: number, form: string, instruction: string) =>
      store.record(
        draft({
          task: { ...draft().task, id: form, instruction },
          provenance: { ...draft().provenance, runId: form, trialKey: `trial-${i}` },
        }),
        new Map(),
      ).status;
    for (const [i, c] of all.entries()) {
      // The store refuses some fuzzed paths as instructions (control characters): those cases
      // keep the word form in the ids and a plain instruction.
      const status = put(i, c.form, c.path) === "refused" ? put(i, c.form, "x") : "written";
      expect(status, `case ${i}`).toBe("written");
    }
    const out = join(dir("iw-fzo"), "ds");
    const m = exportDataset({
      stores: [root],
      out,
      simulated: true,
      host: HOST,
      identity: { identityFile: file },
    });
    expect(m.files.length).toBe(CASES);
    const text = datasetText(out);
    for (const [i, c] of all.entries())
      if (anyWordIn(text, c.words)) expect.fail(`case ${i}: a word survived`);
    for (const f of readdirSync(join(out, "episodes"))) {
      const ep = JSON.parse(readFileSync(join(out, "episodes", f), "utf8")) as Episode;
      expect(
        /^h-[0-9a-f]{60}$/.test(ep.task.id) && /^h-[0-9a-f]{60}$/.test(ep.provenance.runId),
      ).toBe(true);
    }
    expect(validateDataset(out, HOST, { identityFile: file })).toEqual([]);
  }, 120_000);
});
