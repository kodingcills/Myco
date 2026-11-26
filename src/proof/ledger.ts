/**
 * Track Q (replayable proof): the attempt-ledger format, read-only.
 *
 * The append-only attempt ledger is #518 (`src/m2/attempt-ledger.ts`, open at the time of
 * writing). This module does NOT import it: unmerged code is never imported. It re-states
 * #518's DOCUMENTED format so a proof bundle can carry the ledger and a verifier can
 * recompute it:
 *  - one `myco.m2.attempt-event/1` event per line: `start`, then `end` with an outcome
 *    (`completed` or `harness-fault` with a harness class);
 *  - `seq` = the event's index;
 *  - `prevSha256` = sha256 of the previous event's canonical JSON (parsed, key-sorted, no
 *    undefined members), 64 zeros for the first;
 *  - the head is (event count, sha256 of the last event).
 *
 * TO FILE: once #518 lands, replace this module's checks with its `verifyAttemptLedger` and
 * `eventSha256` (a parity test then pins that both agree). Until then a format change in
 * #518 makes the proof verifier refuse honest ledgers, which fails closed.
 *
 * The tamper-evidence this gives is exactly #518's: partial edits, gaps, reordering and
 * truncation against a pinned head. NOT regeneration of the whole history: the chain is
 * unkeyed, so whoever writes the ledger can write a fresh consistent one.
 */
import { createHash } from "node:crypto";

export const ATTEMPT_EVENT_SCHEMA = "myco.m2.attempt-event/1" as const;
export const GENESIS_SHA256 = "0".repeat(64);

/** #518's harness classes and arms, as documented there. */
export const LEDGER_HARNESS_CLASSES = [
  "convert-deadline",
  "deploy-copy",
  "sshd",
  "timeout",
  "load",
] as const;
export const LEDGER_ARMS = ["myco-gate", "hcu+shell"] as const;

export interface LedgerEvent {
  readonly schema: typeof ATTEMPT_EVENT_SCHEMA;
  readonly seq: number;
  readonly prevSha256: string;
  readonly kind: "start" | "end";
  readonly trialKey: string;
  readonly taskId: string;
  readonly arm: (typeof LEDGER_ARMS)[number];
  readonly outcome?: "completed" | "harness-fault";
  readonly harnessClass?: string;
}

export interface LedgerHead {
  readonly events: number;
  readonly headSha256: string;
}

/** JSON with object keys sorted and undefined members dropped (#518's canonical form). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function ledgerEventSha256(event: LedgerEvent): string {
  return sha256Hex(canonicalJson(event));
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVENT_KEYS = new Set([
  "schema",
  "seq",
  "prevSha256",
  "kind",
  "trialKey",
  "taskId",
  "arm",
  "outcome",
  "harnessClass",
]);

/** Closed-shape check of one event, per #518's documented schema. */
function eventShapeErrors(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["not an object"];
  const e = value as Record<string, unknown>;
  const out: string[] = [];
  // The unknown key's NAME is never echoed: a key can carry a path or a secret.
  const unknown = Object.keys(e).filter((key) => !EVENT_KEYS.has(key)).length;
  if (unknown > 0) out.push(`${unknown} unknown field(s)`);
  if (e.schema !== ATTEMPT_EVENT_SCHEMA) out.push("schema");
  if (!Number.isInteger(e.seq) || (e.seq as number) < 0) out.push("seq");
  if (typeof e.prevSha256 !== "string" || !HEX64.test(e.prevSha256)) out.push("prevSha256");
  if (e.kind !== "start" && e.kind !== "end") out.push("kind");
  if (typeof e.trialKey !== "string" || !ID.test(e.trialKey)) out.push("trialKey");
  if (typeof e.taskId !== "string" || !ID.test(e.taskId)) out.push("taskId");
  if (!LEDGER_ARMS.includes(e.arm as never)) out.push("arm");
  if (e.outcome !== undefined && e.outcome !== "completed" && e.outcome !== "harness-fault")
    out.push("outcome");
  if (e.harnessClass !== undefined && !LEDGER_HARNESS_CLASSES.includes(e.harnessClass as never))
    out.push("harnessClass");
  if (out.length > 0) return out;
  if (e.kind === "start" && (e.outcome !== undefined || e.harnessClass !== undefined))
    out.push("a start event has no outcome or harness class");
  if (e.kind === "end") {
    if (e.outcome === undefined) out.push("an end event must have an outcome");
    if ((e.outcome === "harness-fault") !== (e.harnessClass !== undefined))
      out.push("an end event has a harness class exactly when its outcome is harness-fault");
  }
  return out;
}

/**
 * Recompute the chain. Stops at the first break (everything after an unverifiable link is
 * unverifiable). Returns the verified events, the recomputed head, and every error.
 */
export function verifyLedgerChain(lines: readonly unknown[]): {
  readonly events: readonly LedgerEvent[];
  readonly head: LedgerHead;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  const events: LedgerEvent[] = [];
  let prev = GENESIS_SHA256;
  for (let i = 0; i < lines.length; i++) {
    const shape = eventShapeErrors(lines[i]);
    if (shape.length > 0) {
      errors.push(`ledger event ${i}: ${shape.join("; ")}`);
      break;
    }
    const e = lines[i] as LedgerEvent;
    if (e.seq !== i) {
      errors.push(`ledger event ${i}: seq ${e.seq}, expected ${i} (a gap or a reordering)`);
      break;
    }
    if (e.prevSha256 !== prev) {
      errors.push(
        `ledger event ${i}: the hash chain breaks (an edited, removed or reordered event)`,
      );
      break;
    }
    events.push(e);
    prev = ledgerEventSha256(e);
  }
  return { events, head: { events: events.length, headSha256: prev }, errors };
}

/** Parse `attempts.jsonl` text into lines (a torn or non-JSON line is an error, not a skip). */
export function parseLedgerJsonl(text: string): { lines: unknown[]; errors: string[] } {
  const lines: unknown[] = [];
  const errors: string[] = [];
  const raw = text.split("\n");
  if (raw.at(-1) === "") raw.pop();
  for (let i = 0; i < raw.length; i++) {
    try {
      lines.push(JSON.parse(raw[i] as string));
    } catch {
      errors.push(`ledger line ${i + 1} is not JSON (a torn write?)`);
      break;
    }
  }
  return { lines, errors };
}
