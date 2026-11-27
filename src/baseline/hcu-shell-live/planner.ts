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
 * Whether a call completed normally, and how a call that did not is classed, is decided by
 * the myco-gate arm's merged classifier (#598 + #607), imported, not copied (round 4:
 * `classOfUncleanRun` and `classOfClaimlessCleanResult` from `src/pilot/claude-cli.ts`, through
 * `./subscription-faults.ts`), and every class halts the run except the explicit per-trial list:
 *  - `auth` halts `planner-auth`; `billing` (credit, billing, quota, HTTP 402) halts
 *    `planner-billing`; the subscription's usage quota halts `planner-usage-limit` (lead
 *    ruling 02:18Z: its own exit code, no retry, no attempt spent, reported to the lead);
 *  - a transient 429 / 529 / overloaded is a `PlannerTransient`: the runner backs off, bounded;
 *  - an unclassified error result or unreadable output is a `SubscriptionPlannerFailure` for
 *    this trial only, with a code the runner's two-identical-failures rule counts.
 * A call that DID complete normally is the agent's turn, with one fail-closed exception (round
 * 3 N1; round 4, as #607): a clean result with no parseable decision whose text OR stderr names
 * the usage quota (Unicode whitespace folded; "You've hit your limit" included), or one of the
 * narrow billing / auth phrases, halts with that class. A result with a valid decision is never
 * reclassified (the decision plays the myco-gate arm's claim line). With no result event,
 * stdout and stderr are classified together (N2, #598's R2-D3a).
 * A halt is final for the run (no retry loop). An `apiKeySource` other than `none` on ANY
 * message halts `planner-api-key-path`, whatever the call's outcome (as #598).
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
import {
  CHILD_ENV_ALLOWLIST,
  childEnv,
  PILOT_MODEL,
  parseUsage,
  type SpawnFn,
  subscriptionPreflight,
} from "../../pilot/claude-cli.ts";
import type { TokenUsage } from "../../pilot/cost.ts";
import type { Screenshot } from "../c1.ts";
import {
  HCU_SHELL_PROMPT,
  type HcuShellDecision,
  OUTPUT_CEILING,
  parseHcuShellDecision,
  renderShellHistory,
} from "../hcu-shell/decision.ts";
import type { HcuShellPlanner } from "../hcu-shell/trial.ts";
import type { Usage } from "../index.ts";
import {
  failedCallClass,
  PER_TRIAL_CLASSES,
  reportsApiKeySource,
  type SubscriptionFaultClass,
  undecidedCleanCallClass,
} from "./subscription-faults.ts";

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
  // Round 2 (verifier D6): every remaining difference from the myco-gate arm (#598 @ fc01e69a).
  "the agent's tools: HCU's pixel GUI tool plus the read-only shell, where the gate arm's agent has Myco's gate tool (the head-to-head itself)",
  "document: the published fixture CSV is hash-checked on the host, converted to .xlsx in the guest and opened in Calc, and the .xlsx is captured; the gate arm seeds and captures the raw CSV (doc.csv). fc-v1 declares persistedFormat xlsx and a GUI agent needs the document open; the gate arm's CSV is its pilot gate's CSV-only limit (#598 follow-up 1). Material to R2: the lead's GO on this plan decides it",
  "seed check: the guest-made .xlsx is read back, required non-empty and hashed (seededSha256), not compared to host bytes, because the host never holds the .xlsx; the gate arm compares its read-back with the bytes it wrote",
  "repeat-failure signature: the harness's failure code, where the gate arm uses class plus message; both persist it in the ledger and restore it on --resume",
  "load gate: an attempt waits (30 s polls, pause after 1800 s) while host 1-minute load >= 10; the gate arm records the start load and the M2 evidence rule refuses rows at >= 10 (same threshold)",
  "the reset is given trial-base-v3 explicitly and killed after 20 min; the gate arm relies on the script's default and its trial deadline",
  "own ledger, progress and host-capture schemas (myco.hcu-shell.*); live-status.json has the gate arm's shape with runner hcu-shell",
];

export type PlannerHaltCode =
  | "api-key-path-configured"
  | "planner-api-key-path"
  | "planner-auth-source-unknown"
  | "planner-auth"
  | "planner-billing"
  | "planner-usage-limit"
  | "planner-model-mismatch"
  | "planner-fault-unknown";

/** The halt code of each halting fault class; a class missing here halts `planner-fault-unknown`. */
const HALT_CODE: Readonly<Partial<Record<SubscriptionFaultClass, PlannerHaltCode>>> = {
  auth: "planner-auth",
  billing: "planner-billing",
  "usage-limit": "planner-usage-limit",
};

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

/**
 * A transient limit (HTTP 429 / 529, overloaded, "rate limit", "too many requests") with no
 * usage-quota wording. The runner backs off and re-runs the trial at most
 * `MAX_TRANSIENT_RETRIES_PER_TRIAL` times in total in the run directory (counted from the
 * ledger, so `--resume` cannot reset it), never spending an attempt.
 */
export class PlannerTransient extends Error {
  readonly code = "planner-rate-limit";
  constructor(message: string) {
    super(`planner-rate-limit: ${message}`);
    this.name = "PlannerTransient";
  }
}

/** A planner whose in-flight calls the runner can stop when a trial's deadline passes. */
export interface CancellablePlanner extends HcuShellPlanner {
  /** Stop every in-flight call now (SIGTERM, then SIGKILL after the grace); idempotent. */
  cancel?(): void;
}

export interface SubscriptionPlannerOptions {
  readonly spawn: SpawnFn;
  /** The `claude` executable. */
  readonly command: string;
  /** The parent environment: its NAMES are checked, and only allowlisted names are passed. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /**
   * Prices one call's tokens as a token-derived ESTIMATE (the runner passes the pilot's frozen
   * rates, `estimateCost`); null when unpriced. Injected so this module loads no cost tables.
   */
  readonly price: (tokens: TokenUsage) => number | null;
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
          source: {
            type: "base64",
            media_type: turn.screenshot.mimeType,
            data: turn.screenshot.data,
          },
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
  price: (tokens: TokenUsage) => number | null,
): { text: string; usage: Usage } {
  const messages = parseStream(stdout);
  const all = messages ?? [];
  // An API-key session is never spent on, whatever the call's outcome (as #598).
  if (reportsApiKeySource(all))
    throw new PlannerHalt(
      "planner-api-key-path",
      "the CLI authenticated with an API credential, not the subscription",
    );
  const results = all.filter((m) => m.type === "result");
  const last = results[results.length - 1] ?? null;
  // Did the call complete normally? The myco-gate arm's own rule (`classOfUncleanRun`, round
  // 4: imported, one classifier). No result event: the raw stdout (even unparseable) is
  // classified with stderr (N2); an unmapped structured error falls back to the text (#607 B2).
  const cls = failedCallClass(all, last, stderr, stdout, code);
  if (cls !== null) {
    if (PER_TRIAL_CLASSES.has(cls))
      throw new SubscriptionPlannerFailure(`planner-${cls}`, `the CLI call failed (${cls})`);
    if (cls === "rate-limit")
      throw new PlannerTransient("the CLI reported a transient rate limit or overload");
    throw new PlannerHalt(
      HALT_CODE[cls] ?? "planner-fault-unknown",
      `the CLI reported a ${cls} fault; no retry`,
    );
  }
  const result = last ?? {};
  const text = typeof result.result === "string" ? result.result : "";
  // The one narrow, fail-closed exception to "a clean result is the agent's" (round-3 verifier
  // N1; round 4: the myco-gate arm's #606 S1 / S2 and #607 B1 / L1 rule, imported): a clean
  // result with NO parseable decision whose text or stderr names the subscription's usage quota,
  // or one of the narrow numberless billing / auth phrases, is the CLI reporting a fault, not an
  // agent turn. It halts with that class (`planner-usage-limit`: exit 7; no row, nothing
  // counted, no further call). The broad vocabulary (bare 401 / 403 / 429, "billing", "quota")
  // is never applied here, so task data cannot trigger it, and a result WITH a valid decision
  // (this arm's counterpart of the myco-gate arm's claim line) is never reclassified.
  if (parseHcuShellDecision(text.trim()) === undefined) {
    const undecided = undecidedCleanCallClass(text, stderr);
    if (undecided !== null)
      throw new PlannerHalt(
        HALT_CODE[undecided] ?? "planner-fault-unknown",
        `the CLI returned a clean result with no decision whose text or stderr names a ${undecided} fault; no retry`,
      );
  }
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
  const tokens = parseUsage(result.usage);
  const usage: Usage = {};
  if (tokens !== null) {
    usage.prompt =
      tokens.inputTokens + tokens.cacheReadInputTokens + tokens.cacheCreationInputTokens;
    usage.completion = tokens.outputTokens;
    const estimate = price(tokens);
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
export function createSubscriptionPlanner(opts: SubscriptionPlannerOptions): CancellablePlanner {
  const pre = subscriptionPreflight(Object.keys(opts.env));
  if (!pre.ok)
    throw new PlannerHalt(
      "api-key-path-configured",
      `API-path variable(s) configured: ${pre.configured.join(", ")} (names checked, values never read)`,
    );
  const env = { ...childEnv(opts.env, CHILD_ENV_ALLOWLIST), ...PLANNER_FIXED_ENV };
  const timeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  // The in-flight calls' expiry, so the runner's trial deadline can stop them (`cancel`).
  const inFlight = new Set<() => void>();

  async function call(
    input: string,
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
      const expire = () => {
        if (timedOut || exited) return;
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, opts.killGraceMs ?? 10_000);
        killTimer.unref?.();
      };
      inFlight.add(expire);
      const deadline = setTimeout(expire, timeoutMs);
      deadline.unref?.();
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", () => {
        exited = true;
        inFlight.delete(expire);
        clearTimeout(deadline);
        clearTimeout(killTimer);
        reject(new SubscriptionPlannerFailure("planner-spawn-failed", "claude failed to start"));
      });
      child.on("close", (code) => {
        exited = true;
        inFlight.delete(expire);
        clearTimeout(deadline);
        clearTimeout(killTimer);
        if (timedOut)
          reject(new SubscriptionPlannerFailure("planner-timeout", "call deadline passed"));
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
    cancel() {
      for (const expire of [...inFlight]) expire();
    },
    async act(turn) {
      const ran = await call(plannerInput(turn));
      const { text, usage } = readPlannerCall(ran.stdout, ran.stderr, ran.code, opts.price);
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
