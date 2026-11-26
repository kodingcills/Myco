/**
 * Track M skill store: an append-only, hash-chained event log on local disk.
 *
 * Layout: one file, `skills.jsonl`, one event per line. Events:
 *  - `admit`  a record that passed `admit()` (`admission.ts`);
 *  - `revoke` an operator revocation (a closed set of reason codes);
 *  - `use`    a later run that retrieved the skill, with that run's outcome (gate verdict
 *             AND grader status).
 *
 * Every event carries `seq` (0, 1, 2, ...), `prevSha256` (the previous event's digest, or
 * 64 zeros) and `eventSha256` (SHA-256 of its canonical JSON without that field). Loading
 * verifies the chain, every record's own digest and skill id, and re-runs the record shape
 * and the task-independent content rules (secrets, host paths, oracle internals,
 * injection; not the task's own values, which the store does not know). ANY failure refuses the whole store (`SkillStoreError`, code
 * `STORE_TAMPERED`): retrieval then serves nothing. When the operator pins the expected head
 * digest (kept outside the store, e.g. beside the run ledger), a truncated or rolled-back
 * log is refused too (`STORE_HEAD_MISMATCH`). Without a pin, an attacker who can rewrite the
 * file AND recompute every digest is not detected (they could plant a task's expected
 * value); the pin is what closes that, and the task-independent content rules still apply
 * to anything that loads.
 *
 * State is derived from the log, never stored separately:
 *  - revoked: a `revoke` event names the skill;
 *  - quarantined: at least `quarantineAfter` (default 1) `use` events with outcome
 *    `refuted`. Quarantine is sticky: later verified uses do not lift it; only a new
 *    admission from a new verified run (a new record, a new id) brings the procedure back.
 *
 * Writes re-read and re-verify the file first and refuse if the on-disk head is not the
 * head this process last saw, so a concurrent or hand edit is never silently extended.
 *
 * Reads (`skills()`, `active()`, `snapshot()`) re-read and re-verify the file every time, so
 * a revocation written through another handle (the operator's) reaches a store that is
 * already open (a running `myco-skills` server) on its next call. The re-read log must
 * extend the log this handle already verified; a shorter or diverging log (a rolled-back
 * revocation) refuses the read (`STORE_HEAD_MISMATCH`).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdmissionResult } from "./admission.ts";
import { canonicalJson, checkRecordShape, PLAIN_ID, type SkillRecord, sha256 } from "./record.ts";

export const STORE_FILE = "skills.jsonl";
export const GENESIS = "0".repeat(64);
export const DEFAULT_QUARANTINE_AFTER = 1;

export const REVOKE_REASONS = ["operator", "poisoned", "superseded", "provenance-doubt"] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/** A later use's outcome: verified only when the gate verified AND the grader passed. */
export type UseOutcome = "verified" | "refuted" | "uncertain";

interface EventBase {
  readonly seq: number;
  readonly prevSha256: string;
  readonly eventSha256: string;
}
export type StoreEvent =
  | (EventBase & { readonly type: "admit"; readonly record: SkillRecord })
  | (EventBase & {
      readonly type: "revoke";
      readonly skillId: string;
      readonly reason: RevokeReason;
    })
  | (EventBase & {
      readonly type: "use";
      readonly skillId: string;
      readonly runId: string;
      readonly outcome: UseOutcome;
    });

type EventBody =
  | { readonly type: "admit"; readonly record: SkillRecord }
  | { readonly type: "revoke"; readonly skillId: string; readonly reason: RevokeReason }
  | {
      readonly type: "use";
      readonly skillId: string;
      readonly runId: string;
      readonly outcome: UseOutcome;
    };

export type SkillStatus = "active" | "revoked" | "quarantined";

export interface SkillState {
  readonly record: SkillRecord;
  readonly status: SkillStatus;
  readonly uses: {
    readonly verified: number;
    readonly refuted: number;
    readonly uncertain: number;
  };
  readonly admittedSeq: number;
}

export type StoreErrorCode =
  | "STORE_TAMPERED"
  | "STORE_HEAD_MISMATCH"
  | "STORE_CHANGED"
  | "STORE_NOT_PINNED"
  | "UNKNOWN_SKILL"
  | "DUPLICATE"
  | "INVALID_EVENT";

export class SkillStoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "SkillStoreError";
  }
}

export interface OpenOptions {
  /** The expected head digest. A mismatch refuses the store. */
  readonly expectHead?: string;
  /** Refuted uses that quarantine a skill. At least 1. */
  readonly quarantineAfter?: number;
}

function eventDigest(e: Omit<StoreEvent, "eventSha256">): string {
  return sha256(canonicalJson(e));
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Parse and verify a log. Throws `SkillStoreError` on any break. */
export function verifyLog(text: string): { events: StoreEvent[]; head: string } {
  const events: StoreEvent[] = [];
  let prev = GENESIS;
  const lines = text.length === 0 ? [] : text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] !== "")
    throw new SkillStoreError("STORE_TAMPERED", "log does not end with a newline");
  lines.pop();
  const ids = new Set<string>();
  for (const [i, line] of lines.entries()) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new SkillStoreError("STORE_TAMPERED", `line ${i + 1} is not JSON`);
    }
    if (typeof e !== "object" || e === null || Array.isArray(e))
      throw new SkillStoreError("STORE_TAMPERED", `line ${i + 1} is not an event`);
    if (e.seq !== i)
      throw new SkillStoreError("STORE_TAMPERED", `line ${i + 1} seq ${String(e.seq)}`);
    if (e.prevSha256 !== prev)
      throw new SkillStoreError("STORE_TAMPERED", `line ${i + 1} breaks the chain`);
    const { eventSha256, ...body } = e;
    if (
      typeof eventSha256 !== "string" ||
      !HEX64.test(eventSha256) ||
      eventDigest(body as never) !== eventSha256
    )
      throw new SkillStoreError("STORE_TAMPERED", `line ${i + 1} digest does not match`);
    const allowedKeys: Record<string, string[]> = {
      admit: ["seq", "prevSha256", "eventSha256", "type", "record"],
      revoke: ["seq", "prevSha256", "eventSha256", "type", "skillId", "reason"],
      use: ["seq", "prevSha256", "eventSha256", "type", "skillId", "runId", "outcome"],
    };
    const keys = allowedKeys[String(e.type)];
    if (keys === undefined || Object.keys(e).some((k) => !keys.includes(k)))
      throw new SkillStoreError("STORE_TAMPERED", `line ${i + 1} is not a known event shape`);
    if (e.type === "admit") {
      const problems = checkRecordShape(e.record);
      if (problems.length > 0)
        throw new SkillStoreError("STORE_TAMPERED", `line ${i + 1} record: ${problems.join("; ")}`);
      const id = (e.record as SkillRecord).skillId;
      if (ids.has(id)) throw new SkillStoreError("STORE_TAMPERED", `line ${i + 1} duplicate ${id}`);
      ids.add(id);
    } else {
      if (typeof e.skillId !== "string" || !ids.has(e.skillId))
        throw new SkillStoreError("STORE_TAMPERED", `line ${i + 1} names an unknown skill`);
      if (e.type === "revoke" && !(REVOKE_REASONS as readonly unknown[]).includes(e.reason))
        throw new SkillStoreError("STORE_TAMPERED", `line ${i + 1} revoke reason`);
      if (
        e.type === "use" &&
        (typeof e.runId !== "string" ||
          !PLAIN_ID.test(e.runId) ||
          !["verified", "refuted", "uncertain"].includes(String(e.outcome)))
      )
        throw new SkillStoreError("STORE_TAMPERED", `line ${i + 1} use event`);
    }
    events.push(e as unknown as StoreEvent);
    prev = eventSha256;
  }
  return { events, head: prev };
}

export class SkillStore {
  private events: StoreEvent[] = [];
  private headDigest = GENESIS;
  private readonly file: string;
  private readonly quarantineAfter: number;

  private constructor(
    readonly dir: string,
    opts: OpenOptions,
  ) {
    this.file = join(dir, STORE_FILE);
    const q = opts.quarantineAfter ?? DEFAULT_QUARANTINE_AFTER;
    if (!Number.isInteger(q) || q < 1)
      throw new SkillStoreError("INVALID_EVENT", "quarantineAfter must be an integer >= 1");
    this.quarantineAfter = q;
  }

  /** Open (or create) a store. Verifies the whole log; throws on any break. */
  static open(dir: string, opts: OpenOptions = {}): SkillStore {
    const store = new SkillStore(dir, opts);
    mkdirSync(dir, { recursive: true });
    store.reload();
    if (opts.expectHead !== undefined && opts.expectHead !== store.headDigest)
      throw new SkillStoreError("STORE_HEAD_MISMATCH", "head is not the pinned head");
    return store;
  }

  private readLog(): { events: StoreEvent[]; head: string } {
    return verifyLog(existsSync(this.file) ? readFileSync(this.file, "utf8") : "");
  }

  private reload(): void {
    const { events, head } = this.readLog();
    this.events = events;
    this.headDigest = head;
  }

  /**
   * Re-read and re-verify the log for a read. It must extend what this handle already
   * verified (same events, possibly more after them); otherwise the log was rolled back or
   * rewritten and the read is refused.
   */
  private sync(): void {
    const { events, head } = this.readLog();
    const n = this.events.length;
    if (events.length < n || (n > 0 && events[n - 1]?.eventSha256 !== this.headDigest))
      throw new SkillStoreError(
        "STORE_HEAD_MISMATCH",
        "the log no longer extends the head this store verified",
      );
    this.events = events;
    this.headDigest = head;
  }

  /** The digest of the last event (64 zeros when empty). Pin it to detect rollback. */
  head(): string {
    return this.headDigest;
  }

  private append(body: EventBody): StoreEvent {
    const before = this.headDigest;
    this.reload();
    if (this.headDigest !== before)
      throw new SkillStoreError("STORE_CHANGED", "the log changed under this store");
    const partial = { ...body, seq: this.events.length, prevSha256: this.headDigest };
    const event = { ...partial, eventSha256: eventDigest(partial as never) } as StoreEvent;
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, { flag: "a" });
    this.events.push(event);
    this.headDigest = event.eventSha256;
    return event;
  }

  /**
   * Store an admitted record. Takes `admit()`'s result, so a refused candidate cannot be
   * stored by mistake: a refusal returns its code and writes nothing. One skill per run.
   */
  add(
    result: AdmissionResult,
  ): { stored: true; skillId: string } | { stored: false; code: string } {
    if (!result.ok) return { stored: false, code: result.code };
    const problems = checkRecordShape(result.record);
    if (problems.length > 0) return { stored: false, code: "INVALID_EVENT" };
    const id = result.record.skillId;
    for (const e of this.events) {
      if (e.type !== "admit") continue;
      if (e.record.skillId === id) return { stored: false, code: "DUPLICATE" };
      if (e.record.provenance.runId === result.record.provenance.runId)
        return { stored: false, code: "DUPLICATE" };
    }
    this.append({ type: "admit", record: result.record });
    return { stored: true, skillId: id };
  }

  private requireSkill(skillId: string): void {
    if (!this.events.some((e) => e.type === "admit" && e.record.skillId === skillId))
      throw new SkillStoreError("UNKNOWN_SKILL", "no such skill");
  }

  /** Revoke a skill. It is never retrieved again. */
  revoke(skillId: string, reason: RevokeReason): void {
    this.requireSkill(skillId);
    if (!(REVOKE_REASONS as readonly string[]).includes(reason))
      throw new SkillStoreError("INVALID_EVENT", "unknown revoke reason");
    this.append({ type: "revoke", skillId, reason });
  }

  /**
   * Record a later run that retrieved `skillId`. `outcome` is "verified" only when that run's
   * gate verified AND its grader passed; use `useOutcome()` to derive it.
   */
  recordUse(skillId: string, runId: string, outcome: UseOutcome): void {
    this.requireSkill(skillId);
    if (!PLAIN_ID.test(runId))
      throw new SkillStoreError("INVALID_EVENT", "runId is not a plain id");
    if (!["verified", "refuted", "uncertain"].includes(outcome))
      throw new SkillStoreError("INVALID_EVENT", "unknown outcome");
    this.append({ type: "use", skillId, runId, outcome });
  }

  /**
   * The verified on-disk head and every skill's derived state, read in one pass (so the
   * head and the states always belong together).
   */
  snapshot(): { head: string; skills: SkillState[] } {
    this.sync();
    return { head: this.headDigest, skills: this.derive() };
  }

  /** Every skill with its derived state, in admission order, as on disk now. */
  skills(): SkillState[] {
    return this.snapshot().skills;
  }

  private derive(): SkillState[] {
    const out = new Map<
      string,
      {
        record: SkillRecord;
        admittedSeq: number;
        revoked: boolean;
        uses: { verified: number; refuted: number; uncertain: number };
      }
    >();
    for (const e of this.events) {
      if (e.type === "admit")
        out.set(e.record.skillId, {
          record: e.record,
          admittedSeq: e.seq,
          revoked: false,
          uses: { verified: 0, refuted: 0, uncertain: 0 },
        });
      else {
        const s = out.get(e.skillId);
        if (s === undefined) continue;
        if (e.type === "revoke") s.revoked = true;
        else s.uses[e.outcome] += 1;
      }
    }
    return [...out.values()].map((s) => ({
      record: s.record,
      admittedSeq: s.admittedSeq,
      uses: s.uses,
      status: s.revoked
        ? "revoked"
        : s.uses.refuted >= this.quarantineAfter
          ? "quarantined"
          : "active",
    }));
  }

  /** Only skills that may be served: not revoked, not quarantined. */
  active(): SkillState[] {
    return this.skills().filter((s) => s.status === "active");
  }
}

/** A later use's outcome from that run's gate verdict and grader status. */
export function useOutcome(
  gateVerdict: "verified" | "refuted" | "uncertain",
  gradeStatus: "pass" | "fail" | "ungradable" | null,
): UseOutcome {
  if (gateVerdict === "refuted" || gradeStatus === "fail") return "refuted";
  if (gateVerdict === "verified" && gradeStatus === "pass") return "verified";
  return "uncertain";
}
