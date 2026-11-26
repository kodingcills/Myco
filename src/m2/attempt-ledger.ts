/**
 * The append-only attempt ledger (TIF-274; lead ruling 2026-11-26 14:35Z). A pack's rows and
 * its superseded attempts are what the operator chose to disclose; this ledger is what
 * happened. The runner appends a `start` event when an attempt begins and an `end` event when
 * it ends (`completed`, or `harness-fault` with its harness class), to `attempts.jsonl`, as
 * the attempt runs. Each event names the sha256 of the previous event's canonical JSON (the
 * parsed, key-sorted event, not its raw bytes: whitespace or key order is not evidence), and
 * the pack's manifest pins the head (event count and last hash).
 *
 * THREAT MODEL (lead ruling on #518 D3): the adversary is the checked agent and any
 * guest-side process; the harness that writes packs is trusted. Against that adversary, and
 * against accidental drops or edits by the harness, the ledger is TAMPER-EVIDENT: editing,
 * deleting, inserting or reordering an event breaks the chain; cutting the tail no longer
 * matches the pin; and the runner also appends each head to an EXTERNAL ANCHOR outside the
 * pack and outside anything the agent or the guest can reach (`anchorPathFor`; the writer
 * refuses to place the ledger or the anchor in a forbidden root), so a ledger regenerated and
 * re-pinned inside the pack no longer agrees with its anchor. It is NOT protection against a
 * malicious pack author, who controls the harness, the pack and the anchor alike. No keyed
 * chain or published anchor here (TO FILE on TIF-274).
 *
 * The evidence check (`src/m2/evidence.ts`) then cross-checks the ledger against the pack:
 *  - every attempt in the ledger is disclosed (a pack row, or a superseded attempt), with the
 *    same task and arm, and every disclosed trial has exactly one start and one end;
 *  - a disclosed harness fault (a row whose cause is the harness) matches a recorded
 *    `harness-fault` end event with the same class, and a recorded harness fault is never
 *    disclosed as anything else;
 *  - a superseded attempt ends before the trial that replaced it starts.
 *
 * What it cannot prove: that the trusted harness logged honestly (it moves the trust from
 * "the operator disclosed every attempt" to "the runner logged every attempt as it ran", which
 * is code we review). The ledger records task, arm and outcome only: a row's verdict or
 * document is not bound here.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { m2AttemptAnchorSchema, m2AttemptEventSchema } from "../../schemas/m2-evidence.ts";
import { validateSchema } from "../../schemas/validate.ts";
import type { Arm } from "../benchmark/check.ts";

export const ATTEMPT_EVENT_SCHEMA = "myco.m2.attempt-event/1" as const;
/** The `prevSha256` of the first event. */
export const GENESIS_SHA256 = "0".repeat(64);

export interface AttemptEvent {
  readonly schema: typeof ATTEMPT_EVENT_SCHEMA;
  readonly seq: number;
  readonly prevSha256: string;
  readonly kind: "start" | "end";
  readonly trialKey: string;
  readonly taskId: string;
  readonly arm: Arm;
  readonly outcome?: "completed" | "harness-fault";
  readonly harnessClass?: string;
}

export interface LedgerHead {
  readonly events: number;
  readonly headSha256: string;
}

/** JSON with object keys sorted, so the hash does not depend on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function eventSha256(event: AttemptEvent): string {
  return createHash("sha256").update(canonical(event)).digest("hex");
}

/** An end event's own rule: an outcome, and a harness class exactly on a harness fault. */
function shapeErrors(e: AttemptEvent): string[] {
  const out: string[] = [];
  if (e.kind === "start" && (e.outcome !== undefined || e.harnessClass !== undefined))
    out.push("a start event has no outcome or harness class");
  if (e.kind === "end") {
    if (e.outcome === undefined) out.push("an end event has an outcome");
    if ((e.outcome === "harness-fault") !== (e.harnessClass !== undefined))
      out.push("an end event has a harness class exactly when its outcome is harness-fault");
  }
  return out;
}

/**
 * Verify the chain: every line schema-valid and well formed, `seq` = its index, and
 * `prevSha256` = the hash of the event before it. Returns the valid events (up to the first
 * break), the head, and every error.
 */
export function verifyAttemptLedger(lines: readonly unknown[]): {
  readonly events: readonly AttemptEvent[];
  readonly head: LedgerHead;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  const events: AttemptEvent[] = [];
  let prev = GENESIS_SHA256;
  for (let i = 0; i < lines.length; i++) {
    const issues = validateSchema(lines[i], m2AttemptEventSchema);
    if (issues.length > 0) {
      errors.push(...issues.map((s) => `attempt event ${i}: ${s.path} ${s.message}`));
      break;
    }
    const e = lines[i] as AttemptEvent;
    for (const m of shapeErrors(e)) errors.push(`attempt event ${i}: ${m}`);
    if (e.seq !== i) {
      errors.push(`attempt event ${i}: seq ${e.seq}, expected ${i} (a gap or a reordering)`);
      break;
    }
    if (e.prevSha256 !== prev) {
      errors.push(
        `attempt event ${i}: the hash chain breaks (an edited, removed or reordered event)`,
      );
      break;
    }
    events.push(e);
    prev = eventSha256(e);
  }
  return { events, head: { events: events.length, headSha256: prev }, errors };
}

/** One trial the pack discloses: a row in `arm.jsonl`, or a superseded attempt. */
export interface DisclosedAttempt {
  readonly trialKey: string;
  readonly taskId: string;
  readonly arm: Arm;
  /** The harness class the pack claims (its trial-ops row), or null when not a harness fault. */
  readonly harnessClass: string | null;
  /** For a superseded attempt: the trial that replaced it. */
  readonly replacedBy?: string;
}

/**
 * Cross-check a verified ledger against what the pack discloses, and against the manifest's
 * head pin. Returns errors; empty means every attempt is accounted for.
 */
export function crossCheckAttempts(
  events: readonly AttemptEvent[],
  disclosed: readonly DisclosedAttempt[],
  pin: LedgerHead | undefined,
  head: LedgerHead,
): string[] {
  const errors: string[] = [];
  if (pin === undefined) errors.push("pack.json pins no attempt-ledger head (attempts)");
  else if (pin.events !== head.events || pin.headSha256 !== head.headSha256)
    errors.push(
      `the attempt ledger's head (${head.events} events, ${head.headSha256.slice(0, 12)}) is not the pinned one (${pin.events} events, ${pin.headSha256.slice(0, 12)}): truncated or rewritten`,
    );

  const starts = new Map<string, number>();
  const ends = new Map<string, AttemptEvent & { at: number }>();
  const startOf = new Map<string, AttemptEvent>();
  events.forEach((e, at) => {
    if (e.kind === "start") {
      if (starts.has(e.trialKey)) errors.push(`attempt ${e.trialKey}: started twice`);
      starts.set(e.trialKey, at);
      if (!startOf.has(e.trialKey)) startOf.set(e.trialKey, e);
    } else {
      const start = startOf.get(e.trialKey);
      if (start === undefined) errors.push(`attempt ${e.trialKey}: ended before it started`);
      else if (start.taskId !== e.taskId || start.arm !== e.arm)
        errors.push(`attempt ${e.trialKey}: its end names another task or arm than its start`);
      // A second end is refused, and the first is kept, so a later end cannot overwrite the
      // recorded outcome (#518 round 1, D1).
      if (ends.has(e.trialKey)) errors.push(`attempt ${e.trialKey}: ended twice`);
      else ends.set(e.trialKey, { ...e, at });
    }
  });
  for (const key of starts.keys())
    if (!ends.has(key)) errors.push(`attempt ${key}: started and never ended`);

  const byKey = new Map(disclosed.map((d) => [d.trialKey, d]));
  const startEvent = new Map(events.filter((e) => e.kind === "start").map((e) => [e.trialKey, e]));
  for (const key of starts.keys())
    if (!byKey.has(key))
      errors.push(
        `attempt ${key}: in the ledger but not disclosed (neither a pack row nor superseded)`,
      );
  for (const d of disclosed) {
    const s = startEvent.get(d.trialKey);
    const end = ends.get(d.trialKey);
    if (s === undefined || end === undefined) {
      errors.push(
        `${d.trialKey}: disclosed, but the attempt ledger has no complete attempt for it`,
      );
      continue;
    }
    if (s.taskId !== d.taskId || s.arm !== d.arm)
      errors.push(
        `${d.trialKey}: the ledger recorded task ${s.taskId} on ${s.arm}, the pack says ${d.taskId} on ${d.arm}`,
      );
    const recorded = end.outcome === "harness-fault" ? (end.harnessClass ?? null) : null;
    if (d.harnessClass !== recorded)
      errors.push(
        d.harnessClass === null
          ? `${d.trialKey}: the ledger recorded a harness fault (${recorded}), the pack does not disclose one`
          : recorded === null
            ? `${d.trialKey}: the pack claims a harness fault (${d.harnessClass}) the ledger never recorded`
            : `${d.trialKey}: the pack claims harness class ${d.harnessClass}, the ledger recorded ${recorded}`,
      );
    if (d.replacedBy !== undefined) {
      const next = starts.get(d.replacedBy);
      if (next !== undefined && next < end.at)
        errors.push(`${d.trialKey}: its replacement ${d.replacedBy} started before it ended`);
    }
  }
  return errors;
}

/**
 * The runner's writer: appends one event per call to an append-only JSONL file. Resumes an
 * existing file only after verifying its chain, and refuses an end without a start or a
 * second start of the same attempt.
 */
export class AttemptLedgerWriter {
  readonly #path: string;
  #seq = 0;
  #prev = GENESIS_SHA256;
  readonly #open = new Map<string, { taskId: string; arm: Arm }>();
  readonly #seen = new Set<string>();
  readonly #anchorPath: string | undefined;

  /**
   * `anchorPath`: the external anchor, appended with the head at every attempt end.
   * `forbiddenRoots`: directories the agent or the guest can reach (the agent's workspace,
   * anything shared with the guest). The ledger and the anchor are refused inside any of them.
   */
  constructor(
    path: string,
    opts: { readonly anchorPath?: string; readonly forbiddenRoots?: readonly string[] } = {},
  ) {
    this.#path = path;
    this.#anchorPath = opts.anchorPath;
    for (const target of [path, ...(opts.anchorPath === undefined ? [] : [opts.anchorPath])])
      for (const root of opts.forbiddenRoots ?? [])
        if (isInside(target, root))
          throw new Error(
            `refusing to write ${basename(target)} inside ${root}: the agent or the guest can reach it`,
          );
    if (opts.anchorPath !== undefined) mkdirSync(dirname(opts.anchorPath), { recursive: true });
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l, i) => {
          try {
            return JSON.parse(l) as unknown;
          } catch {
            // A torn line (for example a crash mid-append) is a broken ledger: refuse clearly.
            throw new Error(
              `refusing to append to a broken attempt ledger: line ${i + 1} is not JSON (a torn write?)`,
            );
          }
        });
      const v = verifyAttemptLedger(lines);
      if (v.errors.length > 0)
        throw new Error(`refusing to append to a broken attempt ledger: ${v.errors[0]}`);
      for (const e of v.events) {
        if (e.kind === "start") {
          this.#open.set(e.trialKey, { taskId: e.taskId, arm: e.arm });
          this.#seen.add(e.trialKey);
        } else this.#open.delete(e.trialKey);
      }
      this.#seq = v.head.events;
      this.#prev = v.head.headSha256;
    }
  }

  #append(e: Omit<AttemptEvent, "schema" | "seq" | "prevSha256">): void {
    const event: AttemptEvent = {
      schema: ATTEMPT_EVENT_SCHEMA,
      seq: this.#seq,
      prevSha256: this.#prev,
      ...e,
    };
    appendFileSync(this.#path, `${JSON.stringify(event)}\n`, { flag: "a" });
    this.#seq++;
    this.#prev = eventSha256(event);
  }

  start(a: { trialKey: string; taskId: string; arm: Arm }): void {
    if (this.#seen.has(a.trialKey)) throw new Error(`attempt ${a.trialKey} already started`);
    this.#seen.add(a.trialKey);
    this.#open.set(a.trialKey, { taskId: a.taskId, arm: a.arm });
    this.#append({ kind: "start", ...a });
  }

  end(
    trialKey: string,
    result: { outcome: "completed" } | { outcome: "harness-fault"; harnessClass: string },
  ): void {
    const open = this.#open.get(trialKey);
    if (open === undefined) throw new Error(`attempt ${trialKey} is not running`);
    this.#open.delete(trialKey);
    this.#append({ kind: "end", trialKey, ...open, ...result });
    // The external anchor: the head as of this attempt's end, outside the pack.
    if (this.#anchorPath !== undefined) {
      const line: AnchorEntry = { schema: ANCHOR_SCHEMA, ...this.head() };
      appendFileSync(this.#anchorPath, `${JSON.stringify(line)}\n`, { flag: "a" });
    }
  }

  head(): LedgerHead {
    return { events: this.#seq, headSha256: this.#prev };
  }
}

export const ANCHOR_SCHEMA = "myco.m2.attempt-anchor/1" as const;

/** One anchored head: the ledger as of an attempt's end. */
export interface AnchorEntry extends LedgerHead {
  readonly schema: typeof ANCHOR_SCHEMA;
}

/**
 * Where a pack's external anchor lives: `<pack parent>/attempt-anchors/<pack name>.jsonl`,
 * outside the pack directory (and not an `m2-*` directory, so it is not mistaken for a pack).
 * The anchor belongs to its pack: the harness deletes (or moves) it together with the pack, and
 * a pack copied elsewhere without its anchor is refused as R1 evidence ("anchor missing").
 */
export function anchorPathFor(packDir: string): string {
  return join(dirname(resolve(packDir)), "attempt-anchors", `${basename(resolve(packDir))}.jsonl`);
}

/**
 * Whether `target` resolves inside `root`, following symlinks on the longest existing prefix of
 * each path (so a symlink into a forbidden root is caught even when the directories below it
 * do not exist yet). Limits, stated: it compares realpaths, so a bind mount or a hard-linked
 * directory that aliases a forbidden root under another path, a symlink created after this
 * check, and case-insensitive aliases of the same directory on a case-insensitive file system
 * are not detected. The harness is trusted (threat model above); this guards against a wrong
 * path, not a hostile host.
 */
function isInside(target: string, root: string): boolean {
  const real = (p: string): string => {
    let at = resolve(p);
    const rest: string[] = [];
    while (!existsSync(at) && dirname(at) !== at) {
      rest.unshift(basename(at));
      at = dirname(at);
    }
    return join(existsSync(at) ? realpathSync(at) : at, ...rest);
  };
  const rel = relative(real(root), real(target));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Check the external anchor against the verified ledger and the pack's pin: every anchored
 * head must be the ledger's own chain head at that event count (counts strictly increasing),
 * and the last must equal both the ledger's head and the pin. A ledger rewritten and re-pinned
 * inside the pack changes those intermediate heads, so it no longer agrees with its anchor.
 */
export function verifyAnchor(
  lines: readonly unknown[],
  events: readonly AttemptEvent[],
  pin: LedgerHead | undefined,
): string[] {
  const errors: string[] = [];
  if (lines.length === 0) return ["the external attempt anchor is empty"];
  const ends = events.filter((e) => e.kind === "end").length;
  if (lines.length !== ends)
    errors.push(`the anchor has ${lines.length} heads, the ledger has ${ends} attempt ends`);
  const headAt = [GENESIS_SHA256];
  for (const e of events) headAt.push(eventSha256(e));
  let last: AnchorEntry | undefined;
  for (let i = 0; i < lines.length; i++) {
    const issues = validateSchema(lines[i], m2AttemptAnchorSchema);
    if (issues.length > 0) {
      errors.push(...issues.map((s) => `anchor line ${i}: ${s.path} ${s.message}`));
      return errors;
    }
    const a = lines[i] as AnchorEntry;
    if (last !== undefined && a.events <= last.events)
      errors.push(`anchor line ${i}: ${a.events} events does not follow ${last.events}`);
    if (a.events <= events.length && events[a.events - 1]?.kind !== "end")
      errors.push(`anchor line ${i}: ${a.events} events does not end on an attempt end`);
    if (a.events > events.length || headAt[a.events] !== a.headSha256)
      errors.push(
        `anchor line ${i}: the ledger's head at ${a.events} events is not the anchored one (rewritten or truncated)`,
      );
    last = a;
  }
  if (last !== undefined) {
    const head = { events: events.length, headSha256: headAt[events.length] };
    if (last.events !== head.events || last.headSha256 !== head.headSha256)
      errors.push("the last anchored head is not the ledger's head");
    if (pin !== undefined && (pin.events !== last.events || pin.headSha256 !== last.headSha256))
      errors.push("the pack's pinned head is not the last anchored head");
  }
  return errors;
}
