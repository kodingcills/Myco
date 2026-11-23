import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

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

/** Start a process detached from this test's stdio and return its pid. */
function spawnDetached(argv: string): number {
  const out = spawnSync(
    "bash",
    ["-c", `nohup bash -c "exec -a '${argv}' sleep 60" >/dev/null 2>&1 & echo $!`],
    {
      encoding: "utf8",
    },
  );
  return Number(out.stdout.trim());
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
    const { script, runDir } = harness();
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

  it("admits exactly one --run under a real race", () => {
    const { script, runDir } = harness();
    // Eight simultaneous --run calls, both outcomes counted. A shared output file
    // made an earlier version of this test lie, so each racer writes its own.
    const rounds = 6;
    for (let round = 0; round < rounds; round += 1) {
      spawnSync("bash", ["-c", `rm -rf "${runDir}"; mkdir -p "${runDir}"`]);
      const winners = spawnSync(
        "bash",
        [
          "-c",
          `for i in 1 2 3 4 5 6 7 8; do ( S0_RUN_DIR="${runDir}" bash "${script}" --run >"${runDir}/out.$i" 2>&1; echo $? >"${runDir}/rc.$i" ) & done; wait; cat "${runDir}"/rc.* | grep -c '^0$'`,
        ],
        { encoding: "utf8" },
      );
      expect(Number(winners.stdout.trim())).toBe(1);
      // Seven refusals, and count them from the rc files: the launcher appends
      // several lines to one log, so racing writers can interleave there.
      const refusals = spawnSync("bash", ["-c", `cat "${runDir}"/rc.* | grep -c '^1$'`], {
        encoding: "utf8",
      });
      expect(Number(refusals.stdout.trim())).toBe(7);
      // The recorded pid must be alive: an untracked child is the defect.
      const recorded = Number(readFileSync(join(runDir, "s0.pid"), "utf8").trim());
      expect(spawnSync("kill", ["-0", String(recorded)]).status).toBe(0);
      spawnSync("bash", ["-c", `pkill -9 -f "${runDir}" 2>/dev/null; rm -rf "${runDir}"`]);
    }
  });

  it("keeps --status and --stop on the terminal, and everything else in the log", () => {
    const { dir, script, runDir } = harness();
    // A child of THIS worktree, and a look-alike under another root. --status must
    // list the first and never the second: an unanchored pattern listed both.
    // /tmp is a symlink on macOS: the launcher canonicalises $ROOT, so the argv
    // must use the same spelling or the pattern is correct and still misses.
    const mine = spawnDetached(`node ${realpathSync(dir)}/scripts/s0-live.ts --live`);
    const foreign = spawnDetached(`node ${realpathSync(dir)}/foreign/scripts/s0-live.ts --live`);
    try {
      const status = run(script, runDir, ["--status"]);
      expect(status.stdout).toContain("not running");
      expect(status.stdout).toContain(String(mine));
      expect(status.stdout).not.toContain(String(foreign));
    } finally {
      for (const pid of [mine, foreign]) spawnSync("kill", ["-9", String(pid)]);
    }
  });

  it("keeps a human's answer on the terminal", () => {
    const { script, runDir } = harness();
    const status = run(script, runDir, ["--status"]);
    expect(status.stdout).toContain("not running");
    const stop = run(script, runDir, ["--stop"]);
    expect(stop.stdout).toContain("not running");
    // A run nobody is watching must leave its gate verdict in the log.
    const watched = run(script, runDir, ["--watchdog"]);
    expect(watched.stdout).not.toContain("REFUSED");
    expect(logOf(runDir)).toContain("REFUSED: no Coordinator GO");
  });

  it("still shows --probe to the person who asked for it", () => {
    const { script, runDir } = harness();
    const probed = run(script, runDir, ["--probe"]);
    expect(probed.stdout).toContain("S0 pre-run gate");
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
