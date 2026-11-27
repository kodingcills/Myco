/**
 * TIF-268 - the `hcu+shell` planner on the Claude SUBSCRIPTION: one headless Claude Code call
 * per planner decision. There is no API-key path in this module, by construction and by test.
 *
 * Lead ruling 2026-11-27 01:35Z: the head-to-head arm runs at $0 Anthropic API. Paid API use
 * is not approved, so C1's `createPlanner` (`../planner.ts`, `POST /v1/messages`) is never
 * used here, and this module neither reads, requires nor falls back to an Anthropic key:
 *
 *  - Construction refuses (`PlannerRefusal`, code `api-key-path-configured`) when any
 *    variable that would put Claude Code on an API account or another provider is set in the
 *    parent environment. The check is `subscriptionPreflight` from the myco-gate arm's
 *    launcher (`src/pilot/launch.ts`), by NAME only: no value is read.
 *  - The child gets an environment built from the myco-gate arm's allowlist of names
 *    (`childEnv`, `CHILD_ENV_ALLOWLIST`), plus one fixed non-secret setting (the output
 *    ceiling). An API key that slipped past the preflight is still not passed down.
 *  - Every call is checked against the CLI's own `system/init` event: `apiKeySource` must be
 *    `none` (the logged-in subscription). Anything else, or no init event, halts the run
 *    with `planner-api-key-path` / `planner-auth-source-unknown` after that one call: the
 *    CLI found an API credential somewhere we cannot see (a settings file, a helper), and we
 *    stop rather than spend on it.
 *
 * Errors from the CLI are classified by the myco-gate arm's transport classifier
 * (`interpretResult` in `src/pilot/claude-transport.ts`, reused, not copied): an auth fault
 * halts with `planner-auth`, a credit, billing, quota or usage-limit fault halts with
 * `planner-quota`. A halt is final for the run (no retry loop): the runner stops, writes the
 * code to its progress file, and exits. Any other CLI fault is a `PlannerFailure` for this
 * trial only, with a code the runner's two-identical-failures rule counts.
 *
 * Settings parity with the myco-gate arm (`src/pilot/config.ts` `ARGV_TEMPLATE`): the same
 * model (`PILOT_MODEL`), `--setting-sources ""` (no user/project settings, hooks or
 * `apiKeyHelper`), `--strict-mcp-config` with no MCP server, `--tools ""` (no built-in tool),
 * `--permission-mode dontAsk`, and the same environment allowlist. Differences, all forced by
 * the arm's design (`docs/research/m2-hcu-shell-arm.md`, "Asymmetries"), are recorded in
 * `PLANNER_DIFFERENCES` and printed in the run plan.
 *
 * The CLI wrapper itself is the myco-gate arm's: the classifier, the env builder and the
 * spawn type are imported from the pilot transport. Only the per-call plumbing differs,
 * because this arm sends a screenshot on stdin (`--input-format stream-json`), which the
 * gate arm's one-shot `-p PROMPT` launch does not do.
 */
import type { ChildProcess } from "node:child_process";
import type { Screenshot } from "../c1.ts";
import type { Usage } from "../index.ts";
import { HarnessFault } from "../../pilot/runner.ts";
import { interpretResult, parseUsage, type SpawnFn } from "../../pilot/claude-transport.ts";
import { CHILD_ENV_ALLOWLIST, PILOT_MODEL } from "../../pilot/config.ts";
import { estimateCost } from "../../pilot/cost.ts";
import { childEnv, subscriptionPreflight } from "../../pilot/launch.ts";
import {
  HCU_SHELL_PROMPT,
  type HcuShellDecision,
  OUTPUT_CEILING,
  parseHcuShellDecision,
  renderShellHistory,
} from "../hcu-shell/decision.ts";
import type { HcuShellPlanner } from "../hcu-shell/trial.ts";

/** The planner model: the myco-gate arm's, so the head-to-head compares one model. */
export const HCU_PLANNER_MODEL = PILOT_MODEL;

/**
 * The headless argv for one planner call. Every flag the myco-gate arm sets that applies to
 * a tool-less call is set the same way; see `PLANNER_DIFFERENCES` for the rest.
 */
export const PLANNER_ARGV: readonly string[] = [
  "-p",
  "--model",
  HCU_PLANNER_MODEL,
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--tools",
  "",
  "--permission-mode",
  "dontAsk",
  "--max-turns",
  "1",
];

/** The one setting added to the child's environment: C1's per-call output ceiling (#340). */
export const PLANNER_FIXED_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(OUTPUT_CEILING),
};

/** The only `apiKeySource` a subscription session reports. Anything else halts. */
export const SUBSCRIPTION_KEY_SOURCE = "none";

export const PLANNER_DIFFERENCES: readonly string[] = [
  "one headless call per planner decision (the arm's loop owns the step budget and the GUI), where the myco-gate arm is one call per trial",
  "screenshot sent on stdin as a stream-json user message (--input-format/--output-format stream-json --verbose); the gate arm sends its prompt with -p",
  "--max-turns 1 and no tool at all: the arm's actions are returned as JSON and executed by the harness, not by Claude Code",
  "per-call output ceiling 1024 tokens (CLAUDE_CODE_MAX_OUTPUT_TOKENS), C1's ceiling recorded on every hcu+shell row; the gate arm sets none",
  "the hcu+shell prompt (C1's prompt with the shell sentence) is the user message; the gate arm appends its gate instruction to the system prompt",
];

export type PlannerHaltCode =
  | "api-key-path-configured"
  | "planner-api-key-path"
  | "planner-auth-source-unknown"
  | "planner-auth"
  | "planner-quota"
  | "planner-model-mismatch";

/** A refusal or halt: the run stops with this code and is never retried automatically. */
export class PlannerHalt extends Error {
  constructor(
    readonly code: PlannerHaltCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PlannerHalt";
  }
}

/** A per-trial planner failure (not a halt). `code` feeds the two-identical-failures rule. */
export class SubscriptionPlannerFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SubscriptionPlannerFailure";
  }
}

export interface SubscriptionPlannerOptions {
  readonly spawn: SpawnFn;
  /** The `claude` executable. */
  readonly command: string;
  /** The parent environment: its NAMES are checked, and only allowlisted names are passed. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** One call's deadline; SIGTERM, then SIGKILL after `killGraceMs`. Default 180 s. */
  readonly callTimeoutMs?: number;
  readonly killGraceMs?: number;
}

export const DEFAULT_CALL_TIMEOUT_MS = 180_000;

/** The stream-json user message for one turn: the screenshot, then the prompt text. */
export function plannerInput(turn: Parameters<HcuShellPlanner["act"]>[0]): string {
  const history = renderShellHistory(turn.shellHistory);
  const text = `${HCU_SHELL_PROMPT}\nTask: ${turn.instruction}${history ? `\n${history}` : ""}`;
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: turn.screenshot.mimeType, data: turn.screenshot.data },
        },
        { type: "text", text },
      ],
    },
  })}\n`;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Stream-json stdout: one JSON object per line. An unparseable line drops the whole output. */
export function parseStream(stdout: string): Record<string, unknown>[] | null {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (!isObj(v)) return null;
      out.push(v);
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * Read one finished call. Throws `PlannerHalt` for anything that must stop the run, and
 * `SubscriptionPlannerFailure` for a per-trial fault. Pure: the tests drive it directly.
 */
export function readPlannerCall(
  stdout: string,
  stderr: string,
  code: number | null,
): { text: string; usage: Usage } {
  const messages = parseStream(stdout);
  // Classification first, on the gate arm's own classifier (it reads arrays of messages).
  try {
    interpretResult(messages === null ? stdout : JSON.stringify(messages), stderr, code);
  } catch (error) {
    if (error instanceof HarnessFault) {
      if (error.harnessClass === "auth")
        throw new PlannerHalt("planner-auth", "the CLI reported an authentication fault");
      if (error.harnessClass === "rate-limit")
        throw new PlannerHalt(
          "planner-quota",
          "the CLI reported a credit, billing, quota or usage-limit fault",
        );
      throw new SubscriptionPlannerFailure(`planner-${error.harnessClass}`, error.message);
    }
    throw new SubscriptionPlannerFailure("planner-transport-error", "unreadable CLI output");
  }
  // A clean result: interpretResult accepted it, so `messages` parsed.
  const all = messages ?? [];
  const init = all.find((m) => m.type === "system" && m.subtype === "init");
  if (init === undefined || typeof init.apiKeySource !== "string")
    throw new PlannerHalt(
      "planner-auth-source-unknown",
      "no system/init event naming apiKeySource; refusing to assume the subscription",
    );
  if (init.apiKeySource !== SUBSCRIPTION_KEY_SOURCE)
    throw new PlannerHalt(
      "planner-api-key-path",
      "the CLI authenticated with an API credential, not the subscription",
    );
  if (init.model !== HCU_PLANNER_MODEL)
    throw new PlannerHalt(
      "planner-model-mismatch",
      `the CLI ran ${String(init.model)}, not ${HCU_PLANNER_MODEL}`,
    );
  const results = all.filter((m) => m.type === "result");
  const result = results[results.length - 1] ?? {};
  const text = typeof result.result === "string" ? result.result : "";
  const tokens = parseUsage(result.usage);
  const usage: Usage = {};
  if (tokens !== null) {
    usage.prompt = tokens.inputTokens + tokens.cacheReadInputTokens + tokens.cacheCreationInputTokens;
    usage.completion = tokens.outputTokens;
    const estimate = estimateCost(HCU_PLANNER_MODEL, tokens).estimatedModelUsd;
    // Unmeasured stays absent (the runner turns that into a null cost, never 0).
    if (estimate !== null) usage.cost = estimate;
  }
  return { text, usage };
}

/**
 * The subscription planner. `paid` is true in the sense the arm row uses it: cost is
 * measured, as a token-derived estimate at frozen rates (`src/pilot/cost.ts`), the same
 * convention as the myco-gate pilot. Nothing is billed per token on the subscription.
 */
export function createSubscriptionPlanner(opts: SubscriptionPlannerOptions): HcuShellPlanner {
  const pre = subscriptionPreflight(Object.keys(opts.env));
  if (!pre.ok)
    throw new PlannerHalt(
      "api-key-path-configured",
      `API-path variable(s) configured: ${pre.configured.join(", ")} (names checked, values never read)`,
    );
  const env = { ...childEnv(opts.env, CHILD_ENV_ALLOWLIST), ...PLANNER_FIXED_ENV };
  const timeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  async function call(input: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = opts.spawn(opts.command, PLANNER_ARGV, {
          cwd: opts.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        reject(new SubscriptionPlannerFailure("planner-spawn-failed", "could not start claude"));
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let exited = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, opts.killGraceMs ?? 10_000);
        killTimer.unref?.();
      }, timeoutMs);
      deadline.unref?.();
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", () => {
        exited = true;
        clearTimeout(deadline);
        clearTimeout(killTimer);
        reject(new SubscriptionPlannerFailure("planner-spawn-failed", "claude failed to start"));
      });
      child.on("close", (code) => {
        exited = true;
        clearTimeout(deadline);
        clearTimeout(killTimer);
        if (timedOut) reject(new SubscriptionPlannerFailure("planner-timeout", "call deadline passed"));
        else resolve({ stdout, stderr, code });
      });
      child.stdin?.on("error", () => {
        // The process may exit before reading stdin; its exit is classified on close.
      });
      child.stdin?.end(input);
    });
  }

  return {
    paid: true,
    async act(turn) {
      const ran = await call(plannerInput(turn));
      const { text, usage } = readPlannerCall(ran.stdout, ran.stderr, ran.code);
      const calls = [{ model: HCU_PLANNER_MODEL, usage }];
      const decision: HcuShellDecision | undefined = parseHcuShellDecision(text.trim());
      return decision === undefined ? { calls } : { calls, decision };
    },
  };
}

/** A tiny valid PNG (1x1), for the operator's no-VM planner probe. */
export const PROBE_SCREENSHOT: Screenshot = {
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
};
