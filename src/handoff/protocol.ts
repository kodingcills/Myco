/**
 * Human handoff (capability track N): the shared vocabulary.
 *
 * A handoff pauses one trial's agent until a human on the host resolves it. It is requested
 * either by the agent (the `myco-handoff` MCP tool, `agent-server.ts`) or by a host-side
 * policy (`HandoffBroker.policyTrigger`, the interface track O implements). The human resolves
 * it through the operator channel only (`operator-server.ts`, `scripts/myco-handoff.ts`), never
 * through anything the agent can reach. See docs/handoff/protocol.md.
 *
 * Everything here is a closed vocabulary: the agent picks a reason from `HANDOFF_REASONS` and
 * writes a short bounded note; the human picks an outcome from `HANDOFF_OUTCOMES` and may write
 * a short bounded note. Nothing a handoff carries reaches the gate or the grader: a handoff
 * never changes a verdict (docs/handoff/security.md §4).
 */

export const HANDOFF_API_VERSION = "myco.handoff/v1";

/** Why the agent (or a policy) asks for a human. Closed: anything else is refused. */
export const HANDOFF_REASONS = ["uncertain", "needs-approval", "blocked"] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** What the human decides. Closed. */
export const HANDOFF_OUTCOMES = ["approve", "reject", "fixed-it"] as const;
export type HumanOutcome = (typeof HANDOFF_OUTCOMES)[number];

/**
 * How a handoff ended: a human outcome, or one the host imposed. `timeout` fails closed (the
 * attempt ends as `handoff-timeout`, never auto-approved); `cancelled` is the harness closing a
 * handoff still pending when the trial ended.
 */
export type HandoffResolution = HumanOutcome | "timeout" | "cancelled";

/** Who asked for the handoff. */
export type HandoffSource = "agent" | "policy";

/** Through which operator surface a human resolved it. */
export const OPERATOR_VIAS = ["cli", "watch-view", "api"] as const;
export type OperatorVia = (typeof OPERATOR_VIAS)[number];

/** Who resolved it: a human through an operator surface, or the host. */
export type ResolvedBy = `operator:${OperatorVia}` | "host:timeout" | "host:harness";

/**
 * The trial's assistance label, derived from its handoffs (`assistanceOf`):
 *  - `unassisted`: no handoff at all. The only label R1 evidence accepts.
 *  - `assisted`: a human answered `fixed-it` (human intervention on the desktop).
 *  - `human-gated`: handoffs happened but none was `fixed-it` (approve, reject, timeout,
 *    cancelled). The human still had the live desktop while the agent was paused, so this is
 *    not unassisted either.
 */
export const ASSISTANCE_LABELS = ["unassisted", "human-gated", "assisted"] as const;
export type AssistanceLabel = (typeof ASSISTANCE_LABELS)[number];

/** The attempt end a handoff can impose. Null when no handoff ended the attempt. */
export const HANDOFF_TIMEOUT_END = "handoff-timeout";
export type HandoffAttemptEnd = typeof HANDOFF_TIMEOUT_END | null;

/** Agent note bound (characters). */
export const AGENT_NOTE_LIMIT = 280;
/** Human note bound (characters). */
export const HUMAN_NOTE_LIMIT = 500;
/** Policy id: what track O names its rule (`policy-trigger`), recorded verbatim. */
export const POLICY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Operator label recorded with a resolution. Not an OS user name (docs/handoff/security.md). */
export const OPERATOR_LABEL = /^[a-z0-9][a-z0-9._-]{0,31}$/;
/** Handoff ids are broker-local counters (`ho-1`, `ho-2`, ...). */
export const HANDOFF_ID = /^ho-[1-9][0-9]{0,5}$/;

/** Default handoff timeout: 15 minutes. Configurable within the bounds below. */
export const DEFAULT_HANDOFF_TIMEOUT_MS = 15 * 60 * 1000;
export const MIN_HANDOFF_TIMEOUT_MS = 1_000;
export const MAX_HANDOFF_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** One handoff, as the run record keeps it (`myco.handoff.log/1` entries). */
export interface HandoffEntry {
  readonly handoffId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly source: HandoffSource;
  /** Set exactly when `source` is `policy`. */
  readonly policyId: string | null;
  readonly reason: HandoffReason;
  readonly note: string;
  readonly requestedAt: string;
  readonly resolvedAt: string;
  readonly durationMs: number;
  readonly resolution: HandoffResolution;
  readonly resolvedBy: ResolvedBy;
  /** Set only when a human resolved it (`operator:*`). */
  readonly operatorLabel: string | null;
  readonly humanNote: string | null;
}

/** The run record's `handoffs` field (`schemas/handoff.ts`, `myco.handoff.log/1`). */
export interface HandoffLog {
  readonly schema: "myco.handoff.log/1";
  readonly assistance: AssistanceLabel;
  readonly attemptEnd: HandoffAttemptEnd;
  readonly timeoutMs: number;
  readonly entries: readonly HandoffEntry[];
}

/** The label a trial's handoffs imply. Recomputed by every check; a declared label is not trusted. */
export function assistanceOf(
  entries: readonly Pick<HandoffEntry, "resolution">[],
): AssistanceLabel {
  if (entries.length === 0) return "unassisted";
  return entries.some((e) => e.resolution === "fixed-it") ? "assisted" : "human-gated";
}

// ---------------------------------------------------------------------------------------------
// Note hygiene. Both notes end up in the run record (which can be committed in an evidence
// pack) and one of them reaches the agent, so a note must be short, single-line, free of
// terminal control sequences, host paths and anything key-shaped. A bad note is refused with a
// code, never echoed.

export type NoteRejection =
  | "NOTE_NOT_STRING"
  | "NOTE_TOO_LONG"
  | "NOTE_CONTROL_CHAR"
  | "NOTE_HOST_PATH"
  | "NOTE_SECRET_SHAPED";

/** C0/C1 controls (newline included), DEL, and bidi overrides/isolates. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** Host path shapes (mirrors src/benchmark/check.ts `HOST_PATH`, plus `~/` and UNC). */
export const HOST_PATH =
  /(?:^|[\s"'(=:,])(?:\/Users\/|\/home\/|\/root\/|\/private\/|\/var\/folders\/|\/tmp\/|~\/|[A-Za-z]:\\|\\\\)/;

/**
 * Key-shaped strings: common vendor prefixes, PEM headers, bearer headers, and long unbroken
 * runs of key alphabet. Deliberately broad: a refused note costs the human a retype, a leaked
 * key costs a rotation.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S{6,}/i,
  /[A-Za-z0-9+/_=-]{40,}/,
];

export function looksSecret(text: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(text));
}

/** Null when `note` is acceptable under `limit`, else the code it is refused with. */
export function noteRejection(note: unknown, limit: number): NoteRejection | null {
  if (typeof note !== "string") return "NOTE_NOT_STRING";
  if ([...note].length > limit) return "NOTE_TOO_LONG";
  if (CONTROL.test(note)) return "NOTE_CONTROL_CHAR";
  if (HOST_PATH.test(note)) return "NOTE_HOST_PATH";
  if (looksSecret(note)) return "NOTE_SECRET_SHAPED";
  return null;
}

/**
 * Text that may carry agent-written content, made safe to print on the operator's terminal:
 * every control character (escape sequences included) and bidi override becomes `?`, and the
 * result is cut to `limit` characters. Notes are already validated; this is defence in depth for
 * the one place agent text meets a TTY.
 */
export function terminalSafe(text: string, limit = 200): string {
  const out = [...text]
    .map((c) => (CONTROL.test(c) ? "?" : c))
    .slice(0, limit)
    .join("");
  return out;
}
