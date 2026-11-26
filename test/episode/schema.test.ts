/**
 * `myco.episode/1`: round-trip of every variant, refusal of unknown fields at every level, and
 * each rule `validateEpisode` adds to the schema (one test per guard, so each is
 * mutation-provable: removing the guard turns exactly its test red).
 */
import { describe, expect, it } from "vitest";
import { EPISODE_COST_BASIS, episodeSchema } from "../../schemas/episode.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { COST_BASIS, EVIDENCE_PLANNERS } from "../../src/benchmark/check.ts";
import { buildEpisode } from "../../src/episode/build.ts";
import { EpisodeRecorder } from "../../src/episode/recorder.ts";
import type { Episode } from "../../src/episode/types.ts";
import {
  canonicalJson,
  episodeIdOf,
  REAL_PLANNERS,
  validateEpisode,
} from "../../src/episode/validate.ts";
import { draft, HOST } from "./helpers.ts";

/** Parsed episode JSON, mutated freely by the refusal tests. */
// biome-ignore lint/suspicious/noExplicitAny: the tests write arbitrary (invalid) shapes on purpose
type Loose = Record<string, any>;

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function full(): { episode: Episode; blobs: ReadonlyMap<string, Uint8Array> } {
  const rec = new EpisodeRecorder({ host: HOST, frameRedactor: { redact: (b) => b } });
  rec.action({ kind: "launch", app: "soffice calc" });
  rec.action({ kind: "click", x: 10, y: 20, button: "left", atMs: 5 });
  rec.action({ kind: "type", text: "REVISED-1" });
  rec.action({ kind: "key", keys: "ctrl+s" });
  rec.action({ kind: "scroll", dx: 0, dy: -3 });
  rec.action({ kind: "wait", ms: 250 });
  rec.action({ kind: "shell", command: "ls docs" });
  rec.action({ kind: "observe" });
  rec.action({ kind: "gate-check", claim: "done" });
  rec.screenshot(PNG);
  rec.state("persisted", "text/csv", new TextEncoder().encode("id,name\nEMP-1,A\n"));
  rec.state("app-state", "application/json", new TextEncoder().encode('{"saved":true}'));
  rec.uiStatus("saved 4");
  const snap = rec.snapshot();
  const built = buildEpisode(
    draft({
      actions: snap.actions,
      observations: snap.observations,
      harness: {
        arm: "myco-gate",
        plannerModelId: "claude-opus-5-5",
        outputCeiling: 4096,
        corrections: "off",
        fault: null,
        flags: { policy: true, handoff: false, assisted: null },
        timing: {
          startedAt: "2026-11-26T10:00:00Z",
          endedAt: "2026-11-26T10:01:00.500Z",
          wallClockS: 60.5,
          vmS: 61,
        },
        cost: { estimateUsd: 0.12, inputTokens: 1000, outputTokens: 200 },
      },
      provenance: {
        source: "gated-trial",
        runId: "run-1",
        trialKey: "trial-1",
        attemptLedger: { schema: "myco.m2.attempt-event/1", events: 2, headSha256: "c".repeat(64) },
      },
      simulated: false,
    }),
    snap.blobs,
    HOST,
  );
  if (!built.ok) throw new Error(JSON.stringify(built.issues));
  return built;
}

describe("myco.episode/1 schema", () => {
  it("round-trips an episode with every action and observation kind", () => {
    const { episode, blobs } = full();
    const back = JSON.parse(canonicalJson(episode)) as Episode;
    expect(back).toEqual(episode);
    expect(validateEpisode(back, { blobs, host: HOST })).toEqual([]);
    expect(episode.actions.items.map((a) => a.kind)).toEqual([
      "launch",
      "click",
      "type",
      "key",
      "scroll",
      "wait",
      "shell",
      "observe",
      "gate-check",
    ]);
    expect(episode.observations.items.map((o) => o.kind)).toEqual([
      "screenshot",
      "state",
      "state",
      "ui-status",
    ]);
  });

  it.each([
    ["verified", { outcome: "verified" }],
    [
      "refuted",
      {
        outcome: "refuted",
        gate: {
          verdict: "refuted",
          accepted: false,
          reasonCodes: ["ORACLE_FAIL", "TARGET_MISMATCH"],
          oracle: null,
        },
      },
    ],
    [
      "uncertain",
      {
        outcome: "uncertain",
        gate: {
          verdict: "uncertain",
          accepted: false,
          reasonCodes: ["ORACLE_UNCERTAIN"],
          oracle: null,
        },
      },
    ],
    [
      "harness-fault",
      {
        outcome: "harness-fault",
        gate: null,
        groundTruth: { source: "none", reason: "harness-fault" },
        harness: {
          arm: "myco-gate",
          plannerModelId: null,
          outputCeiling: null,
          corrections: "off",
          fault: { class: "transport-error", code: null },
        },
      },
    ],
    [
      "launch-refused",
      {
        outcome: "launch-refused",
        gate: null,
        groundTruth: { source: "none", reason: "agent-never-ran" },
      },
    ],
    ["unregistrable", { outcome: "unregistrable", gate: null }],
  ] as const)("builds a valid %s episode", (_name, over) => {
    const built = buildEpisode(draft(over as never), new Map(), HOST);
    expect(built.ok ? [] : built.issues).toEqual([]);
  });

  const paths: [string, (e: Loose) => void][] = [
    [
      "top level",
      (e) => {
        e.extra = 1;
      },
    ],
    [
      "task",
      (e) => {
        e.task.env = "x";
      },
    ],
    [
      "actions",
      (e) => {
        e.actions.raw = [];
      },
    ],
    [
      "action item",
      (e) => {
        e.actions.items[0].argv = ["x"];
      },
    ],
    [
      "observations",
      (e) => {
        e.observations.vaultPath = "x";
      },
    ],
    [
      "observation item",
      (e) => {
        e.observations.items[0].path = "x";
      },
    ],
    [
      "gate",
      (e) => {
        e.gate.reasons = ["prose"];
      },
    ],
    [
      "gate oracle",
      (e) => {
        e.gate.oracle = {
          family: "calc-record-edit",
          version: "1",
          specSha256: "d".repeat(64),
          source: "x",
        };
      },
    ],
    [
      "ground truth",
      (e) => {
        e.groundTruth.gateVerdict = "verified";
      },
    ],
    [
      "harness",
      (e) => {
        e.harness.env = {};
      },
    ],
    [
      "harness cost",
      (e) => {
        e.harness.cost.billedUsd = 1;
      },
    ],
    [
      "harness flags",
      (e) => {
        e.harness.flags.other = true;
      },
    ],
    [
      "harness timing",
      (e) => {
        e.harness.timing.tz = "x";
      },
    ],
    [
      "provenance",
      (e) => {
        e.provenance.receipt = "x";
      },
    ],
    [
      "attempt ledger",
      (e) => {
        e.provenance.attemptLedger.rows = [];
      },
    ],
  ];
  it.each(paths)("refuses an unknown field in %s", (_where, mutate) => {
    const { episode } = full();
    const copy = JSON.parse(JSON.stringify(episode));
    copy.gate.oracle = null;
    mutate(copy);
    const issues = validateSchema(copy, episodeSchema);
    expect(
      issues.some(
        (i) =>
          i.keyword === "additionalProperties" || i.keyword === "oneOf" || i.keyword === "anyOf",
      ),
    ).toBe(true);
    expect(validateEpisode(copy, { host: HOST }).length).toBeGreaterThan(0);
  });

  it("refuses an unknown schema version and an unbounded action list", () => {
    const { episode } = full();
    expect(validateEpisode({ ...episode, schema: "myco.episode/2" }, { host: HOST })[0]?.code).toBe(
      "SCHEMA",
    );
    const many = Array.from({ length: 1001 }, (_, i) => ({ seq: i, atMs: null, kind: "observe" }));
    const big = { ...episode, actions: { capture: "recorded", truncated: false, items: many } };
    expect(validateEpisode(big, { host: HOST }).some((i) => i.code === "SCHEMA")).toBe(true);
  });

  it("the recorder bounds actions and marks the tail truncated", () => {
    const rec = new EpisodeRecorder({ host: HOST });
    for (let i = 0; i < 1005; i++) rec.action({ kind: "observe" });
    const snap = rec.snapshot();
    expect(snap.actions.items).toHaveLength(1000);
    expect(snap.actions.truncated).toBe(true);
  });

  it("mirrors the benchmark's evidence planners and cost basis", () => {
    expect([...REAL_PLANNERS].sort()).toEqual([...EVIDENCE_PLANNERS].sort());
    expect(EPISODE_COST_BASIS).toBe(COST_BASIS);
  });
});

describe("validateEpisode rules (each guard has its own red test)", () => {
  const ok = () => {
    const built = buildEpisode(draft(), new Map(), HOST);
    if (!built.ok) throw new Error("base draft invalid");
    return JSON.parse(JSON.stringify(built.episode)) as Loose;
  };
  const codesOf = (e: Loose, rehash = true) => {
    if (rehash) e.episodeId = episodeIdOf(e as Episode);
    return validateEpisode(e, { host: HOST }).map((i) => i.code);
  };

  it("ID_MISMATCH: the id is the content hash", () => {
    const e = ok();
    e.agentClaim = "not-done";
    expect(codesOf(e, false)).toContain("ID_MISMATCH");
  });

  it("OUTCOME: a verified outcome needs the gate's verified verdict", () => {
    const e = ok();
    e.gate = { verdict: "refuted", accepted: false, reasonCodes: ["ORACLE_FAIL"], oracle: null };
    expect(codesOf(e)).toContain("OUTCOME");
  });

  it("OUTCOME: accepted only with verified", () => {
    const e = ok();
    e.gate.accepted = false;
    expect(codesOf(e)).toContain("OUTCOME");
  });

  it("OUTCOME: a harness fault cannot be filed as an agent outcome", () => {
    const e = ok();
    e.harness.fault = { class: "timeout", code: null };
    expect(codesOf(e)).toContain("OUTCOME");
  });

  it("OUTCOME: launch-refused has no gate decision", () => {
    const e = ok();
    e.outcome = "launch-refused";
    expect(codesOf(e)).toContain("OUTCOME");
  });

  it("GROUND_TRUTH: a harness-faulted attempt carries no grade", () => {
    const e = ok();
    e.outcome = "harness-fault";
    e.gate = null;
    e.harness.fault = { class: "sshd", code: null };
    e.groundTruth = {
      source: "independent-grader",
      graderVersion: "false-completion-grader/1",
      status: "pass",
      targetSatisfied: true,
      mismatchCount: 0,
      fixtureSha256: "b".repeat(64),
      persistedSha256: "e".repeat(64),
    };
    expect(codesOf(e)).toContain("GROUND_TRUTH");
  });

  it("GROUND_TRUTH: a grade with no document is ungradable", () => {
    const e = ok();
    e.groundTruth = {
      source: "independent-grader",
      graderVersion: "g/1",
      status: "pass",
      targetSatisfied: true,
      mismatchCount: 0,
      fixtureSha256: "b".repeat(64),
      persistedSha256: null,
    };
    expect(codesOf(e)).toContain("GROUND_TRUTH");
  });

  it("GROUND_TRUTH: the grade is of the captured document and the task's fixture", () => {
    const { episode } = full();
    const e = JSON.parse(JSON.stringify(episode));
    e.groundTruth = {
      source: "independent-grader",
      graderVersion: "g/1",
      status: "pass",
      targetSatisfied: true,
      mismatchCount: 0,
      fixtureSha256: "b".repeat(64),
      persistedSha256: "f".repeat(64),
    };
    expect(codesOf(e)).toContain("GROUND_TRUTH");
    const f = ok();
    f.groundTruth = {
      source: "independent-grader",
      graderVersion: "g/1",
      status: "ungradable",
      targetSatisfied: null,
      mismatchCount: 0,
      fixtureSha256: "9".repeat(64),
      persistedSha256: null,
    };
    expect(codesOf(f)).toContain("GROUND_TRUTH");
  });

  it("SIMULATED: a real episode needs a gated trial and a Claude planner", () => {
    const e = ok();
    e.simulated = false;
    expect(codesOf(e)).toContain("SIMULATED");
    const g = ok();
    g.simulated = false;
    g.harness.plannerModelId = "claude-opus-5-5";
    g.provenance.source = "m2-dry-run";
    expect(codesOf(g)).toContain("SIMULATED");
    const h = ok();
    h.simulated = false;
    h.harness.plannerModelId = "claude-opus-5-5";
    expect(codesOf(h)).toEqual([]);
  });

  it("COST: an estimate without token counts is refused (null, never 0)", () => {
    const e = ok();
    e.harness.cost.estimateUsd = 0;
    expect(codesOf(e)).toContain("COST");
    const f = ok();
    f.harness.cost = { ...f.harness.cost, estimateUsd: 0, inputTokens: 0, outputTokens: 0 };
    expect(codesOf(f)).toEqual([]);
  });

  it("SEQ: items are numbered in order and not-recorded means empty", () => {
    const { episode } = full();
    const e = JSON.parse(JSON.stringify(episode));
    e.actions.items[1].seq = 7;
    expect(codesOf(e)).toContain("SEQ");
    const f = ok();
    f.actions.truncated = true;
    expect(codesOf(f)).toContain("SEQ");
    const g = JSON.parse(JSON.stringify(episode));
    g.observations.items[0].afterAction = 99;
    expect(codesOf(g)).toContain("SEQ");
  });

  it("BLOB_*: blobs present, hashing to their names, none stray", () => {
    const { episode, blobs } = full();
    const missing = new Map(blobs);
    const first = [...missing.keys()][0] as string;
    missing.delete(first);
    expect(validateEpisode(episode, { blobs: missing, host: HOST }).map((i) => i.code)).toContain(
      "BLOB_MISSING",
    );
    const swapped = new Map(blobs);
    swapped.set(first, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]));
    expect(validateEpisode(episode, { blobs: swapped, host: HOST }).map((i) => i.code)).toContain(
      "BLOB_HASH",
    );
    const stray = new Map(blobs);
    stray.set(`blobs/${"0".repeat(64)}.csv`, new Uint8Array());
    expect(validateEpisode(episode, { blobs: stray, host: HOST }).map((i) => i.code)).toContain(
      "BLOB_UNREFERENCED",
    );
  });
});
