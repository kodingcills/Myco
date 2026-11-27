/**
 * The live pilot transport: one headless Claude Code process per attempt, on the subscription.
 *
 * NOT exercised against a real `claude` in this repo's tests: `spawn` is injected, and the
 * tests hand it a fake that checks the argv and environment and returns canned output. Its
 * `capture` is the VM step's host-side read of the guest document (`src/pilot/vm-capture.ts`,
 * `liveVmDriver`); the runner CLIs build it only after every launch precondition holds
 * (`src/pilot/live-launch.ts`).
 *
 * Subscription only (TIF-274): an API-path credential name in the agent's environment
 * allowlist refuses the driver (`apiKeyPathRefusal`), and an `apiKeySource` other than `none`
 * in the CLI's output is an `ApiKeyPathFault` that stops the run (code `api-key`). Credit,
 * billing and quota errors are class `billing` and, like a lost login (`auth`) and the
 * subscription's usage limit (`usage-limit`, its own code, for the lead), stop the run at once
 * with a code: never a back-off or retry loop. Only a transient 429 / 529 / overloaded backs off.
 *
 * What it does, in the order the gated harness requires (`GatedTrialTransport`):
 *  - writes `mcpConfigJson(plan)` to `plan.mcpConfigPath` (the audit pinned the argv to that
 *    path but does not read the file);
 *  - spawns `claude` with exactly `plan.argv` and an environment of allowlisted NAMES only
 *    (`childEnv`): no API key can reach it, and the harness never logs the environment;
 *  - resolves only after the process exited; on the trial deadline it sends SIGTERM, then
 *    SIGKILL after `killGraceMs` if the process is still there, and throws
 *    `HarnessFault("timeout")`;
 *  - reads the final `--output-format json` result and classifies it (`interpretResult`).
 *    Only a clean result (no error flag, subtype `success`, exit 0, no structured error) is
 *    the agent's outcome: the claim from the last line of the final message (`DONE` /
 *    `NOT DONE`, anything else is no claim) and the token usage; a clean result with no claim
 *    whose text names the usage quota is `usage-limit` instead. Everything else is a harness
 *    fault, classified from structured fields first (the assistant message's `error` class,
 *    `api_error_status`, the result `subtype`, `is_error`, exit status) and from a tested
 *    text vocabulary only as a fallback; an error the classifier cannot name is
 *    `HarnessFault("error-result")` (re-run in place), never an agent outcome. A failure to
 *    start is `spawn-failed`; unparseable output is `transport-error`.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentLaunchPlan, mcpConfigJson } from "../integrity/launch.ts";
import type { CaptureInput } from "../integrity/vault.ts";
import type { TokenUsage } from "./cost.ts";
import { API_CREDENTIAL_NAMES, childEnv } from "./launch.ts";
import type { PilotHarnessClass } from "./ledger.ts";
import {
  type AgentReport,
  ApiKeyPathFault,
  type AttemptContext,
  HarnessFault,
  type PilotDriver,
  type PilotTransport,
} from "./runner.ts";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ClaudeDriverOptions {
  readonly spawn: SpawnFn;
  /** The `claude` executable. */
  readonly command: string;
  /** The parent environment, read only for the allowlisted names. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly envAllowlist: readonly string[];
  /** Host copy of the saved document after the agent stopped (the VM step supplies it). */
  readonly capture: (ctx: AttemptContext) => Promise<CaptureInput>;
  /** After SIGTERM on the deadline, wait this long, then SIGKILL. Default 10 s. */
  readonly killGraceMs?: number;
}

export const DEFAULT_KILL_GRACE_MS = 10_000;

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
 * stderr (`interpretResult`). It is always applied through `namesUsageLimit`, which folds
 * Unicode whitespace first.
 *
 * Two kinds of limit (lead ruling, PR #598 round 2, D3):
 *  - `USAGE_LIMIT_TEXT`, the subscription's own quota ("usage limit reached", "5-hour limit
 *    reached ∙ resets 3pm", "Weekly limit reached", "Opus limit reached", "resets at 5pm"):
 *    class `usage-limit`, which stops the run at once with its own code (no retry, no attempt
 *    spent) and goes to the lead. It wins over the transient wording when both appear.
 *  - `RATE_LIMIT_TEXT`, a transient API limit (429 / 529 bodies, "rate limit", "too many
 *    requests", "overloaded"): class `rate-limit`, bounded back-off.
 * The wording varies by plan and version, so the vocabulary is broad;
 * `test/pilot/claude-transport.test.ts` pins it.
 */
export const USAGE_LIMIT_TEXT =
  /usage[ _-]?limit|(?<!rate[ _-]?)limit (?:reached|exceeded|hit)|limit (?:will )?resets?|\bresets? (?:at |on |in )?(?:\d|mon|tue|wed|thu|fri|sat|sun|tomorrow)|(?:weekly|daily|monthly|hourly|session|\d+[ -]?hour|five[ -]hour|opus|sonnet|haiku|fable) limit/i;

/**
 * Whether `text` names the subscription's usage quota. Every Unicode whitespace run (NBSP
 * U+00A0, U+2000-U+200A incl. U+2007, U+202F, U+205F, U+3000, U+FEFF, tabs, newlines, repeated
 * spaces; JS `\s`) is folded to one ASCII space first, because `USAGE_LIMIT_TEXT` spells its
 * spaces as literal ASCII spaces (#606 S2). The vocabulary itself is unchanged. Every
 * usage-limit decision goes through here, never through `USAGE_LIMIT_TEXT` directly.
 */
export function namesUsageLimit(text: string): boolean {
  return USAGE_LIMIT_TEXT.test(text.replace(/\s+/g, " "));
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
  /invalid (?:api )?key|api key|\/login|not logged in|log ?in again|please (?:log|sign) ?in|authenticat|unauthori[sz]ed|oauth|\b401\b|\b403\b|forbidden|credential|account (?:is )?on hold|verification required|token (?:has )?expired/i;

/**
 * The text-fallback class of an error message, or null when it names none. The order is
 * pinned (`test/pilot/claude-transport.test.ts`): a lost login first, then billing, then the
 * subscription's usage quota, then a transient limit.
 */
export function classOfText(text: string): PilotHarnessClass | null {
  if (AUTH_TEXT.test(text)) return "auth";
  if (BILLING_TEXT.test(text)) return "billing";
  if (namesUsageLimit(text)) return "usage-limit";
  if (RATE_LIMIT_TEXT.test(text)) return "rate-limit";
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

export function parseClaim(text: string): AgentReport["claim"] {
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
 * `usage-limit` (round 3, R2-D3b; #606 S1). The full text fallback runs only on runs that did not complete normally (no result
 * event: stdout and stderr; an error result: its text, `errors[]` and stderr; a non-zero or
 * null exit; a structured error).
 */
export function interpretResult(stdout: string, stderr: string, code: number | null): AgentReport {
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
    const cls =
      structured === null ? classOfText(noResultText) : refineLimit(structured, noResultText);
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
    const cls = structured === null ? classOfText(failedText) : refineLimit(structured, failedText);
    fault(
      cls ?? "error-result",
      `claude returned an error result (subtype ${String(r.subtype)}, exit ${String(code)}${cls === null ? ", unclassified" : ""})`,
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
  // never matters.
  if (claim === "no-claim" && namesUsageLimit(`${text}\n${stderr}`))
    fault(
      "usage-limit",
      "claude returned a clean result with no claim, and its text or stderr names the usage limit",
    );
  return { claim, usage };
}

/**
 * Why `claudeDriver` refuses to build: an API-path credential NAME in the agent's environment
 * allowlist, which is the only way one could reach the `claude` process (names only; no value
 * is read). A name in the parent environment is stripped by `childEnv` and refused earlier by
 * the CLI preflight (`subscriptionPreflight`).
 */
export function apiKeyPathRefusal(opts: Pick<ClaudeDriverOptions, "envAllowlist">): string | null {
  const named = API_CREDENTIAL_NAMES.filter((n) => opts.envAllowlist.includes(n));
  if (named.length === 0) return null;
  return `refusing the live driver: API-path credential name(s) ${named.join(", ")} in the agent's environment allowlist; the pilot runs on the Claude subscription only`;
}

export function claudeDriver(opts: ClaudeDriverOptions): PilotDriver {
  const refusal = apiKeyPathRefusal(opts);
  if (refusal !== null) throw new Error(refusal);
  return {
    simulated: false,
    transport(ctx: AttemptContext): PilotTransport {
      let report: AgentReport | null = null;
      return {
        async runAgent(plan: AgentLaunchPlan) {
          writeFileSync(plan.mcpConfigPath, mcpConfigJson(plan));
          const env = childEnv(opts.env, opts.envAllowlist);
          report = await new Promise<AgentReport>((resolve, reject) => {
            let child: ChildProcess;
            try {
              child = opts.spawn(opts.command, plan.argv, {
                cwd: ctx.trialDir,
                env,
                stdio: ["ignore", "pipe", "pipe"],
              });
            } catch (error) {
              reject(new HarnessFault("spawn-failed", String(error)));
              return;
            }
            let stdout = "";
            let stderr = "";
            let timedOut = false;
            let exited = false;
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            const onAbort = () => {
              timedOut = true;
              child.kill("SIGTERM");
              // A process that ignores SIGTERM must not hang the runner.
              killTimer = setTimeout(() => {
                if (!exited) child.kill("SIGKILL");
              }, opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
              killTimer.unref?.();
            };
            if (ctx.signal.aborted) onAbort();
            else ctx.signal.addEventListener("abort", onAbort, { once: true });
            child.stdout?.on("data", (d: Buffer) => {
              stdout += d.toString("utf8");
            });
            child.stderr?.on("data", (d: Buffer) => {
              stderr += d.toString("utf8");
            });
            child.on("error", (error) => {
              exited = true;
              clearTimeout(killTimer);
              ctx.signal.removeEventListener("abort", onAbort);
              reject(new HarnessFault("spawn-failed", error.message));
            });
            child.on("close", (code) => {
              exited = true;
              clearTimeout(killTimer);
              ctx.signal.removeEventListener("abort", onAbort);
              writeFileSync(join(ctx.trialDir, "transcript.json"), stdout);
              if (timedOut) {
                reject(
                  new HarnessFault("timeout", "the trial deadline passed; claude was stopped"),
                );
                return;
              }
              try {
                resolve(interpretResult(stdout, stderr, code));
              } catch (error) {
                reject(error);
              }
            });
          });
        },
        captureAfterStop() {
          return opts.capture(ctx);
        },
        report() {
          if (report === null)
            throw new Error(`${ctx.trialKey}: no agent report (the agent did not finish)`);
          return report;
        },
      };
    },
  };
}
