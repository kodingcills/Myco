/**
 * Track U dataset exporter (src/dataset/export.ts): a container over canonical
 * `myco.episode/1` records. Which episodes are exported, which exports are refused, and that
 * nothing that would leak is ever written, in any output file. Mutation-proved by
 * scripts/desktops-mutation-proof.sh.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { datasetManifestSchema, datasetRecordSchema } from "../../schemas/dataset-export.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  draftEpisode,
  type Episode,
  type EpisodeDraft,
  type EpisodeGroundTruth,
  episodeIdOf,
  episodeMirrorSchema,
} from "../../src/dataset/episode.ts";
import {
  canonicalJson,
  classify,
  type DesktopFacts,
  type ExportCandidate,
  ExportRefused,
  exportDataset,
  type GateLike,
} from "../../src/dataset/export.ts";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const NOW = () => new Date("2026-11-26T16:00:00.000Z");
const FIXTURE_SHA = sha("pristine fixture");
const DOC = Buffer.from("id,qty\nEMP-0001,42\n");
const j = (...parts: string[]) => parts.join("");

interface Over {
  readonly gate?: GateLike | null;
  readonly draft?: Partial<EpisodeDraft>;
  readonly truth?: Partial<EpisodeGroundTruth & { source: "independent-grader" }>;
  readonly capture?: ExportCandidate["capture"];
  readonly fixtureSha256?: string;
  readonly desktop?: Partial<DesktopFacts>;
}

function rawGate(k: number, fields: Partial<GateLike> = {}): GateLike {
  return {
    apiVersion: "myco.gate/v1",
    verdict: "verified",
    accepted: true,
    reasonCodes: ["ORACLE_PASS"],
    request: { taskId: `task-${k}`, runId: `run-${k}` },
    ...fields,
  };
}

/** The episode's gate record mirrors the raw gate when the raw gate is well-formed. */
function episodeGateOf(g: GateLike | null): EpisodeDraft["gate"] {
  const fallback = {
    verdict: "verified",
    accepted: true,
    reasonCodes: ["ORACLE_PASS"],
    oracle: null,
  } as const;
  if (g === null) return fallback;
  const ok =
    (g.verdict === "verified" || g.verdict === "refuted" || g.verdict === "uncertain") &&
    g.accepted === (g.verdict === "verified");
  if (!ok) return fallback;
  return {
    verdict: g.verdict as "verified" | "refuted" | "uncertain",
    accepted: g.accepted,
    reasonCodes: [...g.reasonCodes],
    oracle: null,
  };
}

function candidate(k: number, o: Over = {}): ExportCandidate {
  const gate = o.gate === undefined ? rawGate(k) : o.gate;
  const epGate = o.draft?.gate === undefined ? episodeGateOf(gate) : o.draft.gate;
  const truth: EpisodeGroundTruth = {
    source: "independent-grader",
    graderVersion: "false-completion-grader/1",
    status: "pass",
    targetSatisfied: true,
    mismatchCount: 0,
    fixtureSha256: FIXTURE_SHA,
    persistedSha256: sha(DOC),
    ...o.truth,
  } as EpisodeGroundTruth;
  const instruction = `Set record EMP-0001, column qty, to "42", and save. (${k})`;
  const draft: EpisodeDraft = {
    outcome: epGate?.verdict ?? "harness-fault",
    simulated: false,
    task: {
      id: `task-${k}`,
      family: "calc-record-edit",
      taskSetVersion: null,
      faultClass: null,
      instruction,
      instructionSha256: sha(instruction),
      fixtureSha256: FIXTURE_SHA,
    },
    actions: [
      { kind: "launch", app: "localc fixture.csv" },
      { kind: "type", text: "42" },
      { kind: "key", keys: "ctrl+s" },
    ],
    observations: [{ afterAction: 0, text: "opened" }],
    withheld: 0,
    agentClaim: "done",
    gate: epGate,
    groundTruth: truth,
    arm: "hcu+shell",
    plannerModelId: "claude-model-x",
    startedAt: "2026-11-26T15:00:00.000Z",
    endedAt: "2026-11-26T15:01:00.000Z",
    source: "gated-trial",
    runId: `run-${k}`,
    trialKey: `task-${k}:run-${k}`,
    ...o.draft,
  };
  return {
    episode: draftEpisode(draft),
    fixtureSha256: o.fixtureSha256 ?? FIXTURE_SHA,
    gate,
    capture: o.capture === undefined ? { path: "doc.csv", format: "csv", bytes: DOC } : o.capture,
    desktop: {
      backend: "local-process/1",
      isolation: "process",
      networkEnforced: false,
      image: "myco-linux-desktop/1",
      ...o.desktop,
    },
  };
}

function refuted(k: number, o: Over = {}): ExportCandidate {
  return candidate(k, {
    gate: rawGate(k, { verdict: "refuted", accepted: false, reasonCodes: ["ORACLE_FAIL"] }),
    truth: { status: "fail", mismatchCount: 1, targetSatisfied: false },
    ...o,
  });
}

/** Re-addresses a hand-edited episode so only the edit (not the id) is wrong. */
function readdressed(ep: Record<string, unknown>): Episode {
  const { episodeId: _drop, ...rest } = ep;
  return {
    ...(rest as unknown as Omit<Episode, "episodeId">),
    episodeId: episodeIdOf(rest as unknown as Episode),
  };
}

function out(): string {
  return join(mkdtempSync(join(tmpdir(), "myco-u-export-")), "ds");
}

function refusal(fn: () => unknown): ExportRefused {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExportRefused) return e;
    throw e;
  }
  throw new Error("expected the export to be refused");
}

const fileOf = (c: ExportCandidate) => `episodes/${c.episode.episodeId}.json`;

describe("classify: positives need gate verified AND grader pass AND both bound", () => {
  it("verified + pass + claimed done is positive", () => {
    expect(classify(candidate(1), false)).toEqual({ label: "positive" });
  });

  it.each<[string, string, ExportCandidate]>([
    ["no raw gate result", "MISSING_GATE", candidate(1, { gate: null })],
    ["no gate record in the episode", "MISSING_GATE", candidate(1, { draft: { gate: null } })],
    [
      "no independent grade",
      "MISSING_GRADE",
      candidate(1, {
        draft: { groundTruth: { source: "none", reason: "no-independent-grader" } },
      }),
    ],
    ["no capture", "MISSING_CAPTURE", candidate(1, { capture: null })],
    [
      "wrong api version",
      "GATE_MALFORMED",
      candidate(1, { gate: rawGate(1, { apiVersion: "myco.gate/v2" }) }),
    ],
    [
      "unknown verdict",
      "GATE_MALFORMED",
      candidate(1, { gate: rawGate(1, { verdict: "VERIFIED" }) }),
    ],
    [
      "verified but not accepted",
      "GATE_MALFORMED",
      candidate(1, { gate: rawGate(1, { accepted: false }) }),
    ],
    [
      "refuted but accepted",
      "GATE_MALFORMED",
      candidate(1, { gate: rawGate(1, { verdict: "refuted", accepted: true }) }),
    ],
    [
      "gate answered another task",
      "GATE_NOT_BOUND",
      candidate(1, { gate: rawGate(1, { request: { taskId: "task-2", runId: "run-1" } }) }),
    ],
    [
      "gate answered another run",
      "GATE_NOT_BOUND",
      candidate(1, { gate: rawGate(1, { request: { taskId: "task-1", runId: "run-2" } }) }),
    ],
    [
      "gate request without ids",
      "GATE_NOT_BOUND",
      candidate(1, { gate: rawGate(1, { request: {} }) }),
    ],
    [
      "episode records another verdict than the gate gave",
      "GATE_EPISODE_MISMATCH",
      candidate(1, {
        draft: {
          outcome: "refuted",
          gate: { verdict: "refuted", accepted: false, reasonCodes: ["ORACLE_PASS"], oracle: null },
        },
      }),
    ],
    [
      "episode records other reason codes",
      "GATE_EPISODE_MISMATCH",
      candidate(1, {
        draft: {
          gate: { verdict: "verified", accepted: true, reasonCodes: ["OTHER"], oracle: null },
        },
      }),
    ],
    [
      "episode records no reason codes",
      "GATE_EPISODE_MISMATCH",
      candidate(1, {
        draft: { gate: { verdict: "verified", accepted: true, reasonCodes: null, oracle: null } },
      }),
    ],
    [
      "grade of other bytes",
      "GRADE_NOT_BOUND",
      candidate(1, { truth: { persistedSha256: sha("other") } }),
    ],
    [
      "grade with no persisted digest",
      "GRADE_NOT_BOUND",
      candidate(1, { truth: { persistedSha256: null } }),
    ],
    [
      "grade against another fixture",
      "GRADE_NOT_BOUND",
      candidate(1, { truth: { fixtureSha256: sha("x") } }),
    ],
    [
      "episode task names another fixture",
      "GRADE_NOT_BOUND",
      candidate(1, {
        draft: {
          task: { ...candidate(1).episode.task, fixtureSha256: sha("x") },
        },
      }),
    ],
    [
      "task set declares another fixture",
      "GRADE_NOT_BOUND",
      candidate(1, { fixtureSha256: sha("declared") }),
    ],
    [
      "captured bytes changed after grading",
      "GRADE_NOT_BOUND",
      candidate(1, { capture: { path: "doc.csv", format: "csv", bytes: Buffer.from("tampered") } }),
    ],
    [
      "gate uncertain",
      "GATE_UNCERTAIN",
      candidate(1, { gate: rawGate(1, { verdict: "uncertain", accepted: false }) }),
    ],
    ["grader ungradable", "GRADE_UNGRADABLE", candidate(1, { truth: { status: "ungradable" } })],
    [
      "gate verified, grader fail (a false VERIFIED)",
      "GATE_GRADER_DISAGREE",
      candidate(1, { truth: { status: "fail" } }),
    ],
    [
      "gate refuted, grader pass",
      "GATE_GRADER_DISAGREE",
      refuted(1, { truth: { status: "pass" } }),
    ],
    [
      "correct but claimed not done",
      "NOT_CLAIMED",
      candidate(1, { draft: { agentClaim: "not-done" } }),
    ],
    ["correct but no claim", "NOT_CLAIMED", candidate(1, { draft: { agentClaim: "no-claim" } })],
    ["refuted + fail without includeNegatives", "NEGATIVES_NOT_REQUESTED", refuted(1)],
  ])("%s is excluded (%s)", (_name, code, c) => {
    expect(classify(c, false)).toEqual({ excluded: code });
  });

  it("refuted + fail is a labelled negative only when negatives are requested", () => {
    expect(classify(refuted(1), true)).toEqual({ label: "negative" });
    // includeNegatives never turns anything else into an export.
    expect(
      classify(candidate(1, { gate: rawGate(1, { verdict: "uncertain", accepted: false }) }), true),
    ).toEqual({ excluded: "GATE_UNCERTAIN" });
    expect(classify(candidate(1, { truth: { status: "fail" } }), true)).toEqual({
      excluded: "GATE_GRADER_DISAGREE",
    });
  });
});

describe("exportDataset: a container over episodes", () => {
  it("writes episodes, records, manifest and schema; records carry only U fields; deterministic", () => {
    const cands = [candidate(2), candidate(1), refuted(3), candidate(4, { gate: null })];
    const a = out();
    const b = out();
    const ra = exportDataset(cands, { outDir: a, includeNegatives: true, now: NOW });
    exportDataset([...cands].reverse(), { outDir: b, includeNegatives: true, now: NOW });
    const files = (d: string) => [
      "records.jsonl",
      "manifest.json",
      "schema.json",
      ...readdirSync(join(d, "episodes")).map((f) => `episodes/${f}`),
    ];
    expect(files(a)).toEqual(files(b));
    for (const f of files(a)) expect(readFileSync(join(a, f))).toEqual(readFileSync(join(b, f)));
    // Only exported episodes are written (the excluded one is not).
    expect(readdirSync(join(a, "episodes")).sort()).toEqual(
      [cands[0]!, cands[1]!, cands[2]!].map((c) => `${c.episode.episodeId}.json`).sort(),
    );
    const lines = readFileSync(join(a, "records.jsonl"), "utf8").trimEnd().split("\n");
    const ids = lines.map((l) => JSON.parse(l).episode.id);
    expect(ids).toEqual([...ids].sort());
    const byId = new Map(cands.map((c) => [c.episode.episodeId, c]));
    for (const line of lines) {
      const record = JSON.parse(line);
      expect(validateSchema(record, datasetRecordSchema)).toEqual([]);
      // Only U's own fields: no steps, verdict, grade, claim, provenance or simulated flag.
      expect(Object.keys(record).sort()).toEqual([
        "capture",
        "desktop",
        "episode",
        "label",
        "schema",
      ]);
      const c = byId.get(record.episode.id)!;
      const text = readFileSync(join(a, record.episode.file), "utf8");
      expect(sha(text)).toBe(record.episode.sha256);
      // The episode is copied byte for byte (canonical JSON), and is a valid episode.
      expect(text).toBe(`${canonicalJson(c.episode)}\n`);
      const ep = JSON.parse(text);
      expect(validateSchema(ep, episodeMirrorSchema)).toEqual([]);
      expect(episodeIdOf(ep)).toBe(record.episode.id);
      expect(record.label).toBe(ep.gate.verdict === "verified" ? "positive" : "negative");
      expect(record.capture).toEqual({ path: "doc.csv", format: "csv", size: DOC.byteLength });
    }
    const manifest = JSON.parse(readFileSync(join(a, "manifest.json"), "utf8"));
    expect(validateSchema(manifest, datasetManifestSchema)).toEqual([]);
    expect(manifest.records.map((r: { sha256: string }) => r.sha256)).toEqual(
      lines.map((l) => sha(l)),
    );
    expect(manifest.files["records.jsonl"]).toBe(sha(readFileSync(join(a, "records.jsonl"))));
    expect(manifest.files["schema.json"]).toBe(sha(readFileSync(join(a, "schema.json"))));
    expect(ra.manifest).toMatchObject({
      evidence: false,
      negativesIncluded: true,
      episodeFormat: { schema: "myco.episode/1" },
      counts: {
        candidates: 4,
        records: 3,
        positive: 2,
        negative: 1,
        simulated: 0,
        excluded: { MISSING_GATE: 1 },
      },
    });
  });

  it("refuses an existing output directory", () => {
    const dir = out();
    mkdirSync(dir);
    expect(refusal(() => exportDataset([candidate(1)], { outDir: dir })).code).toBe("OUT_EXISTS");
  });

  it("refuses duplicate trial keys, run ids or episodes", () => {
    expect(refusal(() => exportDataset([candidate(1), candidate(1)], { outDir: out() })).code).toBe(
      "DUPLICATE_TRIAL",
    );
    const dupRun = candidate(2, { draft: { runId: "run-1" } });
    expect(refusal(() => exportDataset([candidate(1), dupRun], { outDir: out() })).code).toBe(
      "DUPLICATE_TRIAL",
    );
    const dupKey = candidate(2, { draft: { trialKey: "task-1:run-1" } });
    expect(refusal(() => exportDataset([candidate(1), dupKey], { outDir: out() })).code).toBe(
      "DUPLICATE_TRIAL",
    );
  });

  it("refuses a scripted planner or a non-gated source that is not labelled simulated", () => {
    const scripted = candidate(1, { draft: { plannerModelId: null } });
    expect(refusal(() => exportDataset([scripted], { outDir: out() })).code).toBe(
      "SIMULATED_UNLABELLED",
    );
    const mock = candidate(1, { draft: { source: "demo-mock" } });
    expect(refusal(() => exportDataset([mock], { outDir: out() })).code).toBe(
      "SIMULATED_UNLABELLED",
    );
    // Even an excluded episode must be labelled honestly.
    const excludedMock = candidate(1, { draft: { source: "demo-mock" }, capture: null });
    expect(refusal(() => exportDataset([excludedMock], { outDir: out() })).code).toBe(
      "SIMULATED_UNLABELLED",
    );
    // Labelled, it exports and is counted as simulated.
    const labelled = candidate(1, { draft: { plannerModelId: null, simulated: true } });
    const r = exportDataset([labelled], { outDir: out() });
    expect(r.manifest.counts).toMatchObject({ records: 1, simulated: 1 });
  });

  describe("refuses an episode that is not a valid myco.episode/1 (whole export, nothing written)", () => {
    const base = candidate(1).episode as unknown as Record<string, unknown>;
    const gate = base.gate as Record<string, unknown>;
    it.each<[string, Episode, string]>([
      // A smuggled field is refused, never passed through into the container.
      [
        "gate prose smuggled in",
        readdressed({ ...base, gate: { ...gate, reasons: ["prose"] } }),
        "$.gate",
      ],
      ["env smuggled at the top level", readdressed({ ...base, env: { A: "b" } }), "$"],
      [
        "content id does not match",
        { ...candidate(1).episode, episodeId: sha("x") },
        "$.episodeId",
      ],
      [
        "blob observation (not carried yet)",
        readdressed({
          ...base,
          observations: {
            capture: "recorded",
            withheld: 0,
            items: [
              {
                seq: 0,
                afterAction: 0,
                kind: "screenshot",
                mediaType: "image/png",
                sha256: sha("png"),
                bytes: 3,
                file: `blobs/${sha("png")}.png`,
              },
            ],
          },
        }),
        "$.observations.items[0]",
      ],
      [
        "outcome disagrees with the gate",
        readdressed({ ...base, outcome: "refuted" }),
        "$.outcome",
      ],
      [
        "accepted disagrees with the verdict",
        readdressed({ ...base, outcome: "refuted", gate: { ...gate, verdict: "refuted" } }),
        "$.gate.accepted",
      ],
      [
        "actions out of order",
        readdressed({
          ...base,
          actions: {
            capture: "recorded",
            truncated: false,
            items: [{ seq: 1, atMs: null, kind: "observe" }],
          },
          observations: { capture: "recorded", withheld: 0, items: [] },
        }),
        "$.actions.items[0]",
      ],
    ])("%s", (_name, episode, path) => {
      const dir = out();
      const e = refusal(() =>
        exportDataset([candidate(2), { ...candidate(1), episode }], { outDir: dir }),
      );
      expect(e.code).toBe("EPISODE_INVALID");
      expect(e.where).toBe(`candidates[1]:${path}`);
      expect(existsSync(dir)).toBe(false);
    });
  });

  it("refuses a record that fails its schema", () => {
    const bad = candidate(1, { desktop: { backend: "bad backend!" } });
    const e = refusal(() => exportDataset([bad], { outDir: out() }));
    expect(e.code).toBe("SCHEMA_INVALID");
    expect(e.where).toContain("record.desktop.backend");
  });

  // Planted-marker tests: each marker is built at runtime so this file never matches the
  // repo's own secret and home-path scanners.
  const IDENTITY = { user: "zelda", host: "mallow-box" } as const;
  const MARKERS: Array<[string, string]> = [
    ["POSIX home path", j("/", "home", "/", "carol", "/", "work", "/doc.csv")],
    ["redirect to a home path", j("sort fixture.csv >", "/", "home", "/", "alice", "/out.csv")],
    ["macOS home path", j("/", "Users", "/", "dave", "/", "doc.csv")],
    ["JSON-escaped macOS home path", j("\\", "/", "Users", "\\", "/", "dave")],
    ["percent-encoded home path", j("%2F", "home", "%2F", "carol")],
    ["tmp path", j("/", "tmp", "/", "myco-desktops-x", "/d-1")],
    ["Windows path", j("C:", "\\", "Users", "\\", "erin")],
    ["file URL", j("file:", "//", "srv/share")],
    ["home-relative path", j("see ", "~", "/", ".config/x")],
    ["home-relative user path", j("~", "carol", "/", "x")],
    ["sk-ant key", j("sk", "-ant-", "api03", "-", "Z".repeat(20))],
    ["GitHub token", j("gh", "p_", "A1b2".repeat(6))],
    ["AWS key id", j("AK", "IA", "ABCDEFGHIJKLMNOP")],
    ["private key", j("-----BEGIN ", "RSA ", "PRIVATE KEY-----")],
    ["bearer token", j("Bear", "er ", "abcDEF123456ghiJKL789")],
    ["key assignment", j("api", "_key", "=", "hunter2hunter2")],
    ["operator marker", "zz-operator-planted-marker"],
    ["username", "written by zelda"],
    ["hostname", "ran on mallow-box"],
  ];
  const FIELDS: Array<[string, (m: string) => Partial<EpisodeDraft>]> = [
    [
      "instruction",
      (m) => ({ task: { ...candidate(2).episode.task, instruction: `Do it. ${m}` } }),
    ],
    ["observation", (m) => ({ observations: [{ afterAction: 0, text: m }] })],
    ["typed text", (m) => ({ actions: [{ kind: "type", text: m }] })],
    ["shell command", (m) => ({ actions: [{ kind: "shell", command: m }] })],
  ];

  for (const [markerName, marker] of MARKERS) {
    for (const [fieldName, put] of FIELDS) {
      it(`a ${markerName} in the episode's ${fieldName} refuses the whole export, naming no value`, () => {
        const dir = out();
        const leaky = candidate(2, { draft: put(marker) });
        const e = refusal(() =>
          exportDataset([candidate(1), leaky], {
            outDir: dir,
            hygiene: { forbiddenStrings: ["zz-operator-planted-marker"], identity: IDENTITY },
          }),
        );
        expect(e.code).toBe("LEAK");
        expect(e.message).not.toContain(marker);
        expect(e.where.startsWith(`${fileOf(leaky)}:$.`)).toBe(true);
        expect(existsSync(dir)).toBe(false);
      });
    }
  }

  // Every output file is scanned, not only the records: an operator string that appears in
  // exactly one file refuses the export and names that file.
  it.each<[string, string, Over]>([
    [
      "an episode file",
      "zz-only-in-episode",
      { draft: { observations: [{ afterAction: 0, text: "zz-only-in-episode" }] } },
    ],
    ["records.jsonl", "zz-only-in-record", { desktop: { image: "zz-only-in-record/1" } }],
    ["schema.json", "additionalProperties", {}],
    ["manifest.json", "myco-dataset-exporter/2", {}],
  ])("a leak only in %s is refused", (file, forbidden, o) => {
    const dir = out();
    const c = candidate(1, o);
    const e = refusal(() =>
      exportDataset([c], {
        outDir: dir,
        hygiene: { forbiddenStrings: [forbidden], hostIdentity: false },
      }),
    );
    expect(e.code).toBe("LEAK");
    const expected = file === "an episode file" ? fileOf(c) : file;
    expect(e.where.split(/[:#]/)[0]).toBe(expected);
    expect(existsSync(dir)).toBe(false);
  });

  it("a leak in the trial key is refused without echoing it", () => {
    const e = refusal(() =>
      exportDataset([candidate(1, { draft: { trialKey: "zz-operator-planted-marker" } })], {
        outDir: out(),
        hygiene: { forbiddenStrings: ["zz-operator-planted-marker"] },
      }),
    );
    expect(e.code).toBe("LEAK");
    expect(e.message).not.toContain("zz-operator-planted-marker");
  });

  it("excluded episodes are never written (a leak in an excluded episode does not block)", () => {
    const leakyExcluded = candidate(2, {
      gate: null,
      draft: { observations: [{ afterAction: 0, text: "zz-operator-planted-marker" }] },
    });
    const dir = out();
    const r = exportDataset([candidate(1), leakyExcluded], {
      outDir: dir,
      hygiene: { forbiddenStrings: ["zz-operator-planted-marker"] },
    });
    expect(r.manifest.counts).toMatchObject({ records: 1, excluded: { MISSING_GATE: 1 } });
    expect(readdirSync(join(dir, "episodes"))).toEqual([`${candidate(1).episode.episodeId}.json`]);
  });

  it("placeholders the backend writes are clean", () => {
    const c = candidate(1, {
      draft: {
        actions: [{ kind: "shell", command: "cat <home>/doc.csv >out.csv" }],
        observations: [{ afterAction: 0, text: "<desktop>/tmp ok; docs/var/x" }],
      },
    });
    expect(exportDataset([c], { outDir: out() }).manifest.counts).toMatchObject({ records: 1 });
  });
});
