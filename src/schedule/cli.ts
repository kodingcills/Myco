/**
 * `myco-schedule`: the local scheduler service and its operator commands (track S).
 *
 *   myco-schedule serve   --config schedule.json --allow-task fc-v1-001 [--allow-task …]
 *   myco-schedule trigger --config schedule.json --schedule nightly [--key req-42]
 *   myco-schedule pause   --config schedule.json
 *   myco-schedule kill    --config schedule.json     # pause + abort runs in flight
 *   myco-schedule resume  --config schedule.json
 *   myco-schedule status  --config schedule.json
 *
 * `serve` runs the $0 scripted executor only (fc-v1 tasks, scripted agent, real gate): every
 * row is `simulated`. A live executor (agent on the VM) is out of this PR.
 * Output is ids and codes; no command prints a secret, and errors name paths, never values.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseScheduleFile, type ScheduleFile } from "./config.ts";
import { readFcV1Tasks, scriptedFcV1Executor } from "./executor.ts";
import { writeManualRequest } from "./manual.ts";
import { taskAllowListPolicy } from "./runtime.ts";
import { startScheduleService } from "./service.ts";
import { ScheduleState } from "./state.ts";

export interface CliIo {
  readonly stdout: { write(s: string): unknown };
  readonly stderr: { write(s: string): unknown };
  /** Resolves when the service should stop (SIGINT/SIGTERM in the script; tests pass their own). */
  readonly stopSignal?: Promise<void>;
}

const USAGE =
  "usage: myco-schedule <serve|trigger|pause|kill|resume|status> --config <schedule.json> [options]\n";

function flags(argv: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) throw new Error(`unexpected argument at position ${i + 1}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    out.set(a.slice(2), [...(out.get(a.slice(2)) ?? []), v]);
    i++;
  }
  return out;
}

function one(f: Map<string, string[]>, name: string): string | undefined {
  const v = f.get(name);
  if (v && v.length > 1) throw new Error(`--${name} given more than once`);
  return v?.[0];
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  let f: Map<string, string[]>;
  let config: ScheduleFile;
  try {
    f = flags(rest);
    const path = one(f, "config");
    if (!cmd || !path) {
      io.stderr.write(USAGE);
      return 2;
    }
    config = parseScheduleFile(readFileSync(path, "utf8"));
  } catch (e) {
    io.stderr.write(`myco-schedule: ${(e as Error).message}\n`);
    return 2;
  }
  const out = (o: Record<string, unknown>) => io.stdout.write(`${JSON.stringify(o)}\n`);
  try {
    switch (cmd) {
      case "trigger": {
        const scheduleId = one(f, "schedule");
        if (!scheduleId) throw new Error("--schedule is required");
        if (!config.schedules.some((s) => s.id === scheduleId))
          throw new Error("unknown schedule id");
        const key = one(f, "key") ?? randomUUID();
        const state = new ScheduleState(config.stateDir);
        writeManualRequest(state.manualDir, scheduleId, key);
        out({ code: "QUEUED", scheduleId, key });
        return 0;
      }
      case "pause":
      case "kill":
        new ScheduleState(config.stateDir).pause(cmd === "kill" ? "KILLED" : "PAUSED");
        out({ code: cmd === "kill" ? "KILLED" : "PAUSED" });
        return 0;
      case "resume":
        new ScheduleState(config.stateDir).resume();
        out({ code: "RESUMED" });
        return 0;
      case "status": {
        const state = new ScheduleState(config.stateDir);
        const ledger = join(config.stateDir, "ledger.jsonl");
        out({
          paused: state.pauseReason() ?? null,
          cursor: state.readCursor() ?? null,
          ledgerRows: existsSync(ledger)
            ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).length
            : 0,
          schedules: config.schedules.map((s) => s.id),
        });
        return 0;
      }
      case "serve": {
        const allow = f.get("allow-task") ?? [];
        if (allow.length === 0)
          throw new Error("serve needs at least one --allow-task (policies are always applied)");
        const tasksFile =
          one(f, "tasks") ??
          resolve(
            import.meta.dirname,
            "..",
            "..",
            "benchmark",
            "false-completion",
            "fc-v1",
            "tasks.jsonl",
          );
        const workDir = one(f, "work-dir") ?? join(config.stateDir, "work");
        const service = await startScheduleService({
          config,
          policies: [taskAllowListPolicy(allow)],
          executor: scriptedFcV1Executor({ tasks: readFcV1Tasks(tasksFile), workDir }),
          onDiagnostic: (code) => io.stderr.write(`myco-schedule: diagnostic ${code}\n`),
        });
        out({
          code: "SERVING",
          simulated: true,
          webhookPort: service.webhook?.port ?? null,
          schedules: config.schedules.map((s) => s.id),
        });
        await (io.stopSignal ?? new Promise<void>(() => {}));
        await service.stop();
        out({ code: "STOPPED", rows: service.records.length });
        return 0;
      }
      default:
        io.stderr.write(USAGE);
        return 2;
    }
  } catch (e) {
    io.stderr.write(`myco-schedule: ${(e as Error).message}\n`);
    return 1;
  }
}
