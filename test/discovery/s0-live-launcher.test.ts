import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The launcher spawns and signals real processes. Inside vitest's worker threads that
// deadlocks its pool (measured 2026-11-23: >200s hang then ERR_IPC_CHANNEL_CLOSED,
// versus ~2s in a forked child). package.json runs this file in its own forked,
// single-fork invocation.

const ROOT = join(import.meta.dirname, "..", "..");
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) {
    // The launcher tree carries `dir` in argv, so the path kill reaches it. The sleepers
    // do not — they are bare `sleep 297` — so they are killed by the pids the stub
    // recorded while it was alive.
    spawnSync("bash", ["-c", `pkill -9 -f ${JSON.stringify(dir)} 2>/dev/null`]);
    const recorded = join(dir, "sleepers");
    if (existsSync(recorded)) {
      const pids = readFileSync(recorded, "utf8")
        .split("\n")
        .filter((line) => /^\d+$/.test(line.trim()));
      if (pids.length > 0) {
        spawnSync("kill", ["-9", ...pids]);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake worktree: idle host, present binary, and a pnpm that blocks. */
function worktree(): { dir: string; script: string; runDir: string; env: NodeJS.ProcessEnv } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "myco-launcher-")));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(ROOT, "scripts", "s0-live.sh"), join(dir, "scripts", "s0-live.sh"));
  const runDir = join(dir, "run");
  mkdirSync(runDir, { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nprintf 'launchd\\n'\n");
  // A plain `sleep 297` orphans itself when its parent stub dies and cannot be found by
  // path (measured 2026-11-23: 29 orphans after a 30-round run). `exec -a` fixed that on
  // macOS but broke on Ubuntu, where `/bin/sh` is dash and `exec` has no `-a`: the stub
  // exited 127 and every watchdog was already dead. So the stub records the sleeper's own
  // pid in the fixture and afterEach kills exactly those — `sh` is enough, and both
  // shells fork the backgrounded `sleep` rather than exec'ing it, so `$!` is the process
  // that must be signalled.
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/sh\nsleep 297 &\necho $! >> ${JSON.stringify(join(dir, "sleepers"))}\nwait\n`,
  );
  chmodSync(join(bin, "ps"), 0o755);
  chmodSync(join(bin, "pnpm"), 0o755);
  const rt = join(dir, "runtime", "target", "debug");
  mkdirSync(rt, { recursive: true });
  writeFileSync(join(rt, "myco-rt-mcp"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(rt, "myco-rt-mcp"), 0o755);
  made.push(dir);
  return {
    dir,
    script: join(dir, "scripts", "s0-live.sh"),
    runDir,
    env: { PATH: bin + ":" + process.env.PATH, MYCO_COORDINATOR_GO: "1", MYCO_HOST_LOCK: "1" },
  };
}

function launcher(script: string, runDir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, S0_RUN_DIR: runDir, ...env },
  });
}

function logOf(runDir: string): string {
  return existsSync(join(runDir, "s0.log")) ? readFileSync(join(runDir, "s0.log"), "utf8") : "";
}

function startDetached(argv: string): number {
  // A child whose argv[0] is the argv we were given, so the launcher's `$ROOT`-anchored
  // fallback matches it exactly as it would a real `s0-live.ts --live`. `bash` is named
  // explicitly, so `exec -a` is safe here; the fixture's `pnpm` stub cannot assume it.
  const out = spawnSync(
    "bash",
    ["-c", "nohup bash -c \"exec -a '" + argv + "' sleep 297\" >/dev/null 2>&1 & echo $!"],
    {
      encoding: "utf8",
    },
  );
  return Number(out.stdout.trim());
}

function alive(pid: number): boolean {
  return spawnSync("kill", ["-0", String(pid)]).status === 0;
}

describe("s0-live.sh launcher", () => {
  it("refuses to start without the Coordinator GO and the host lock", () => {
    const { script, runDir } = worktree();
    expect(launcher(script, runDir, ["--watchdog"]).status).toBe(2);
    expect(logOf(runDir)).toContain("REFUSED: no Coordinator GO");
    expect(launcher(script, runDir, ["--watchdog"], { MYCO_COORDINATOR_GO: "1" }).status).toBe(2);
    expect(logOf(runDir)).toContain("REFUSED: the shared host lock is not held");
  });

  it("hands the child an absolute path, so the scoped fallback can find it", () => {
    const { script } = worktree();
    const source = readFileSync(script, "utf8");
    // A relative argv never contains $ROOT, which is why the first fallback missed.
    expect(source).toContain('tsx "$ROOT/scripts/s0-live.ts"');
    expect(source).not.toContain("tsx scripts/s0-live.ts");
    expect(source).toContain('pgrep -f -- "$ROOT/.*scripts/s0-live\\.ts --live"');
    expect(source).toContain('pgrep -f -- "$ROOT/runtime/target/debug/myco-rt-mcp"');
  });

  it("lets --stop reach a child whose pid file was lost, and spares another worktree", () => {
    const { dir, script, runDir } = worktree();
    const mine = startDetached("node " + join(dir, "scripts", "s0-live.ts") + " --live");
    // A second, unrelated tree: the fallback is anchored on this one's $ROOT only.
    const other = realpathSync(mkdtempSync(join(tmpdir(), "myco-sibling-")));
    made.push(other);
    const sibling = startDetached("node " + join(other, "scripts", "s0-live.ts") + " --live");
    try {
      launcher(script, runDir, ["--stop"], { MYCO_COORDINATOR_GO: "1", MYCO_HOST_LOCK: "1" });
      // The signal is asynchronous: give it a moment before asserting it landed.
      spawnSync("bash", ["-c", "sleep 0.3"]);
      expect(alive(mine)).toBe(false);
      expect(alive(sibling)).toBe(true);
    } finally {
      spawnSync("kill", ["-9", String(sibling)]);
    }
  });

  it("admits exactly one --run under a real race, and the winner owns the pid", () => {
    const { script, runDir, env } = worktree();
    // Check-then-write tears roughly one round in ten (measured 2026-11-23: 4/40
    // rounds with two winners), so 30 rounds make the negative control dependable
    // without making a green run slow — ~10 s.
    for (let round = 0; round < 30; round += 1) {
      spawnSync("bash", ["-c", 'rm -rf "' + runDir + '"; mkdir -p "' + runDir + '"']);
      const racers = spawnSync(
        "bash",
        [
          "-c",
          'for i in 1 2 3 4 5 6 7 8; do ( S0_RUN_DIR="' +
            runDir +
            '" bash "' +
            script +
            '" --run >"' +
            runDir +
            '/out.$i" 2>&1; echo $? >"' +
            runDir +
            '/rc.$i" ) & done; wait; cat "' +
            runDir +
            '"/rc.* | grep -c "^0$"; cat "' +
            runDir +
            '"/rc.* | grep -c "^1$"',
        ],
        { encoding: "utf8", env: { ...process.env, ...env } },
      );
      const [winners, refusals] = racers.stdout.trim().split("\n").map(Number);
      expect(winners).toBe(1);
      expect(refusals).toBe(7);
      // Before --stop: every `--run` that admitted itself logged the watchdog it
      // launched (`say "pid $CHILD"`), so the live watchdogs are countable. `s0.pid`
      // alone is not evidence: it is the treaty that a torn claim breaks, and the
      // last writer wins it even when it names a child that has already been killed.
      // `--run` routes its stdout to the shared log, not to the racer's own file,
      // because the detached-run case is the one the log exists for.
      const loggedPids = () =>
        readFileSync(join(runDir, "s0.log"), "utf8")
          .split("\n")
          .map((line) => /^\S+ pid (\d+)$/.exec(line))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => Number(match[1]));
      let pids: number[] = [];
      for (let attempt = 0; attempt < 40 && !pids.some((pid) => alive(pid)); attempt += 1) {
        spawnSync("bash", ["-c", "sleep 0.05"]);
        pids = loggedPids();
      }
      const live = pids.filter((pid) => alive(pid));
      expect(live).toHaveLength(1);
      // Read the pid before --stop: a late read raced a watchdog that had already gone.
      const recorded = Number(readFileSync(join(runDir, "s0.pid"), "utf8").trim());
      expect(recorded).toBe(live[0]);
      expect(alive(recorded)).toBe(true);
      launcher(script, runDir, ["--stop"], env);
      spawnSync("bash", ["-c", 'pkill -9 -f "' + runDir + '" 2>/dev/null']);
    }
  }, 30_000);

  it("releases the run lock on every exit that is not a signal", () => {
    const { script, runDir, env } = worktree();
    const lock = join(runDir, "s0.lock");
    expect(launcher(script, runDir, ["--watchdog"]).status).toBe(2);
    expect(existsSync(lock)).toBe(false);
    launcher(script, runDir, ["--run"], env);
    expect(existsSync(lock)).toBe(true);
    launcher(script, runDir, ["--stop"], env);
    expect(existsSync(lock)).toBe(false);
    // A leaked lock would make this refusal permanent.
    expect(launcher(script, runDir, ["--run"], env).status).toBe(0);
    expect(alive(Number(readFileSync(join(runDir, "s0.pid"), "utf8").trim()))).toBe(true);
    launcher(script, runDir, ["--stop"], env);
  });

  it("keeps --probe, --status and --stop on the terminal", () => {
    const { script, runDir } = worktree();
    expect(launcher(script, runDir, ["--probe"]).stdout).toContain("S0 pre-run gate");
    expect(launcher(script, runDir, ["--status"]).stdout).toContain("not running");
    expect(launcher(script, runDir, ["--stop"]).stdout).toContain("not running");
    const watched = launcher(script, runDir, ["--watchdog"]);
    expect(watched.stdout).not.toContain("REFUSED");
    expect(logOf(runDir)).toContain("REFUSED: no Coordinator GO");
  });

  it("keeps a failed child's exit code and leaves no pid files or lock", () => {
    const { dir, script, runDir, env } = worktree();
    writeFileSync(join(dir, "bin", "pnpm"), "#!/bin/sh\nexit 7\n");
    chmodSync(join(dir, "bin", "pnpm"), 0o755);
    const result = launcher(script, runDir, ["--watchdog"], env);
    expect(result.status).toBe(7);
    const log = logOf(runDir);
    expect(log).toContain("exited with 7");
    expect(log).toContain("watchdog done (rc 7)");
    expect(existsSync(join(runDir, "s0.pid"))).toBe(false);
    expect(existsSync(join(runDir, "s0.child"))).toBe(false);
    expect(existsSync(join(runDir, "s0.lock"))).toBe(false);
  });
});
