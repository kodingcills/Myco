/**
 * Track Q (replayable proof): the attempt ledger, read through #518's own code.
 *
 * #518 (`src/m2/attempt-ledger.ts`, merged) owns the format and its check. A bundle carries
 * the ledger's events verbatim, which is allowed under the allowlist rule (`closed.ts`)
 * because every field of an event is closed under #518's schema: a schema id, integers, a
 * sha256, enums (`kind`, `arm`, `outcome`, `harnessClass`) and two ids in #518's grammar
 * (`^[A-Za-z0-9._:-]{1,128}$`: no separator, no whitespace, no escape). A ledger that fails
 * #518's check is refused, so nothing outside that schema is ever carried.
 *
 * #518's id grammar admits `:` and a leading `.`/`-`, so it can spell a drive-relative path
 * (`C:<user>`) or `..`. A bundle carries the ids verbatim (they are under the chain), so they
 * cannot be hashed: instead Q NARROWS them. Every `trialKey` and `taskId` must also match the
 * proof's `CLOSED_ID` (starts alphanumeric; letters, digits, `.`, `_`, `-`; no `:`), or the
 * ledger is refused, on export and on verify (#553 r2 field re-audit). No real ledger id uses
 * `:` (the runners write `r1p-<task>-a<n>`, `dry-<task>`, `demo-<i>-<task>`).
 *
 * #518's messages may quote a value (its schema validator does); this module never passes
 * them on. A refusal says only which event failed and how many issues it had.
 *
 * The tamper-evidence is exactly #518's ruled threat model: partial edits, gaps, reordering
 * and truncation against a pinned head, with the agent and the guest as the adversary and
 * the harness trusted. NOT regeneration of the whole history by whoever writes the ledger.
 */
import { createHash } from "node:crypto";
import { type AttemptEvent, type LedgerHead, verifyAttemptLedger } from "../m2/attempt-ledger.ts";
import { CLOSED_ID } from "./closed.ts";

export type { AttemptEvent as LedgerEvent, LedgerHead } from "../m2/attempt-ledger.ts";
export { ATTEMPT_EVENT_SCHEMA, eventSha256, GENESIS_SHA256 } from "../m2/attempt-ledger.ts";

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

/**
 * #518's `verifyAttemptLedger`, with its messages replaced by structural ones (an event
 * index and an issue count, never a value or a key).
 */
export function verifyLedgerChain(lines: readonly unknown[]): {
  readonly events: readonly AttemptEvent[];
  readonly head: LedgerHead;
  readonly errors: readonly string[];
} {
  const { events, head, errors } = verifyAttemptLedger(lines);
  if (errors.length === 0) {
    const narrowed = events.flatMap((e, i) =>
      CLOSED_ID.test(e.trialKey) && CLOSED_ID.test(e.taskId)
        ? []
        : [`ledger event ${i} has an id outside the proof's closed id grammar`],
    );
    return { events, head, errors: narrowed };
  }
  const failing = new Map<number, number>();
  for (const m of errors) {
    const at = /^attempt event (\d+):/.exec(m);
    const i = at === null ? -1 : Number(at[1]);
    failing.set(i, (failing.get(i) ?? 0) + 1);
  }
  const out = [...failing.entries()].map(([i, n]) =>
    i < 0
      ? `the attempt ledger fails #518's check (${n} issue(s))`
      : `ledger event ${i} fails #518's check (${n} issue(s))`,
  );
  return { events, head, errors: out };
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
