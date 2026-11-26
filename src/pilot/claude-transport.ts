/**
 * The live pilot transport: one headless Claude Code process per attempt, on the subscription.
 *
 * NOT exercised against a real `claude` in this repo's tests: `spawn` is injected, and the
 * tests hand it a fake that checks the argv and environment and returns canned output. The
 * runner CLI (`scripts/m2-r1-pilot.ts`) refuses a live launch unless it gets the explicit
 * flag and the printed plan's hash, and in this change it also has no `capture` (the VM-side
 * copy of the saved document is the lead-approved later step), so it cannot start a real
 * trial.
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
 *    `NOT DONE`, anything else is no claim) and the token usage. Everything else is a harness
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
import { childEnv } from "./launch.ts";
import type { PilotHarnessClass } from "./ledger.ts";
import {
  type AgentReport,
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
 * Text fallback, only for output that carries no structured class. Subscription limit
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
  // The most actionable class wins: a lost login pauses, a limit backs off.
  if (found.includes("auth")) return "auth";
  if (found.includes("rate-limit")) return "rate-limit";
  return "error-result";
}

/**
 * Classify the process outcome; throws `HarnessFault` for every harness-side or uncertain
 * outcome. Returns the agent's report only for a clean result: `type: "result"`, subtype
 * `success`, `is_error` false, exit status 0, and no structured error on any message. A clean
 * result whose final message makes no claim and reads as a limit or login message is a
 * harness fault too (an unflagged limit message is not an agent outcome).
 */
export function interpretResult(stdout: string, stderr: string, code: number | null): AgentReport {
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
  const claim = parseClaim(text);
  if (claim === "no-claim") {
    const cls = classOfText(text);
    if (cls !== null) fault(cls, `the final message is a ${cls} message with no claim`);
  }
  return { claim, usage };
}

export function claudeDriver(opts: ClaudeDriverOptions): PilotDriver {
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
