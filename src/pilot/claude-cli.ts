/**
 * Headless Claude Code on the subscription: the pure, dependency-free half of the pilot
 * transport. Moved out of `claude-transport.ts`, `launch.ts`, `config.ts` and `runner.ts`
 * unchanged (TIF-268) so that a second caller, the `hcu+shell` arm's subscription planner,
 * can reuse the same classifier, preflight and environment allowlist WITHOUT loading the
 * pilot runner, which reaches Myco's gate and the benchmark grader. The original modules
 * re-export everything here, so every existing import and test is unchanged.
 *
 * Runtime imports: none (type-only imports are erased). `test/pilot/claude-cli.test.ts`
 * pins that.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { TokenUsage } from "./cost.ts";
import type { PilotHarnessClass } from "./ledger.ts";

/**
 * The planner. Sonnet 5.5 because the hcu+shell arm (R2's other side, TIF-268) runs it, so a
 * later paired run keeps the same model, and because the repo's frozen token rates price it.
 */
export const PILOT_MODEL = "claude-sonnet-5-5";

/** Names passed through to the agent process (values are never read by the harness). */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "TERM",
  "TMPDIR",
];

/** A fault of the harness, not the agent: the only kind of attempt that is ever re-run. */
export class HarnessFault extends Error {
  readonly harnessClass: PilotHarnessClass;
  /** Tokens the agent used before the fault, when the transport measured them. */
  readonly usage: TokenUsage | null;
  constructor(harnessClass: PilotHarnessClass, message: string, usage: TokenUsage | null = null) {
    super(message);
    this.name = "HarnessFault";
    this.harnessClass = harnessClass;
    this.usage = usage;
  }
}

/** What a clean headless result says: the agent's claim and its token usage. */
export interface ClaudeReport {
  readonly claim: "done" | "not-done" | "no-claim";
  readonly usage: TokenUsage | null;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Claude Code's structured error classes (the SDK assistant message's `error` field), mapped
 * to the pilot's harness classes. Limits and overload back off; a lost or refused login
 * pauses; anything else (including an unknown future class) is an unclassified error result.
 */
const ERROR_CLASS: Readonly<Record<string, PilotHarnessClass>> = {
  rate_limit: "rate-limit",
  overloaded: "rate-limit",
  billing_error: "rate-limit",
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  account_on_hold: "auth",
  verification_required: "auth",
  cloud_credential_error: "auth",
};

/** HTTP status of an API error, as Claude Code reports it (`api_error_status`). */
export function classOfStatus(status: number): PilotHarnessClass {
  if (status === 429 || status === 529) return "rate-limit";
  if (status === 401 || status === 403) return "auth";
  return "error-result";
}

/**
 * Text fallback, only for a run that did NOT complete normally (no result event, an error
 * result, a non-zero exit) and carries no structured class; never for a clean result, whose
 * text is the agent's (fc-v1 fixtures hold qty values 401, 403 and 429). Subscription limit
 * wording varies by plan and version ("usage limit reached", "5-hour limit reached ∙ resets
 * 3pm", "Weekly limit reached", "Opus limit reached", "out of extra usage", API 429/529
 * bodies), so the vocabulary is broad; `test/pilot/claude-transport.test.ts` pins it.
 */
export const RATE_LIMIT_TEXT =
  /rate[ _-]?limit|usage[ _-]?limit|limit (?:reached|exceeded|hit)|limit (?:will )?resets?|\bresets? (?:at |on |in )?(?:\d|mon|tue|wed|thu|fri|sat|sun|tomorrow)|too many requests|\b429\b|\b529\b|overloaded|quota|out of (?:extra )?usage|(?:weekly|daily|monthly|hourly|session|\d+[ -]?hour|five[ -]hour|opus|sonnet|haiku|fable) limit|credit balance|billing/i;

export const AUTH_TEXT =
  /invalid (?:api )?key|api key|\/login|not logged in|log ?in again|please (?:log|sign) ?in|authenticat|unauthori[sz]ed|oauth|\b401\b|\b403\b|forbidden|credential|account (?:is )?on hold|verification required|token (?:has )?expired/i;

/** The text-fallback class of an error message, or null when it names neither. */
export function classOfText(text: string): PilotHarnessClass | null {
  if (AUTH_TEXT.test(text)) return "auth";
  if (RATE_LIMIT_TEXT.test(text)) return "rate-limit";
  return null;
}

export function parseClaim(text: string): ClaudeReport["claim"] {
  const last = text.trimEnd().split("\n").pop()?.trim() ?? "";
  if (last === "DONE") return "done";
  if (last === "NOT DONE") return "not-done";
  return "no-claim";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : Number.NaN;
}

export function parseUsage(u: unknown): TokenUsage | null {
  if (u === null || typeof u !== "object") return null;
  const r = u as Record<string, unknown>;
  const usage = {
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadInputTokens: num(r.cache_read_input_tokens ?? 0),
    cacheCreationInputTokens: num(r.cache_creation_input_tokens ?? 0),
  };
  return Object.values(usage).every((n) => !Number.isNaN(n)) ? usage : null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Parse `--output-format json` (one result object) or `--verbose` output (an array of messages). */
function parseOutput(stdout: string): {
  result: Record<string, unknown> | null;
  messages: Record<string, unknown>[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return { result: null, messages: [] };
  }
  const messages = Array.isArray(parsed) ? parsed.filter(isObj) : isObj(parsed) ? [parsed] : [];
  const results = messages.filter((m) => m.type === "result");
  return { result: results[results.length - 1] ?? null, messages };
}

/** The structured class, if any message carries one (error class first, then HTTP status). */
function structuredClass(messages: readonly Record<string, unknown>[]): PilotHarnessClass | null {
  const found: PilotHarnessClass[] = [];
  for (const m of messages) {
    const inner = isObj(m.message) ? m.message : {};
    for (const e of [m.error, inner.error])
      if (typeof e === "string" && e !== "") found.push(ERROR_CLASS[e] ?? "error-result");
    for (const st of [m.api_error_status, inner.api_error_status])
      if (typeof st === "number" && Number.isInteger(st) && st >= 400)
        found.push(classOfStatus(st));
  }
  if (found.length === 0) return null;
  // The most actionable class wins: a lost login pauses, a limit backs off.
  if (found.includes("auth")) return "auth";
  if (found.includes("rate-limit")) return "rate-limit";
  return "error-result";
}

/**
 * Classify the process outcome; throws `HarnessFault` for every harness-side or uncertain
 * outcome. Returns the agent's report only for a clean result: `type: "result"`, subtype
 * `success`, `is_error` false, exit status 0, and no structured error on any message. A clean
 * result is always the agent's outcome (a missing `DONE`/`NOT DONE` line is "no claim"); the
 * text fallback runs only on runs that did not complete normally (no result event, an error
 * result, a non-zero or null exit, a structured error) and on their stderr.
 */
export function interpretResult(stdout: string, stderr: string, code: number | null): ClaudeReport {
  const { result, messages } = parseOutput(stdout);
  const text = typeof result?.result === "string" ? result.result : "";
  const usage = parseUsage(result?.usage);
  const fault = (cls: PilotHarnessClass, why: string): never => {
    throw new HarnessFault(cls, why, usage);
  };
  const structured = structuredClass(messages);
  if (result === null) {
    const cls = structured ?? classOfText(stderr);
    if (cls !== null)
      fault(cls, `claude exited ${String(code)} with a ${cls} signal and no result`);
    fault(
      "transport-error",
      `claude exited ${String(code)} without a JSON result (stderr ${stderr.length} bytes)`,
    );
  }
  const r = result as Record<string, unknown>;
  const errors = Array.isArray(r.errors) ? r.errors.filter((e) => typeof e === "string") : [];
  const errored =
    r.is_error !== false || r.subtype !== "success" || code !== 0 || structured !== null;
  if (errored) {
    const cls = structured ?? classOfText(`${text}\n${errors.join("\n")}\n${stderr}`);
    fault(
      cls ?? "error-result",
      `claude returned an error result (subtype ${String(r.subtype)}, exit ${String(code)}${cls === null ? ", unclassified" : ""})`,
    );
  }
  // A run that completed normally is the agent's outcome, whatever its text says. The text
  // vocabulary above is broad (bare 401/403/429, "billing", "quota", "credential", "<word>
  // limit") and matches ordinary task content, so it is NEVER applied here: a missing claim is
  // "no claim", decided and never re-run (verifier round 2, D4).
  return { claim: parseClaim(text), usage };
}

/**
 * Environment variable names that put Claude Code (or an SDK it spawns) on a paid API path or
 * another provider instead of the subscription. Matched by name only.
 */
export const API_CREDENTIAL_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_PROFILE",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_BEARER_TOKEN_BEDROCK",
  /** This repo's own key-file pointer (`src/baseline/secret-file.ts`). */
  "MYCO_ANTHROPIC_KEY_FILE",
];

export interface PreflightResult {
  readonly ok: boolean;
  /** Names (never values) of the API-path variables that are configured. */
  readonly configured: readonly string[];
}

/**
 * Names only: a variable counts as configured when its name is present (even empty: an empty
 * `ANTHROPIC_API_KEY` still shadows other credentials in some clients). Values are not read.
 */
export function subscriptionPreflight(envNames: Iterable<string>): PreflightResult {
  const present = new Set(envNames);
  const configured = API_CREDENTIAL_NAMES.filter((n) => present.has(n));
  return { ok: configured.length === 0, configured };
}

/** Refusal text for a failed preflight: names the variables, never a value. */
export function preflightRefusal(r: PreflightResult): string {
  return (
    `refusing to start: API-path credential variable(s) configured: ${r.configured.join(", ")}. ` +
    "The pilot runs on the Claude subscription only; unset them (names checked, values never read) and re-run."
  );
}

/**
 * The agent's environment: the allowlisted names copied from `env`, nothing else. Runs only in
 * the live transport; the harness never logs the result.
 */
export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
  allowlist: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allowlist) {
    const v = env[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}
