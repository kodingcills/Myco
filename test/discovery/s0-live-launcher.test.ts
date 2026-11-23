import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir, uptime } from "node:os";
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

// TIF-170 diagnostics. CI-only: MYCO_TIF170_DIAG=<dir> turns on a dump of everything a
// failing round leaves behind, so the one run that reproduces on a GitHub runner
// carries its own evidence. Unset, none of this runs and the test is unchanged.
const DIAG = process.env.MYCO_TIF170_DIAG || "";
// The round cap defaults to the tested 30; the CI workflow raises it so a dispatch can
// hunt for a failure inside a single vitest invocation.
const ROUNDS = Number(process.env.MYCO_TIF170_ROUNDS || 30);

/** `mtime`, `ctime` and `birth` in ns where the filesystem provides them. */
function times(path: string): string {
  const s = statSync(path, { bigint: true, throwIfNoEntry: false });
  return s
    ? `mtime=${s.mtimeNs} ctime=${s.ctimeNs} birth=${s.birthtimeNs} ino=${s.ino} size=${s.size}`
    : "absent";
}

/** The whole log, every line numbered, so a `pid N` claim can be ordered against a loss. */
function numberedLog(runDir: string): string[] {
  const log = logOf(runDir);
  return log === ""
    ? ["  (no s0.log)"]
    : log
        .split("\n")
        .filter((line) => line !== "")
        .map((line, index) => `  ${String(index + 1).padStart(3, " ")}| ${line}`);
}

/** Where the claim, the pid file, the racer output and the rc files landed, in time order. */
function runDirChronology(runDir: string): string[] {
  const names = ["s0.lock", "s0.pid", "s0.child"];
  try {
    for (const name of readdirSync(runDir)) {
      if (/^(out|rc)\.\d+$/.test(name)) {
        names.push(name);
      }
    }
  } catch {
    // A round dir that does not exist is itself the finding; `times` reports it.
  }
  const stamped = names.map((name) => {
    const path = join(runDir, name);
    const s = statSync(path, { bigint: true, throwIfNoEntry: false });
    return { name, sort: s ? s.mtimeNs : 0n, text: `  ${name.padEnd(9)} ${times(path)}` };
  });
  stamped.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  return ["--- times, mtime ns ascending (claim order) ---", ...stamped.map((s) => s.text)];
}

/** The process tree, scoped to the fixture dirs of this round. */
function processTree(dirs: string[]): string[] {
  const ps = spawnSync("ps", ["-eo", "pid,ppid,lstart,stat,args"], { encoding: "utf8" });
  const lines = (ps.stdout || "").split("\n").filter((line) => line !== "");
  const head = lines.slice(0, 1);
  const hit = lines.filter((line) => dirs.some((dir) => dir !== "" && line.includes(dir)));
  return ["--- ps -eo pid,ppid,lstart,stat,args, filtered to this round's dirs ---", ...head, ...hit];
}

function hostContext(): string[] {
  // macOS has no `nproc`; the CI target is ubuntu, and this branch also runs locally.
  const nproc = spawnSync("nproc", { encoding: "utf8" }).stdout?.trim() || "?";
  return [
    "--- host ---",
    `  nproc=${nproc}` +
      ` cpus().length=${cpus().length} uptime_s=${Math.round(uptime())}` +
      ` node=${process.version} platform=${process.platform}`,
  ];
}

/**
 * Everything a round leaves behind, as raw bytes, for the one case the exit codes
 * cannot explain: two racers that both exited 0. The rc values say how many won; only
 * the log's claim records, the file times and the process tree say whether one of them
 * won the claim, or whether both exited 0 with a single claim and one lost watchdog.
 */
function dumpRound(
  runDir: string,
  round: number,
  dirs: string[],
  counts: { winners: number; refusals: number },
): string {
  const rcs: string[] = [];
  try {
    for (const name of readdirSync(runDir).filter((n) => /^rc\.\d+$/.test(n)).sort()) {
      rcs.push(`  ${name} = ${readFileSync(join(runDir, name), "utf8").trim()}`);
    }
  } catch {
    rcs.push("  (no run dir)");
  }
  const outs: string[] = [];
  try {
    for (const name of readdirSync(runDir).filter((n) => /^out\.\d+$/.test(n)).sort()) {
      const body = readFileSync(join(runDir, name), "utf8").trim();
      outs.push(`  ${name}: ${body === "" ? "(empty)" : JSON.stringify(body)}`);
    }
  } catch {
    // The rc block already reports a missing run dir.
  }
  return [
    `=== TIF-170 round ${round}: winners=${counts.winners} refusals=${counts.refusals}`,
    ...hostContext(),
    `--- racer rc (indexed) ---`,
    ...rcs,
    `--- racer stdout/stderr (indexed; --run sends its say lines to the log) ---`,
    ...outs,
    `--- s0.log, numbered in file order (claim = "pid N", loss = "holds the run lock") ---`,
    ...numberedLog(runDir),
    ...runDirChronology(runDir),
    ...processTree(dirs),
  ].join("\n");
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
    const { dir, script, runDir, env } = worktree();
    // Check-then-write tears roughly one round in ten (measured 2026-11-23: 4/40
    // rounds with two winners), so 30 rounds make the negative control dependable
    // without making a green run slow — ~10 s.
    for (let round = 0; round < ROUNDS; round += 1) {
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
      // Before anything touches the round dir: the state the failure left, plus who is
      // still alive. The process tree must be read here, while the watchdogs and their
      // sleepers are up, because `--stop` below tears them down.
      const anomaly = winners !== 1 || refusals !== 7;
      if (DIAG !== "") {
        mkdirSync(DIAG, { recursive: true });
        if (anomaly || round === 0) {
          const evidence = dumpRound(runDir, round, [dir, runDir], { winners, refusals });
          const where = join(DIAG, anomaly ? `round-${round}.failure.txt` : `round-${round}.baseline.txt`);
          writeFileSync(where, evidence + "\n");
          if (anomaly) {
            // Unbuffered: vitest prints it inside the failed assertion, so the job log
            // carries the evidence even when the artifact never uploads.
            appendFileSync(2, evidence + "\n");
          }
          // Printed for every run, so a green CI round still shows what was captured.
          console.log(`TIF-170 round ${round}: winners=${winners} refusals=${refusals} -> ${where}`);
        }
      }
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
    // A CI hunt runs far more rounds than the 30 the local test does; 2 s a round is
    // ample on a healthy host and the cap only exists to stop a hung round running on.
  }, Math.max(30_000, ROUNDS * 2_000));

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
