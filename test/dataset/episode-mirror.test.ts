/**
 * Pins track U's mirror of the canonical `myco.episode/1` record (src/dataset/episode.ts) to
 * the data-capture PR #542 at `EPISODE_MIRROR_PINNED_AT`. The key lists below were copied
 * from #542's `schemas/episode.ts` at that head; if #542 changes the format before it
 * merges, this test is where the mirror must be brought back in step (TO FILE: replace the
 * mirror with #542's own types and validator once it merges).
 */
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../../schemas/validate.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  canonicalJson,
  draftEpisode,
  EPISODE_COST_BASIS,
  EPISODE_MIRROR_PINNED_AT,
  EPISODE_OUTCOMES,
  EPISODE_SCHEMA,
  EPISODE_SOURCES,
  EPISODE_WRITER,
  type EpisodeDraft,
  episodeIdOf,
  episodeMirrorSchema,
  sha256Hex,
} from "../../src/dataset/episode.ts";

const sub = (s: JsonSchema, ...path: string[]): JsonSchema => {
  let cur = s;
  for (const p of path) {
    const props = cur.properties as Record<string, JsonSchema> | undefined;
    const next = props?.[p];
    if (next !== undefined) {
      cur = next;
      continue;
    }
    // Step into the object branch of a nullable `anyOf`.
    const branch = (cur.anyOf ?? []).find((b) => b.type === "object");
    cur = (branch!.properties as Record<string, JsonSchema>)[p]!;
  }
  if (cur.type !== "object") return (cur.anyOf ?? []).find((b) => b.type === "object") ?? cur;
  return cur;
};
const keys = (s: JsonSchema) => [...(s.required ?? [])].sort();

describe("myco.episode/1 mirror, pinned to #542", () => {
  it("is pinned to one #542 head and its constants", () => {
    expect(EPISODE_MIRROR_PINNED_AT).toBe("b50484690d22d9dbd34ea836678ed2ade1a7e9f7");
    expect(EPISODE_SCHEMA).toBe("myco.episode/1");
    expect(EPISODE_WRITER).toBe("myco.episode-writer/1");
    expect(EPISODE_COST_BASIS).toBe("token-derived estimate at frozen rates; not billed USD");
    expect([...EPISODE_OUTCOMES]).toEqual([
      "verified",
      "refuted",
      "uncertain",
      "harness-fault",
      "launch-refused",
      "unregistrable",
    ]);
    expect([...EPISODE_SOURCES]).toEqual([
      "gated-trial",
      "m2-dry-run",
      "demo-mock",
      "demo-multistep-mock",
    ]);
  });

  it.each<[string, string[], string[]]>([
    [
      "episode",
      [],
      [
        "schema",
        "episodeId",
        "outcome",
        "simulated",
        "task",
        "actions",
        "observations",
        "agentClaim",
        "gate",
        "groundTruth",
        "harness",
        "provenance",
      ],
    ],
    [
      "task",
      ["task"],
      [
        "id",
        "family",
        "taskSetVersion",
        "faultClass",
        "instruction",
        "instructionSha256",
        "fixtureSha256",
      ],
    ],
    ["actions", ["actions"], ["capture", "truncated", "items"]],
    ["observations", ["observations"], ["capture", "withheld", "items"]],
    ["gate", ["gate"], ["verdict", "accepted", "reasonCodes", "oracle"]],
    ["gate.oracle", ["gate", "oracle"], ["family", "version", "specSha256"]],
    [
      "harness",
      ["harness"],
      ["arm", "plannerModelId", "outputCeiling", "corrections", "flags", "timing", "cost", "fault"],
    ],
    ["harness.flags", ["harness", "flags"], ["policy", "handoff", "assisted"]],
    ["harness.timing", ["harness", "timing"], ["startedAt", "endedAt", "wallClockS", "vmS"]],
    ["harness.cost", ["harness", "cost"], ["basis", "estimateUsd", "inputTokens", "outputTokens"]],
    ["harness.fault", ["harness", "fault"], ["class", "code"]],
    ["provenance", ["provenance"], ["source", "runId", "trialKey", "attemptLedger", "writer"]],
    [
      "provenance.attemptLedger",
      ["provenance", "attemptLedger"],
      ["schema", "events", "headSha256"],
    ],
  ])("%s is closed with exactly #542's fields", (_name, path, expected) => {
    const s = sub(episodeMirrorSchema, ...path);
    expect(s.additionalProperties).toBe(false);
    expect(keys(s)).toEqual([...expected].sort());
    expect(Object.keys(s.properties ?? {}).sort()).toEqual([...expected].sort());
  });

  it("ground truth, actions and observations have exactly #542's variants", () => {
    const truth = (episodeMirrorSchema.properties as Record<string, JsonSchema>).groundTruth!;
    expect(truth.oneOf!.map(keys)).toEqual([
      [
        "fixtureSha256",
        "graderVersion",
        "mismatchCount",
        "persistedSha256",
        "source",
        "status",
        "targetSatisfied",
      ],
      ["reason", "source"],
    ]);
    const actionItems = sub(episodeMirrorSchema, "actions").properties!.items!.items as JsonSchema;
    expect(
      actionItems.oneOf!.map((v) => [(v.properties!.kind as JsonSchema).const, keys(v)]),
    ).toEqual([
      ["click", ["atMs", "button", "kind", "seq", "x", "y"]],
      ["type", ["atMs", "kind", "seq", "text"]],
      ["key", ["atMs", "keys", "kind", "seq"]],
      ["scroll", ["atMs", "dx", "dy", "kind", "seq"]],
      ["launch", ["app", "atMs", "kind", "seq"]],
      ["wait", ["atMs", "kind", "ms", "seq"]],
      ["shell", ["atMs", "command", "kind", "seq"]],
      ["gate-check", ["atMs", "claim", "kind", "seq"]],
      ["observe", ["atMs", "kind", "seq"]],
    ]);
    const obsItems = sub(episodeMirrorSchema, "observations").properties!.items!
      .items as JsonSchema;
    expect(obsItems.oneOf!.map((v) => [(v.properties!.kind as JsonSchema).const, keys(v)])).toEqual(
      [
        ["screenshot", ["afterAction", "bytes", "file", "kind", "mediaType", "seq", "sha256"]],
        ["state", ["afterAction", "bytes", "file", "kind", "label", "mediaType", "seq", "sha256"]],
        ["ui-status", ["afterAction", "kind", "seq", "text"]],
      ],
    );
  });
});

describe("draftEpisode (interim stand-in for #542's buildEpisode)", () => {
  const draft: EpisodeDraft = {
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
  };

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
