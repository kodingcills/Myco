/**
 * The pilot's host-side, append-only attempt ledger (`<out>/attempts.jsonl`).
 *
 * Every attempt is written twice: a `start` line before the agent is launched and an `end`
 * line after the trial is decided or faulted. Lines are only ever appended (`appendFileSync`);
 * nothing is rewritten, so the ledger is the history. Resume reads it back:
 *
 *  - a trial with a `decided` end is done and is skipped (never re-run, never a second row);
 *  - a trial whose last attempt ended in a harness fault is re-run in place as the next
 *    attempt, whose `start` names the faulted attempt in `supersedes` (the topped-up-run
 *    ruling, lead 2026-11-26 12:22Z: re-run in place, the faulted attempt kept and linked);
 *  - a `start` with no `end` is an attempt the runner crashed in. On resume it is closed
 *    with an appended `end` (`harness-fault`, class `crash`, `recovered: true`) before
 *    anything else runs, and then re-run like any harness fault;
 *  - a torn last line (the process died mid-write, no trailing newline) is closed by an
 *    appended `torn-previous-line` marker; the torn bytes stay where they are.
 *
 * The first line is a header with the config's sha256 and whether the run is simulated; a
 * resume with a different config or mode is refused (a changed plan is a new run directory).
 * Loading fails closed on anything else: a duplicate start or end, an end with no start, a
 * second decided attempt for a trial, an attempt numbered out of order, a broken link.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { BenchmarkArmRow } from "../benchmark/check.ts";
import type { CostEstimate } from "./cost.ts";

export const HEADER_SCHEMA = "myco.pilot.header/1" as const;
export const ATTEMPT_SCHEMA = "myco.pilot.attempt/1" as const;

/** Harness faults the pilot records. Only these may be re-run; agent outcomes never are. */
export const PILOT_HARNESS_CLASSES = [
  "rate-limit",
  "timeout",
  "crash",
  "spawn-failed",
  "transport-error",
] as const;
export type PilotHarnessClass = (typeof PILOT_HARNESS_CLASSES)[number];

export interface HeaderLine {
  readonly schema: typeof HEADER_SCHEMA;
  readonly configSha256: string;
  readonly simulated: boolean;
  readonly plannerModelId: string;
}

export interface StartLine {
  readonly schema: typeof ATTEMPT_SCHEMA;
  readonly event: "start";
  readonly taskId: string;
  readonly attempt: number;
  readonly trialKey: string;
  readonly runId: string;
  /** The faulted attempt this one replaces in place, or null for a first attempt. */
  readonly supersedes: string | null;
  readonly at: string;
}

export interface EndLine {
  readonly schema: typeof ATTEMPT_SCHEMA;
  readonly event: "end";
  readonly trialKey: string;
  readonly outcome: "decided" | "harness-fault";
  readonly harnessClass: PilotHarnessClass | null;
  /** True when the end was appended on resume for an attempt the runner crashed in. */
  readonly recovered: boolean;
  readonly armRow: BenchmarkArmRow | null;
  readonly cost: CostEstimate | null;
  readonly at: string;
}

interface TornLine {
  readonly schema: typeof ATTEMPT_SCHEMA;
  readonly event: "torn-previous-line";
  readonly at: string;
}

export interface AttemptRecord {
  readonly start: StartLine;
  readonly end: EndLine | null;
}

export interface LedgerState {
  readonly header: HeaderLine | null;
  /** Attempts by task id, in attempt order. */
  readonly byTask: ReadonlyMap<string, readonly AttemptRecord[]>;
  /** The file ends mid-line (a torn write); the next append must close it first. */
  readonly torn: boolean;
}

export const ATTEMPTS_FILE = "attempts.jsonl";

export function loadLedger(path: string): LedgerState {
  if (!existsSync(path)) return { header: null, byTask: new Map(), torn: false };
  const text = readFileSync(path, "utf8");
  const torn = text.length > 0 && !text.endsWith("\n");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let header: HeaderLine | null = null;
  const byTask = new Map<string, AttemptRecord[]>();
  const byKey = new Map<string, { task: string; index: number }>();
  const fail = (i: number, why: string): never => {
    throw new Error(`${path}:${i + 1}: ${why}`);
  };
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i] as string);
    } catch {
      const last = i === lines.length - 1;
      const next = lines[i + 1];
      const closed = next?.includes('"event":"torn-previous-line"') === true;
      if ((last && torn) || closed) continue; // A torn write, kept as is.
      fail(i, "malformed line");
    }
    const line = parsed as Record<string, unknown>;
    if (i === 0 || (header === null && line.schema === HEADER_SCHEMA)) {
      if (line.schema !== HEADER_SCHEMA || i !== 0) fail(i, "the first line must be the header");
      header = line as unknown as HeaderLine;
      continue;
    }
    if (line.schema === HEADER_SCHEMA) fail(i, "a second header");
    if (line.schema !== ATTEMPT_SCHEMA) fail(i, `unknown schema ${String(line.schema)}`);
    if (line.event === "torn-previous-line") continue;
    if (line.event === "start") {
      const s = line as unknown as StartLine;
      if (byKey.has(s.trialKey)) fail(i, `duplicate start for ${s.trialKey}`);
      const list = byTask.get(s.taskId) ?? [];
      const prev = list[list.length - 1];
      if (s.attempt !== list.length + 1)
        fail(i, `${s.trialKey}: attempt ${s.attempt}, expected ${list.length + 1}`);
      if (prev !== undefined) {
        if (prev.end === null)
          fail(i, `${s.trialKey}: started before ${prev.start.trialKey} ended`);
        if (prev.end?.outcome !== "harness-fault")
          fail(i, `${s.taskId}: a new attempt after a decided one (agent outcomes are final)`);
        if (s.supersedes !== prev.start.trialKey)
          fail(i, `${s.trialKey}: supersedes ${String(s.supersedes)}, not ${prev.start.trialKey}`);
      } else if (s.supersedes !== null)
        fail(i, `${s.trialKey}: a first attempt supersedes nothing`);
      list.push({ start: s, end: null });
      byTask.set(s.taskId, list);
      byKey.set(s.trialKey, { task: s.taskId, index: list.length - 1 });
      continue;
    }
    if (line.event === "end") {
      const e = line as unknown as EndLine;
      const at = byKey.get(e.trialKey);
      if (at === undefined) fail(i, `end for ${e.trialKey} with no start`);
      const list = byTask.get((at as { task: string }).task) as AttemptRecord[];
      const idx = (at as { index: number }).index;
      const rec = list[idx] as AttemptRecord;
      if (rec.end !== null) fail(i, `duplicate end for ${e.trialKey}`);
      if (e.outcome === "harness-fault" && e.harnessClass === null)
        fail(i, `${e.trialKey}: a harness fault needs a class`);
      if (e.outcome === "decided" && (e.armRow === null || e.harnessClass !== null))
        fail(i, `${e.trialKey}: a decided attempt carries its arm row and no harness class`);
      list[idx] = { start: rec.start, end: e };
      continue;
    }
    fail(i, `unknown event ${String(line.event)}`);
  }
  return { header, byTask, torn };
}

/** Append one line (closing a torn last line first, never rewriting it). */
function append(path: string, state: { torn: boolean }, value: unknown): void {
  if (state.torn) {
    const marker: TornLine = {
      schema: ATTEMPT_SCHEMA,
      event: "torn-previous-line",
      at: new Date().toISOString(),
    };
    appendFileSync(path, `\n${JSON.stringify(marker)}\n`);
    state.torn = false;
  }
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

/** The writer: append-only, one per runner process (the runner holds a lock file). */
export class AttemptLedger {
  readonly path: string;
  private readonly state: { torn: boolean };

  constructor(path: string, torn: boolean) {
    this.path = path;
    this.state = { torn };
  }

  header(h: Omit<HeaderLine, "schema">): void {
    append(this.path, this.state, { schema: HEADER_SCHEMA, ...h });
  }

  start(s: Omit<StartLine, "schema" | "event" | "at">): void {
    append(this.path, this.state, {
      schema: ATTEMPT_SCHEMA,
      event: "start",
      ...s,
      at: new Date().toISOString(),
    });
  }

  end(e: Omit<EndLine, "schema" | "event" | "at">): void {
    append(this.path, this.state, {
      schema: ATTEMPT_SCHEMA,
      event: "end",
      ...e,
      at: new Date().toISOString(),
    });
  }
}

/** What resume does with one task. */
export type TaskStatus =
  | { readonly kind: "done"; readonly final: AttemptRecord }
  | { readonly kind: "open"; readonly nextAttempt: number; readonly supersedes: string | null }
  | { readonly kind: "exhausted"; readonly attempts: number }
  | { readonly kind: "crashed"; readonly attempt: AttemptRecord };

export function taskStatus(
  attempts: readonly AttemptRecord[] | undefined,
  maxAttempts: number,
): TaskStatus {
  if (attempts === undefined || attempts.length === 0)
    return { kind: "open", nextAttempt: 1, supersedes: null };
  const last = attempts[attempts.length - 1] as AttemptRecord;
  if (last.end === null) return { kind: "crashed", attempt: last };
  if (last.end.outcome === "decided") return { kind: "done", final: last };
  if (attempts.length >= maxAttempts) return { kind: "exhausted", attempts: attempts.length };
  return { kind: "open", nextAttempt: attempts.length + 1, supersedes: last.start.trialKey };
}

/** The final arm rows (one per decided trial) and every faulted attempt, for the checks. */
export function ledgerRows(state: LedgerState): {
  readonly armRows: BenchmarkArmRow[];
  readonly faulted: EndLine[];
  readonly costs: (number | null)[];
} {
  const armRows: BenchmarkArmRow[] = [];
  const faulted: EndLine[] = [];
  const costs: (number | null)[] = [];
  for (const list of state.byTask.values())
    for (const rec of list) {
      if (rec.end === null) continue;
      costs.push(rec.end.cost?.estimatedModelUsd ?? null);
      if (rec.end.outcome === "decided" && rec.end.armRow !== null) armRows.push(rec.end.armRow);
      else faulted.push(rec.end);
    }
  return { armRows, faulted, costs };
}
