/**
 * Fixtures for track Q (replayable proof). The ledger builder writes #518's documented
 * format (seq, prevSha256 over canonical JSON, 64-zero genesis) so tests do not import
 * unmerged code.
 */
import type { ProofBundle, ProofRecord, ProofRunInput } from "../../src/proof/bundle.ts";
import { recordSha256 } from "../../src/proof/bundle.ts";
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
  let prev = GENESIS_SHA256;
  for (const r of bundle.records) {
    const next = { ...r, seq: records.length, prevSha256: prev };
    records.push(next);
    prev = recordSha256(next);
  }
  return { ...bundle, records, head: { records: records.length, headSha256: prev } };
}
