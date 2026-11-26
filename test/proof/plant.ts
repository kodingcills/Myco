/**
 * Track Q test helpers: plant one raw value into EVERY free-text, path-capable and id input
 * field of a run, and check that no planted word reaches any output byte.
 */
import { expect } from "vitest";
import type { RedactionContext } from "../../src/proof/backstop.ts";
import {
  exportProofBundle,
  type ProofBundle,
  type ProofRunInput,
  type ProofStep,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { episodeIdOf } from "../../src/proof/episode-ref.ts";
import { renderProofReport } from "../../src/proof/report.ts";
import { NO_CTX, sampleEpisode } from "./fixture.ts";

/**
 * The input fields `plantEverywhere` writes `value` into. Every key of `FIELD_TREATMENT`
 * whose treatment is a string-replacement (id, arm, text, media-type, code, digest-only,
 * reference) is listed; `allowlist.test.ts` pins that the two lists agree.
 */
export const PLANTED_FIELDS = [
  "run.runId",
  "run.taskId",
  "run.arm",
  "action.tool",
  "action.summary",
  "evidence.evidenceId",
  "evidence.evidenceKind",
  "evidence.mediaType",
  "evidence.path",
  "evidence.content",
  "verdict.taskId",
  "verdict.runId",
  "verdict.evidence",
  "verdict.oracle.family",
  "verdict.oracle.version",
  "handoff.from",
  "handoff.to",
  "handoff.summary",
  "policy.policyId",
  "policy.subject",
  "policy.reasonCode",
  "episode",
] as const;

/** A run whose every string-valued input field (and the episode's) is `value`. */
export function plantEverywhere(value: string): ProofRunInput {
  const steps: ProofStep[] = [
    {
      kind: "policy",
      policyId: value,
      subject: value,
      decision: "allow",
      reasonCode: value,
    },
    { kind: "action", actor: "harness", tool: value, summary: value },
    { kind: "action", actor: "agent", tool: value, summary: `${value} ${value}` },
    { kind: "handoff", from: value, to: value, summary: value, checkpoint: 1 },
    {
      kind: "evidence",
      evidenceId: value,
      evidenceKind: value,
      mediaType: value,
      path: value,
      content: value,
    },
    {
      kind: "evidence",
      evidenceId: `${value}.2`,
      evidenceKind: value,
      mediaType: value,
      path: `${value}/frame.png`,
      content: new TextEncoder().encode(value),
    },
    {
      kind: "verdict",
      taskId: value,
      runId: value,
      verdict: "refuted",
      accepted: false,
      reasonCodes: ["ORACLE_FAIL"],
      evidence: [value],
      oracle: { family: value, version: value, specSha256: "a".repeat(64) },
    },
  ];
  // The episode holds the value in the projected fields AND in free-text fields it never
  // hands to the bundle (instruction, actions, claim).
  const base = sampleEpisode();
  const { episodeId: _id, ...rest } = base;
  const episodeBody: Record<string, unknown> = {
    ...rest,
    agentClaim: value,
    task: { ...(rest.task as object), id: value, instruction: value },
    harness: { ...(rest.harness as object), arm: value },
    actions: {
      capture: "recorded",
      truncated: false,
      items: [{ seq: 0, atMs: null, kind: "type", text: value }],
    },
    provenance: { ...(rest.provenance as object), runId: value, trialKey: null },
  };
  const episode = { ...episodeBody, episodeId: episodeIdOf(episodeBody) };
  return { runId: value, taskId: value, arm: value, simulated: true, steps, episode };
}

/** Words that must not appear: each, its lower and upper case, and its JSON-escaped form. */
export function expectAbsent(text: string, words: readonly string[], where: string): void {
  const lower = text.toLowerCase();
  for (const w of words) {
    if (w.length < 4) continue;
    const forms = new Set([w, JSON.stringify(w).slice(1, -1)]);
    for (const f of forms) {
      if (lower.includes(f.toLowerCase()))
        expect.fail(`${where}: carries a planted word (${w.length} chars)`);
    }
  }
}

/**
 * Export the planted run, verify it, render the report: every step must succeed and no
 * output byte may carry a planted word. Returns the outputs for further checks.
 */
export function exportVerifyReport(
  run: ProofRunInput,
  words: readonly string[],
  ctx: RedactionContext = NO_CTX,
): { bundle: ProofBundle; text: string; html: string } {
  const bundle = exportProofBundle(run, ctx);
  const text = serializeProofBundle(bundle);
  const result = verifyProofBundle(text, {
    redaction: ctx,
    ...(run.episode === undefined ? {} : { episode: run.episode }),
  });
  if (!result.ok) expect.fail(`verify refused: ${result.errors.map((e) => e.code).join(",")}`);
  expect(result.episodeChecked).toBe(run.episode !== undefined);
  const html = renderProofReport(bundle, result, ctx);
  expectAbsent(text, words, "bundle");
  expectAbsent(JSON.stringify(result), words, "verify result");
  expectAbsent(html, words, "report");
  return { bundle, text, html };
}
