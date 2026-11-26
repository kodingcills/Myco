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
 *  - resolves only after the process exited; on the trial deadline it kills the process and
 *    throws `HarnessFault("timeout")`;
 *  - reads the final `--output-format json` result: the claim from the last line of the final
 *    message (`DONE` / `NOT DONE`, anything else is no claim) and the token usage. A rate-limit
 *    or usage-limit error is `HarnessFault("rate-limit")`; unparseable output is
 *    `HarnessFault("transport-error")`; a failure to start is `spawn-failed`. Any result the
 *    agent itself produced (including an error result) is the agent's outcome, never retried.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentLaunchPlan, mcpConfigJson } from "../integrity/launch.ts";
import type { CaptureInput } from "../integrity/vault.ts";
import type { TokenUsage } from "./cost.ts";
import { childEnv } from "./launch.ts";
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
}

const RATE_LIMIT = /rate[ _-]?limit|usage limit|too many requests|\b429\b|overloaded/i;

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

/** Classify the process outcome; throws `HarnessFault` for harness-side failures. */
export function interpretResult(stdout: string, stderr: string, code: number | null): AgentReport {
  let result: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      result = parsed as Record<string, unknown>;
  } catch {
    result = null;
  }
  const text = typeof result?.result === "string" ? result.result : "";
  const usage = parseUsage(result?.usage);
  const errorText = `${result?.is_error === true ? text : ""}\n${result === null ? stderr : ""}`;
  if (RATE_LIMIT.test(errorText))
    throw new HarnessFault("rate-limit", "the subscription reported a rate or usage limit", usage);
  if (result === null || result.type !== "result")
    throw new HarnessFault(
      "transport-error",
      `claude exited ${String(code)} without a JSON result (stderr ${stderr.length} bytes)`,
      usage,
    );
  return { claim: parseClaim(text), usage };
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
            const onAbort = () => {
              timedOut = true;
              child.kill("SIGTERM");
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
              ctx.signal.removeEventListener("abort", onAbort);
              reject(new HarnessFault("spawn-failed", error.message));
            });
            child.on("close", (code) => {
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
