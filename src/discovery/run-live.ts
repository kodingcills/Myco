/**
 * The live half of `myco-run` (MVD-001 acceptance 4: an ordinary agent drives it;
 * the live path is what the ordinary agent drives).
 *
 * `scripts/s0-live.ts` runs both S0 tasks in one process with `console`-style
 * output and a fixed run directory. The developer entry point needs the same
 * live transport for **one** task, with the gate refusing before anything is
 * booted, and with every refusal reported as a reason rather than thrown.
 *
 * Order matters and is the gate:
 *   1. Coordinator GO and the shared host lock (`checkGate`). Without them no
 *      probe is collected and no binary is looked for.
 *   2. The runtime MCP binary must exist and be executable.
 *   3. A guest must not already be running (this window is not ours).
 *   4. The transport's own evidence probe must pass `combinedPreflight`; a check
 *      the transport cannot vouch for (`oraclePresent`, `guestClean`) keeps the
 *      path closed by saying so, not by assuming.
 *
 * None of these is a retry. A refusal is an abort.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  checkGate,
  combinedPreflight,
  type PreflightResult,
  renderPreflight,
} from "./preflight.ts";
import type { RunTask } from "./run-tasks.ts";
import { RuntimeTransport } from "./runtime-transport.ts";

export interface LiveGate {
  /** The Coordinator's explicit GO for this host window. */
  readonly coordinatorGo: boolean;
  /** The shared host lock is held by this run. */
  readonly hostLock: boolean;
}

export interface LiveTransportDeps {
  readonly root: string;
  readonly gate: LiveGate;
  readonly task: RunTask;
  /** Session id for the runtime; defaults to a timestamped one. */
  readonly sessionId?: string;
  readonly timeoutMs?: number;
  /** Injected for tests: the process table, and whether the binary is executable. */
  readonly processTable?: () => string[] | undefined;
  readonly binaryReady?: (path: string) => boolean;
}

export type LiveTransportResult =
  | {
      readonly ok: true;
      readonly transport: RuntimeTransport;
      readonly probe: PreflightResult;
      readonly savePoint: { readonly x: number; readonly y: number };
    }
  | {
      readonly ok: false;
      readonly code: number;
      readonly report: string;
      readonly reasons: string[];
    };

const RT_BINARY = "runtime/target/debug/myco-rt-mcp";

/**
 * The guest geometry: the Save control sits in the lower band of the app window.
 * `xdotool` is read out of band, exactly as `scripts/s0-live.ts` does, because the
 * runtime has no element query for the app's own Save button yet.
 */
function savePointFrom(window: { x: number; y: number; width: number; height: number }) {
  return { x: window.x + Math.round(window.width / 2), y: window.y + window.height - 76 };
}

function windowGeometry(ssh: (command: string) => string) {
  const geometry = ssh(
    "DISPLAY=:0 xdotool search --name myco-todo getwindowgeometry --shell 2>/dev/null || true",
  );
  const field = (name: string) =>
    Number(
      geometry
        .split("\n")
        .find((line) => line.startsWith(`${name}=`))
        ?.split("=")[1] ?? "0",
    );
  return { x: field("X"), y: field("Y"), width: field("WIDTH"), height: field("HEIGHT") };
}

/**
 * Build the live transport, or explain why not. A refusal carries the exit code a
 * launcher should use (2 = the gate said no) and the same preflight rendering the
 * S0 launcher prints, so a developer reads one format in both places.
 */
export async function openLiveTransport(deps: LiveTransportDeps): Promise<LiveTransportResult> {
  const gate = checkGate(deps.gate);
  if (!gate.ok) {
    return {
      ok: false,
      code: 2,
      report: renderPreflight(gate),
      reasons: [...gate.abort],
    };
  }
  const binary = join(deps.root, RT_BINARY);
  const binaryReady =
    deps.binaryReady?.(binary) ?? (existsSync(binary) && (statSync(binary).mode & 0o111) !== 0);
  if (!binaryReady) {
    return {
      ok: false,
      code: 2,
      report: `refusing: ${binary} is missing or not executable; build it with cargo build -p myco-rt-mcp\n`,
      reasons: [`runtime binary absent: ${RT_BINARY}`],
    };
  }
  // A failed `ps` is not evidence of an idle host: fail closed.
  const table = deps.processTable?.() ?? processTable();
  const guestUp =
    table === undefined ||
    table.some((line) => line.split(" ")[0]?.split("/").at(-1) === "qemu-system-aarch64");
  if (guestUp) {
    return {
      ok: false,
      code: 2,
      report: "refusing: a qemu guest is already running, so this window is not ours\n",
      reasons: ["guest already running"],
    };
  }
  const transport = new RuntimeTransport({
    binary,
    cwd: deps.root,
    readRoot: "/home/myco",
    introspectionPath: deps.task.statePath,
    appPath: deps.task.storeArg,
    sessionId: deps.sessionId ?? `myco-run-${deps.task.id}-${Date.now()}`,
    timeoutMs: deps.timeoutMs ?? 900_000,
  });
  await transport.initialize();
  const session = await transport.create();
  const probe = combinedPreflight(
    { coordinatorGo: true, hostLock: true },
    await transport.evidence(session),
  );
  if (!probe.ok) {
    await transport.destroy();
    return { ok: false, code: 2, report: renderPreflight(probe), reasons: [...probe.abort] };
  }
  const window = windowGeometry((command) =>
    execFileSync("ssh", [...sshArgs(join(deps.root, "runtime/guest/keys/id_ed25519")), command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
  );
  if (!window.width || !window.height) {
    await transport.destroy();
    return {
      ok: false,
      code: 2,
      report: `refusing: could not read the app window geometry (${JSON.stringify(window)}); is myco-todo deployed and running?\n`,
      reasons: ["app window geometry unreadable"],
    };
  }
  return { ok: true, transport, probe, savePoint: savePointFrom(window) };
}

function sshArgs(keyPath: string): string[] {
  return [
    "-i",
    keyPath,
    "-p",
    "10022",
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
}

function processTable(): string[] | undefined {
  const table = spawnSync("ps", ["-Ao", "command"], { encoding: "utf8" });
  if (table.status !== 0) return undefined;
  return table.stdout.split("\n").filter((line) => line.length > 0);
}
