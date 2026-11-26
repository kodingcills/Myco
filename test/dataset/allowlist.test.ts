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
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARM_GRAMMAR,
  closeEpisode,
  closeRecordFields,
  EPISODE_FIELD_TREATMENT,
  KNOWN_KEYS,
  openEpisodeStrings,
  REGISTERED_APPS,
  templateOf,
} from "../../src/dataset/closed.ts";
import {
  draftEpisode,
  EPISODE_REAL_PLANNERS,
  type Episode,
  type EpisodeDraft,
  episodeIdOf,
} from "../../src/dataset/episode.ts";
import {
  CONTAINER_MAX_FILE_BYTES,
  CONTAINER_PROBLEM_CODES,
  canonicalJson,
  type ExportCandidate,
  ExportRefused,
  exportDataset,
  validateContainer,
} from "../../src/dataset/export.ts";
import { GENERIC_ACCOUNTS } from "../../src/dataset/hygiene.ts";
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
});

describe("#559 round 2 (prepared): arms, the container backstop, strict h- idempotence", () => {
  it("the arm grammar admits myco-gate, hcu+shell, variants and track U's arms; refuses drive-relative and path forms", () => {
    for (const ok of [
      "myco-gate",
      "hcu+shell",
      "myco-gate:retry",
      "myco-gate:no-retry",
      "scripted-u-e2e",
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
      "a_b",
      "x/y",
      "x\\y",
    ])
      expect(ARM_GRAMMAR.test(bad), bad).toBe(false);
    const next = makePathFuzzer(0x559);
    for (let i = 0; i < 1000; i++) {
      const v = next().value.slice(0, 64);
      expect(ARM_GRAMMAR.test(v), `case ${i}: ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("a candidate with arm myco-gate:retry exports, and the container validates", () => {
    const base = mkdtempSync(join(tmpdir(), "myco-u-allow-"));
    try {
      const dir = join(base, "ds");
      exportDataset([candidate("ok", { arm: "myco-gate:retry" })], {
        outDir: dir,
        hygiene: HYGIENE,
      });
      const [file] = readdirSync(join(dir, "episodes"));
      const ep = JSON.parse(readFileSync(join(dir, "episodes", file as string), "utf8"));
      expect(ep.harness.arm).toBe("myco-gate:retry");
      expect(validateContainer(dir, HYGIENE)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("free text that merely starts with h- is hashed, never kept (only an exact h-<64 hex> is)", () => {
    const words = ["QzPLANTEDhfirst", "QzPLANTEDhlast"];
    for (const text of [
      `h-C:\\Users\\${words[0]} ${words[1]}`,
      `h-${"a".repeat(64)} C:\\Users\\${words[0]} ${words[1]}`,
      `h-${"a".repeat(63)}`,
    ]) {
      const closed = closeEpisode(candidate(text).episode);
      expect(closed.task.instruction, text).toMatch(/^h-[0-9a-f]{64}$/);
      expect(closed.task.instruction).not.toBe(text);
      expect(words.filter((w) => canonicalJson(closed).includes(w))).toEqual([]);
      expect(
        openEpisodeStrings({ ...closed, task: { ...closed.task, instruction: text } }),
      ).toEqual(["$.task.instruction"]);
    }
    for (const [name, value, w] of PROBES.slice(0, 40)) {
      const closed = closeEpisode(candidate(`h-${value}`).episode);
      expect(
        w.filter((x) => canonicalJson(closed).includes(x)),
        name,
      ).toEqual([]);
    }
  });
});

/**
 * Hand-edit an exported container, keeping every hash consistent: the episode re-addressed by its
 * content, the record's episode reference and digest, the manifest's record digest and episode id,
 * and the records file hash. What is left wrong is only what the edit made wrong.
 */
function rewriteContainer(
  dir: string,
  edit: {
    episode?: (ep: Record<string, unknown>) => unknown;
    record?: (r: Record<string, unknown>) => unknown;
    manifest?: (m: Record<string, unknown>) => unknown;
  },
): void {
  const record = JSON.parse(readFileSync(join(dir, "records.jsonl"), "utf8"));
  if (edit.episode !== undefined) {
    const old = record.episode.file as string;
    const ep = edit.episode(JSON.parse(readFileSync(join(dir, old), "utf8")));
    const { episodeId: _x, ...rest } = ep as Record<string, unknown>;
    const id = episodeIdOf(rest as unknown as Episode);
    const text = `${canonicalJson({ ...rest, episodeId: id })}\n`;
    rmSync(join(dir, old));
    writeFileSync(join(dir, "episodes", `${id}.json`), text);
    record.episode = { ...record.episode, id, sha256: sha(text), file: `episodes/${id}.json` };
  }
  const edited = edit.record === undefined ? record : edit.record(record);
  const line = canonicalJson(edited);
  writeFileSync(join(dir, "records.jsonl"), `${line}\n`);
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  m.records[0] = { ...m.records[0], episodeId: record.episode.id, sha256: sha(line) };
  m.files["records.jsonl"] = sha(`${line}\n`);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(edit.manifest === undefined ? m : edit.manifest(m)),
  );
}

describe("validateContainer (#559 round 1, D1-D6): fixed codes, never a value, never a throw", () => {
  const base = () => mkdtempSync(join(tmpdir(), "myco-u-vc-"));
  /** A fresh valid container under a temp dir; returns [container, temp]. */
  const fresh = (): [string, string] => {
    const b = base();
    const dir = join(b, "ds");
    exportDataset([candidate("ok")], { outDir: dir, hygiene: HYGIENE });
    expect(validateContainer(dir, HYGIENE)).toEqual([]);
    return [dir, b];
  };
  const codes = (ps: readonly string[]) => ps.map((p) => p.split(" ")[0]);
  const withFresh = (fn: (dir: string, b: string) => void) => {
    const [dir, b] = fresh();
    try {
      fn(dir, b);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  };

  it("every problem is CODE location, from the fixed list", () => {
    withFresh((dir) => {
      mkdirSync(join(dir, "blobs"));
      writeFileSync(join(dir, "records.jsonl"), "{}\n");
      const ps = validateContainer(dir, HYGIENE);
      expect(ps.length).toBeGreaterThan(0);
      for (const p of ps)
        expect((CONTAINER_PROBLEM_CODES as readonly string[]).includes(p.split(" ")[0]!), p).toBe(
          true,
        );
    });
  });

  it("layout: blobs/, a stray entry (name never echoed), an unreferenced episode", () => {
    withFresh((dir) => {
      mkdirSync(join(dir, "blobs"));
      const stray = ["Jo", " ", "Smith", " notes"].join("");
      writeFileSync(join(dir, stray), "x");
      writeFileSync(join(dir, "episodes", `${"0".repeat(64)}.json`), "{}\n");
      const ps = validateContainer(dir, HYGIENE);
      expect(ps).toEqual(
        expect.arrayContaining([
          "BLOBS_PRESENT blobs/",
          `UNREFERENCED episodes/${"0".repeat(64)}.json`,
        ]),
      );
      expect(ps.some((p) => /^STRAY_ENTRY h-[0-9a-f]{12}$/.test(p))).toBe(true);
      expect(ps.some((p) => p.includes("Smith"))).toBe(false);
    });
  });

  it("D1: a missing root, a file as root, and 200k nested arrays never throw", () => {
    const b = base();
    try {
      expect(validateContainer(join(b, "absent"))).toEqual(["CONTAINER_UNREADABLE $"]);
      writeFileSync(join(b, "file"), "x");
      expect(validateContainer(join(b, "file"))).toEqual(["CONTAINER_UNREADABLE $"]);
      // A container root that is a link to a valid container is refused, not followed.
      const real = join(b, "real");
      exportDataset([candidate("ok")], { outDir: real, hygiene: HYGIENE });
      expect(validateContainer(real, HYGIENE)).toEqual([]);
      symlinkSync(real, join(b, "linked"));
      expect(validateContainer(join(b, "linked"), HYGIENE)).toEqual(["CONTAINER_UNREADABLE $"]);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
    withFresh((dir) => {
      const deep = `${"[".repeat(200_000)}${"]".repeat(200_000)}`;
      expect(() =>
        openEpisodeStrings(JSON.parse(`{"a":${"[".repeat(5000)}"x"${"]".repeat(5000)}}`)),
      ).not.toThrow();
      const record = JSON.parse(readFileSync(join(dir, "records.jsonl"), "utf8"));
      writeFileSync(join(dir, record.episode.file), deep);
      record.episode.sha256 = sha(deep);
      rewriteContainer(dir, { record: () => record });
      const ps = validateContainer(dir, HYGIENE);
      expect(codes(ps).some((c) => c === "EPISODE_DEPTH" || c === "EPISODE_JSON")).toBe(true);
    });
  });

  it("D2: a record line is schema-checked and its free fields closed, even with every hash consistent", () => {
    const cases: [string, (r: Record<string, unknown>) => unknown, RegExp][] = [
      [
        "capture.path",
        (r) => ({
          ...r,
          capture: {
            ...(r.capture as object),
            path: ["C:", "\\Users\\Jo Smith\\doc.csv"].join(""),
          },
        }),
        /^RECORD_(OPEN|SCHEMA) records\.jsonl#1:\$\.capture\.path/,
      ],
      [
        "an extra note",
        (r) => ({ ...r, note: ["/home/", "josmith/x"].join("") }),
        /^RECORD_SCHEMA records\.jsonl#1:\$ additionalProperties/,
      ],
      [
        "desktop.image",
        (r) => ({
          ...r,
          desktop: { ...(r.desktop as object), image: ["/home/", "josmith/vm.qcow2"].join("") },
        }),
        /^RECORD_(OPEN|SCHEMA) records\.jsonl#1:\$\.desktop\.image/,
      ],
    ];
    for (const [name, edit, want] of cases)
      withFresh((dir) => {
        rewriteContainer(dir, { record: edit });
        const ps = validateContainer(dir, HYGIENE);
        expect(
          ps.some((p) => want.test(p)),
          name,
        ).toBe(true);
      });
  });

  it("D3: an episode is schema-checked: a path used as a key with a non-string value is refused", () => {
    withFresh((dir) => {
      rewriteContainer(dir, {
        episode: (ep) => ({ ...ep, [["C:", "\\Users\\Jo Smith"].join("")]: 1 }),
      });
      const ps = validateContainer(dir, HYGIENE);
      expect(
        ps.some((p) =>
          /^EPISODE_SCHEMA episodes\/[0-9a-f]{64}\.json:\$ additionalProperties$/.test(p),
        ),
      ).toBe(true);
      expect(ps.some((p) => p.includes("Smith"))).toBe(false);
    });
  });

  it("D4: symlinks (records, an episode, episodes/) and hard links are refused", () => {
    withFresh((dir, b) => {
      const out = join(b, "outside.jsonl");
      renameSync(join(dir, "records.jsonl"), out);
      symlinkSync(out, join(dir, "records.jsonl"));
      expect(validateContainer(dir, HYGIENE)).toContain("LINK records.jsonl");
    });
    withFresh((dir, b) => {
      const record = JSON.parse(readFileSync(join(dir, "records.jsonl"), "utf8"));
      const out = join(b, "ep.json");
      renameSync(join(dir, record.episode.file), out);
      symlinkSync(out, join(dir, record.episode.file));
      expect(validateContainer(dir, HYGIENE)).toContain(`LINK ${record.episode.file}`);
    });
    withFresh((dir, b) => {
      renameSync(join(dir, "episodes"), join(b, "eps"));
      symlinkSync(join(b, "eps"), join(dir, "episodes"));
      expect(validateContainer(dir, HYGIENE)).toContain("LINK episodes/");
    });
    withFresh((dir, b) => {
      linkSync(join(dir, "manifest.json"), join(b, "m2.json"));
      expect(validateContainer(dir, HYGIENE)).toContain("HARDLINK manifest.json");
    });
  });

  it("D1: a parseable but deep episode is EPISODE_DEPTH; a file over the size cap is TOO_LARGE, never read", () => {
    withFresh((dir) => {
      const deep = `${"[".repeat(100)}${"]".repeat(100)}`;
      const record = JSON.parse(readFileSync(join(dir, "records.jsonl"), "utf8"));
      writeFileSync(join(dir, record.episode.file), deep);
      record.episode.sha256 = sha(deep);
      rewriteContainer(dir, { record: () => record });
      expect(validateContainer(dir, HYGIENE)).toContain(`EPISODE_DEPTH ${record.episode.file}`);
    });
    withFresh((dir) => {
      truncateSync(join(dir, "records.jsonl"), CONTAINER_MAX_FILE_BYTES + 1);
      expect(validateContainer(dir, HYGIENE)).toContain("TOO_LARGE records.jsonl");
    });
  });

  it("D2: schema-valid record fields that are not closed are RECORD_OPEN; a record that disagrees with the manifest is RECORD_MISMATCH", () => {
    for (const [name, edit, path] of [
      [
        "capture.path not hashed",
        (r: Record<string, unknown>) => ({
          ...r,
          capture: { ...(r.capture as object), path: "doc.csv" },
        }),
        "$.capture.path",
      ],
      [
        "desktop.image not a closed id",
        (r: Record<string, unknown>) => ({
          ...r,
          desktop: { ...(r.desktop as object), image: "Users.jsmith:Documents" },
        }),
        "$.desktop.image",
      ],
      [
        "desktop.backend not a closed id",
        (r: Record<string, unknown>) => ({
          ...r,
          desktop: { ...(r.desktop as object), backend: "a:b" },
        }),
        "$.desktop.backend",
      ],
    ] as const)
      withFresh((dir) => {
        rewriteContainer(dir, { record: edit });
        expect(validateContainer(dir, HYGIENE), name).toContain(
          `RECORD_OPEN records.jsonl#1:${path}`,
        );
      });
    withFresh((dir) => {
      rewriteContainer(dir, { record: (r) => ({ ...r, label: "negative" }) });
      expect(validateContainer(dir, HYGIENE)).toContain("RECORD_MISMATCH records.jsonl#1");
    });
  });

  it("D5: manifest counts are recomputed", () => {
    for (const edit of [
      // Each case changes one count only (records and candidates move together, so only the
      // records count is wrong; positive alone; and so on).
      (m: Record<string, unknown>) => ({
        ...m,
        counts: { ...(m.counts as object), records: 5, candidates: 5 },
      }),
      (m: Record<string, unknown>) => ({ ...m, counts: { ...(m.counts as object), positive: 0 } }),
      (m: Record<string, unknown>) => ({
        ...m,
        counts: { ...(m.counts as object), positive: 0, negative: 1 },
      }),
      (m: Record<string, unknown>) => ({
        ...m,
        counts: { ...(m.counts as object), candidates: 9 },
      }),
      (m: Record<string, unknown>) => ({ ...m, counts: { ...(m.counts as object), simulated: 1 } }),
    ])
      withFresh((dir) => {
        rewriteContainer(dir, { manifest: edit });
        expect(validateContainer(dir, HYGIENE)).toContain("COUNTS manifest.json");
      });
  });

  it("an episode edited without re-hashing is EPISODE_HASH; edited but not re-addressed is EPISODE_RULE", () => {
    withFresh((dir) => {
      const record = JSON.parse(readFileSync(join(dir, "records.jsonl"), "utf8"));
      const ep = JSON.parse(readFileSync(join(dir, record.episode.file), "utf8"));
      ep.task.id = "task-9";
      writeFileSync(join(dir, record.episode.file), `${canonicalJson(ep)}\n`);
      const ps = validateContainer(dir, HYGIENE);
      expect(ps).toContain(`EPISODE_HASH ${record.episode.file}`);
      // Now make the record's digest agree: the content address is still wrong.
      const text = readFileSync(join(dir, record.episode.file), "utf8");
      rewriteContainer(dir, {
        record: (r) => ({ ...r, episode: { ...(r.episode as object), sha256: sha(text) } }),
      });
      expect(validateContainer(dir, HYGIENE)).toContain(
        `EPISODE_RULE ${record.episode.file}:$.episodeId ID_MISMATCH`,
      );
    });
  });

  it("hashes, the record count, the line digest, open strings and the key-shaped backstop", () => {
    withFresh((dir) => {
      writeFileSync(
        join(dir, "records.jsonl"),
        `${readFileSync(join(dir, "records.jsonl"), "utf8")} `,
      );
      expect(validateContainer(dir, HYGIENE)).toContain("FILE_HASH records.jsonl");
    });
    withFresh((dir) => {
      rewriteContainer(dir, { manifest: (m) => ({ ...m, records: [] }) });
      expect(validateContainer(dir, HYGIENE)).toContain("RECORD_COUNT records.jsonl");
    });
    withFresh((dir) => {
      rewriteContainer(dir, {
        manifest: (m) => ({
          ...m,
          records: [{ ...(m.records as object[])[0], sha256: "0".repeat(64) }],
        }),
      });
      expect(validateContainer(dir, HYGIENE)).toContain("RECORD_HASH records.jsonl#1");
    });
    withFresh((dir) => {
      rewriteContainer(dir, {
        episode: (ep) => ({
          ...ep,
          task: { ...(ep.task as object), instruction: "cd Plain Text" },
        }),
      });
      expect(
        validateContainer(dir, HYGIENE).some((p) =>
          /^OPEN_STRING episodes\/[0-9a-f]{64}\.json:\$\.task\.instruction$/.test(p),
        ),
      ).toBe(true);
    });
    withFresh((dir) => {
      const key = ["sk", "ant", "api03", "x".repeat(24)].join("-");
      rewriteContainer(dir, {
        episode: (ep) => ({ ...ep, task: { ...(ep.task as object), id: key } }),
      });
      expect(
        validateContainer(dir, HYGIENE).some((p) =>
          /^LEAK episodes\/[0-9a-f]{64}\.json:\$\.task\.id secret-shaped$/.test(p),
        ),
      ).toBe(true);
    });
    withFresh((dir) => {
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      m.blobs = [{ file: `blobs/${"a".repeat(64)}.csv`, sha256: "a".repeat(64), bytes: 1 }];
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
      expect(validateContainer(dir, HYGIENE)).toEqual([
        "MANIFEST_SCHEMA manifest.json:$.blobs maxItems",
      ]);
    });
  });
});

describe("identity strings are leaks (lead ruling 21:52Z): bare username, host name, configured identity", () => {
  // The real host values, read now and never printed: assertions compare booleans only. On a CI
  // runner the account is the generic `runner` (#560's list), so the real-value cases skip there;
  // the PLANTED cases run everywhere and are what CI proves.
  const realUser = (() => {
    try {
      return userInfo().username;
    } catch {
      return "";
    }
  })();
  const realHost = hostname().split(".")[0] ?? "";
  const idShaped = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const userCounts =
    realUser.length >= 3 &&
    !GENERIC_ACCOUNTS.has(realUser.toLowerCase()) &&
    idShaped.test(realUser);
  const hostCounts =
    realHost.length >= 4 && realHost.toLowerCase() !== "localhost" && idShaped.test(realHost);
  const PLANTED = ["qzplant", "user"].join("");
  const planted = { identity: { user: PLANTED, host: "nohost-u" } };
  const variants = (v: string) => [v, v.toUpperCase(), v.toLowerCase()];
  /** Joined forms: `_`, `.`, `-` and a digit, letters, camelCase. */
  const joinedForms = (v: string) => [
    `${v}_trial`,
    `${v}.x`,
    `t-${v}-1`,
    `${v}2`,
    `xx${v}`,
    `${v}Trial`,
  ];

  /** Id, token and desktop-fact placements: an identity there is DIGESTED. */
  const digested: [string, (v: string) => ExportCandidate][] = [
    [
      "task id",
      (v) => {
        const c = candidate("ok", {
          task: { ...candidate("ok").episode.task, id: v },
        } as Partial<EpisodeDraft>);
        return { ...c, gate: { ...c.gate!, request: { ...c.gate!.request, taskId: v } } };
      },
    ],
    [
      "run id",
      (v) => {
        const c = candidate("ok", { runId: v });
        return { ...c, gate: { ...c.gate!, request: { ...c.gate!.request, runId: v } } };
      },
    ],
    ["trial key", (v) => candidate("ok", { trialKey: v })],
    ["key name", (v) => candidate("ok", { actions: [{ kind: "key", keys: v.slice(0, 64) }] })],
    ["app name", (v) => candidate("ok", { actions: [{ kind: "launch", app: v.slice(0, 64) }] })],
    [
      "desktop backend",
      (v) => ({ ...candidate("ok"), desktop: { ...candidate("ok").desktop, backend: v } }),
    ],
    [
      "desktop image",
      (v) => ({ ...candidate("ok"), desktop: { ...candidate("ok").desktop, image: v } }),
    ],
  ];
  /** A closed pattern field kept verbatim: an identity there REFUSES the export. */
  const taskSet = (v: string) =>
    candidate("ok", {
      task: { ...candidate("ok").episode.task, taskSetVersion: v },
    } as Partial<EpisodeDraft>);

  function attempt(c: ExportCandidate, hygiene: object) {
    const b = mkdtempSync(join(tmpdir(), "myco-u-id-"));
    const dir = join(b, "ds");
    try {
      exportDataset([c], { outDir: dir, hygiene });
      return {
        refused: null as ExportRefused | null,
        written: everyFile(dir),
        valid: validateContainer(dir, hygiene),
      };
    } catch (e) {
      if (e instanceof ExportRefused) return { refused: e, written: "", valid: [] as string[] };
      throw e;
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  }
  /**
   * Never written verbatim: either the raw scan refuses the export (a word-bounded identity in
   * the raw episode or record is a LEAK signal), or the export goes through with the value
   * digested (a joined form the raw scan cannot see), and the container validates.
   */
  const digestedEverywhere = (v: string, hygiene: object) => {
    for (const [name, put] of digested) {
      const r = attempt(put(v), hygiene);
      if (r.refused !== null) {
        expect(r.refused.code === "LEAK", name).toBe(true);
        expect(r.refused.message.toLowerCase().includes(v.toLowerCase()), name).toBe(false);
        continue;
      }
      expect(r.written.toLowerCase().includes(v.toLowerCase()), name).toBe(false);
      expect(r.valid.length === 0, name).toBe(true);
    }
  };

  it("a planted identity (runs everywhere): digested in every id, token and desktop field, in every case and joined form", () => {
    for (const v of [...variants(PLANTED), ...joinedForms(PLANTED)]) digestedEverywhere(v, planted);
    // Joined forms the raw (word-bounded) scan cannot see, in any case, are DIGESTED, never
    // merely refused: closing is identity-aware.
    for (const v of [
      `${PLANTED}2`,
      `xx${PLANTED}`,
      `${PLANTED}Trial`,
      `XX${PLANTED.toUpperCase()}9`,
    ])
      for (const [name, put] of digested.filter(([n]) => n !== "key name" && n !== "app name")) {
        const r = attempt(put(v), planted);
        expect(r.refused === null, `${name} ${v.length}`).toBe(true);
        expect(r.written.toLowerCase().includes(v.toLowerCase()), name).toBe(false);
      }
    // An identity that is also a registered app id is still hashed (identity beats vocabulary).
    const app = closeEpisode(
      candidate("ok", { actions: [{ kind: "launch", app: "localc" }] }).episode,
      [["identity", "localc"]],
    ).actions.items[0] as unknown as { app: string };
    expect(/^h-[0-9a-f]{60}$/.test(app.app)).toBe(true);
    // Without the identity, the same id is kept verbatim (the digest is the identity check's doing).
    const r = attempt(digested[0]![1](PLANTED), HYGIENE);
    expect(r.refused === null && r.written.includes(PLANTED)).toBe(true);
  });

  it("a planted identity in a closed pattern field refuses the export (LEAK, kind and path, never the value)", () => {
    for (const v of [...variants(PLANTED), `${PLANTED}2`, `xx${PLANTED}`]) {
      const r = attempt(taskSet(v), planted);
      expect(r.refused?.code === "LEAK" && r.refused?.detail === "username").toBe(true);
      expect(/:\$\.task\.taskSetVersion$/.test(r.refused?.where ?? "")).toBe(true);
      expect((r.refused?.message ?? "").toLowerCase().includes(PLANTED)).toBe(false);
    }
  });

  it("the real host username and host name (skipped on CI's generic account): digested in ids, refused in a closed field", () => {
    for (const [counts, value, kind] of [
      [userCounts, realUser, "username"],
      [hostCounts, realHost, "hostname"],
    ] as const) {
      if (!counts) continue;
      for (const v of [...variants(value), `${value}2`]) {
        digestedEverywhere(v, HYGIENE);
        const r = attempt(taskSet(v), HYGIENE);
        expect(r.refused?.code === "LEAK" && r.refused?.detail === kind).toBe(true);
        expect((r.refused?.message ?? "").toLowerCase().includes(value.toLowerCase())).toBe(false);
      }
    }
  });

  it("configured identity strings (an identity file): an alias is digested or refused in any case; a full name with a space never appears", () => {
    const b = mkdtempSync(join(tmpdir(), "myco-u-idf-"));
    try {
      const file = join(b, "identity.txt");
      const alias = ["qzplant", "alias"].join("");
      const full = ["Qzfirst", " ", "Plantlast"].join("");
      writeFileSync(file, `# configured identity\n${alias}\n${full}\n`);
      for (const v of variants(alias)) {
        digestedEverywhere(v, { ...HYGIENE, identityFile: file });
        const r = attempt(taskSet(v), { ...HYGIENE, identityFile: file });
        expect(r.refused?.code === "LEAK" && r.refused?.detail === "identity").toBe(true);
      }
      for (const v of variants(full)) {
        const r = attempt(
          candidate(`I am ${v}`, { actions: [{ kind: "key", keys: v.slice(0, 64) }] }),
          {
            ...HYGIENE,
            identityFile: file,
          },
        );
        // Never written: the raw scan refuses the episode (the full name is a word in it), or,
        // were it not seen, the free text would be digested.
        if (r.refused !== null) {
          expect(r.refused.code === "LEAK" && r.refused.detail === "identity").toBe(true);
          expect(r.refused.message.toLowerCase().includes(v.toLowerCase())).toBe(false);
        } else expect(r.written.toLowerCase().includes(v.toLowerCase())).toBe(false);
      }
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("validateContainer refuses a hand-edited container carrying an identity (joined forms too), this machine's included", () => {
    const b = mkdtempSync(join(tmpdir(), "myco-u-idv-"));
    try {
      const file = join(b, "identity.txt");
      const alias = ["qzplant", "other"].join("");
      writeFileSync(file, `${alias}\n`);
      for (const image of [alias.toUpperCase(), `xx${alias}9`]) {
        const dir = join(b, `ds-${image.length}-${image[0]}`);
        exportDataset([candidate("ok")], { outDir: dir, hygiene: HYGIENE });
        rewriteContainer(dir, {
          record: (r) => ({ ...r, desktop: { ...(r.desktop as object), image } }),
        });
        expect(validateContainer(dir, HYGIENE)).toEqual([]);
        expect(validateContainer(dir, { ...HYGIENE, identityFile: file })).toEqual([
          "LEAK records.jsonl#1:$.desktop.image identity",
        ]);
      }
      if (userCounts) {
        const dir = join(b, "ds-real");
        exportDataset([candidate("ok")], { outDir: dir, hygiene: HYGIENE });
        rewriteContainer(dir, {
          record: (r) => ({
            ...r,
            desktop: { ...(r.desktop as object), image: `${realUser.toLowerCase()}2` },
          }),
        });
        const ps = validateContainer(dir, HYGIENE);
        expect(ps.includes("LEAK records.jsonl#1:$.desktop.image username")).toBe(true);
        expect(ps.some((p) => p.toLowerCase().includes(realUser.toLowerCase()))).toBe(false);
      }
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("fixed vocabulary and digests are exempt (no false refusal); generic accounts are not identities (#560's list)", () => {
    // A hex-only identity inside every digest is not a false refusal (digests are exempt).
    for (const user of ["bbbb"]) {
      const r = attempt(candidate("ok"), { identity: { user, host: "nohost-u" } });
      expect(r.refused).toBeNull();
      expect(r.valid).toEqual([]);
    }
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
    const r = attempt(digested[0]![1]("runner-task"), {
      identity: { user: "runner", host: "nohost-u" },
    });
    expect(r.refused === null && r.written.includes("runner-task")).toBe(true);
  });
});

describe("F1 (lead ruling 22:18Z): key and app names are verbatim only from a closed vocabulary", () => {
  const close = (actions: EpisodeDraft["actions"]) => {
    const ep = closeEpisode(candidate("ok", { actions }).episode);
    return ep.actions.items as unknown as readonly { kind: string; keys?: string; app?: string }[];
  };
  const hashed = /^h-[0-9a-f]{60}$/;

  it("a known key (or combination) and a registered app pass verbatim", () => {
    for (const keys of [
      "ctrl+s",
      "Return",
      "F5",
      "ctrl+shift+Tab",
      "a",
      "escape",
      "pagedown",
      "cmd+alt+shift+left",
    ])
      expect(close([{ kind: "key", keys }])[0]?.keys, keys).toBe(keys);
    for (const app of ["localc", "lowriter", "soffice", "libreoffice", "scalc", "swriter"])
      expect(close([{ kind: "launch", app }])[0]?.app, app).toBe(app);
  });

  it("an unknown key, an identity-like value, a path and a near-miss spelling are hashed", () => {
    const keys = [
      "hyperkey",
      "jsmith",
      "Users.jsmith.Documents",
      "C:Users",
      "ctrl+ss",
      "f13",
      "ctrl+ctrl+ctrl+ctrl+s",
      "retrun",
      "localc",
    ];
    for (const k of keys) {
      const out = close([{ kind: "key", keys: k }])[0]?.keys ?? "";
      expect(hashed.test(out), k).toBe(true);
    }
    const apps = [
      "jsmith",
      "Users.jsmith.Documents",
      "localc fixture.csv",
      "locaIc",
      "localc2",
      "LOCALC",
      "soffice.bin",
      "bash",
    ];
    for (const a of apps) {
      const out = close([{ kind: "launch", app: a }])[0]?.app ?? "";
      expect(hashed.test(out), a).toBe(true);
    }
  });

  it("the vocabularies are exact (anchored), and the container's open-string check holds them to it", () => {
    expect(KNOWN_KEYS.test("xctrl+s")).toBe(false);
    expect(KNOWN_KEYS.test("ctrl+sx")).toBe(false);
    expect(REGISTERED_APPS.test("xlocalc")).toBe(false);
    expect(REGISTERED_APPS.test("localcx")).toBe(false);
    const ep = closeEpisode(
      candidate("ok", { actions: [{ kind: "launch", app: "localc" }] }).episode,
    );
    expect(openEpisodeStrings(ep)).toEqual([]);
    const edited = {
      ...ep,
      actions: { ...ep.actions, items: [{ ...ep.actions.items[0], app: "jsmith" }] },
    };
    expect(openEpisodeStrings(edited)).toEqual(["$.actions.items[0].app"]);
  });
});
