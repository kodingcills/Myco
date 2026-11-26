/**
 * Track U's export allowlist (src/dataset/closed.ts; TIF-265, #553's closed-schema pattern).
 * Before this change the exporter's leak scan let a planted username through in 40 of #553's
 * 145 raw probes, and in 92 once #542's `redactText` had turned `C:\Users\First Last\x` into
 * `<path> Last\x`. Now every probe, raw or redacted, is either refused by the scan or written
 * only as a digest; fuzzed host paths never survive closing; every string path has a treatment;
 * and a closed field holding anything else refuses the export by name.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  closeEpisode,
  closeRecordFields,
  EPISODE_FIELD_TREATMENT,
  openEpisodeStrings,
  templateOf,
} from "../../src/dataset/closed.ts";
import {
  draftEpisode,
  EPISODE_REAL_PLANNERS,
  type Episode,
  type EpisodeDraft,
} from "../../src/dataset/episode.ts";
import {
  canonicalJson,
  type ExportCandidate,
  ExportRefused,
  exportDataset,
  validateContainer,
} from "../../src/dataset/export.ts";
import { redactText } from "../../src/episode/clean.ts";
import { makePathFuzzer } from "./path-fuzz.ts";
import * as CORPUS from "./probe-corpus.ts";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const FIXTURE_SHA = sha("pristine fixture");
const DOC = Buffer.from("id,qty\nEMP-0001,42\n");
const REAL_PLANNER = [...EPISODE_REAL_PLANNERS][0] as string;
/** A machine identity no probe can match (the probes plant their own words). */
const HYGIENE = { identity: { user: "nobody-u", host: "nohost-u" } };
const REDACT_HOST = { home: "/nonexistent-home-u", tmp: "/nonexistent-tmp-u", user: "nobody-u" };

/** A positive, exportable candidate whose free text is `value` everywhere the episode allows. */
function candidate(value: string, over: Partial<EpisodeDraft> = {}): ExportCandidate {
  const draft: EpisodeDraft = {
    outcome: "verified",
    simulated: false,
    task: {
      id: "task-1",
      family: "calc-record-edit",
      taskSetVersion: null,
      faultClass: null,
      instruction: value,
      instructionSha256: sha(value),
      fixtureSha256: FIXTURE_SHA,
    },
    actions: [
      { kind: "shell", command: value },
      { kind: "type", text: value },
    ],
    observations: [{ afterAction: 0, text: value.slice(0, 200) }],
    withheld: 0,
    agentClaim: "done",
    gate: { verdict: "verified", accepted: true, reasonCodes: ["ORACLE_PASS"], oracle: null },
    groundTruth: {
      source: "independent-grader",
      graderVersion: "false-completion-grader/1",
      status: "pass",
      targetSatisfied: true,
      mismatchCount: 0,
      fixtureSha256: FIXTURE_SHA,
      persistedSha256: sha(DOC),
    },
    arm: "hcu+shell",
    plannerModelId: REAL_PLANNER,
    startedAt: "2026-11-26T15:00:00.000Z",
    endedAt: "2026-11-26T15:01:00.000Z",
    source: "gated-trial",
    runId: "run-1",
    trialKey: "task-1:run-1",
    persisted: DOC,
    ...over,
  };
  return {
    episode: draftEpisode(draft),
    fixtureSha256: FIXTURE_SHA,
    gate: {
      apiVersion: "myco.gate/v1",
      verdict: "verified",
      accepted: true,
      reasonCodes: ["ORACLE_PASS"],
      request: { taskId: "task-1", runId: "run-1" },
    },
    capture: { path: "doc.csv", format: "csv", bytes: DOC },
    desktop: {
      backend: "local-process/1",
      isolation: "process",
      networkEnforced: false,
      image: "myco-linux-desktop/1",
    },
  };
}

function everyFile(root: string): string {
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

type Outcome = { refused: string } | { written: string };
function exportOne(c: ExportCandidate): Outcome {
  const base = mkdtempSync(join(tmpdir(), "myco-u-allow-"));
  const dir = join(base, "ds");
  try {
    exportDataset([c], { outDir: dir, hygiene: HYGIENE });
    return { written: everyFile(dir) };
  } catch (e) {
    if (e instanceof ExportRefused) return { refused: e.code };
    throw e;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

type Probe = readonly [string, string, readonly string[]];
const PROBES: Probe[] = Object.values(CORPUS)
  .flatMap((v) =>
    Array.isArray(v) && v.length > 0 && Array.isArray(v[0])
      ? (v as unknown as (readonly [string, string, (readonly string[])?])[]).map(
          (p): Probe => [p[0], p[1], p[2] ?? [CORPUS.USER]],
        )
      : [],
  )
  .filter(([, v, words]) => words.some((w) => v.includes(w)));

describe("the #553 probe corpus through U's exporter: refused, or written only as digests", () => {
  it("has the corpus (spaced folders, Documents and Settings, UNC, 8.3, mixed separators, unicode)", () => {
    expect(PROBES.length).toBeGreaterThanOrEqual(140);
  });

  for (const [form, prep] of [
    ["raw", (v: string) => v],
    ["after #542's redactText", (v: string) => redactText(v, REDACT_HOST)],
  ] as const) {
    it(`every probe, ${form}: no planted word in any output file`, () => {
      const leaks: string[] = [];
      let written = 0;
      for (const [name, value, words] of PROBES) {
        const r = exportOne(candidate(prep(value)));
        if ("refused" in r) continue;
        written++;
        const hit = words.filter((w) => r.written.includes(w));
        if (hit.length > 0) leaks.push(`${name}: ${hit.join(", ")}`);
      }
      expect(leaks).toEqual([]);
      // The scan no longer has to catch them: many pass it and are written, closed.
      expect(written).toBeGreaterThanOrEqual(form === "raw" ? 30 : 80);
    }, 600_000);
  }

  it("a key name and an app name are closed tokens or hashed", () => {
    for (const [name, value, words] of PROBES.slice(0, 40)) {
      const c = candidate("x", {
        actions: [
          { kind: "key", keys: value.slice(0, 64) },
          { kind: "launch", app: "localc" },
        ],
      });
      const s = canonicalJson(closeEpisode(c.episode));
      expect(
        words.filter((w) => s.includes(w)),
        name,
      ).toEqual([]);
    }
  });
});

describe("property: arbitrary host paths (seeded fuzz) never survive closing", () => {
  it("2000 fuzzed paths in every free field, the record's included: no planted word, all closed, idempotent", () => {
    const next = makePathFuzzer(0x531);
    for (let i = 0; i < 2000; i++) {
      const f = next();
      const c = candidate(f.value, {
        actions: [
          { kind: "shell", command: f.value },
          { kind: "type", text: f.value },
          { kind: "key", keys: f.value.slice(0, 64) },
        ],
      });
      const closed = closeEpisode(c.episode);
      const record = closeRecordFields({
        desktop: { backend: f.value, image: f.value },
        capture: { path: f.value },
      });
      const s = canonicalJson(closed) + canonicalJson(record);
      expect(
        f.words.filter((w) => s.includes(w)),
        `case ${i} (${f.shape})`,
      ).toEqual([]);
      expect(openEpisodeStrings(closed), `case ${i}`).toEqual([]);
      expect(canonicalJson(closeEpisode(closed))).toBe(canonicalJson(closed));
    }
  });
});

describe("the field table covers every string path of the mirrored episode", () => {
  function everything(): Episode {
    const base = candidate("t").episode;
    return {
      ...base,
      task: { ...base.task, taskSetVersion: "fc-v1", faultClass: "none" },
      gate: {
        verdict: "verified",
        accepted: true,
        reasonCodes: ["ORACLE_PASS"],
        oracle: { family: "calc-record-edit", version: "1", specSha256: "c".repeat(64) },
      },
      harness: { ...base.harness, fault: { class: "timeout", code: "APP_KILLED" } },
      provenance: {
        ...base.provenance,
        attemptLedger: {
          schema: "myco.m2.attempt-event/1",
          events: 2,
          headSha256: "f".repeat(64),
        },
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
    } as Episode;
  }

  it("every string path has a treatment, and every treatment names a reachable path", () => {
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
    expect([...seen].filter((p) => EPISODE_FIELD_TREATMENT[p] === undefined)).toEqual([]);
    expect(Object.keys(EPISODE_FIELD_TREATMENT).filter((p) => !seen.has(p))).toEqual([]);
    expect(openEpisodeStrings(closeEpisode(everything()))).toEqual([]);
  });

  it("openEpisodeStrings flags plain text, an open id and an off-grammar closed value, by path", () => {
    const closed = closeEpisode(everything());
    const opened = {
      ...closed,
      task: { ...closed.task, instruction: "cd Plain Text", id: "a b" },
      harness: { ...closed.harness, arm: "x y" },
    };
    expect(openEpisodeStrings(opened).sort()).toEqual(
      ["$.harness.arm", "$.task.id", "$.task.instruction"].sort(),
    );
  });

  it("a string at an unlisted path is refused (a new field is a reviewed change)", () => {
    const ep = { ...everything(), task: { ...everything().task, note: "x" } } as unknown as Episode;
    expect(() => closeEpisode(ep)).toThrow(/^\$\.task\.note is not a closed value/);
  });
});

describe("refusals name the field, never the value", () => {
  it("a closed field holding a path refuses the whole export with OPEN_VALUE", () => {
    const leak = ["Users", "/", "QzPLANTEDref"].join("");
    const c = candidate("ok", {
      groundTruth: {
        source: "independent-grader",
        graderVersion: leak,
        status: "pass",
        targetSatisfied: true,
        mismatchCount: 0,
        fixtureSha256: FIXTURE_SHA,
        persistedSha256: sha(DOC),
      },
    });
    const base = mkdtempSync(join(tmpdir(), "myco-u-allow-"));
    try {
      let err: ExportRefused | null = null;
      try {
        exportDataset([c], { outDir: join(base, "ds"), hygiene: HYGIENE });
      } catch (e) {
        if (e instanceof ExportRefused) err = e;
        else throw e;
      }
      expect(err?.code).toBe("OPEN_VALUE");
      expect(err?.where).toMatch(/:\$\.groundTruth\.graderVersion$/);
      expect(err?.message).not.toContain("QzPLANTEDref");
      expect(readdirSync(base)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("the container is digest-only (lead ruling 2026-11-26 20:3xZ)", () => {
  const words = ["QzPLANTEDdocfirst", "QzPLANTEDdoclast"];
  /** A captured document holding a long-path UNC path the leak scan does not flag. */
  const planted = Buffer.from(
    `id,qty\nEMP-0001,${["\\\\?\\UNC\\nas\\homes\\", words[0], " ", words[1]].join("")}\n`,
  );
  function withDoc(doc: Buffer): ExportCandidate {
    const c = candidate("ok", {
      groundTruth: {
        source: "independent-grader",
        graderVersion: "false-completion-grader/1",
        status: "pass",
        targetSatisfied: true,
        mismatchCount: 0,
        fixtureSha256: FIXTURE_SHA,
        persistedSha256: sha(doc),
      },
      persisted: doc,
    });
    return { ...c, capture: { path: "doc.csv", format: "csv", bytes: doc } };
  }

  it("a captured document the scan lets through never reaches the container; only its digest and size do", () => {
    const base = mkdtempSync(join(tmpdir(), "myco-u-allow-"));
    const dir = join(base, "ds");
    try {
      const r = exportDataset([withDoc(planted)], { outDir: dir, hygiene: HYGIENE });
      const written = everyFile(dir);
      expect(words.filter((w) => written.includes(w))).toEqual([]);
      expect(existsSync(join(dir, "blobs"))).toBe(false);
      expect(r.manifest.blobs).toEqual([]);
      expect(written).toContain(sha(planted));
      expect(validateContainer(dir)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("validateContainer refuses a blobs/ entry, a stray entry, an edit, an open string and an unreferenced episode", () => {
    const base = mkdtempSync(join(tmpdir(), "myco-u-allow-"));
    const fresh = (name: string) => {
      const dir = join(base, name);
      exportDataset([candidate("ok")], { outDir: dir, hygiene: HYGIENE });
      return dir;
    };
    try {
      const a = fresh("a");
      mkdirSync(join(a, "blobs"));
      writeFileSync(join(a, "blobs", `${sha(planted)}.csv`), planted);
      expect(validateContainer(a)).toContain("blobs/ is present: the container is digest-only");

      const b = fresh("b");
      writeFileSync(join(b, "notes.txt"), "x");
      expect(validateContainer(b)).toContain("notes.txt: not part of the container layout");

      const c = fresh("c");
      writeFileSync(join(c, "records.jsonl"), `${readFileSync(join(c, "records.jsonl"), "utf8")} `);
      expect(validateContainer(c)).toContain("records.jsonl does not hash to the manifest");

      const d = fresh("d");
      const [file] = readdirSync(join(d, "episodes"));
      const ep = JSON.parse(readFileSync(join(d, "episodes", file as string), "utf8"));
      ep.task.instruction = "cd Plain Text";
      writeFileSync(join(d, "episodes", file as string), `${canonicalJson(ep)}\n`);
      expect(validateContainer(d)).toEqual(
        expect.arrayContaining([
          `episodes/${file} does not hash to its record`,
          `episodes/${file}: OPEN_STRING at $.task.instruction`,
        ]),
      );

      const e = fresh("e");
      writeFileSync(join(e, "episodes", `${"0".repeat(64)}.json`), "{}\n");
      expect(validateContainer(e)).toContain(
        `episodes/${"0".repeat(64)}.json is not referenced by a record`,
      );

      // A record line edited (and the file hash in the manifest made consistent): the line's own
      // digest in the manifest catches it. A record removed the same way: the counts disagree.
      const g = fresh("g");
      const gm = JSON.parse(readFileSync(join(g, "manifest.json"), "utf8"));
      const edited = readFileSync(join(g, "records.jsonl"), "utf8").replace(
        '"positive"',
        '"negative"',
      );
      writeFileSync(join(g, "records.jsonl"), edited);
      gm.files["records.jsonl"] = sha(edited);
      writeFileSync(join(g, "manifest.json"), JSON.stringify(gm));
      expect(validateContainer(g)).toContain("records.jsonl#1 does not hash to the manifest");
      const h = fresh("h");
      const hm = JSON.parse(readFileSync(join(h, "manifest.json"), "utf8"));
      writeFileSync(join(h, "records.jsonl"), "");
      hm.files["records.jsonl"] = sha("");
      writeFileSync(join(h, "manifest.json"), JSON.stringify(hm));
      expect(validateContainer(h)).toContain(
        "records.jsonl and the manifest list different numbers of records",
      );

      const f = fresh("f");
      const m = JSON.parse(readFileSync(join(f, "manifest.json"), "utf8"));
      m.blobs = [
        { file: `blobs/${sha(planted)}.csv`, sha256: sha(planted), bytes: planted.byteLength },
      ];
      writeFileSync(join(f, "manifest.json"), JSON.stringify(m));
      expect(validateContainer(f).join("\n")).toMatch(/^manifest\.json:\$\.blobs maxItems$/m);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
