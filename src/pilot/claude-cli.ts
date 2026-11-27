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

/**
 * The CLI ran (or would run) on an API key instead of the operator's subscription. Recorded as
 * an `auth` fault, and it stops the run at once with code `api-key`: never retried, never an
 * agent outcome.
 */
export class ApiKeyPathFault extends HarnessFault {
  constructor(message: string, usage: TokenUsage | null = null) {
    super("auth", message, usage);
    this.name = "ApiKeyPathFault";
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
 * to the pilot's harness classes. Limits and overload back off (unless the run's text names the
 * subscription's usage quota: `refineLimit`); a lost or refused login and a
 * credit, billing or quota error stop the run at once (fail closed, no retry loop); anything
 * else (including an unknown future class) is an unclassified error result.
 */
const ERROR_CLASS: Readonly<Record<string, PilotHarnessClass>> = {
  rate_limit: "rate-limit",
  overloaded: "rate-limit",
  billing_error: "billing",
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
  if (status === 402) return "billing";
  return "error-result";
}

/**
 * Text fallback, only for a run that did NOT complete normally (no result event, an error
 * result, a non-zero exit) and carries no structured class; never for a clean result, whose
 * text is the agent's (fc-v1 fixtures hold qty values 401, 403 and 429). The one exception is
 * `USAGE_LIMIT_TEXT` alone, on a clean result with no claim line, tested on its text and
 * stderr (`interpretResult`). Every vocabulary is applied to the folded forms of the text
 * (`vocabularyForms`), never to the raw text.
 *
 * Two kinds of limit (lead ruling, PR #598 round 2, D3):
 *  - `USAGE_LIMIT_TEXT`, the subscription's own quota ("usage limit reached", "5-hour limit
 *    reached ∙ resets 3pm", "Weekly limit reached", "Opus limit reached", "resets at 5pm",
 *    "You've hit your limit"):
 *    class `usage-limit`, which stops the run at once with its own code (no retry, no attempt
 *    spent) and goes to the lead. It wins over the transient wording when both appear.
 *  - `RATE_LIMIT_TEXT`, a transient API limit (429 / 529 bodies, "rate limit", "too many
 *    requests", "overloaded"): class `rate-limit`, bounded back-off.
 * The wording varies by plan and version, so the vocabulary is broad;
 * `test/pilot/claude-transport.test.ts` pins it.
 */
export const USAGE_LIMIT_TEXT =
  /usage[ _-]?limit|(?<!rate[ _-]?)limit (?:reached|exceeded|hit)|limit (?:will )?resets?|\bresets? (?:at |on |in )?(?:\d|mon|tue|wed|thu|fri|sat|sun|tomorrow)|(?:weekly|daily|monthly|hourly|session|\d+[ -]?hour|five[ -]hour|opus|sonnet|haiku|fable) limit|(?:you['\u2018\u2019\u02bc]?ve|you have) (?:hit|reached) your (?:usage )?limit/i;

// U+180E (Mongolian vowel separator) is in `\p{Cf}` (Unicode 6.3+); pinned by a test.
const FORMAT_CHARS = /\p{Cf}/gu;
const HYPHENS = /[\u2010-\u2015]/g;

/**
 * The forms of `text` every vocabulary is matched against (#606 S2, round 2 F-A). Hyphen
 * variants U+2010-U+2015 (incl. the non-breaking U+2011 of "5-hour") become "-". Unicode
 * format characters (`\p{Cf}`: U+200B-U+200D, U+2060, U+FEFF, U+180E, ...) are removed in one
 * form and become a space in the other, so both "usage<ZWSP>limit" and "limit<WJ>reached"
 * match. Then every whitespace run (JS `\s`: NBSP, U+2000-U+200A, U+202F, U+205F, U+3000,
 * tabs, newlines, repeated spaces) becomes one ASCII space, because the vocabularies spell
 * their spaces as literal ASCII spaces.
 */
export function vocabularyForms(text: string): readonly string[] {
  const hyphens = text.replace(HYPHENS, "-");
  return [hyphens.replace(FORMAT_CHARS, ""), hyphens.replace(FORMAT_CHARS, " ")].map((s) =>
    s.replace(/\s+/g, " "),
  );
}

/** Whether `vocabulary` matches any folded form of `text`; the only way a vocabulary is applied. */
function matchesVocabulary(vocabulary: RegExp, text: string): boolean {
  return vocabularyForms(text).some((form) => vocabulary.test(form));
}

/**
 * Whether `text` names the subscription's usage quota, on its folded forms
 * (`vocabularyForms`). Every usage-limit decision goes through here, never through
 * `USAGE_LIMIT_TEXT` directly.
 */
export function namesUsageLimit(text: string): boolean {
  return matchesVocabulary(USAGE_LIMIT_TEXT, text);
}

export const RATE_LIMIT_TEXT = /rate[ _-]?limit|too many requests|\b429\b|\b529\b|overloaded/i;

/**
 * Credit, billing and quota wording ("Credit balance is too low", "out of extra usage", "quota
 * exceeded", HTTP 402). Unlike a rate limit these do not clear by waiting, so they stop the run
 * at once with code `billing` (fail closed; never a back-off or retry loop). Checked before the
 * rate-limit vocabulary, after the login vocabulary.
 */
export const BILLING_TEXT =
  /credit balance|out of credits?|credits? (?:(?:are|is|have been|has been) )?(?:exhausted|depleted|used up|ran out)|insufficient (?:credits?|funds|balance)|billing|payment (?:required|failed|method)|\b402\b|quota|out of (?:extra )?usage/i;

export const AUTH_TEXT =
  /invalid (?:api )?key|api key|\/login|not logged in|log[ -]?in again|please (?:log|sign)[ -]?in|authenticat|unauthori[sz]ed|oauth|\b401\b|\b403\b|forbidden|credential|account (?:is )?on hold|verification required|token (?:has )?expired/i;

/**
 * The text-fallback class of an error message, or null when it names none. The order is
 * pinned (`test/pilot/claude-transport.test.ts`): a lost login first, then billing, then the
 * subscription's usage quota, then a transient limit. Each vocabulary is matched on the folded
 * forms (`vocabularyForms`; round 2 F-B), so NBSP or thin-space wording is classified as its
 * ASCII-spaced form is. Only runs that did not complete normally reach here.
 */
export function classOfText(text: string): PilotHarnessClass | null {
  if (matchesVocabulary(AUTH_TEXT, text)) return "auth";
  if (matchesVocabulary(BILLING_TEXT, text)) return "billing";
  if (namesUsageLimit(text)) return "usage-limit";
  if (matchesVocabulary(RATE_LIMIT_TEXT, text)) return "rate-limit";
  return null;
}

/**
 * A structured limit (`rate_limit`, `overloaded`, HTTP 429 / 529) is transient unless the
 * failed run's own text names the subscription's quota: Claude Code reports both through the
 * same structured class, and the quota must stop the run, not back off (D3).
 */
function refineLimit(cls: PilotHarnessClass, text: string): PilotHarnessClass {
  return cls === "rate-limit" && namesUsageLimit(text) ? "usage-limit" : cls;
}

/**
 * The class of a run that did not complete normally, from its structured class and its text
 * (#607 round 3, B2). With no structured class, or only an unmapped one (`error-result`: an
 * unknown `error` string such as `invalid_request` / `server_error`, or an `api_error_status`
 * other than 401/402/403/429/529, e.g. 400 or 500), the text vocabulary decides, so quota,
 * billing or auth wording is never spent as an unclassified error result; with no matching
 * text, the structured class stands (a bare status 500 stays `error-result`). A mapped
 * structured class (auth, billing, rate-limit) wins, refined only by `refineLimit`.
 */
export function classOfFailure(
  structured: PilotHarnessClass | null,
  text: string,
): PilotHarnessClass | null {
  return structured === null || structured === "error-result"
    ? (classOfText(text) ?? structured)
    : refineLimit(structured, text);
}

/**
 * The narrow, numberless billing and auth wording that stops a claimless clean result (#607
 * round 3, L1; lead rule 04:52Z). Exact CLI phrases only: unlike `BILLING_TEXT` / `AUTH_TEXT`
 * ("billing", "quota", "credential", bare 401/403) none of them reads as task data. Matched on
 * the folded forms (`vocabularyForms`). A result with a claim line is never reclassified.
 */
export const CLEAN_RESULT_AUTH_TEXT =
  /please run \/login|not logged in|invalid api key|oauth token has expired/i;
export const CLEAN_RESULT_BILLING_TEXT = /credit balance is too low|out of extra usage/i;

/**
 * The harness class of a claimless clean result, or null when it is the agent's `no-claim`.
 * Tested on its text and stderr together (#606 S1). Auth first, then billing, then the usage
 * quota, the same order as `classOfText`.
 */
export function classOfClaimlessCleanResult(text: string): PilotHarnessClass | null {
  if (matchesVocabulary(CLEAN_RESULT_AUTH_TEXT, text)) return "auth";
  if (matchesVocabulary(CLEAN_RESULT_BILLING_TEXT, text)) return "billing";
  if (namesUsageLimit(text)) return "usage-limit";
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
export function structuredClass(
  messages: readonly Record<string, unknown>[],
): PilotHarnessClass | null {
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
  // The most actionable class wins: a lost login or a billing error stops, a limit backs off.
  if (found.includes("auth")) return "auth";
  if (found.includes("billing")) return "billing";
  if (found.includes("rate-limit")) return "rate-limit";
  return "error-result";
}

/**
 * Claude Code names where its credential came from in its `system`/`init` message
 * (`apiKeySource`; present in `--verbose` / stream output). On the subscription it is `none`.
 * Any other value means the CLI is billing an API key: refused, fail closed, whatever the run's
 * outcome. The returned text names the source field only, never a credential.
 */
export function apiKeySourceProblem(messages: readonly Record<string, unknown>[]): string | null {
  for (const m of messages)
    if (Object.hasOwn(m, "apiKeySource") && m.apiKeySource !== "none")
      return 'claude reported an apiKeySource other than "none": it is not on the subscription';
  return null;
}

/**
 * Classify the process outcome; throws `HarnessFault` for every harness-side or uncertain
 * outcome. Returns the agent's report only for a clean result: `type: "result"`, subtype
 * `success`, `is_error` false, exit status 0, and no structured error on any message. A clean
 * result is the agent's outcome (a missing `DONE`/`NOT DONE` line is "no claim"), with one
 * fail-closed exception: no claim line AND usage-quota wording in its text or on stderr is
 * `usage-limit` (round 3, R2-D3b; #606 S1), and the narrow billing / auth phrases stop with
 * their own class (#607 round 3, L1). The full text fallback runs only on runs that
 * did not complete normally (no result event: stdout and stderr; an error result: its text,
 * `errors[]` and stderr; a non-zero or null exit; a structured error), and also when the only
 * structured class is unmapped (`classOfFailure`, #607 round 3, B2).
 */
export function interpretResult(stdout: string, stderr: string, code: number | null): ClaudeReport {
  const { result, messages } = parseOutput(stdout);
  const text = typeof result?.result === "string" ? result.result : "";
  const usage = parseUsage(result?.usage);
  const fault = (cls: PilotHarnessClass, why: string): never => {
    throw new HarnessFault(cls, why, usage);
  };
  // An API-key run is never the agent's outcome and never retried: it stops the run first.
  const apiKey = apiKeySourceProblem(messages);
  if (apiKey !== null) throw new ApiKeyPathFault(apiKey, usage);
  const structured = structuredClass(messages);
  if (result === null) {
    // No result event: nothing here is an agent outcome, so plain (non-JSON) stdout is
    // classified with stderr (PR #598 round 3, R2-D3a: quota wording on stdout must stop the
    // run, not be re-run as a transport error that spends attempts).
    const noResultText = `${stdout}\n${stderr}`;
    const cls = classOfFailure(structured, noResultText);
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
    const failedText = `${text}\n${errors.join("\n")}\n${stderr}`;
    const cls = classOfFailure(structured, failedText);
    fault(
      cls ?? "error-result",
      `claude returned an error result (subtype ${String(r.subtype)}, exit ${String(code)}${cls === null || cls === "error-result" ? ", unclassified" : ""})`,
    );
  }
  // A run that completed normally is the agent's outcome. The auth / billing / transient
  // vocabulary is broad (bare 401/403/429, "billing", "quota", "credential") and matches
  // ordinary task content, so it is NEVER applied here (verifier round 2, D4).
  const claim = parseClaim(text);
  // One narrow, fail-closed exception (PR #598 round 3, R2-D3b, within the lead's D3 rule
  // "nothing counted"): a clean result with NO `DONE` / `NOT DONE` line whose text names the
  // subscription's usage quota is the CLI reporting the quota, not an agent outcome. It stops
  // the run as `usage-limit` and nothing is counted. The usage vocabulary has no bare numbers,
  // so fixture qty values (401 / 403 / 429) cannot trigger it; a result WITH a claim line is
  // never reclassified. The quota wording may be on stderr alone (lead ruling 03:58Z, #606
  // S1): a claimless clean result is tested together with stderr; with a claim line, stderr
  // never matters. Round 3, L1 (lead rule 04:52Z): the same holds for a narrow, numberless set
  // of exact CLI billing and auth phrases (`CLEAN_RESULT_*_TEXT`), which stop with their own
  // class; the broad billing / auth / transient vocabulary is still never applied here.
  if (claim === "no-claim") {
    const cls = classOfClaimlessCleanResult(`${text}\n${stderr}`);
    if (cls !== null)
      fault(
        cls,
        `claude returned a clean result with no claim, and its text or stderr names a ${cls} fault`,
      );
  }
  return { claim, usage };
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
