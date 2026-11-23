#!/usr/bin/env node
/**
 * S0 live run (TIF-89) — the command the detached launcher runs.
 *
 *   tsx scripts/s0-live.ts --dry-run   # mock transport; proves the wiring offline
 *   tsx scripts/s0-live.ts --live      # runtime MCP + QEMU guest; needs the window
 *
 * The live path deploys the dogfood app over the guest's SSH, reads the window
 * geometry with xdotool (out-of-band, like the runtime's own live proof), and
 * runs DF-S01 then DF-S02 through the same runner the mock uses. It never starts
 * a guest unless the gate passes: no qemu already running, and the runtime binary
 * present.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runDirectionALive } from "../src/discovery/live-runner.ts";
import { MockDesktop } from "../src/discovery/mock-desktop.ts";
import { RuntimeTransport } from "../src/discovery/runtime-transport.ts";
import {
  persistedStoreOracle,
  REVIEWED_PROBE,
  renderS0Report,
  S0_TASKS,
} from "../src/discovery/s0-sequence.ts";

const ROOT = resolve(import.meta.dirname, "..");
const RUN_DIR = process.env.S0_RUN_DIR ?? "/tmp/myco-s0";
const KEY = join(ROOT, "runtime/guest/keys/id_ed25519");
const SSH = [
  "-i",
  KEY,
  "-p",
  "10022",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
  "myco@localhost",
];
const APP = "dogfood/apps/myco-todo";
const GUEST_APP = "/home/myco/myco-todo";
const STATE = ".myco-todo-state.json";
const STORE = ".myco-todo.json";

/** `strict: false` turns a non-zero exit into empty output (pgrep found nothing). */
function sh(command: string, args: string[], strict = true): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (strict) throw error;
    return String((error as { stdout?: string }).stdout ?? "").trim();
  }
}

function deploy(): void {
  sh("ssh", [...SSH, `mkdir -p ${GUEST_APP}`]);
  sh("scp", [
    "-i",
    KEY,
    "-P",
    "10022",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-r",
    join(ROOT, APP, "."),
    `myco@localhost:${GUEST_APP}`,
  ]);
}

function savePoint(): { x: number; y: number } {
  const geometry = sh("ssh", [
    ...SSH,
    "DISPLAY=:0 xdotool search --name myco-todo getwindowgeometry --shell 2>/dev/null || true",
  ]);
  const field = (name: string) =>
    Number(
      geometry
        .split("\n")
        .find((line) => line.startsWith(`${name}=`))
        ?.split("=")[1] ?? "0",
    );
  const x = field("X");
  const y = field("Y");
  const width = field("WIDTH");
  const height = field("HEIGHT");
  if (!width || !height) throw new Error(`could not read the app window geometry: ${geometry}`);
  // The Save control sits in the lower band of the 420x360 window.
  return { x: x + Math.round(width / 2), y: y + height - 76 };
}

async function live(): Promise<number> {
  if (sh("pgrep", ["-f", "qemu-system-aarch64"], false).length > 0) {
    process.stderr.write("refusing: a qemu guest is already running\n");
    return 2;
  }
  const binary = join(ROOT, "runtime/target/debug/myco-rt-mcp");
  if (!existsSync(binary)) {
    process.stderr.write(
      `refusing: ${binary} is missing; build it with cargo build -p myco-rt-mcp\n`,
    );
    return 2;
  }
  mkdirSync(RUN_DIR, { recursive: true });
  const runs = [];
  for (const task of S0_TASKS) {
    const transport = new RuntimeTransport({
      binary,
      cwd: ROOT,
      readRoot: "/home/myco",
      introspectionPath: STATE,
      sessionId: `s0-${task.id}-${Date.now()}`,
      timeoutMs: 900_000,
    });
    await transport.initialize();
    await transport.create();
    deploy();
    const point = savePoint();
    const result = await runDirectionALive({
      transport,
      probe: REVIEWED_PROBE,
      app: {
        command: "bash",
        args: ["-lc", `MYCO_TODO_STATE_FILE=/home/myco/${STATE} python3 ${GUEST_APP}/myco_todo.py`],
        storePath: STORE,
        savePoint: point,
      },
      items: [...task.items],
      verify: persistedStoreOracle,
      runsDir: join(RUN_DIR, "runs"),
      runId: task.id,
      taskId: task.id,
    });
    runs.push({ id: task.id, title: task.title, expected: task.expected, result });
    await transport.destroy();
  }
  const report = renderS0Report(runs);
  writeFileSync(join(RUN_DIR, "s0-report.md"), report);
  process.stdout.write(report);
  return runs.every((run) => run.result.status === run.expected) ? 0 : 1;
}

async function dryRun(): Promise<number> {
  mkdirSync(RUN_DIR, { recursive: true });
  const runs = [];
  for (const task of S0_TASKS) {
    const result = await runDirectionALive({
      transport: new MockDesktop(),
      probe: REVIEWED_PROBE,
      app: {
        command: "python3",
        args: [join(APP, "myco_todo.py")],
        storePath: STORE,
        savePoint: { x: 210, y: 284 },
      },
      items: [...task.items],
      verify: persistedStoreOracle,
      runsDir: join(RUN_DIR, "runs"),
      runId: task.id,
      taskId: task.id,
      simulated: true,
    });
    runs.push({ id: task.id, title: task.title, expected: task.expected, result });
  }
  const report = renderS0Report(runs);
  writeFileSync(join(RUN_DIR, "s0-report.md"), report);
  process.stdout.write(report);
  return runs.every((run) => run.result.status === run.expected) ? 0 : 1;
}

const mode = process.argv[2];
if (mode === "--live") process.exit(await live());
if (mode === "--dry-run") process.exit(await dryRun());
process.stderr.write("usage: s0-live.ts --dry-run | --live\n");
process.exit(2);
