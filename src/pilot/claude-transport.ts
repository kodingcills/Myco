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
import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentLaunchPlan, mcpConfigJson } from "../integrity/launch.ts";
import type { CaptureInput } from "../integrity/vault.ts";
import {
  API_CREDENTIAL_NAMES,
  childEnv,
  HarnessFault,
  interpretResult,
  type SpawnFn,
} from "./claude-cli.ts";
import type { AgentReport, AttemptContext, PilotDriver, PilotTransport } from "./runner.ts";

// The classifier and the spawn type live in `claude-cli.ts` (dependency-free, TIF-268: the
// hcu+shell arm imports the very same classifier from there without loading the pilot runner)
// and are re-exported here unchanged, so every existing importer keeps working.
export {
  AUTH_TEXT,
  apiKeySourceProblem,
  BILLING_TEXT,
  CLEAN_RESULT_AUTH_TEXT,
  CLEAN_RESULT_BILLING_TEXT,
  classOfClaimlessCleanResult,
  classOfFailure,
  classOfStatus,
  classOfText,
  classOfUncleanRun,
  interpretResult,
  namesUsageLimit,
  parseClaim,
  parseUsage,
  RATE_LIMIT_TEXT,
  type SpawnFn,
  structuredClass,
  USAGE_LIMIT_TEXT,
  vocabularyForms,
} from "./claude-cli.ts";

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
