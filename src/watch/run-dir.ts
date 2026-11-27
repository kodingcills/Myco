/**
 * Live watch view, track A step 2 (#618, parent TIF-265): follow an R1 pilot run directory,
 * or a corrections A/B stage root, as it runs. It reads only the run's existing durable
 * outputs, as `src/pilot` writes them:
 *
 *  - `pilot-progress.jsonl` (`myco.pilot.header/1`, `myco.pilot.attempt/1`): the runner's
 *    append-only progress file: attempt starts and ends, harness faults, and each decided
 *    trial's arm row (claim, gate call, verdict, acceptance);
 *  - `live-status.json` (`myco.pilot.live-status/1`): the heartbeat, rewritten atomically;
 *  - `attempts.jsonl` (#518, `myco.m2.attempt-event/1`; A/B arms only): the evidence attempt
 *    ledger, cross-checked against the progress file per trial;
 *  - `grades.jsonl` (A/B arms only): the independent grader's rows (status only);
 *  - `trials/<trialKey>/transcript.json`: the agent CLI's output, for the agent's actions.
 *
 * It never opens anything else. In particular it never opens the oracle's inputs or the vault:
 * `vault/`, `trials/<key>/gate-evidence/`, `doc.csv`, `gate-tasks.json`, `mcp.json`.
 *
 * Passive by construction: the JSONL files are tailed by `DecisionLogTail` (`O_RDONLY |
 * O_NOFOLLOW`, never created), and the two whole-file reads go through `readRegular` (same
 * flags, size-capped). A transcript is reached through `resolveListed`, so a symlink planted at
 * any component under the run directory (the agent's trial directory included) is refused.
 * This module has no write call; the static scan in `test/watch/server-security.test.ts`
 * covers it.
 *
 * Redaction by allowlist, the same rule as `events.ts`: every field of a `PilotView` is
 * rebuilt from a closed vocabulary (states, verdicts, `REASON_CODES`, harness classes, claim,
 * grade status, stop codes), a strict pattern (safe ids, ISO timestamps) or a bounded integer.
 * Free text is never carried: not the heartbeat's `lastLog` or `error`, the pid, a fault's
 * `faultMessage`, an arm row's `cause.detail`, digests, the agent's result text or claim text,
 * the gate's claim echo, corrections, evidence, or the grader's reasons and target. An id that
 * contains a host needle (home or temp directory, `/<user>`) is dropped too.
 */
import { join } from "node:path";
import { isSafeId, REASON_CODES } from "../gate/api.ts";
import { DecisionLogTail } from "./decision-log.ts";
import { readRegular, resolveListed } from "./frames.ts";

export const PROGRESS_FILE = "pilot-progress.jsonl";
export const LIVE_STATUS_FILE = "live-status.json";
export const ATTEMPT_LEDGER_FILE = "attempts.jsonl";
export const GRADES_FILE = "grades.jsonl";
export const TRANSCRIPT_FILE = "transcript.json";
export const AB_ARMS = ["on", "off"] as const;
export type WatchArm = (typeof AB_ARMS)[number];

/** The one tool the pilot grants the agent (`GATE_GRANT` in `src/pilot/config.ts`; tested equal). */
export const GATE_TOOL_NAME = "mcp__myco-gate__myco_gate_check";

/** `PILOT_HARNESS_CLASSES` in `src/pilot/ledger.ts` (tested equal). Anything else shows as `other`. */
export const WATCH_HARNESS_CLASSES = [
  "rate-limit",
  "auth",
  "error-result",
  "timeout",
  "crash",
  "spawn-failed",
  "transport-error",
  "billing",
  "usage-limit",
] as const;
/** `StopCode` in `src/pilot/runner.ts`. */
export const WATCH_STOP_CODES = [
  "auth",
  "billing",
  "api-key",
  "repeat-failure",
  "usage-limit",
] as const;
/** `PilotRunResult["status"]` in `src/pilot/runner.ts`. */
export const WATCH_RUN_STATUSES = ["complete", "paused", "incomplete", "halted"] as const;

/** Most trials one view carries (30 pilot trials; an A/B stage has a few dozen per arm). */
export const MAX_TRIALS = 500;
/** Most gate calls shown per trial. */
export const MAX_GATE_CALLS = 64;
/** A heartbeat older than this is shown as stale (the runner rewrites it every 60 s). */
export const DEFAULT_STALE_AFTER_MS = 180_000;

export type TrialState = "running" | "decided" | "harness-fault";
export type Verdict = "verified" | "refuted" | "uncertain";

export interface GateCallView {
  /** The gate's verdict as returned to the agent, or null when no result was recorded. */
  readonly verdict: Verdict | null;
  readonly reasonCodes: readonly string[];
}

/** The agent's actions, from its transcript. Counts and closed names only. */
export interface ActionsView {
  readonly turns: number | null;
  /** Tool calls by closed name: the gate tool, or any other tool. */
  readonly toolCalls: { readonly gate: number; readonly other: number };
  /** Tool uses the CLI refused (`permission_denials`), by the same closed names. */
  readonly denied: { readonly gate: number; readonly other: number };
  /** Each gate call, in order (at most `MAX_GATE_CALLS`). */
  readonly gateCalls: readonly GateCallView[];
}

export interface TrialView {
  readonly arm: WatchArm | null;
  readonly trialKey: string;
  readonly taskId: string | null;
  readonly attempt: number;
  /** The faulted attempt this one re-runs in place, or null. */
  readonly supersedes: string | null;
  readonly state: TrialState;
  /** True when the end was appended on resume for an attempt the runner died in. */
  readonly recovered: boolean;
  /** A harness fault's class (closed), `other` for an unknown one, null otherwise. */
  readonly harnessClass: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly says: "done" | "not-done" | "no-claim" | null;
  readonly gate: {
    readonly called: boolean;
    readonly verdict: Verdict | null;
    readonly unregistrable: boolean;
    readonly corrections: "on" | "off" | null;
  } | null;
  readonly accepted: boolean | null;
  readonly causeKind: "agent" | "oracle" | "harness" | null;
  readonly wallClockS: number | null;
  /** The independent grader's status (A/B), or null when no grade row exists yet. */
  readonly grade: "pass" | "fail" | "ungradable" | null;
  /**
   * Does #518's attempt ledger agree with the progress file on this trial (a start, and an end
   * with the same outcome and class once the trial ended)? Null where the run has no ledger.
   */
  readonly ledger: "agrees" | "behind" | "disagrees" | null;
  readonly actions: ActionsView | null;
}

export interface LiveView {
  readonly runner: "r1-pilot" | "corrections-ab" | null;
  readonly state: "running" | "finished" | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  /** The heartbeat is older than the stale limit while the run says it is running. */
  readonly stale: boolean;
  readonly exitCode: number | null;
  readonly status: (typeof WATCH_RUN_STATUSES)[number] | null;
  readonly stopCode: (typeof WATCH_STOP_CODES)[number] | null;
}

export interface PilotView {
  readonly layout: "single" | "ab";
  /** From the progress header(s): true if any arm says simulated. Null before a header. */
  readonly simulated: boolean | null;
  readonly progressPresent: boolean;
  readonly live: LiveView | null;
  readonly trials: readonly TrialView[];
  readonly counts: {
    readonly running: number;
    readonly decided: number;
    readonly faulted: number;
    readonly accepted: number;
  };
  /** Trials beyond `MAX_TRIALS`, left out. */
  readonly omitted: number;
  /** Lines or fields that were refused (malformed, unknown schema, an unsafe id). */
  readonly skipped: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const CODES: ReadonlySet<string> = new Set(REASON_CODES);
const HARNESS: ReadonlySet<string> = new Set(WATCH_HARNESS_CLASSES);
const VERDICTS: ReadonlySet<string> = new Set(["verified", "refuted", "uncertain"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(value: unknown): string | null {
  return typeof value === "string" && ISO.test(value) ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function count(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

function verdict(value: unknown): Verdict | null {
  return typeof value === "string" && VERDICTS.has(value) ? (value as Verdict) : null;
}

function harnessClass(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && HARNESS.has(value) ? value : "other";
}

/** Decode one transcript into closed counts. Never throws; null if it is not a transcript. */
export function projectTranscript(bytes: Buffer): ActionsView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const messages = Array.isArray(parsed)
    ? parsed.filter(isRecord)
    : isRecord(parsed)
      ? [parsed]
      : [];
  if (messages.length === 0) return null;
  let turns: number | null = null;
  const toolCalls = { gate: 0, other: 0 };
  const denied = { gate: 0, other: 0 };
  const gateIds: (string | null)[] = [];
  const results = new Map<string, GateCallView>();
  for (const m of messages) {
    if (m.type === "result") {
      turns = count(m.num_turns, 100_000) ?? turns;
      if (Array.isArray(m.permission_denials))
        for (const d of m.permission_denials)
          if (isRecord(d)) denied[d.tool_name === GATE_TOOL_NAME ? "gate" : "other"] += 1;
    }
    const content = isRecord(m.message) ? m.message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (m.type === "assistant" && part.type === "tool_use") {
        const isGate = part.name === GATE_TOOL_NAME;
        toolCalls[isGate ? "gate" : "other"] += 1;
        if (isGate) gateIds.push(typeof part.id === "string" ? part.id : null);
      } else if (m.type === "user" && part.type === "tool_result") {
        if (typeof part.tool_use_id === "string")
          results.set(part.tool_use_id, gateResultOf(part.content));
      }
    }
  }
  const gateCalls = gateIds.slice(0, MAX_GATE_CALLS).map(
    (id): GateCallView =>
      (id === null ? undefined : results.get(id)) ?? {
        verdict: null,
        reasonCodes: [],
      },
  );
  return { turns, toolCalls, denied, gateCalls };
}

/** The gate's MCP result, as the agent saw it: verdict and reason codes only. */
function gateResultOf(content: unknown): GateCallView {
  const texts: string[] = [];
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content))
    for (const c of content) if (isRecord(c) && typeof c.text === "string") texts.push(c.text);
  for (const text of texts) {
    let r: unknown;
    try {
      r = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(r)) continue;
    const codes = Array.isArray(r.reasonCodes)
      ? r.reasonCodes.filter((c): c is string => typeof c === "string" && CODES.has(c))
      : [];
    return { verdict: verdict(r.verdict), reasonCodes: [...new Set(codes)] };
  }
  return { verdict: null, reasonCodes: [] };
}

interface Attempt {
  start: Record<string, unknown>;
  end: Record<string, unknown> | null;
}

/** One arm directory's tails. */
class ArmReader {
  readonly progress: DecisionLogTail;
  readonly ledger: DecisionLogTail;
  readonly grades: DecisionLogTail;
  /** Transcripts of ended attempts, read once (the runner writes them before the end line). */
  private readonly actions = new Map<string, ActionsView | null>();

  constructor(
    readonly dir: string,
    readonly arm: WatchArm | null,
  ) {
    this.progress = new DecisionLogTail(join(dir, PROGRESS_FILE));
    this.ledger = new DecisionLogTail(join(dir, ATTEMPT_LEDGER_FILE));
    this.grades = new DecisionLogTail(join(dir, GRADES_FILE));
  }

  poll(): void {
    this.progress.poll();
    this.ledger.poll();
    this.grades.poll();
  }

  actionsOf(trialKey: string, ended: boolean): ActionsView | null {
    if (this.actions.has(trialKey)) return this.actions.get(trialKey) ?? null;
    const path = resolveListed(this.dir, `trials/${trialKey}/${TRANSCRIPT_FILE}`);
    const bytes = path === null ? null : readRegular(path);
    const view = bytes === null ? null : projectTranscript(bytes);
    if (ended) this.actions.set(trialKey, view);
    return view;
  }
}

export interface PilotSourceOptions {
  /** A heartbeat older than this, on a running run, is stale. Default 180 s. */
  readonly staleAfterMs?: number;
  readonly now?: () => number;
  /** Host needles (`hostNeedles()`); an id containing one is dropped. */
  readonly needles?: readonly string[];
}

export interface PilotRunSource {
  /**
   * Re-read whatever was appended and return the current view. Malformed input is skipped,
   * never thrown; an unexpected I/O error throws, and the server keeps its last good state.
   */
  poll(): PilotView;
}

/**
 * A source over one run directory: an R1 pilot directory (or one A/B arm), or an A/B stage
 * root whose arms are `on/` and `off/`. The layout is re-detected on every poll, so a stage
 * root whose arm directories do not exist yet is followed once they appear.
 */
export function pilotRunSource(dir: string, opts: PilotSourceOptions = {}): PilotRunSource {
  const now = opts.now ?? Date.now;
  const staleAfter = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const needles = opts.needles ?? [];
  const single = new ArmReader(dir, null);
  const arms = AB_ARMS.map((arm) => new ArmReader(join(dir, arm), arm));
  const safe = (value: unknown): string | null =>
    typeof value === "string" && isSafeId(value) && !needles.some((n) => value.includes(n))
      ? value
      : null;

  const liveOf = (): LiveView | null => {
    const bytes = readRegular(join(dir, LIVE_STATUS_FILE));
    if (bytes === null || bytes.length > 1024 * 1024) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch {
      return null;
    }
    if (!isRecord(raw) || raw.schema !== "myco.pilot.live-status/1") return null;
    const state = oneOf(raw.state, ["running", "finished"] as const);
    const updatedAt = iso(raw.updatedAt);
    const result = isRecord(raw.result) ? raw.result : {};
    const age = updatedAt === null ? Number.POSITIVE_INFINITY : now() - Date.parse(updatedAt);
    return {
      runner: oneOf(raw.runner, ["r1-pilot", "corrections-ab"] as const),
      state,
      startedAt: iso(raw.startedAt),
      updatedAt,
      stale: state === "running" && age > staleAfter,
      exitCode: count(raw.exitCode, 255),
      status: oneOf(result.status, WATCH_RUN_STATUSES),
      stopCode: oneOf(result.stopCode, WATCH_STOP_CODES),
    };
  };

  const trialsOf = (
    reader: ArmReader,
  ): { trials: TrialView[]; skipped: number; simulated: boolean | null; present: boolean } => {
    const log = reader.progress.snapshot();
    let skipped = log.malformed;
    let simulated: boolean | null = null;
    const attempts = new Map<string, Attempt>();
    for (const line of log.records) {
      if (!isRecord(line)) {
        skipped += 1;
        continue;
      }
      if (line.schema === "myco.pilot.header/1") {
        if (typeof line.simulated === "boolean") simulated = line.simulated;
        continue;
      }
      if (line.schema !== "myco.pilot.attempt/1") {
        skipped += 1;
        continue;
      }
      if (line.event === "torn-previous-line") continue;
      const key = safe(line.trialKey);
      if (key === null) {
        skipped += 1;
        continue;
      }
      if (line.event === "start" && !attempts.has(key))
        attempts.set(key, { start: line, end: null });
      else if (line.event === "end" && attempts.get(key)?.end === null)
        (attempts.get(key) as Attempt).end = line;
      else skipped += 1;
    }

    // #518's ledger, per trial: did it record a start, and the end (outcome, class)?
    const ledgerLog = reader.ledger.snapshot();
    const ledger = new Map<string, { start: boolean; end: Record<string, unknown> | null }>();
    for (const e of ledgerLog.records) {
      if (!isRecord(e) || e.schema !== "myco.m2.attempt-event/1") continue;
      const key = safe(e.trialKey);
      if (key === null) continue;
      const entry = ledger.get(key) ?? { start: false, end: null };
      if (e.kind === "start") entry.start = true;
      if (e.kind === "end") entry.end = e;
      ledger.set(key, entry);
    }
    const grades = new Map<string, TrialView["grade"]>();
    for (const g of reader.grades.snapshot().records) {
      if (!isRecord(g) || g.schema !== "myco.benchmark.grade-row/1") continue;
      const key = safe(g.trialKey);
      if (key !== null) grades.set(key, oneOf(g.status, ["pass", "fail", "ungradable"] as const));
    }

    const trials: TrialView[] = [];
    for (const [trialKey, { start, end }] of attempts) {
      const outcome = end === null ? null : end.outcome;
      const state: TrialState =
        end === null ? "running" : outcome === "decided" ? "decided" : "harness-fault";
      const row = end !== null && isRecord(end.armRow) ? end.armRow : null;
      const gate = row !== null && isRecord(row.gate) ? row.gate : null;
      const cause = row !== null && isRecord(row.cause) ? row.cause : null;
      const cost = row !== null && isRecord(row.cost) ? row.cost : null;
      const wall = cost?.wallClockS;
      const cls = end === null ? null : harnessClass(end.harnessClass);
      let ledgerState: TrialView["ledger"] = null;
      if (ledgerLog.present) {
        const l = ledger.get(trialKey);
        if (l === undefined || !l.start) ledgerState = "behind";
        else if (end === null) ledgerState = l.end === null ? "agrees" : "disagrees";
        else if (l.end === null) ledgerState = "behind";
        else {
          const want = state === "decided" ? "completed" : "harness-fault";
          const sameClass = state === "decided" || harnessClass(l.end.harnessClass) === cls;
          ledgerState = l.end.outcome === want && sameClass ? "agrees" : "disagrees";
        }
      }
      trials.push({
        arm: reader.arm,
        trialKey,
        taskId: safe(start.taskId),
        attempt: count(start.attempt, 1000) ?? 0,
        supersedes: safe(start.supersedes),
        state,
        recovered: end?.recovered === true,
        harnessClass: cls,
        startedAt: iso(start.at),
        endedAt: end === null ? null : iso(end.at),
        says: row === null ? null : oneOf(row.claim, ["done", "not-done", "no-claim"] as const),
        gate:
          gate === null
            ? null
            : {
                called: gate.called === true,
                verdict: verdict(gate.verdict),
                unregistrable: gate.unregistrable === true,
                corrections: oneOf(gate.corrections, ["on", "off"] as const),
              },
        accepted:
          row === null ? null : row.accepted === true && verdict(gate?.verdict) === "verified",
        causeKind:
          cause === null ? null : oneOf(cause.kind, ["agent", "oracle", "harness"] as const),
        wallClockS:
          typeof wall === "number" && Number.isFinite(wall) && wall >= 0 && wall < 1e7
            ? Math.round(wall * 10) / 10
            : null,
        grade: grades.get(trialKey) ?? null,
        ledger: ledgerState,
        actions: reader.actionsOf(trialKey, end !== null),
      });
    }
    return { trials, skipped, simulated, present: log.present };
  };

  const poll = (): PilotView => {
    single.poll();
    const singlePresent = single.progress.snapshot().present;
    for (const a of arms) a.poll();
    const abPresent = arms.some((a) => a.progress.snapshot().present);
    const readers = singlePresent || !abPresent ? [single] : arms;
    let skipped = 0;
    let simulated: boolean | null = null;
    let present = false;
    const all: TrialView[] = [];
    for (const r of readers) {
      const t = trialsOf(r);
      skipped += t.skipped;
      present ||= t.present;
      if (t.simulated !== null) simulated = (simulated ?? false) || t.simulated;
      all.push(...t.trials);
    }
    const omitted = Math.max(0, all.length - MAX_TRIALS);
    const trials = omitted === 0 ? all : all.slice(omitted);
    return {
      layout: readers === arms ? "ab" : "single",
      simulated,
      progressPresent: present,
      live: liveOf(),
      trials,
      counts: {
        running: all.filter((t) => t.state === "running").length,
        decided: all.filter((t) => t.state === "decided").length,
        faulted: all.filter((t) => t.state === "harness-fault").length,
        accepted: all.filter((t) => t.accepted === true).length,
      },
      omitted,
      skipped,
    };
  };
  return { poll };
}
