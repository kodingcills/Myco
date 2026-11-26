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
import { closeEpisode, openEpisodeStrings } from "../../src/dataset/closed.ts";
import {
  draftEpisode,
  EPISODE_REAL_PLANNERS,
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
  episodeProblem,
  exportDataset,
  type GateLike,
  validateContainer,
} from "../../src/dataset/export.ts";
import { validateEpisode } from "../fixtures/episode-542/src/episode/validate.ts";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const NOW = () => new Date("2026-11-26T16:00:00.000Z");
const FIXTURE_SHA = sha("pristine fixture");
const DOC = Buffer.from("id,qty\nEMP-0001,42\n");
const j = (...parts: string[]) => parts.join("");
/** A planner id #542 accepts on a real (non-simulated) episode. */
const REAL_PLANNER = [...EPISODE_REAL_PLANNERS][0]!;
/** Host facts for #542's validator that nothing in these episodes can match. */
const HOST_542 = { home: "/nonexistent-home-u", tmp: "/nonexistent-tmp-u", user: "nobody-u" };

interface Over {
  readonly gate?: GateLike | null;
  readonly draft?: Partial<EpisodeDraft>;
  readonly truth?: Partial<EpisodeGroundTruth & { source: "independent-grader" }>;
  readonly capture?: ExportCandidate["capture"];
  readonly fixtureSha256?: string;
  readonly desktop?: Partial<DesktopFacts>;
  /** Another captured document (graded, observed and captured consistently). */
  readonly doc?: Buffer;
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
  const doc = o.doc ?? DOC;
  const gate = o.gate === undefined ? rawGate(k) : o.gate;
  const epGate = o.draft?.gate === undefined ? episodeGateOf(gate) : o.draft.gate;
  const truth: EpisodeGroundTruth = {
    source: "independent-grader",
    graderVersion: "false-completion-grader/1",
    status: "pass",
    targetSatisfied: true,
    mismatchCount: 0,
    fixtureSha256: FIXTURE_SHA,
    persistedSha256: sha(doc),
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
    plannerModelId: REAL_PLANNER,
    startedAt: "2026-11-26T15:00:00.000Z",
    endedAt: "2026-11-26T15:01:00.000Z",
    source: "gated-trial",
    runId: `run-${k}`,
    trialKey: `task-${k}:run-${k}`,
    // #542: a graded document is observed in the episode.
    persisted: truth.source === "independent-grader" && truth.persistedSha256 !== null ? doc : null,
    ...o.draft,
  };
  return {
    episode: draftEpisode(draft),
    fixtureSha256: o.fixtureSha256 ?? FIXTURE_SHA,
    gate,
    capture: o.capture === undefined ? { path: "doc.csv", format: "csv", bytes: doc } : o.capture,
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
    // Each is written in its CLOSED form (closed.ts, TIF-265), named by its closed id.
    expect(readdirSync(join(a, "episodes")).sort()).toEqual(
      [cands[0]!, cands[1]!, cands[2]!]
        .map((c) => `${closeEpisode(c.episode).episodeId}.json`)
        .sort(),
    );
    const lines = readFileSync(join(a, "records.jsonl"), "utf8").trimEnd().split("\n");
    const ids = lines.map((l) => JSON.parse(l).episode.id);
    expect(ids).toEqual([...ids].sort());
    const byId = new Map(cands.map((c) => [closeEpisode(c.episode).episodeId, c]));
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
      // The episode is its closed form (canonical JSON): no free text, and a valid episode.
      expect(text).toBe(`${canonicalJson(closeEpisode(c.episode))}\n`);
      expect(openEpisodeStrings(JSON.parse(text))).toEqual([]);
      const ep = JSON.parse(text);
      expect(validateSchema(ep, episodeMirrorSchema)).toEqual([]);
      expect(episodeIdOf(ep)).toBe(record.episode.id);
      expect(record.label).toBe(ep.gate.verdict === "verified" ? "positive" : "negative");
      // The capture path is free text: hashed, never written.
      expect(record.capture).toMatchObject({ format: "csv", size: DOC.byteLength });
      expect(record.capture.path).toMatch(/^h-[0-9a-f]{64}$/);
      expect(record.desktop).toMatchObject({ backend: c.desktop.backend, image: c.desktop.image });
    }
    const manifest = JSON.parse(readFileSync(join(a, "manifest.json"), "utf8"));
    expect(validateSchema(manifest, datasetManifestSchema)).toEqual([]);
    expect(manifest.records.map((r: { sha256: string }) => r.sha256)).toEqual(
      lines.map((l) => sha(l)),
    );
    expect(manifest.files["records.jsonl"]).toBe(sha(readFileSync(join(a, "records.jsonl"))));
    expect(manifest.files["schema.json"]).toBe(sha(readFileSync(join(a, "schema.json"))));
    // Digest-only (lead ruling 20:3xZ): the captured document is never carried. Each exported
    // episode's persisted observation names it by digest and size; the container has no blobs/.
    expect(existsSync(join(a, "blobs"))).toBe(false);
    expect(manifest.blobs).toEqual([]);
    for (const f of readdirSync(join(a, "episodes"))) {
      const ep = JSON.parse(readFileSync(join(a, "episodes", f), "utf8"));
      expect(ep.observations.items).toContainEqual(
        expect.objectContaining({
          kind: "state",
          sha256: sha(DOC),
          bytes: DOC.byteLength,
          file: `blobs/${sha(DOC)}.csv`,
        }),
      );
    }
    expect(validateContainer(a)).toEqual([]);
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
    // #542's rule: a planner id that is not a real planner makes the episode simulated.
    const unknownPlanner = candidate(1, { draft: { plannerModelId: "claude-model-x" } });
    expect(refusal(() => exportDataset([unknownPlanner], { outDir: out() })).code).toBe(
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
        "screenshot blob observation (not carried)",
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
        "observation follows an action that does not exist",
        readdressed({
          ...base,
          observations: {
            capture: "recorded",
            withheld: 0,
            items: [{ seq: 0, afterAction: 9, kind: "ui-status", text: "x" }],
          },
        }),
        "$.observations.items[0]",
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

  describe("#542's rules at the pinned head (R2-D1): each one refuses the whole export", () => {
    const base = candidate(1).episode as unknown as Record<string, unknown>;
    const obs = base.observations as { items: Array<Record<string, unknown>> };
    const persistedObs = obs.items.find((o) => o.kind === "state")!;
    const uiObs = obs.items.filter((o) => o.kind === "ui-status");
    const truth = base.groundTruth as Record<string, unknown>;
    const harness = base.harness as Record<string, unknown>;
    it.each<[string, Record<string, unknown>, string, string]>([
      [
        "a graded document with no persisted observation",
        { ...base, observations: { capture: "recorded", withheld: 0, items: uiObs } },
        "$.groundTruth.persistedSha256",
        "GROUND_TRUTH_DOCUMENT",
      ],
      [
        "a persisted observation of another document than the graded one",
        {
          ...base,
          observations: {
            ...obs,
            items: [
              ...uiObs,
              { ...persistedObs, sha256: sha("other"), file: `blobs/${sha("other")}.csv` },
            ],
          },
        },
        "$.groundTruth.persistedSha256",
        "GROUND_TRUTH_DOCUMENT",
      ],
      [
        "a grade without a document that is not ungradable",
        {
          ...base,
          observations: { capture: "recorded", withheld: 0, items: uiObs },
          groundTruth: { ...truth, persistedSha256: null },
        },
        "$.groundTruth.status",
        "GROUND_TRUTH_NO_DOCUMENT",
      ],
      [
        "document-withheld while the document is captured",
        {
          ...base,
          observations: { ...obs, withheld: 1 },
          groundTruth: { source: "none", reason: "document-withheld" },
        },
        "$.groundTruth",
        "GROUND_TRUTH_WITHHELD",
      ],
      [
        "document-withheld with nothing withheld",
        {
          ...base,
          observations: { capture: "recorded", withheld: 0, items: uiObs },
          groundTruth: { source: "none", reason: "document-withheld" },
        },
        "$.groundTruth",
        "GROUND_TRUTH_WITHHELD",
      ],
      [
        "a harness fault recorded on a verified outcome",
        { ...base, harness: { ...harness, fault: { class: "harness-error", code: null } } },
        "$.outcome",
        "OUTCOME_FAULT_MISMATCH",
      ],
      [
        "harness-fault ground truth on an agent outcome",
        {
          ...base,
          observations: { capture: "recorded", withheld: 0, items: uiObs },
          groundTruth: { source: "none", reason: "harness-fault" },
        },
        "$.groundTruth",
        "GROUND_TRUTH_FAULT",
      ],
      [
        "an unregistrable outcome with a gate decision",
        { ...base, outcome: "unregistrable" },
        "$.gate",
        "OUTCOME_GATE_MISMATCH",
      ],
      [
        "a cost estimate without token counts",
        {
          ...base,
          harness: {
            ...harness,
            cost: { ...(harness.cost as object), estimateUsd: 0.5, inputTokens: null },
          },
        },
        "$.harness.cost",
        "COST",
      ],
      [
        "the grade against another fixture than the task's",
        { ...base, groundTruth: { ...truth, fixtureSha256: sha("x") } },
        "$.groundTruth.fixtureSha256",
        "GROUND_TRUTH_FIXTURE",
      ],
      [
        "not-recorded actions that carry items",
        { ...base, actions: { ...(base.actions as object), capture: "not-recorded" } },
        "$.actions",
        "SEQ",
      ],
      [
        "not-recorded observations that carry items",
        { ...base, observations: { ...obs, capture: "not-recorded" } },
        "$.observations",
        "SEQ",
      ],
      [
        "a second persisted document",
        {
          ...base,
          observations: {
            ...obs,
            items: [...obs.items, { ...persistedObs, seq: obs.items.length }],
          },
        },
        `$.observations.items[${obs.items.length}]`,
        "BLOBS_UNSUPPORTED",
      ],
      [
        "a JSON state blob",
        {
          ...base,
          observations: {
            ...obs,
            items: [
              ...uiObs,
              {
                ...persistedObs,
                label: "app-state",
                mediaType: "application/json",
                file: `blobs/${sha(DOC)}.json`,
              },
            ],
          },
        },
        `$.observations.items[${uiObs.length}]`,
        "BLOBS_UNSUPPORTED",
      ],
    ])("%s", (_name, edited, path, detail) => {
      const episode = readdressed(edited);
      expect(episodeProblem(episode)).toEqual({ path, detail });
      // #542's own validator refuses the same episode (U is stricter only on blobs: it carries
      // one persisted CSV document and nothing else).
      if (detail !== "BLOBS_UNSUPPORTED") {
        expect(validateEpisode(episode, { host: HOST_542 })).not.toEqual([]);
      }
      const dir = out();
      const e = refusal(() =>
        exportDataset([candidate(2), { ...candidate(1), episode }], { outDir: dir }),
      );
      expect(e).toMatchObject({ code: "EPISODE_INVALID", where: `candidates[1]:${path}`, detail });
      expect(existsSync(dir)).toBe(false);
    });

    it("the new #542 enum values are accepted (harness-error, document-withheld)", () => {
      const faulted = readdressed({
        ...base,
        outcome: "harness-fault",
        gate: null,
        observations: { capture: "recorded", withheld: 0, items: uiObs },
        groundTruth: { source: "none", reason: "harness-fault" },
        harness: { ...harness, fault: { class: "harness-error", code: "X" } },
      });
      expect(episodeProblem(faulted)).toBeNull();
      expect(validateEpisode(faulted, { host: HOST_542 })).toEqual([]);
      const withheld = readdressed({
        ...base,
        observations: { capture: "recorded", withheld: 1, items: uiObs },
        groundTruth: { source: "none", reason: "document-withheld" },
      });
      expect(episodeProblem(withheld)).toBeNull();
      expect(validateEpisode(withheld, { host: HOST_542 })).toEqual([]);
    });

    it("with the blobs supplied, the document must be present and hash to its name and size", () => {
      const ep = candidate(1).episode;
      const at = `$.observations.items[${ep.observations.items.length - 1}]`;
      const file = `blobs/${sha(DOC)}.csv`;
      expect(episodeProblem(ep, new Map([[file, DOC]]))).toBeNull();
      expect(validateEpisode(ep, { blobs: new Map([[file, DOC]]), host: HOST_542 })).toEqual([]);
      expect(episodeProblem(ep, new Map())).toEqual({ path: at, detail: "BLOB_MISSING" });
      expect(episodeProblem(ep, new Map([[file, Buffer.from("x")]]))).toEqual({
        path: at,
        detail: "BLOB_HASH",
      });
      // The file name must be the digest: a persisted observation naming another file is
      // refused even when that file holds the right bytes.
      const other = `blobs/${sha("other")}.csv`;
      const renamed = readdressed({
        ...base,
        observations: { ...obs, items: [...uiObs, { ...persistedObs, file: other }] },
      });
      expect(episodeProblem(renamed, new Map([[other, DOC]]))).toEqual({
        path: `$.observations.items[${uiObs.length}]`,
        detail: "BLOB_HASH",
      });
      // The exporter applies this to every exported episode: a misnamed document is refused.
      const e = refusal(() =>
        exportDataset([{ ...candidate(1), episode: renamed }], { outDir: out() }),
      );
      expect(e).toMatchObject({ code: "EPISODE_INVALID", detail: "BLOB_MISSING" });
    });
  });

  it("a captured document that is not UTF-8 text cannot be scanned, so it is refused", () => {
    const binary = Buffer.from([0x69, 0x64, 0x0a, 0xff, 0xfe, 0x00]);
    const dir = out();
    const e = refusal(() => exportDataset([candidate(1, { doc: binary })], { outDir: dir }));
    expect(e).toMatchObject({
      code: "LEAK",
      where: `blobs/${sha(binary)}.csv:$`,
      detail: "unscannable",
    });
    expect(existsSync(dir)).toBe(false);
  });

  it("a captured document with a byte-order mark is scanned and referenced by its digest, never carried", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), DOC]);
    const dir = out();
    const r = exportDataset([candidate(1, { doc: bom })], { outDir: dir });
    expect(existsSync(join(dir, "blobs"))).toBe(false);
    expect(r.manifest.blobs).toEqual([]);
    expect(readFileSync(join(dir, "records.jsonl"), "utf8")).toContain(`"size":${bom.byteLength}`);
    expect(validateContainer(dir)).toEqual([]);
  });

  it("refuses a record that fails its schema", () => {
    const bad = candidate(1, { desktop: { isolation: "bogus" as "process" } });
    const e = refusal(() => exportDataset([bad], { outDir: out() }));
    expect(e.code).toBe("SCHEMA_INVALID");
    expect(e.where).toContain("record.desktop.isolation");
  });

  it("a desktop fact that is not a closed id is hashed, never written (TIF-265)", () => {
    const dir = out();
    exportDataset([candidate(1, { desktop: { backend: "bad backend!" } })], { outDir: dir });
    const record = JSON.parse(readFileSync(join(dir, "records.jsonl"), "utf8"));
    expect(record.desktop.backend).toMatch(/^h-[0-9a-f]{64}$/);
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
    it(`a ${markerName} in the captured document refuses the whole export, naming no value`, () => {
      const dir = out();
      const doc = Buffer.from(`id,note\nEMP-0001,${marker}\n`);
      const e = refusal(() =>
        exportDataset([candidate(1), candidate(2, { doc })], {
          outDir: dir,
          hygiene: { forbiddenStrings: ["zz-operator-planted-marker"], identity: IDENTITY },
        }),
      );
      expect(e.code).toBe("LEAK");
      expect(e.message).not.toContain(marker);
      expect(e.where).toBe(`blobs/${sha(doc)}.csv:$`);
      expect(existsSync(dir)).toBe(false);
    });
  }

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
    ["manifest.json", "myco-dataset-exporter/3", {}],
    [
      "a blob (the captured document)",
      "zz-only-in-blob",
      { doc: Buffer.from("id,qty\nEMP-0001,zz-only-in-blob\n") },
    ],
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
    const expected =
      file === "an episode file"
        ? fileOf(c)
        : file === "a blob (the captured document)"
          ? `blobs/${sha(o.doc!)}.csv`
          : file;
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
    expect(readdirSync(join(dir, "episodes"))).toEqual([
      `${closeEpisode(candidate(1).episode).episodeId}.json`,
    ]);
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
