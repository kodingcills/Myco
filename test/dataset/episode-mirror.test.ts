/**
 * Pins track U's mirror of the canonical `myco.episode/1` record (src/dataset/episode.ts) to
 * the data-capture PR #542 at `EPISODE_MIRROR_PINNED_AT`, by running #542's OWN code.
 *
 * test/fixtures/episode-542/ holds #542's `schemas/episode.ts` and `src/episode/{validate,
 * clean,types}.ts` at that head, byte for byte apart from import paths (see its README). The
 * mirror schema must equal #542's schema (one documented loosening), the mirror's constants
 * must equal #542's, and episodes U writes must pass #542's `validateEpisode` and vice versa.
 * Round 2 found the mirror stale (R2-D1) because this file only pinned a SHA string; now a
 * change to #542's contract that is re-vendored fails here until the mirror follows, and
 * `scripts/episode-mirror-drift.sh` says when #542's head has moved past the vendored copy.
 * TO FILE: replace the mirror and this vendored copy with #542's own modules once it merges.
 */
import { describe, expect, it } from "vitest";
import { validateSchema } from "../../schemas/validate.ts";
import { EVIDENCE_PLANNERS } from "../../src/benchmark/check.ts";
import {
  canonicalJson,
  draftEpisode,
  EPISODE_COST_BASIS,
  EPISODE_FAULT_CLASSES,
  EPISODE_MAX_ACTIONS,
  EPISODE_MAX_OBSERVATIONS,
  EPISODE_MAX_TEXT,
  EPISODE_MIRROR_PINNED_AT,
  EPISODE_NO_GRADE_REASONS,
  EPISODE_OUTCOMES,
  EPISODE_REAL_PLANNERS,
  EPISODE_SCHEMA,
  EPISODE_SOURCES,
  type Episode,
  type EpisodeDraft,
  episodeIdOf,
  episodeMirrorSchema,
  persistedBlobFile,
  sha256Hex,
} from "../../src/dataset/episode.ts";
import { episodeProblem } from "../../src/dataset/export.ts";
import { REASON_CODES } from "../../src/gate/api.ts";
import * as upstream from "../fixtures/episode-542/schemas/episode.ts";
import {
  REAL_PLANNERS,
  episodeIdOf as upstreamIdOf,
  validateEpisode,
} from "../fixtures/episode-542/src/episode/validate.ts";

/** The vendored copy's head (test/fixtures/episode-542/README.md). */
const VENDORED_AT = "2e39c2463cc2fc7c0168721ed077b104f2b8733f";
const HOST = { home: "/nonexistent-home-u", tmp: "/nonexistent-tmp-u", user: "nobody-u" };

/** #542's schema with the one documented loosening applied (reason codes as a pattern). */
function loosened(): unknown {
  const copy = JSON.parse(JSON.stringify(upstream.episodeSchema));
  const items = copy.properties.gate.anyOf[1].properties.reasonCodes.anyOf[0].items;
  delete items.enum;
  items.pattern = "^[A-Z][A-Z0-9_]{0,63}$";
  return copy;
}

describe("myco.episode/1 mirror, pinned to #542 by #542's own code", () => {
  it("is pinned to the head the vendored copy was taken from", () => {
    expect(EPISODE_MIRROR_PINNED_AT).toBe(VENDORED_AT);
  });

  it("the mirror schema equals #542's schema, apart from the documented reason-code loosening", () => {
    expect(episodeMirrorSchema).toEqual(loosened());
    // The loosening is a superset: every real reason code is accepted.
    for (const code of REASON_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
  });

  it("the mirror's constants equal #542's (fault classes, no-grade reasons, limits, planners)", () => {
    expect(EPISODE_SCHEMA).toBe(upstream.EPISODE_SCHEMA);
    expect(EPISODE_COST_BASIS).toBe(upstream.EPISODE_COST_BASIS);
    expect([...EPISODE_OUTCOMES]).toEqual([...upstream.EPISODE_OUTCOMES]);
    expect([...EPISODE_SOURCES]).toEqual([...upstream.EPISODE_SOURCES]);
    expect([...EPISODE_FAULT_CLASSES]).toEqual([...upstream.EPISODE_FAULT_CLASSES]);
    expect(EPISODE_FAULT_CLASSES).toContain("harness-error");
    expect(EPISODE_NO_GRADE_REASONS).toContain("document-withheld");
    expect([EPISODE_MAX_ACTIONS, EPISODE_MAX_OBSERVATIONS, EPISODE_MAX_TEXT]).toEqual([
      upstream.MAX_ACTIONS,
      upstream.MAX_OBSERVATIONS,
      upstream.MAX_TEXT,
    ]);
    expect([...EPISODE_REAL_PLANNERS].sort()).toEqual([...REAL_PLANNERS].sort());
    expect([...EPISODE_REAL_PLANNERS].sort()).toEqual([...EVIDENCE_PLANNERS].sort());
  });

  it("an episode #542 writes (dry-run shape: persisted CSV observed, no actions) passes U", () => {
    const doc = Buffer.from("id,qty\nEMP-0001,7\n");
    const fixture = sha256Hex("fixture");
    const body: Omit<Episode, "episodeId"> = {
      schema: "myco.episode/1",
      outcome: "verified",
      simulated: true,
      task: {
        id: "m2-t1",
        family: "calc-record-edit",
        taskSetVersion: "fc-v1",
        faultClass: null,
        instruction: null,
        instructionSha256: null,
        fixtureSha256: fixture,
      },
      actions: { capture: "not-recorded", truncated: false, items: [] },
      observations: {
        capture: "recorded",
        withheld: 0,
        items: [
          {
            seq: 0,
            afterAction: null,
            kind: "state",
            label: "persisted",
            mediaType: "text/csv",
            sha256: sha256Hex(doc),
            bytes: doc.byteLength,
            file: persistedBlobFile(doc),
          },
        ],
      },
      agentClaim: "done",
      gate: { verdict: "verified", accepted: true, reasonCodes: ["ORACLE_PASS"], oracle: null },
      groundTruth: {
        source: "independent-grader",
        graderVersion: "false-completion-grader/1",
        status: "pass",
        targetSatisfied: true,
        mismatchCount: 0,
        fixtureSha256: fixture,
        persistedSha256: sha256Hex(doc),
      },
      harness: {
        arm: "c1",
        plannerModelId: null,
        outputCeiling: null,
        corrections: "off",
        flags: { policy: null, handoff: null, assisted: null },
        timing: { startedAt: null, endedAt: null, wallClockS: null, vmS: null },
        cost: {
          basis: EPISODE_COST_BASIS,
          estimateUsd: null,
          inputTokens: null,
          outputTokens: null,
        },
        fault: null,
      },
      provenance: {
        source: "m2-dry-run",
        runId: "m2-r1-1",
        trialKey: null,
        attemptLedger: null,
        writer: "myco.episode-writer/1",
      },
    };
    const ep: Episode = { ...body, episodeId: episodeIdOf(body) };
    expect(ep.episodeId).toBe(upstreamIdOf(ep as never));
    const blobs = new Map([[persistedBlobFile(doc), Uint8Array.from(doc)]]);
    expect(validateEpisode(ep, { blobs, host: HOST })).toEqual([]);
    expect(episodeProblem(ep, blobs)).toBeNull();
    // Both refuse the same episode with its graded document removed (#542 R4 / M07').
    const stripped = readdress({ ...ep, observations: { ...ep.observations, items: [] } });
    expect(validateEpisode(stripped, { blobs: new Map(), host: HOST }).map((i) => i.code)).toEqual([
      "GROUND_TRUTH",
    ]);
    expect(episodeProblem(stripped, new Map())?.detail).toBe("GROUND_TRUTH_DOCUMENT");
  });

  it("draftEpisode's graded episodes pass #542's validateEpisode (blobs included)", () => {
    const doc = Buffer.from("id,qty\nEMP-0001,42\n");
    const ep = draftEpisode({
      ...DRAFT,
      groundTruth: {
        source: "independent-grader",
        graderVersion: "false-completion-grader/1",
        status: "pass",
        targetSatisfied: true,
        mismatchCount: 0,
        fixtureSha256: sha256Hex("f"),
        persistedSha256: sha256Hex(doc),
      },
      persisted: doc,
    });
    const blobs = new Map([[persistedBlobFile(doc), Uint8Array.from(doc)]]);
    expect(validateEpisode(ep, { blobs, host: HOST })).toEqual([]);
    expect(episodeProblem(ep, blobs)).toBeNull();
    // Without the document observation (round 2's draftEpisode), #542 refuses it.
    const old = draftEpisode({ ...DRAFT, groundTruth: ep.groundTruth, persisted: null });
    expect(validateEpisode(old, { host: HOST }).map((i) => i.code)).toContain("GROUND_TRUTH");
    expect(episodeProblem(old)?.detail).toBe("GROUND_TRUTH_DOCUMENT");
  });
});

function readdress(ep: Episode): Episode {
  const { episodeId: _drop, ...rest } = ep;
  return { ...rest, episodeId: episodeIdOf(rest) };
}

const DRAFT: EpisodeDraft = {
  outcome: "verified",
  simulated: true,
  task: {
    id: "t-1",
    family: "calc-record-edit",
    taskSetVersion: null,
    faultClass: null,
    instruction: "Set it.",
    instructionSha256: sha256Hex("Set it."),
    fixtureSha256: sha256Hex("f"),
  },
  actions: [{ kind: "type", text: "42" }, { kind: "observe" }],
  observations: [{ afterAction: 1, text: "ok" }],
  withheld: 2,
  agentClaim: "done",
  gate: { verdict: "verified", accepted: true, reasonCodes: ["ORACLE_PASS"], oracle: null },
  groundTruth: { source: "none", reason: "no-independent-grader" },
  arm: "hcu+shell",
  plannerModelId: null,
  startedAt: null,
  endedAt: null,
  source: "gated-trial",
  runId: "r-1",
  trialKey: "t-1:r-1",
  persisted: null,
};

describe("draftEpisode (interim stand-in for #542's buildEpisode)", () => {
  const draft = DRAFT;

  it("produces a valid, content-addressed episode with numbered actions and observations", () => {
    const ep = draftEpisode(draft);
    expect(validateSchema(ep, episodeMirrorSchema)).toEqual([]);
    expect(ep.episodeId).toBe(episodeIdOf(ep));
    const { episodeId: _id, ...rest } = ep;
    expect(ep.episodeId).toBe(sha256Hex(canonicalJson(rest)));
    expect(ep.actions.items.map((a) => a.seq)).toEqual([0, 1]);
    expect(ep.observations).toEqual({
      capture: "recorded",
      withheld: 2,
      items: [{ seq: 0, afterAction: 1, kind: "ui-status", text: "ok" }],
    });
  });

  it("copies named fields only: gate prose or extra fields never reach the episode", () => {
    const smuggled = {
      ...draft,
      gate: { ...draft.gate!, reasons: ["human prose"] },
      groundTruth: {
        source: "independent-grader",
        graderVersion: "false-completion-grader/1",
        status: "fail",
        targetSatisfied: false,
        mismatchCount: 1,
        fixtureSha256: sha256Hex("f"),
        persistedSha256: null,
        reasons: ["grader prose"],
        mismatches: [{ cell: "B2" }],
      },
      task: { ...draft.task, vaultRoot: "x" },
      env: { A: "b" },
    } as unknown as EpisodeDraft;
    const ep = draftEpisode(smuggled);
    expect(validateSchema(ep, episodeMirrorSchema)).toEqual([]);
    expect(JSON.stringify(ep)).not.toContain("human prose");
    expect(JSON.stringify(ep)).not.toContain("grader prose");
    expect(JSON.stringify(ep)).not.toContain("mismatches");
    expect(JSON.stringify(ep)).not.toContain("vaultRoot");
  });
});
