/**
 * Fixtures for track Q (replayable proof). The ledger builder writes #518's documented
 * format (seq, prevSha256 over canonical JSON, 64-zero genesis) so tests do not import
 * unmerged code.
 */
import type { ProofBundle, ProofRecord, ProofRunInput } from "../../src/proof/bundle.ts";
import { recordSha256, runGenesis } from "../../src/proof/bundle.ts";
import { episodeIdOf } from "../../src/proof/episode-ref.ts";
import {
  ATTEMPT_EVENT_SCHEMA,
  GENESIS_SHA256,
  type LedgerEvent,
  type LedgerHead,
  ledgerEventSha256,
} from "../../src/proof/ledger.ts";
import type { RedactionContext } from "../../src/proof/redact.ts";

type EventInput = Omit<LedgerEvent, "schema" | "seq" | "prevSha256">;

export function buildLedger(inputs: readonly EventInput[]): {
  lines: LedgerEvent[];
  head: LedgerHead;
} {
  const lines: LedgerEvent[] = [];
  let prev = GENESIS_SHA256;
  for (const input of inputs) {
    const e: LedgerEvent = {
      schema: ATTEMPT_EVENT_SCHEMA,
      seq: lines.length,
      prevSha256: prev,
      ...input,
    };
    lines.push(e);
    prev = ledgerEventSha256(e);
  }
  return { lines, head: { events: lines.length, headSha256: prev } };
}

/** Two trials: another one first, then ours (`t-ours`). */
export function sampleLedger() {
  return buildLedger([
    { kind: "start", trialKey: "t-other", taskId: "df-s01", arm: "myco-gate" },
    { kind: "end", trialKey: "t-other", taskId: "df-s01", arm: "myco-gate", outcome: "completed" },
    { kind: "start", trialKey: "t-ours", taskId: "df-s02", arm: "myco-gate" },
    { kind: "end", trialKey: "t-ours", taskId: "df-s02", arm: "myco-gate", outcome: "completed" },
  ]);
}

export const STORE_TEXT = '{"items":["buy milk","fix bike"]}\n';

export function sampleRun(): ProofRunInput {
  const ledger = sampleLedger();
  return {
    runId: "run-1",
    taskId: "df-s02",
    arm: "myco-gate",
    simulated: true,
    steps: [
      {
        kind: "policy",
        policyId: "pol-1",
        subject: "typeTextGlobal",
        decision: "allow",
        reasonCode: "POLICY_ALLOW",
      },
      { kind: "action", actor: "agent", tool: "typeTextGlobal", summary: "typed 'buy milk'" },
      { kind: "action", actor: "agent", tool: "keyPress", summary: "Return" },
      { kind: "checkpoint", checkpoint: 1, verdict: "verified" },
      { kind: "handoff", from: "agent-a", to: "agent-b", summary: "item 1 saved", checkpoint: 1 },
      { kind: "action", actor: "agent", tool: "clickAt", summary: "clicked Save (210,284)" },
      {
        kind: "evidence",
        evidenceId: "ev-store",
        evidenceKind: "persisted-state",
        mediaType: "application/json",
        path: "run-1/.myco-todo.json",
        content: STORE_TEXT,
      },
      {
        kind: "evidence",
        evidenceId: "ev-frame",
        evidenceKind: "screenshot",
        mediaType: "image/png",
        path: "run-1/frame-0001.png",
        content: new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
      },
      {
        kind: "verdict",
        taskId: "df-s02",
        runId: "run-1",
        verdict: "refuted",
        accepted: false,
        reasonCodes: ["ORACLE_FAIL", "CLAIM_RECORDED"],
        evidence: ["ev-store"],
      },
    ],
    ledger: { lines: ledger.lines, head: ledger.head, trialKey: "t-ours" },
  };
}

/**
 * A whole `myco.episode/1` record in #542's shape (src/episode/types.ts @ b5048469), for the
 * run `sampleRun()` describes. Q reads only `EPISODE_FIELDS_USED`; the rest is here so the
 * id and digest are computed over a realistic record.
 */
export function sampleEpisode(over: Record<string, unknown> = {}): Record<string, unknown> {
  const ledger = sampleLedger();
  const body: Record<string, unknown> = {
    schema: "myco.episode/1",
    outcome: "refuted",
    simulated: true,
    task: {
      id: "df-s02",
      family: "todo-store",
      taskSetVersion: null,
      faultClass: "silent-drop",
      instruction: null,
      instructionSha256: null,
      fixtureSha256: null,
    },
    actions: {
      capture: "recorded",
      truncated: false,
      items: [
        { seq: 0, atMs: null, kind: "type", text: "buy milk" },
        { seq: 1, atMs: null, kind: "key", keys: "Return" },
        { seq: 2, atMs: null, kind: "click", x: 210, y: 284, button: "left" },
        { seq: 3, atMs: null, kind: "gate-check", claim: "done" },
      ],
    },
    observations: { capture: "not-recorded", withheld: 0, items: [] },
    agentClaim: "done",
    gate: {
      verdict: "refuted",
      accepted: false,
      reasonCodes: ["ORACLE_FAIL", "CLAIM_RECORDED"],
      oracle: null,
    },
    groundTruth: { source: "none", reason: "no-independent-grader" },
    harness: {
      arm: "myco-gate",
      plannerModelId: null,
      outputCeiling: null,
      corrections: "off",
      flags: { policy: true, handoff: true, assisted: null },
      timing: { startedAt: null, endedAt: null, wallClockS: null, vmS: null },
      cost: {
        basis: "token-derived estimate at frozen rates; not billed USD",
        estimateUsd: null,
        inputTokens: null,
        outputTokens: null,
      },
      fault: null,
    },
    provenance: {
      source: "demo-mock",
      runId: "run-1",
      trialKey: "t-ours",
      attemptLedger: {
        schema: "myco.m2.attempt-event/1",
        events: ledger.head.events,
        headSha256: ledger.head.headSha256,
      },
      writer: "myco.episode-writer/1",
    },
    ...over,
  };
  return { ...body, episodeId: episodeIdOf(body) };
}

/** `sampleRun()` with its episode attached. */
export function sampleRunWithEpisode(): ProofRunInput {
  return { ...sampleRun(), episode: sampleEpisode() };
}

export const NO_CTX: RedactionContext = {
  secrets: [],
  vaultKeys: [],
  hostPaths: [],
  usernames: [],
};

/** Deep clone (bundles are plain JSON). */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Re-chain records and re-pin the head, as a forger who controls the whole bundle would. */
export function rechain(bundle: ProofBundle): ProofBundle {
  const records: ProofRecord[] = [];
  let prev = runGenesis(bundle.run);
  for (const r of bundle.records) {
    const next = { ...r, seq: records.length, prevSha256: prev };
    records.push(next);
    prev = recordSha256(next);
  }
  return { ...bundle, records, head: { records: records.length, headSha256: prev } };
}
