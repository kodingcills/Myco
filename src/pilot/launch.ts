/**
 * Headless Claude Code on the subscription path, for one pilot trial.
 *
 * Subscription only, no API-key path at all: `subscriptionPreflight` refuses to start when any
 * variable that would make Claude Code bill an API account or another provider is configured.
 * It reads environment variable NAMES only (`Object.keys`), never a value, and never prints
 * one. The agent process then gets an environment built from an allowlist of names
 * (`childEnv`), so even a credential that slipped past the preflight is not passed down.
 * Claude Code itself authenticates from the operator's logged-in subscription session.
 *
 * The plan (`trialLaunchPlan`) is exactly what `runGatedTrial` audits with
 * `auditAgentLaunch` and hands, frozen, to the transport: argv from the reviewed template,
 * one MCP server (`myco-gate`, bound to this trial), one MCP config path.
 */
import { join, normalize } from "node:path";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import { SERVER_NAME } from "../gate/mcp-server.ts";
import type { AgentLaunchPlan } from "../integrity/launch.ts";
import type { PilotConfig } from "./config.ts";

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

export interface TrialIds {
  readonly runId: string;
  readonly trialKey: string;
}

function fill(s: string, vars: Readonly<Record<string, string>>): string {
  return s.replace(/\{([A-Z_]+)\}/g, (m, k: string) => (k in vars ? (vars[k] as string) : m));
}

/**
 * The launch plan for one trial attempt. `trialDir` must be absolute; the MCP config is
 * `<trialDir>/mcp.json` (normalised, as the audit requires).
 */
export function trialLaunchPlan(
  config: PilotConfig,
  task: BenchmarkTask,
  ids: TrialIds,
  trialDir: string,
  repoRoot: string,
): AgentLaunchPlan {
  const mcpConfigPath = normalize(join(trialDir, "mcp.json"));
  const vars = {
    TASK_ID: task.taskId,
    RUN_ID: ids.runId,
    TRIAL_DIR: normalize(trialDir),
    REPO: normalize(repoRoot),
  };
  const system = fill(config.systemTemplate, vars);
  const argv = config.argvTemplate.map((a) =>
    a === "{PROMPT}"
      ? task.instruction
      : a === "{MCP_CONFIG}"
        ? mcpConfigPath
        : a === "{SYSTEM}"
          ? system
          : a,
  );
  return {
    argv,
    mcpConfigPath,
    mcpServers: {
      [SERVER_NAME]: {
        command: config.gateServerTemplate.command,
        args: config.gateServerTemplate.args.map((a) => fill(a, vars)),
        env: {},
      },
    },
  };
}
