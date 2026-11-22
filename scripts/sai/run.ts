/**
 * Sai arm 001 runner. `--dry-run` prints the plan and makes no network call and reads no secret.
 * Live stages run only under the free-tier guard; see PROTOCOL.md and README.md.
 *
 *   tsx scripts/sai/run.ts --dry-run
 *   tsx scripts/sai/run.ts --stages s0,t1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { loadApiKey, SaiClient } from "./client.ts";
import type { Control } from "./control.ts";
import { Guard, GuardStop } from "./guard.ts";
import { Ledger } from "./ledger.ts";
import { checkMcpServer } from "./mcp.ts";
import { renderPlan } from "./plan.ts";
import { scrubDeep } from "./redact.ts";
import { runStage, type StageContext } from "./stages.ts";

export const EXPERIMENT_DIR = "docs/research/experiments/sai-arm-001";
export const STATE_FILE = "/private/tmp/sai-setup/state.json";

export interface RunnerState {
  initialUsd: number | null;
  machineId: string | null;
  approvalCount: number;
  /** Full (unscrubbed) ids needed by later stages; private file only, never committed. */
  turns: Record<string, { turnId: string; sessionId: string }>;
  priv: Record<string, unknown>;
}

const emptyState = (): RunnerState => ({
  initialUsd: null,
  machineId: null,
  approvalCount: 0,
  turns: {},
  priv: {},
});

export function loadState(file = STATE_FILE): RunnerState {
  if (existsSync(file)) {
    try {
      return {
        ...emptyState(),
        ...(JSON.parse(readFileSync(file, "utf8")) as Partial<RunnerState>),
      };
    } catch {
      /* fall through */
    }
  }
  return emptyState();
}

export function saveState(state: RunnerState, file = STATE_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}

export interface CliArgs {
  dryRun: boolean;
  stages: string[];
  out: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { dryRun: false, stages: [], out: join(EXPERIMENT_DIR, "raw") };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--stages") args.stages = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--out") args.out = argv[++i] ?? args.out;
  }
  return args;
}

function loadResults(file: string): Record<string, unknown> {
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.dryRun) {
    process.stdout.write(`${renderPlan()}\n`);
    return 0;
  }
  if (args.stages.length === 0) {
    process.stderr.write("no --stages given (or use --dry-run)\n");
    return 2;
  }
  mkdirSync(args.out, { recursive: true });
  const ledger = new Ledger(join(args.out, "ledger.jsonl"));
  const guard = new Guard();
  const state = loadState();
  if (state.initialUsd !== null) guard.initialUsd = state.initialUsd;
  const client = new SaiClient(loadApiKey(), ledger, guard);
  const resultsFile = join(args.out, "results.json");
  const results = loadResults(resultsFile);
  const persist = () => {
    writeFileSync(resultsFile, `${JSON.stringify(scrubDeep(results), null, 2)}\n`);
    state.initialUsd = guard.initialUsd;
    saveState(state);
  };
  const ctx: StageContext = {
    client,
    ledger,
    guard,
    results,
    state,
    persist,
    control: null as unknown as Control,
    mcp: checkMcpServer,
  };
  let code = 0;
  try {
    await client.account("init", "account-initial");
    persist();
    for (const stage of args.stages) {
      await runStage(stage, ctx);
      persist();
    }
  } catch (e) {
    if (e instanceof GuardStop) {
      ledger.append({ stage: "guard", label: "stop", kind: "guard", note: e.message });
      results.stop = { reason: e.info.reason, detail: e.info.detail };
      process.stderr.write(`STOPPED: ${e.message}\n`);
      code = 3;
    } else {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      ledger.append({ stage: "error", label: "unexpected", kind: "note", note: message });
      process.stderr.write(`ERROR: ${scrubDeep(message)}\n`);
      code = 1;
    }
  } finally {
    persist();
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
