/**
 * The export allowlist (src/episode/closed.ts; TIF-265, #553's closed-schema pattern). The
 * export never writes free text: every #553 probe and every fuzzed host path, entered as agent
 * text, leaves no planted word in the dataset; every string path an episode can hold has a
 * treatment; a closed field holding anything else is refused by name, never by value; and
 * `validateDataset` refuses a dataset carrying an open string. Before this change the same
 * corpus put a planted username into 123 of 145 exported datasets.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARM_GRAMMAR,
  CLOSED_ID,
  closeEpisode,
  FIELD_TREATMENT,
  openStrings,
  templateOf,
} from "../../src/episode/closed.ts";
import { writeMultiStepDemoEpisodes } from "../../src/episode/demo.ts";
import { exportDataset, NO_FILTER, validateDataset } from "../../src/episode/export.ts";
import { EpisodeRecorder } from "../../src/episode/recorder.ts";
import { EpisodeStore, readStoreDir } from "../../src/episode/store.ts";
import type { Episode } from "../../src/episode/types.ts";
import { canonicalJson, episodeIdOf, sha256Hex } from "../../src/episode/validate.ts";
import { runMultiStepMockDemo } from "../../src/gate/multistep-demo.ts";
import { draft, fakeKey, HOST, scratch } from "./helpers.ts";
import { makePathFuzzer } from "./path-fuzz.ts";
import * as CORPUS from "./probe-corpus.ts";

const made: string[] = [];
const dir = (p: string) => {
  const d = scratch(p);
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every file of a dataset, as one string. */
function dataset(root: string): string {
  let s = "";
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else s += readFileSync(join(root, p), "utf8");
    }
  };
  walk("");
  return s;
}

/** Records `value` as every free-text input the recorder takes, stores it, exports it. */
function exportWith(value: string, extra: Partial<Parameters<typeof draft>[0]> = {}) {
  const root = join(dir("al-store"), "s");
  const store = EpisodeStore.open(root, { simulated: true, host: HOST });
  const rec = new EpisodeRecorder({ host: HOST });
  rec.action({ kind: "shell", command: value });
  rec.action({ kind: "type", text: value });
  rec.uiStatus(value);
  const snap = rec.snapshot();
  const r = store.record(
    draft({ actions: snap.actions, observations: snap.observations, ...extra }),
    snap.blobs,
  );
  if (r.status !== "written") return { written: false as const };
  const out = join(dir("al-out"), "ds");
  exportDataset({ stores: [root], out, simulated: true, host: HOST });
  return { written: true as const, out, text: dataset(out) };
}

type Probe = readonly [string, string, readonly string[]];
const PROBES: Probe[] = Object.values(CORPUS).flatMap((v) =>
  Array.isArray(v) && v.length > 0 && Array.isArray(v[0])
    ? (v as unknown as (readonly [string, string, (readonly string[])?])[]).map(
        (p): Probe => [p[0], p[1], p[2] ?? [CORPUS.USER]],
      )
    : [],
);

describe("the #553 probe corpus, entered as agent text, never reaches an exported dataset", () => {
  const withWords = PROBES.filter(([, v, words]) => words.some((w) => v.includes(w)));

  it("has the corpus (spaced folders, Documents and Settings, UNC, 8.3, mixed separators, unicode)", () => {
    expect(withWords.length).toBeGreaterThanOrEqual(140);
  });

  it("every probe: the store keeps the episode (redacted), the dataset carries no planted word and validates", () => {
    const leaks: string[] = [];
    let exported = 0;
    for (const [name, value, words] of withWords) {
      const r = exportWith(value);
      if (!r.written) continue;
      exported++;
      const hit = words.filter((w) => r.text.includes(w));
      if (hit.length > 0) leaks.push(`${name}: ${hit.join(", ")}`);
      const problems = validateDataset(r.out, HOST);
      if (problems.length > 0) leaks.push(`${name}: dataset invalid: ${problems[0]}`);
    }
    expect(leaks).toEqual([]);
    // The store still refuses only what the cleanliness scan flags; the rest is exported closed.
    expect(exported).toBeGreaterThanOrEqual(130);
  }, 600_000);

  it("the instruction, a key name and an app name are closed too", () => {
    for (const [name, value, words] of withWords.slice(0, 40)) {
      const ep = closeEpisode({
        ...(readOne(value) as Episode),
        task: { ...(readOne(value) as Episode).task, instruction: value },
      });
      const s = canonicalJson(ep);
      expect(
        words.filter((w) => s.includes(w)),
        name,
      ).toEqual([]);
      const key = closeEpisode({
        ...(readOne("x") as Episode),
        actions: {
          capture: "recorded",
          truncated: false,
          items: [
            { seq: 0, atMs: null, kind: "key", keys: value.slice(0, 64) },
            { seq: 1, atMs: null, kind: "launch", app: value.slice(0, 64) },
          ],
        },
      });
      expect(
        words.filter((w) => canonicalJson(key).includes(w)),
        name,
      ).toEqual([]);
    }
  });
});

/** One stored episode carrying `value` as a shell command (the store's redacted form). */
function readOne(value: string): Episode {
  const root = join(dir("al-one"), "s");
  const store = EpisodeStore.open(root, { simulated: true, host: HOST });
  const rec = new EpisodeRecorder({ host: HOST });
  rec.action({ kind: "shell", command: value });
  const snap = rec.snapshot();
  store.record(draft({ actions: snap.actions, observations: snap.observations }), snap.blobs);
  const eps = readStoreDir(root).episodes;
  return (eps[0] ?? closeEpisode(readStoreDirOrDraft())) as Episode;
}
function readStoreDirOrDraft(): Episode {
  const root = join(dir("al-draft"), "s");
  const store = EpisodeStore.open(root, { simulated: true, host: HOST });
  store.record(draft(), new Map());
  return readStoreDir(root).episodes[0] as Episode;
}

describe("property: arbitrary host paths (seeded fuzz) never survive closing", () => {
  it("2000 fuzzed paths in every free-text field: no planted word, every string in its closed grammar", () => {
    const next = makePathFuzzer(0x542);
    const base = readStoreDirOrDraft();
    for (let i = 0; i < 2000; i++) {
      const f = next();
      const ep: Episode = {
        ...base,
        task: { ...base.task, instruction: f.value },
        actions: {
          capture: "recorded",
          truncated: false,
          items: [
            { seq: 0, atMs: null, kind: "shell", command: f.value },
            { seq: 1, atMs: null, kind: "type", text: f.value },
            { seq: 2, atMs: null, kind: "key", keys: f.value.slice(0, 64) },
            { seq: 3, atMs: null, kind: "launch", app: f.value.slice(0, 64) },
          ],
        },
        observations: {
          capture: "recorded",
          withheld: 0,
          items: [{ seq: 0, afterAction: 0, kind: "ui-status", text: f.value.slice(0, 200) }],
        },
      };
      const closed = closeEpisode(ep);
      const s = canonicalJson(closed);
      const hit = f.words.filter((w) => s.includes(w));
      expect(hit, `case ${i} (${f.shape})`).toEqual([]);
      expect(openStrings(closed), `case ${i} (${f.shape})`).toEqual([]);
      expect(closed.episodeId).toBe(episodeIdOf(closed));
      // Idempotent: closing a closed episode changes nothing.
      expect(canonicalJson(closeEpisode(closed))).toBe(s);
    }
  });
});

describe("the field table covers every string path an episode can hold", () => {
  /** An episode with every action and observation variant and every nullable string set. */
  function everything(): Episode {
    const base = readStoreDirOrDraft();
    return {
      ...base,
      gate: {
        verdict: "verified",
        accepted: true,
        reasonCodes: ["ORACLE_PASS"],
        oracle: { family: "calc-record-edit", version: "1", specSha256: "c".repeat(64) },
      },
      groundTruth: {
        source: "independent-grader",
        graderVersion: "false-completion-grader/1",
        status: "pass",
        targetSatisfied: true,
        mismatchCount: 0,
        fixtureSha256: "d".repeat(64),
        persistedSha256: "e".repeat(64),
      },
      harness: {
        ...base.harness,
        timing: {
          startedAt: "2026-11-26T10:00:00Z",
          endedAt: "2026-11-26T10:01:00Z",
          wallClockS: 1,
          vmS: 1,
        },
        fault: { class: "timeout", code: "APP_KILLED" },
      },
      provenance: {
        ...base.provenance,
        attemptLedger: { schema: "myco.m2.attempt-event/1", events: 2, headSha256: "f".repeat(64) },
      },
      actions: {
        capture: "recorded",
        truncated: false,
        items: [
          { seq: 0, atMs: 1, kind: "click", x: 1, y: 2, button: "left" },
          { seq: 1, atMs: 1, kind: "type", text: "t" },
          { seq: 2, atMs: 1, kind: "key", keys: "ctrl+s" },
          { seq: 3, atMs: 1, kind: "scroll", dx: 0, dy: 1 },
          { seq: 4, atMs: 1, kind: "launch", app: "soffice" },
          { seq: 5, atMs: 1, kind: "wait", ms: 5 },
          { seq: 6, atMs: 1, kind: "shell", command: "ls" },
          { seq: 7, atMs: 1, kind: "gate-check", claim: "done" },
          { seq: 8, atMs: 1, kind: "observe" },
        ],
      },
      observations: {
        capture: "recorded",
        withheld: 0,
        items: [
          {
            seq: 0,
            afterAction: 0,
            kind: "screenshot",
            mediaType: "image/png",
            sha256: "1".repeat(64),
            bytes: 9,
            file: `blobs/${"1".repeat(64)}.png`,
          },
          {
            seq: 1,
            afterAction: 0,
            kind: "state",
            label: "persisted",
            mediaType: "text/csv",
            sha256: "2".repeat(64),
            bytes: 9,
            file: `blobs/${"2".repeat(64)}.csv`,
          },
          { seq: 2, afterAction: 0, kind: "ui-status", text: "ok" },
        ],
      },
    };
  }

  it("every string path of every variant has a treatment, and every treatment names a reachable path", () => {
    const seen = new Set<string>();
    const visit = (node: unknown, path: string): void => {
      if (typeof node === "string") seen.add(templateOf(path));
      else if (Array.isArray(node)) {
        for (const [i, x] of node.entries()) visit(x, `${path}[${i}]`);
      } else if (node !== null && typeof node === "object")
        for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`);
    };
    visit(everything(), "$");
    visit({ ...everything(), groundTruth: { source: "none", reason: "harness-fault" } }, "$");
    expect([...seen].filter((p) => FIELD_TREATMENT[p] === undefined)).toEqual([]);
    expect(Object.keys(FIELD_TREATMENT).filter((p) => !seen.has(p))).toEqual([]);
    expect(openStrings(closeEpisode(everything()))).toEqual([]);
  });

  it("a string at a path the table does not name refuses the export (a new field is a reviewed change)", () => {
    const ep = {
      ...everything(),
      task: { ...everything().task, note: "anything" },
    } as unknown as Episode;
    expect(() => closeEpisode(ep)).toThrow(/^export refused: \$\.task\.note is not a closed value/);
  });

  it("a closed field holding anything else is refused by name, never by value", () => {
    const leak = ["Users", "/", "QzPLANTEDref"].join("");
    const ep = everything();
    for (const bad of [
      { ...ep, groundTruth: { ...(ep.groundTruth as object), graderVersion: leak } },
      { ...ep, harness: { ...ep.harness, arm: `x ${leak}` } },
      { ...ep, harness: { ...ep.harness, timing: { ...ep.harness.timing, startedAt: leak } } },
      { ...ep, task: { ...ep.task, taskSetVersion: leak } },
    ] as Episode[]) {
      let message = "";
      try {
        closeEpisode(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/^export refused: \$\.[a-zA-Z.]+ is not a closed value/);
      expect(message).not.toContain("QzPLANTEDref");
    }
  });

  it("ids outside the closed grammar are hashed, so equality stays checkable", () => {
    const ep = everything();
    const a = closeEpisode({ ...ep, provenance: { ...ep.provenance, runId: "run:C:x" } });
    const b = closeEpisode({ ...ep, provenance: { ...ep.provenance, runId: "run:C:x" } });
    expect(a.provenance.runId).toMatch(/^h-[0-9a-f]{64}$/);
    expect(a.provenance.runId).toBe(b.provenance.runId);
    expect(closeEpisode(ep).provenance.runId).toBe(ep.provenance.runId);
  });
});

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

describe("validateDataset refuses an open string; the filter is closed", () => {
  it("a dataset hand-edited to carry plain text (hashes and id made consistent) is refused", () => {
    const r = exportWith("echo hello");
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(validateDataset(r.out, HOST)).toEqual([]);
    rewriteFirstEpisode(r.out, (ep) => ({
      ...ep,
      actions: {
        ...ep.actions,
        items: ep.actions.items.map((a) =>
          a.kind === "shell" ? { ...a, command: "cd Plain Text" } : a,
        ),
      },
    }));
    const problems = validateDataset(r.out, HOST);
    expect(problems).toEqual([
      expect.stringMatching(
        /: OPEN_STRING at \$\.actions\.items\[0\]\.command \(not a closed value\)$/,
      ),
    ]);
  });

  it("an export filter that is not a closed id is refused (the filter is written to the manifest)", () => {
    const root = join(dir("al-f"), "s");
    EpisodeStore.open(root, { simulated: true, host: HOST }).record(draft(), new Map());
    const out = join(dir("al-fo"), "ds");
    const filter = (over: object) => ({ ...NO_FILTER, ...over });
    expect(() =>
      exportDataset({
        stores: [root],
        out,
        simulated: true,
        host: HOST,
        filter: filter({ arm: "C:\\x y" }),
      }),
    ).toThrow(/arm is not a closed arm id/);
    expect(() =>
      exportDataset({
        stores: [root],
        out,
        simulated: true,
        host: HOST,
        filter: filter({ taskSetVersion: "a b" }),
      }),
    ).toThrow(/taskSetVersion is not a closed task-set id/);
  });
});

describe("blobs are digest-only (lead ruling 2026-11-26 20:3xZ)", () => {
  it("a captured document the byte scan lets through never reaches the dataset; only its digest and size do", () => {
    // A long-path UNC form the store's blob scan does not flag (so the store keeps the document).
    const words = ["QzPLANTEDblobfirst", "QzPLANTEDbloblast"];
    const csv = new TextEncoder().encode(
      `id,v\nA,${["\\\\?\\UNC\\nas\\homes\\", words[0], " ", words[1]].join("")}\n`,
    );
    const root = join(dir("al-blob"), "s");
    const store = EpisodeStore.open(root, { simulated: true, host: HOST });
    const rec = new EpisodeRecorder({ host: HOST });
    rec.action({ kind: "type", text: "x" });
    expect(rec.state("persisted", "text/csv", csv, 0)).toBe(true);
    const snap = rec.snapshot();
    expect(
      store.record(draft({ actions: snap.actions, observations: snap.observations }), snap.blobs)
        .status,
    ).toBe("written");
    const out = join(dir("al-blobout"), "ds");
    const m = exportDataset({ stores: [root], out, simulated: true, host: HOST });
    const text = dataset(out);
    expect(words.filter((w) => text.includes(w))).toEqual([]);
    expect(m.counts.blobs).toBe(0);
    expect(text).toContain(createHash("sha256").update(csv).digest("hex"));
    expect(validateDataset(out, HOST)).toEqual([]);
  });
});

describe("#556 round 1 fixes", () => {
  it("D1: a multi-step demo store (arm myco-gate:retry / :no-retry) exports, and its arm is a valid filter", async () => {
    const report = await runMultiStepMockDemo({ outDir: dir("al-ms") });
    const root = join(dir("al-ms-store"), "s");
    const store = EpisodeStore.open(root, { simulated: true, host: HOST });
    const written = writeMultiStepDemoEpisodes(report, store);
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((w) => w.status === "written")).toBe(true);
    const out = join(dir("al-ms-out"), "ds");
    const m = exportDataset({ stores: [root], out, simulated: true, host: HOST });
    expect(Object.keys(m.counts.byArm).sort()).toEqual(["myco-gate:no-retry", "myco-gate:retry"]);
    expect(validateDataset(out, HOST)).toEqual([]);
    const only = join(dir("al-ms-f"), "ds");
    const f = exportDataset({
      stores: [root],
      out: only,
      simulated: true,
      host: HOST,
      filter: { ...NO_FILTER, arm: "myco-gate:retry" },
    });
    expect(Object.keys(f.counts.byArm)).toEqual(["myco-gate:retry"]);
    expect(validateDataset(only, HOST)).toEqual([]);
  }, 120_000);

  it("D1: the arm vocabulary admits the known arms and variants, and refuses drive-relative and path forms", () => {
    for (const ok of [
      "myco-gate",
      "hcu+shell",
      "myco-gate:retry",
      "myco-gate:no-retry",
      "hcu+shell:v2",
    ])
      expect(ARM_GRAMMAR.test(ok), ok).toBe(true);
    for (const bad of [
      "c:users.x",
      "C:Users",
      "c:users",
      "d:x",
      "myco-gate:c:x",
      "myco-gate:users.x",
      "myco-gate:Users",
      "myco-gate:..",
      "hcu+shell:a/b",
      "zq:plantuser05",
      "plantuser05",
    ])
      expect(ARM_GRAMMAR.test(bad), bad).toBe(false);
    const base = readStoreDirOrDraft();
    expect(() => closeEpisode({ ...base, harness: { ...base.harness, arm: "c:users.x" } })).toThrow(
      /^export refused: \$\.harness\.arm is not a closed value/,
    );
    // Fuzz: no fuzzed host path is ever an arm.
    const next = makePathFuzzer(0x556);
    for (let i = 0; i < 1000; i++) {
      const v = next().value.slice(0, 64);
      expect(ARM_GRAMMAR.test(v), `case ${i}: ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("T1: the dataset backstop refuses a key-shaped id that fits CLOSED_ID (hashes made consistent)", () => {
    const r = exportWith("echo hello");
    expect(r.written).toBe(true);
    if (!r.written) return;
    const key = fakeKey();
    expect(CLOSED_ID.test(key)).toBe(true);
    rewriteFirstEpisode(r.out, (ep) => ({ ...ep, task: { ...ep.task, id: key } }));
    expect(validateDataset(r.out, HOST)).toEqual([
      expect.stringMatching(/: KEY_SHAPED at \$\.task\.id$/),
    ]);
  });

  it("T2: free text that merely starts with h- is hashed, never kept (only an exact h-<64 hex> is)", () => {
    const words = ["QzPLANTEDhfirst", "QzPLANTEDhlast"];
    const base = readStoreDirOrDraft();
    for (const text of [
      `h-C:\\Users\\${words[0]} ${words[1]}`,
      `h-${"a".repeat(64)} C:\\Users\\${words[0]} ${words[1]}`,
      `h-${"a".repeat(63)}`,
    ]) {
      const closed = closeEpisode({ ...base, task: { ...base.task, instruction: text } });
      expect(closed.task.instruction, text).toMatch(/^h-[0-9a-f]{64}$/);
      expect(closed.task.instruction).not.toBe(text);
      expect(words.filter((w) => canonicalJson(closed).includes(w))).toEqual([]);
      // And an exported string that is only h-prefixed is open.
      expect(openStrings({ ...closed, task: { ...closed.task, instruction: text } })).toEqual([
        "$.task.instruction",
      ]);
    }
    for (const [name, value, w] of PROBES.slice(0, 40)) {
      const closed = closeEpisode({ ...base, task: { ...base.task, instruction: `h-${value}` } });
      expect(
        w.filter((x) => canonicalJson(closed).includes(x)),
        name,
      ).toEqual([]);
    }
  });
});
