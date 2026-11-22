/**
 * Sai arm 001 runner. `--dry-run` prints the plan and makes no network call and reads no secret.
 * Live stages run only under the free-tier guard; see PROTOCOL.md and README.md.
 *
 *   tsx scripts/sai/run.ts --dry-run
 *   tsx scripts/sai/run.ts --stages s0,t1
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { loadApiKey, SaiClient } from "./client.ts";
import type { Control } from "./control.ts";
import { Guard, type GuardCounters, GuardStop, validCounters } from "./guard.ts";
import { Ledger } from "./ledger.ts";
import { checkMcpServer } from "./mcp.ts";
import { renderPlan } from "./plan.ts";
import { scrub, scrubDeep } from "./redact.ts";
import { runStage, type StageContext } from "./stages.ts";

export const EXPERIMENT_DIR = "docs/research/experiments/sai-arm-001";
export const STATE_FILE = "/private/tmp/sai-setup/state.json";

export interface RunnerState {
  initialUsd: number | null;
  counters: GuardCounters;
  machineId: string | null;
  approvalCount: number;
  /** Full (unscrubbed) ids needed by later stages; private file only, never committed. */
  turns: Record<string, { turnId: string; sessionId: string }>;
  priv: Record<string, unknown>;
}

export function loadState(file = STATE_FILE): RunnerState {
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as RunnerState;
    if (
      validCounters(state.counters) &&
      (state.initialUsd === null || (Number.isFinite(state.initialUsd) && state.initialUsd >= 0)) &&
      (state.machineId === null || typeof state.machineId === "string") &&
      Number.isSafeInteger(state.approvalCount) &&
      state.approvalCount >= 0 &&
      state.turns &&
      typeof state.turns === "object" &&
      !Array.isArray(state.turns) &&
      state.priv &&
      typeof state.priv === "object" &&
      !Array.isArray(state.priv)
    ) {
      return state;
    }
  } catch {
    // Unreadable state cannot establish how much of the budget remains.
  }
  throw new GuardStop({
    reason: "invalid_state",
    detail: "runner state is missing, unreadable or invalid",
  });
}

export function saveState(state: RunnerState, file = STATE_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx", flush: true });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export interface CliArgs {
  dryRun: boolean;
  checkMcp: boolean;
  stages: string[];
  out: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    checkMcp: false,
    stages: [],
    out: join(EXPERIMENT_DIR, "raw"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--check-mcp") args.checkMcp = true;
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

export function writeOutput(stream: Pick<NodeJS.WriteStream, "write">, text: string): void {
  stream.write(scrub(text));
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.dryRun) {
    writeOutput(process.stdout, `${renderPlan()}\n`);
    return 0;
  }
  if (args.stages.length === 0) {
    writeOutput(process.stderr, "no --stages given (or use --dry-run)\n");
    return 2;
  }
  const lock = `${STATE_FILE}.lock`;
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    writeOutput(process.stderr, "STOPPED: runner state directory unavailable or locked\n");
    return 3;
  }
  try {
    return await runLive(args);
  } catch (error) {
    writeOutput(
      process.stderr,
      error instanceof GuardStop ? `STOPPED: ${error.message}\n` : `ERROR: ${String(error)}\n`,
    );
    return error instanceof GuardStop ? 3 : 1;
  } finally {
    rmdirSync(lock);
  }
}

async function runLive(args: CliArgs): Promise<number> {
  const state = loadState();
  const guard = new Guard(Date.now, state.counters, () => saveState(state));
  mkdirSync(args.out, { recursive: true });
  const ledger = new Ledger(join(args.out, "ledger.jsonl"));
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
    ...(args.checkMcp ? { mcp: checkMcpServer } : {}),
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
      writeOutput(process.stderr, `STOPPED: ${e.message}\n`);
      code = 3;
    } else {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      ledger.append({ stage: "error", label: "unexpected", kind: "note", note: message });
      writeOutput(process.stderr, `ERROR: ${message}\n`);
      code = 1;
    }
  } finally {
    persist();
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      writeOutput(process.stderr, `${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
