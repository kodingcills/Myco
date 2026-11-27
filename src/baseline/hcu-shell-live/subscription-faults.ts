/**
 * TIF-268 round 2 (verifier D1) - how the `hcu+shell` planner classes a headless Claude Code
 * call that did not complete normally. It halts on every class except an explicit per-trial
 * list (`PER_TRIAL_CLASSES`), so a class added later can only stop the run, never slip through
 * as a per-trial failure.
 *
 * PARITY WITH THE MYCO-GATE ARM (#598). The vocabulary, the structured-class mapping, the
 * precedence and the usage-limit refinement are #598's round-2 classifier
 * (`src/pilot/claude-transport.ts` at #598 head 13fccd96: `ERROR_CLASS`, `classOfStatus`,
 * `USAGE_LIMIT_TEXT`, `RATE_LIMIT_TEXT`, `BILLING_TEXT`, `classOfText`, `structuredClass`,
 * `refineLimit`), matched exactly, because #598 has not merged and this arm must not change the
 * pilot runner's behaviour on main (`src/pilot/claude-cli.ts` keeps main's classifier, which
 * the pilot runner on main is reviewed against). `test/baseline/hcu-shell-live/
 * subscription-faults.test.ts` pins #598's vectors, and compares these expressions with the
 * pilot transport's own as soon as that module exports `USAGE_LIMIT_TEXT` (that is, once #598
 * merges): from then on, a drift between the two arms fails the suite. When #598 merges, this
 * module should import its classifier instead (follow-up in the round-2 changes comment).
 *
 * Lead ruling 2026-11-27 02:18Z (on #597 and #598): the subscription's own quota wording
 * ("usage limit reached", "5-hour limit", "Weekly limit reached", "resets at ...") stops the
 * run at once with its own code, no retry, no attempt spent, reported to the lead. Only a
 * transient 429 / 529 / overloaded backs off, bounded.
 *
 * Pure and dependency-free apart from the pilot's unchanged login vocabulary (`AUTH_TEXT`).
 */
import { AUTH_TEXT } from "../../pilot/claude-cli.ts";

export type SubscriptionFaultClass =
  | "auth"
  | "billing"
  | "usage-limit"
  | "rate-limit"
  | "error-result"
  | "transport-error";

/** The only classes that are a per-trial failure; every other class halts the run. */
export const PER_TRIAL_CLASSES: ReadonlySet<SubscriptionFaultClass> = new Set([
  "error-result",
  "transport-error",
]);

/** Claude Code's structured error classes, as #598 round 2 maps them. */
const ERROR_CLASS: Readonly<Record<string, SubscriptionFaultClass>> = {
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
export function classOfStatus(status: number): SubscriptionFaultClass {
  if (status === 429 || status === 529) return "rate-limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  return "error-result";
}

/** The subscription's own quota (#598 round 2, D3). Wins over the transient wording. */
export const USAGE_LIMIT_TEXT =
  /usage[ _-]?limit|(?<!rate[ _-]?)limit (?:reached|exceeded|hit)|limit (?:will )?resets?|\bresets? (?:at |on |in )?(?:\d|mon|tue|wed|thu|fri|sat|sun|tomorrow)|(?:weekly|daily|monthly|hourly|session|\d+[ -]?hour|five[ -]hour|opus|sonnet|haiku|fable) limit/i;

/** A transient API limit: bounded back-off. */
export const RATE_LIMIT_TEXT = /rate[ _-]?limit|too many requests|\b429\b|\b529\b|overloaded/i;

/** Credit, billing and quota wording, HTTP 402: does not clear by waiting. */
export const BILLING_TEXT =
  /credit balance|out of credits?|credits? (?:(?:are|is|have been|has been) )?(?:exhausted|depleted|used up|ran out)|insufficient (?:credits?|funds|balance)|billing|payment (?:required|failed|method)|\b402\b|quota|out of (?:extra )?usage/i;

/** Text fallback, in #598's pinned order: login, billing, usage quota, transient limit. */
export function classOfText(text: string): SubscriptionFaultClass | null {
  if (AUTH_TEXT.test(text)) return "auth";
  if (BILLING_TEXT.test(text)) return "billing";
  if (USAGE_LIMIT_TEXT.test(text)) return "usage-limit";
  if (RATE_LIMIT_TEXT.test(text)) return "rate-limit";
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The structured class, if any message carries one (error class first, then HTTP status). */
export function structuredClass(
  messages: readonly Record<string, unknown>[],
): SubscriptionFaultClass | null {
  const found: SubscriptionFaultClass[] = [];
  for (const m of messages) {
    const inner = isObj(m.message) ? m.message : {};
    for (const e of [m.error, inner.error])
      if (typeof e === "string" && e !== "") found.push(ERROR_CLASS[e] ?? "error-result");
    for (const st of [m.api_error_status, inner.api_error_status])
      if (typeof st === "number" && Number.isInteger(st) && st >= 400)
        found.push(classOfStatus(st));
  }
  if (found.length === 0) return null;
  if (found.includes("auth")) return "auth";
  if (found.includes("billing")) return "billing";
  if (found.includes("rate-limit")) return "rate-limit";
  return "error-result";
}

/** A structured limit is the usage quota when the failed run's own text names it. */
function refineLimit(cls: SubscriptionFaultClass, text: string): SubscriptionFaultClass {
  return cls === "rate-limit" && USAGE_LIMIT_TEXT.test(text) ? "usage-limit" : cls;
}

/**
 * The class of a call that did NOT complete normally. `result` is the last result event (null
 * when there is none). Never called for a clean result: its text is the agent's.
 */
export function failedCallClass(
  messages: readonly Record<string, unknown>[],
  result: Record<string, unknown> | null,
  stderr: string,
): SubscriptionFaultClass {
  const structured = structuredClass(messages);
  if (result === null) {
    const cls = structured === null ? classOfText(stderr) : refineLimit(structured, stderr);
    return cls ?? "transport-error";
  }
  const text = typeof result.result === "string" ? result.result : "";
  const errors = Array.isArray(result.errors)
    ? result.errors.filter((e) => typeof e === "string")
    : [];
  const failedText = `${text}\n${errors.join("\n")}\n${stderr}`;
  const cls = structured === null ? classOfText(failedText) : refineLimit(structured, failedText);
  return cls ?? "error-result";
}

/**
 * #598's `apiKeySourceProblem`: any message naming an `apiKeySource` other than `none` means
 * the CLI is billing an API key, whatever the call's outcome.
 */
export function reportsApiKeySource(messages: readonly Record<string, unknown>[]): boolean {
  return messages.some((m) => Object.hasOwn(m, "apiKeySource") && m.apiKeySource !== "none");
}
