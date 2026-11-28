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
 * two MCP servers (`myco-gate`, bound to this trial, and the separate `myco-hcu` actuator
 * that gives the agent its desktop action tools, #732), one MCP config path.
 */
import { join, normalize } from "node:path";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import { SERVER_NAME } from "../gate/mcp-server.ts";
import type { AgentLaunchPlan } from "../integrity/launch.ts";
import { correctionPolicy, type PilotConfig } from "./config.ts";
import { ACTUATOR_SERVER_NAME } from "./hcu-actuator.ts";

// The subscription preflight and the environment allowlist builder live in `claude-cli.ts`
// (dependency-free, TIF-268) and are re-exported here unchanged.
export {
  API_CREDENTIAL_NAMES,
  childEnv,
  type PreflightResult,
  preflightRefusal,
  subscriptionPreflight,
} from "./claude-cli.ts";

export interface TrialIds {
  readonly runId: string;
  readonly trialKey: string;
}

function fill(s: string, vars: Readonly<Record<string, string>>): string {
  return s.replace(/\{([A-Z_]+)\}/g, (m, k: string) => (k in vars ? (vars[k] as string) : m));
}

/** `--corrections <families>` when the config turns corrections on, else nothing. */
export function correctionsArgs(config: Pick<PilotConfig, "corrections">): string[] {
  const policy = correctionPolicy(config);
  return policy === undefined ? [] : ["--corrections", policy.families.join(",")];
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
        // The A/B's ON arm (and only it) adds the gate's own `--corrections` flag.
        args: [
          ...config.gateServerTemplate.args.map((a) => fill(a, vars)),
          ...correctionsArgs(config),
        ],
        env: {},
      },
      // The agent's action tools (#732): a separate server, with no trial, run or path input.
      [ACTUATOR_SERVER_NAME]: {
        command: config.actuatorServerTemplate.command,
        args: config.actuatorServerTemplate.args.map((a) => fill(a, vars)),
        env: {},
      },
    },
  };
}
