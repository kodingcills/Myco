import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const LAUNCHER = join(ROOT, "scripts", "s0-live.sh");

/** A launcher copy in its own fake worktree, so nothing here touches the real run dir. */
function harness(): { dir: string; script: string; runDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "myco-launcher-"));
  cpSync(join(ROOT, "scripts", "s0-live.sh"), join(dir, "scripts", "s0-live.sh"));
  const runDir = join(dir, "run");
  mkdirSync(runDir, { recursive: true });
  return { dir, script: join(dir, "scripts", "s0-live.sh"), runDir };
}

function run(script: string, runDir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, S0_RUN_DIR: runDir, ...env },
  });
}

/** The launcher redirects its whole output to the log, so assertions read the log. */
function logOf(runDir: string): string {
  return existsSync(join(runDir, "s0.log")) ? readFileSync(join(runDir, "s0.log"), "utf8") : "";
}

describe("s0-live.sh launcher", () => {
  it("refuses to start without the Coordinator GO and the host lock", () => {
    const { script, runDir } = harness();
    const refused = run(script, runDir, ["--watchdog"]);
    expect(refused.status).toBe(2);
    expect(logOf(runDir)).toContain("REFUSED: no Coordinator GO");

    const noLock = run(script, runDir, ["--watchdog"], { MYCO_COORDINATOR_GO: "1" });
    expect(noLock.status).toBe(2);
    expect(logOf(runDir)).toContain("REFUSED: the shared host lock is not held");
  });

  it("scopes the pid-less fallback to this worktree's path", () => {
    const { dir, script, runDir } = harness();
    // No pid files, so only the argv fallback can act. Assert what it is anchored
    // to, rather than whether a particular signal landed: on this host a signal
    // sent to a wrapper whose argv replaced its own does not terminate it, which
    // is a property of the test double, not of the launcher.
    const stopped = run(script, runDir, ["--stop"]);
    expect(stopped.status).toBe(0);
    const source = readFileSync(script, "utf8");
    expect(source).toContain('pgrep -f -- "$ROOT/.*scripts/s0-live\\.ts --live"');
    expect(source).toContain('pgrep -f -- "$ROOT/runtime/target/debug/myco-rt-mcp"');
    // A relative script path in the child spawn would make those anchors dead.
    expect(source).not.toContain("tsx scripts/s0-live.ts");
  });

  it("refuses a second --run while a pid file is held", () => {
    const { script, runDir } = harness();
    writeFileSync(join(runDir, "s0.pid"), String(process.pid));
    const second = run(script, runDir, ["--run"]);
    expect(second.status).toBe(1);
    expect(logOf(runDir)).toContain("already running");
  });

  it("claims the pid file atomically, so a concurrent --run cannot both start", () => {
    const { script, runDir } = harness();
    // No live pid in the file: the guard passes and the claim itself must refuse.
    writeFileSync(join(runDir, "s0.pid"), "999999");
    const second = run(script, runDir, ["--run"]);
    expect(second.status).toBe(1);
    expect(logOf(runDir)).toContain("claimed the pid file first");
    // The loser must not leave a watchdog behind.
    expect(existsSync(join(runDir, "s0.child"))).toBe(false);
  });

  it("keeps --status and --stop on the terminal, and everything else in the log", () => {
    const { script, runDir } = harness();
    // A person asking "is it running?" must get an answer on stdout, not a file.
    const status = run(script, runDir, ["--status"]);
    expect(status.stdout).toContain("not running");
    const stop = run(script, runDir, ["--stop"]);
    expect(stop.stdout).toContain("not running");
    // A run nobody is watching must leave its gate verdict in the log.
    run(script, runDir, ["--watchdog"]);
    expect(logOf(runDir)).toContain("REFUSED: no Coordinator GO");
  });

  it("keeps a failed child's exit code in the log and leaves no pid files", () => {
    const { dir, script, runDir } = harness();
    const fakeBin = join(dir, "bin");
    mkdirSync(fakeBin, { recursive: true });
    // pnpm that fails, and an idle host.
    writeFileSync(join(fakeBin, "pnpm"), "#!/bin/sh\nexit 7\n");
    writeFileSync(join(fakeBin, "ps"), "#!/bin/sh\nprintf 'launchd\\n-bash\\n'\n");
    chmodSync(join(fakeBin, "pnpm"), 0o755);
    chmodSync(join(fakeBin, "ps"), 0o755);
    mkdirSync(join(dir, "runtime", "target", "debug"), { recursive: true });
    // A real myco-rt-mcp for the existence check; the fake pnpm never runs it.
    writeFileSync(join(dir, "runtime", "target", "debug", "myco-rt-mcp"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "runtime", "target", "debug", "myco-rt-mcp"), 0o755);
    const result = run(script, runDir, ["--watchdog"], {
      MYCO_COORDINATOR_GO: "1",
      MYCO_HOST_LOCK: "1",
      PATH: `${fakeBin}:${process.env.PATH}`,
    });
    // The child writes the log; assert only after it has been reaped.
    expect(result.status).toBe(7);
    const log = readFileSync(join(runDir, "s0.log"), "utf8");
    expect(log).toContain("exited with 7");
    expect(log).toContain("watchdog done (rc 7)");
    expect(existsSync(join(runDir, "s0.pid"))).toBe(false);
    expect(existsSync(join(runDir, "s0.child"))).toBe(false);
  });
});
