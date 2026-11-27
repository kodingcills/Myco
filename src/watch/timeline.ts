/**
 * Replay (spec #589 §2.2, build PR B1): the frame ⋈ decision join, with no clock.
 *
 * A trusted harness that captures frames also writes one `myco.watch-timeline/1` record per
 * frame: the frame's sha256 and the run's own decision log as it stood just before and just
 * after the capture (a line count and a sha256 of that prefix). A decision is then pinned to
 * the last frame whose capture finished before its line was in the log:
 *
 *   pinned(d) = the largest frame with logAfter.lines < d
 *
 * The only clock is the log's own line count. `checkedAt`, file names, mtimes and the host
 * clock are never join keys (`checkedAt` is only checked never to go backwards, TL_CLOCK_SKEW).
 *
 * Attribution is the gate's binding (§1.2), never `request.runId`: the log is the audit log of
 * the one gate bound to (taskId, runId), so every line is that trial's call. The binding is
 * checked, not assumed (`bindingHolds`): a line naming another trial must have the shape of a
 * pre-evidence rejection, and every evidence ref must name the bound run.
 *
 * Fail closed: any inconsistency invalidates the join for the run with the first failing code
 * in TIMELINE_CODES order, and the caller shows frames and decisions unjoined.
 *
 * Pure and read-only: hashing is `node:crypto`'s `createHash` (no key, no HMAC, no random);
 * the one file read is `readRegular` (`O_RDONLY | O_NOFOLLOW`, regular files only). There is
 * no write call, no process spawn, no network call and no vault or secret-file import.
 */
import { createHash, type Hash } from "node:crypto";
import { type GateVerdict, isSafeId, REASON_CODES, type ReasonCode } from "../gate/api.ts";
import { readRegular } from "./frames.ts";

export const TIMELINE_SCHEMA = "myco.watch-timeline/1";

/** The closed join codes (§1.1), in check order: the first failing one is reported. */
export const TIMELINE_CODES = [
  "TL_SCHEMA",
  "TL_RUN",
  "TL_GAP",
  "TL_DUPLICATE",
  "TL_FRAME_DIGEST",
  "TL_ORDER",
  "TL_LOG_AHEAD",
  "TL_LOG_PREFIX",
  "TL_LOG_BINDING",
  "TL_MALFORMED",
  "TL_CLOCK_SKEW",
  "TL_NO_TIMELINE",
  "TL_NO_FRAME_BEFORE",
  "PAIR_MISMATCH",
] as const;
export type TimelineCode = (typeof TIMELINE_CODES)[number];

/** A timeline manifest line longer than this is refused (TL_SCHEMA). */
export const MAX_TIMELINE_LINE_BYTES = 4 * 1024;

export interface LogAnchor {
  /** Complete, non-blank lines of the log at that moment. */
  readonly lines: number;
  /** sha256 of the log's bytes up to and including the newline of line `lines`. */
  readonly prefixSha256: string;
}

export interface TimelineRecord {
  readonly schema: typeof TIMELINE_SCHEMA;
  readonly runId: string;
  /** 0-based frame ordinal for this run. */
  readonly frame: number;
  readonly frameSha256: string;
  readonly logBefore: LogAnchor;
  readonly logAfter: LogAnchor;
}

// ---------------------------------------------------------------------------
// The shared line-count and prefix function (recorder and joiner use the same one)
// ---------------------------------------------------------------------------

/** One complete (newline-terminated), non-blank line of a decision log. */
export interface LogLine {
  /** 1-based ordinal among complete, non-blank lines. */
  readonly ordinal: number;
  /** The line's bytes without its newline. */
  readonly bytes: Uint8Array;
  /** Offset just past the line's newline. */
  readonly end: number;
}

const NEWLINE = 0x0a;
const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

function isBlank(bytes: Uint8Array): boolean {
  // The rule `DecisionLogTail` applies: a line that trims to nothing is skipped.
  return (
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8").trim().length ===
    0
  );
}

/**
 * The log's complete, non-blank lines in order. A trailing line without its newline (a write
 * in progress) is not a line yet. Malformed lines are lines: they count.
 */
export function logLines(log: Uint8Array): LogLine[] {
  const out: LogLine[] = [];
  let start = 0;
  for (let at = 0; at < log.length; at += 1) {
    if (log[at] !== NEWLINE) continue;
    const bytes = log.subarray(start, at);
    start = at + 1;
    if (!isBlank(bytes)) out.push({ ordinal: out.length + 1, bytes, end: start });
  }
  return out;
}

/**
 * Every anchor of the log, for 0..L lines, in one pass with one running sha256 (no copy of the
 * log held beyond the caller's buffer). `anchors[k]` describes the log's first k lines.
 */
export function logAnchors(log: Uint8Array, lines: readonly LogLine[] = logLines(log)): string[] {
  const running: Hash = createHash("sha256");
  const out: string[] = [running.copy().digest("hex")];
  let fed = 0;
  for (const line of lines) {
    running.update(log.subarray(fed, line.end));
    fed = line.end;
    out.push(running.copy().digest("hex"));
  }
  return out;
}

/** The anchor of the log as it stands now (all its complete lines). */
export function currentAnchor(log: Uint8Array): LogAnchor {
  const lines = logLines(log);
  const anchors = logAnchors(log, lines);
  return { lines: lines.length, prefixSha256: anchors[lines.length] as string };
}

/**
 * The record a harness writes for one captured frame, from the frame's bytes and the run's
 * own decision log read just before and just after the capture.
 */
export function timelineRecord(
  runId: string,
  frame: number,
  frameBytes: Uint8Array,
  logBefore: LogAnchor,
  logAfter: LogAnchor,
): TimelineRecord {
  return {
    schema: TIMELINE_SCHEMA,
    runId,
    frame,
    frameSha256: sha256(frameBytes),
    logBefore: { lines: logBefore.lines, prefixSha256: logBefore.prefixSha256 },
    logAfter: { lines: logAfter.lines, prefixSha256: logAfter.prefixSha256 },
  };
}

// ---------------------------------------------------------------------------
// Logged decisions and the binding check (§1.2)
// ---------------------------------------------------------------------------

export interface TrialBinding {
  readonly taskId: string;
  readonly runId: string;
}

/** The closed fields of one decision-log line the join needs. Nothing else is kept. */
export interface LoggedDecision {
  readonly verdict: GateVerdict;
  readonly accepted: boolean;
  readonly reasonCodes: readonly ReasonCode[];
  readonly evidenceRunIds: readonly string[];
  readonly requestTaskId: string | undefined;
  readonly requestRunId: string | undefined;
  readonly hasOracle: boolean;
  readonly hasCheckpoints: boolean;
  readonly hasCorrections: boolean;
  /** `checkedAt` in ms since the epoch: compared for skew only, never a join key. */
  readonly checkedAtMs: number;
}

const VERDICTS: ReadonlySet<string> = new Set(["verified", "refuted", "uncertain"]);
const CODES: ReadonlySet<string> = new Set(REASON_CODES);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse one log line to its closed fields, or null when it is malformed. Never throws. */
export function parseLoggedDecision(bytes: Uint8Array): LoggedDecision | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString());
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { verdict, accepted, reasonCodes, evidenceRefs, request, checkedAt } = raw;
  if (typeof verdict !== "string" || !VERDICTS.has(verdict)) return null;
  if (typeof accepted !== "boolean") return null;
  if (!Array.isArray(reasonCodes) || !reasonCodes.every((c) => CODES.has(c as string))) return null;
  if (!Array.isArray(evidenceRefs)) return null;
  const evidenceRunIds: string[] = [];
  for (const ref of evidenceRefs) {
    if (!isRecord(ref) || typeof ref.runId !== "string") return null;
    evidenceRunIds.push(ref.runId);
  }
  if (!isRecord(request)) return null;
  const { taskId, runId } = request;
  if (taskId !== undefined && typeof taskId !== "string") return null;
  if (runId !== undefined && typeof runId !== "string") return null;
  if (typeof checkedAt !== "string" || !ISO.test(checkedAt)) return null;
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedAtMs)) return null;
  return {
    verdict: verdict as GateVerdict,
    accepted,
    reasonCodes: reasonCodes as ReasonCode[],
    evidenceRunIds,
    requestTaskId: taskId,
    requestRunId: runId,
    hasOracle: raw.oracle !== undefined,
    hasCheckpoints: raw.checkpoints !== undefined,
    hasCorrections: raw.corrections !== undefined,
    checkedAtMs,
  };
}

/** The codes a pre-evidence rejection (shapes S1 and S2 of §1.2) can lead with. */
export const PRE_EVIDENCE_CODES: readonly ReasonCode[] = [
  "INVALID_REQUEST",
  "UNKNOWN_FIELD",
  "ORACLE_INPUT_REJECTED",
  "UNSUPPORTED_API_VERSION",
  "ASSIGNMENT_MISMATCH",
];

/** True when the line's request names a task or run other than the bound trial's. */
export function namesAnotherTrial(d: LoggedDecision, binding: TrialBinding): boolean {
  return (
    (d.requestTaskId !== undefined && d.requestTaskId !== binding.taskId) ||
    (d.requestRunId !== undefined && d.requestRunId !== binding.runId)
  );
}

function isPreEvidenceShape(d: LoggedDecision): boolean {
  const [first, ...rest] = d.reasonCodes;
  return (
    d.verdict === "uncertain" &&
    !d.accepted &&
    d.evidenceRunIds.length === 0 &&
    !d.hasOracle &&
    !d.hasCheckpoints &&
    !d.hasCorrections &&
    first !== undefined &&
    PRE_EVIDENCE_CODES.includes(first) &&
    (rest.length === 0 || (rest.length === 1 && rest[0] === "CLAIM_RECORDED"))
  );
}

/**
 * The binding check of §1.2: (a) every evidence ref names the bound run; (b) a line naming
 * another trial has exactly the shape of a pre-evidence rejection. A line that breaks either
 * cannot come from the gate bound to this trial.
 */
export function bindingHolds(d: LoggedDecision, binding: TrialBinding): boolean {
  if (!d.evidenceRunIds.every((runId) => runId === binding.runId)) return false;
  return !namesAnotherTrial(d, binding) || isPreEvidenceShape(d);
}

// ---------------------------------------------------------------------------
// The timeline manifest
// ---------------------------------------------------------------------------

export type ManifestRead =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "records"; readonly records: readonly unknown[] };

/**
 * Parse manifest bytes: one JSON value per complete line, each at most 4 KiB. A trailing
 * line without its newline is a write in progress and is not read yet.
 */
export function parseManifest(bytes: Uint8Array): ManifestRead {
  const records: unknown[] = [];
  let start = 0;
  for (let at = 0; at < bytes.length; at += 1) {
    if (bytes[at] !== NEWLINE) continue;
    const line = bytes.subarray(start, at);
    start = at + 1;
    if (line.length > MAX_TIMELINE_LINE_BYTES) return { kind: "malformed" };
    if (isBlank(line)) continue;
    try {
      records.push(JSON.parse(Buffer.from(line).toString("utf8")));
    } catch {
      return { kind: "malformed" };
    }
  }
  if (bytes.length - start > MAX_TIMELINE_LINE_BYTES) return { kind: "malformed" };
  return { kind: "records", records };
}

/**
 * Read a manifest file read-only. A missing file, a symbolic link, which `O_NOFOLLOW`
 * refuses, or anything other than a regular file is `absent` (TL_NO_TIMELINE), never followed.
 */
export function readManifest(path: string): ManifestRead {
  const bytes = readRegular(path);
  return bytes === null ? { kind: "absent" } : parseManifest(bytes);
}

const HEX64 = /^[0-9a-f]{64}$/;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function isAnchor(value: unknown): value is LogAnchor {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    isCount(value.lines) &&
    typeof value.prefixSha256 === "string" &&
    HEX64.test(value.prefixSha256)
  );
}

const RECORD_KEYS = ["frame", "frameSha256", "logAfter", "logBefore", "runId", "schema"];

/** The closed schema of one record: no unknown field, none missing, every value typed. */
export function isTimelineRecord(value: unknown): value is TimelineRecord {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.join(",") === RECORD_KEYS.join(",") &&
    value.schema === TIMELINE_SCHEMA &&
    typeof value.runId === "string" &&
    isSafeId(value.runId) &&
    isCount(value.frame) &&
    typeof value.frameSha256 === "string" &&
    HEX64.test(value.frameSha256) &&
    isAnchor(value.logBefore) &&
    isAnchor(value.logAfter)
  );
}

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

export interface JoinInput {
  /** The trial whose own decision log `log` is (§1.2). */
  readonly binding: TrialBinding;
  /** The operator's listed runs. */
  readonly listedRuns: ReadonlySet<string>;
  readonly manifest: ManifestRead;
  /** The frame source's count for the run. */
  readonly frameCount: number;
  /** The bytes of frame `index` as the frame source serves them, or null if unreadable. */
  readonly frameBytes: (index: number) => Uint8Array | null;
  /** The run's own decision log, as read now. */
  readonly log: Uint8Array;
}

export interface JoinedDecision {
  /** 1-based ordinal of the line among the log's complete, non-blank lines. */
  readonly ordinal: number;
  /** 1-based call number among the log's well-formed decisions, in ordinal order. */
  readonly call: number;
  readonly verdict: GateVerdict;
  readonly accepted: boolean;
  readonly reasonCodes: readonly ReasonCode[];
  /** The call named another trial (a pre-evidence rejection; still this trial's call). */
  readonly namedAnotherTrial: boolean;
  /** The frame the decision is pinned to, or null (TL_NO_FRAME_BEFORE). */
  readonly frame: number | null;
}

export interface JoinedFrame {
  readonly frame: number;
  /** Ordinals of decisions whose line landed while this frame was being captured. */
  readonly straddles: readonly number[];
}

export type TimelineJoin =
  | {
      readonly ok: true;
      readonly frames: readonly JoinedFrame[];
      readonly decisions: readonly JoinedDecision[];
    }
  | { readonly ok: false; readonly code: TimelineCode };

const fail = (code: TimelineCode): TimelineJoin => ({ ok: false, code });

/** Compute the join for one run. Total: never throws; any inconsistency is a code. */
export function joinTimeline(input: JoinInput): TimelineJoin {
  const { binding, manifest, frameCount, log } = input;
  if (manifest.kind === "absent") return fail("TL_NO_TIMELINE");
  if (manifest.kind === "malformed") return fail("TL_SCHEMA");
  const records: TimelineRecord[] = [];
  for (const raw of manifest.records) {
    if (!isTimelineRecord(raw)) return fail("TL_SCHEMA");
    records.push(raw);
  }
  if (records.some((r) => !input.listedRuns.has(r.runId) || r.runId !== binding.runId))
    return fail("TL_RUN");
  const ordinals = new Set(records.map((r) => r.frame));
  if (ordinals.size !== frameCount || records.some((r) => r.frame >= frameCount))
    return fail("TL_GAP");
  if (ordinals.size !== records.length) return fail("TL_DUPLICATE");
  const byFrame = [...records].sort((a, b) => a.frame - b.frame);
  for (const record of byFrame) {
    const bytes = input.frameBytes(record.frame);
    if (bytes === null || sha256(bytes) !== record.frameSha256) return fail("TL_FRAME_DIGEST");
  }
  for (let k = 0; k < byFrame.length; k += 1) {
    const here = byFrame[k] as TimelineRecord;
    const next = byFrame[k + 1];
    if (here.logBefore.lines > here.logAfter.lines) return fail("TL_ORDER");
    if (next !== undefined && next.logBefore.lines < here.logAfter.lines) return fail("TL_ORDER");
  }
  const lines = logLines(log);
  const anchors = logAnchors(log, lines);
  const anchorsOf = (r: TimelineRecord) => [r.logBefore, r.logAfter];
  if (byFrame.some((r) => anchorsOf(r).some((a) => a.lines > lines.length)))
    return fail("TL_LOG_AHEAD");
  if (byFrame.some((r) => anchorsOf(r).some((a) => anchors[a.lines] !== a.prefixSha256)))
    return fail("TL_LOG_PREFIX");

  const parsed = lines.map((line) => ({ line, decision: parseLoggedDecision(line.bytes) }));
  for (const { decision } of parsed)
    if (decision !== null && !bindingHolds(decision, binding)) return fail("TL_LOG_BINDING");

  const pinOf = (ordinal: number): number | null => {
    let pinned: number | null = null;
    for (const r of byFrame) if (r.logAfter.lines < ordinal) pinned = r.frame;
    return pinned;
  };
  const decisions: JoinedDecision[] = [];
  let lastPinned = 0;
  for (const { line, decision } of parsed) {
    if (decision === null) continue;
    const frame = pinOf(line.ordinal);
    if (frame !== null) lastPinned = line.ordinal;
    decisions.push({
      ordinal: line.ordinal,
      call: decisions.length + 1,
      verdict: decision.verdict,
      accepted: decision.accepted && decision.verdict === "verified",
      reasonCodes: [...decision.reasonCodes],
      namedAnotherTrial: namesAnotherTrial(decision, binding),
      frame,
    });
  }
  if (parsed.some(({ line, decision }) => decision === null && line.ordinal <= lastPinned))
    return fail("TL_MALFORMED");
  const clocks = parsed.flatMap(({ decision }) => (decision === null ? [] : [decision]));
  for (let i = 1; i < clocks.length; i += 1)
    if ((clocks[i] as LoggedDecision).checkedAtMs < (clocks[i - 1] as LoggedDecision).checkedAtMs)
      return fail("TL_CLOCK_SKEW");

  const frames = byFrame.map((r) => ({
    frame: r.frame,
    straddles: decisions
      .filter((d) => r.logBefore.lines < d.ordinal && d.ordinal <= r.logAfter.lines)
      .map((d) => d.ordinal),
  }));
  return { ok: true, frames, decisions };
}
