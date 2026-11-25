/**
 * The operator-session lock wrapper, scripts/vm-session.sh (TIF-210).
 *
 * Every case runs under a private MYCO_VM_LOCK_PATH in a fresh temp dir, and the
 * only processes spawned under the wrapper are fake steps written here (`sleep`, a
 * bash child that sources vm-lock.sh, a node child that calls lockOwnedByAncestor).
 * `pgrep` is stubbed so the legacy-driver scan in vm_lock_acquire cannot see, or be
 * refused by, a real sweep running on the same host.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import {
  acquireVmLock,
  acquireVmLockUnlessOwnedByAncestor,
  DEFAULT_VM_LOCK_PATH,
  lockOwnedByAncestor,
  VmLockedError,
} from "../src/integration/vm-lock.ts";

const REPO = join(__dirname, "..");
const GUARD = join(REPO, "scripts", "vm-lock.sh");
const WRAPPER = join(REPO, "scripts", "vm-session.sh");

/** A fake step: inherit the parent's lock if it is proven, else take its own. */
const FAKE_STEP = `source "$GUARD"
if vm_lock_owned_by_parent; then echo INHERITED; exit 0; fi
vm_lock_acquire fake-step.sh || exit "$?"
echo ACQUIRED`;

const running: ChildProcess[] = [];
afterEach(() => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "myco-vm-session-test-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pgrep"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
  const lock = join(dir, "test.vm.lock");
  expect(lock).not.toBe(DEFAULT_VM_LOCK_PATH);
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    MYCO_VM_LOCK_PATH: lock,
    MYCO_VM_LOCK_OWNER: "",
    GUARD,
  };
  return { dir, lock, env };
}

type Env = ReturnType<typeof fixture>["env"];

function runSync(args: string[], env: Env) {
  return spawnSync("bash", args, { encoding: "utf8", timeout: 20_000, env, cwd: REPO });
}

/** Start the wrapper in the background and resolve once it has written its record. */
async function startWrapper(cmd: string[], env: Env, lock: string, launcher = ["bash"]) {
  // `launcher` must exec the wrapper in place (nohup, `trap "" INT; exec bash`),
  // so the spawned pid is the wrapper's pid.
  const [program, ...pre] = launcher;
  const child = spawn(program as string, [...pre, WRAPPER, "--", ...cmd], { env, cwd: REPO });
  running.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  for (let i = 0; i < 200; i += 1) {
    if (stderr.includes("vm-session: holding")) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(stderr).toContain("vm-session: holding");
  expect(readFileSync(lock, "utf8").trim()).toBe(`${child.pid} vm-session.sh`);
  return { child, exited, stderr: () => stderr };
}

/** True when a fresh contender can take the lock now (it is released at once). */
function lockIsFree(lock: string): boolean {
  try {
    acquireVmLock({ path: lock, driver: "probe" }).release();
    return true;
  } catch (error) {
    if (error instanceof VmLockedError) return false;
    throw error;
  }
}

async function eventually(check: () => boolean): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return check();
}

/** The lock file's text, or "" before anything has created it. */
function readLock(lock: string): string {
  return existsSync(lock) ? readFileSync(lock, "utf8") : "";
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it("refuses to run without `-- <cmd>`", () => {
  const { env } = fixture();
  expect(runSync([WRAPPER], env).status).toBe(2);
  expect(runSync([WRAPPER, "true"], env).status).toBe(2);
});

it("holds the lock while the command runs and releases it on a normal exit", async () => {
  const { lock, env } = fixture();
  const { exited } = await startWrapper(["sleep", "1"], env, lock);
  expect(lockIsFree(lock)).toBe(false);
  expect(await exited).toEqual({ code: 0, signal: null });
  expect(lockIsFree(lock)).toBe(true);
});

it("passes the command's status through and releases the lock when the child crashes", () => {
  const { lock, env } = fixture();
  expect(runSync([WRAPPER, "--", "bash", "-c", "exit 3"], env).status).toBe(3);
  expect(lockIsFree(lock)).toBe(true);
  // A real crash: the child dies of SIGSEGV, and the wrapper reports 128+11.
  expect(runSync([WRAPPER, "--", "bash", "-c", 'kill -SEGV "$$"'], env).status).toBe(139);
  expect(lockIsFree(lock)).toBe(true);
  expect(runSync([WRAPPER, "--", "no-such-command-tif210"], env).status).toBe(127);
  expect(lockIsFree(lock)).toBe(true);
});

for (const [signal, number] of [
  ["SIGTERM", 15],
  ["SIGINT", 2],
  ["SIGHUP", 1],
] as const) {
  it(`on ${signal} stops the command and releases the lock`, async () => {
    const { dir, lock, env } = fixture();
    const pidFile = join(dir, "child.pid");
    // The fake step records its pid, then blocks while holding the inherited FD 9.
    const { child, exited } = await startWrapper(
      ["bash", "-c", `echo $$ > "${pidFile}"; exec sleep 30`],
      env,
      lock,
    );
    expect(await eventually(() => readFileSync(pidFile, { flag: "a+" }).length > 0)).toBe(true);
    const stepPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(lockIsFree(lock)).toBe(false);

    child.kill(signal); // the wrapper only, as `kill <pid>` from another shell would
    const result = await exited;
    // Release first: it is the property this case exists for.
    expect(await eventually(() => lockIsFree(lock))).toBe(true);
    expect(await eventually(() => !alive(stepPid))).toBe(true);
    expect(result).toEqual({ code: 128 + number, signal: null });
  }, 15_000);
}

it("stops the command on a signal sent the moment the session starts", async () => {
  // Round 2 regression: a signal forwarded before the forked child had exec'd ran
  // the wrapper's own trap inside the child and was lost, so `sleep 30` ran on
  // with the lock held. Now every immediate SIGTERM must end the session at once.
  const { lock, env } = fixture();
  for (let round = 0; round < 5; round += 1) {
    const started = Date.now();
    const { child, exited } = await startWrapper(["sleep", "30"], env, lock);
    child.kill("SIGTERM");
    expect({ round, result: await exited }).toEqual({ round, result: { code: 143, signal: null } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(readFileSync(lock, "utf8")).toBe("");
    expect(lockIsFree(lock)).toBe(true); // writes its own record; checked second
    writeFileSync(lock, "");
  }
}, 30_000);

it("gives the command the operator's stdin", () => {
  const { env } = fixture();
  const result = spawnSync("bash", [WRAPPER, "--", "cat"], {
    encoding: "utf8",
    timeout: 20_000,
    env,
    input: "from-the-operator\n",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("from-the-operator\n");
});

it("accepts a shell step started under the wrapper", async () => {
  const { lock, env } = fixture();
  const result = runSync([WRAPPER, "--", "bash", "-c", FAKE_STEP], env);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("INHERITED");
  expect(lockIsFree(lock)).toBe(true);
});

it("accepts a node step started directly under the wrapper (node --import tsx)", () => {
  const { dir, lock, env } = fixture();
  const step = join(dir, "fake-step.ts");
  writeFileSync(
    step,
    `import { acquireVmLockUnlessOwnedByAncestor } from ${JSON.stringify(join(REPO, "src/integration/vm-lock.ts"))};
const lock = acquireVmLockUnlessOwnedByAncestor({ driver: "fake-step.ts" });
console.log(lock === undefined ? "INHERITED" : "ACQUIRED");
`,
  );
  const result = runSync([WRAPPER, "--", "node", "--import", "tsx", step], env);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("INHERITED");
  expect(lockIsFree(lock)).toBe(true);
});

it("refuses the same step outside the wrapper while the wrapper holds the lock", async () => {
  const { lock, env } = fixture();
  const { child } = await startWrapper(["sleep", "30"], env, lock);
  const plain = runSync(["-c", FAKE_STEP], env);
  expect(plain.status).toBe(10);
  expect(plain.stderr).toContain(`REFUSED_VM_LOCKED: holder ${child.pid} vm-session.sh`);
});

it("refuses a forger that names the wrapper's pid without holding its inherited FD 9", async () => {
  const { dir, lock, env } = fixture();
  const { child } = await startWrapper(["sleep", "30"], env, lock);
  const forged = { ...env, MYCO_VM_LOCK_OWNER: String(child.pid) };
  const other = join(dir, "other.file");
  writeFileSync(other, "");
  const forgeries = {
    // no FD 9 at all
    noFd: `exec 9>&-; ${FAKE_STEP}`,
    // FD 9 open on some other file: the same fd number, not the lock
    otherFile: `exec 9>>"${other}"; ${FAKE_STEP}`,
    // FD 9 open on the lock file itself, but its own open file description
    ownOpen: `exec 9>>"$MYCO_VM_LOCK_PATH"; ${FAKE_STEP}`,
  };
  for (const [name, script] of Object.entries(forgeries)) {
    const result = runSync(["-c", script], forged);
    expect({ name, status: result.status, out: result.stdout.trim() }).toEqual({
      name,
      status: 10,
      out: "",
    });
  }
  // The TypeScript gate, against a descriptor this process opened on the lock file.
  // `ancestorOf: () => true` grants descent outright, so only the fd proof refuses.
  const fd = openSync(lock, "a");
  try {
    expect(lockOwnedByAncestor({ path: lock, owner: child.pid, lockFd: fd })).toBe(false);
    expect(
      lockOwnedByAncestor({ path: lock, owner: child.pid, lockFd: fd, ancestorOf: () => true }),
    ).toBe(false);
  } finally {
    closeSync(fd);
  }
  expect(lockOwnedByAncestor({ path: lock, owner: child.pid })).toBe(false);
});

it("refuses a descendant of the wrapper whose FD 9 is not the wrapper's lock", () => {
  // Descent passes for these, so each is refused by the fd proof alone.
  const { dir, env } = fixture();
  const other = join(dir, "other.file");
  writeFileSync(other, "");
  const forgeries = {
    // FD 9 open on some other file: the same fd number, not the lock
    otherFile: `exec 9>>"${other}"; ${FAKE_STEP}`,
    // FD 9 reopened on the lock file: its own open file description
    ownOpen: `exec 9>>"$MYCO_VM_LOCK_PATH"; ${FAKE_STEP}`,
  };
  for (const [name, script] of Object.entries(forgeries)) {
    const result = runSync([WRAPPER, "--", "bash", "-c", script], env);
    expect({ name, status: result.status, out: result.stdout.trim() }).toEqual({
      name,
      status: 10,
      out: "",
    });
  }
});

it("clears its own record on exit, so no stale vm-session.sh record survives", async () => {
  const { lock, env } = fixture();
  expect(runSync([WRAPPER, "--", "true"], env).status).toBe(0);
  expect(readFileSync(lock, "utf8")).toBe("");
  expect(runSync([WRAPPER, "--", "bash", "-c", "exit 4"], env).status).toBe(4);
  expect(readFileSync(lock, "utf8")).toBe("");
  const { child, exited } = await startWrapper(["sleep", "30"], env, lock);
  child.kill("SIGTERM");
  await exited;
  expect(readFileSync(lock, "utf8")).toBe("");
  // The other drivers keep their diagnostic record after release, as before.
  const sweep = runSync(["-c", 'source "$GUARD"; vm_lock_acquire m1-sweep.sh'], env);
  expect(sweep.status, sweep.stderr).toBe(0);
  expect(readFileSync(lock, "utf8")).toMatch(/^\d+ m1-sweep\.sh\n$/);
});

it("refuses a stale record whose pid is reused by a live process (verifier D1, F6b/F6c)", () => {
  const { dir, lock, env } = fixture();
  // A live unrelated process stands in for the reused pid; the lock itself is FREE.
  const reused = spawn("sleep", ["30"]);
  running.push(reused);
  const pid = String(reused.pid);
  const stale = () => writeFileSync(lock, `${pid} vm-session.sh\n`);
  const forged = { ...env, MYCO_VM_LOCK_OWNER: pid };

  // F6b, the shell gate: a self-opened FD 9 on the lock file must not be accepted.
  stale();
  const shell = runSync(
    [
      "-c",
      `exec 9>>"$MYCO_VM_LOCK_PATH"; source "$GUARD"; vm_lock_owned_by_parent && echo INHERITED`,
    ],
    forged,
  );
  expect(shell.stdout).not.toContain("INHERITED");
  expect(shell.status).not.toBe(0);

  // F6c, the TS gate, through the production entry point in a node child.
  stale();
  const step = join(dir, "forged-step.ts");
  writeFileSync(
    step,
    `import { acquireVmLockUnlessOwnedByAncestor } from ${JSON.stringify(join(REPO, "src/integration/vm-lock.ts"))};
const lock = acquireVmLockUnlessOwnedByAncestor({ driver: "forged-step.ts" });
console.log(lock === undefined ? "INHERITED" : "ACQUIRED");
`,
  );
  const node = runSync(
    ["-c", `exec 9>>"$MYCO_VM_LOCK_PATH"; exec node --import tsx "${step}"`],
    forged,
  );
  expect(node.status, node.stderr).toBe(0);
  // It took the free lock for itself, in its own name: it did not borrow the stale one.
  expect(node.stdout.trim()).toBe("ACQUIRED");

  // And the predicate directly, with the forger's own descriptor.
  stale();
  const fd = openSync(lock, "a");
  try {
    expect(lockOwnedByAncestor({ path: lock, owner: Number(pid), lockFd: fd })).toBe(false);
  } finally {
    closeSync(fd);
  }
  // The refusals did not leave the lock taken.
  expect(lockIsFree(lock)).toBe(true);
});

it("refuses a nested vm-session.sh inside a session", () => {
  const { env } = fixture();
  const result = runSync([WRAPPER, "--", "bash", "-c", `"${WRAPPER}" -- echo SHOULD-NOT-RUN`], env);
  expect(result.status).toBe(10);
  expect(result.stdout).not.toContain("SHOULD-NOT-RUN");
  expect(result.stderr).toMatch(/REFUSED_VM_LOCKED: holder \d+ vm-session\.sh/);
});

it("gives the production entry point no way to take the lockFd seam", () => {
  // Type-level: VmLockOptions has no lockFd, so passing one does not compile.
  const typeCheckOnly = (path: string) =>
    // @ts-expect-error lockFd is a test seam of lockOwnedByAncestor only
    acquireVmLockUnlessOwnedByAncestor({ path, lockFd: 3 });
  expect(typeof typeCheckOnly).toBe("function");
});

it("refuses a descendant of the wrapper that does not carry FD 9 (no ppid fallback)", () => {
  const { env } = fixture();
  const result = runSync([WRAPPER, "--", "bash", "-c", `exec 9>&-; ${FAKE_STEP}`], env);
  expect(result.status).toBe(10);
  expect(result.stdout).not.toContain("INHERITED");
});

it("refuses a second wrapper while the first holds the lock", async () => {
  const { lock, env } = fixture();
  const { child } = await startWrapper(["sleep", "30"], env, lock);
  const second = runSync([WRAPPER, "--", "echo", "SHOULD-NOT-RUN"], env);
  expect(second.status).toBe(10);
  expect(second.stdout).not.toContain("SHOULD-NOT-RUN");
  expect(second.stderr).toContain(`REFUSED_VM_LOCKED: holder ${child.pid} vm-session.sh`);
  // The refusal did not disturb the holder's record.
  expect(readFileSync(lock, "utf8").trim()).toBe(`${child.pid} vm-session.sh`);
});

// ---- Round 3 (verifier round 2): ignored-at-entry signals, process groups ----

it("leaves SIGHUP ignored under nohup: a HUP does not end the session", async () => {
  const { lock, env } = fixture();
  let stdout = "";
  const { child, exited } = await startWrapper(
    ["bash", "-c", "sleep 1; echo survived"],
    env,
    lock,
    ["nohup", "bash"],
  );
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.kill("SIGHUP");
  expect(await exited).toEqual({ code: 0, signal: null });
  expect(stdout).toContain("survived");
  expect(readFileSync(lock, "utf8")).toBe("");
  expect(lockIsFree(lock)).toBe(true);
}, 15_000);

it("leaves SIGINT ignored when it was ignored at entry, early or late", async () => {
  // A background job of a non-interactive shell starts with SIGINT ignored. A
  // signal sent then must neither be lost-then-unignored nor reach the command.
  const { dir, lock, env } = fixture();
  const launcher = ["bash", "-c", 'trap "" INT; exec bash "$0" "$@"'];
  const [program, ...pre] = launcher;
  const command = ["bash", "-c", "sleep 1; echo survived"];

  // Early: inside the window before the supervisor exists, held open by a slow
  // legacy-driver scan that runs after the record is written.
  const marker = join(dir, "in-window");
  writeFileSync(join(dir, "bin", "pgrep"), `#!/bin/bash\n: > "${marker}"\nsleep 1\nexit 1\n`, {
    mode: 0o755,
  });
  const early = spawn(program as string, [...pre, WRAPPER, "--", ...command], { env, cwd: REPO });
  running.push(early);
  let out = "";
  early.stdout?.on("data", (chunk) => {
    out += String(chunk);
  });
  const earlyExit = new Promise((resolve) =>
    early.on("exit", (code, signal) => resolve({ code, signal })),
  );
  expect(await eventually(() => existsSync(marker))).toBe(true);
  early.kill("SIGINT");
  expect(await earlyExit).toEqual({ code: 0, signal: null });
  expect(out).toContain("survived");

  // Late: after the supervisor is up.
  writeFileSync(join(dir, "bin", "pgrep"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
  let lateOut = "";
  const { child, exited } = await startWrapper(command, env, lock, launcher);
  child.stdout?.on("data", (chunk) => {
    lateOut += String(chunk);
  });
  child.kill("SIGINT");
  expect(await exited).toEqual({ code: 0, signal: null });
  expect(lateOut).toContain("survived");
  expect(lockIsFree(lock)).toBe(true);
}, 20_000);

for (const [signal, number] of [
  ["SIGTERM", 15],
  ["SIGINT", 2],
] as const) {
  it(`on ${signal} stops every step of a multi-step session, then frees the lock`, async () => {
    // The runbook's form: `bash -c '<step>; <next step>'`. The running step holds
    // the session lock and keeps going; the signal must reach it, not just the
    // `bash -c` that started it, and the next step must not start.
    const { dir, lock, env } = fixture();
    const pidFile = join(dir, "step.pid");
    const step = join(dir, "step.sh");
    writeFileSync(
      step,
      `source "$GUARD"
vm_lock_owned_by_parent || exit 9
# Slow to stop on TERM, as a step tidying up would be: the wrapper must wait
# for it rather than return while it still holds FD 9.
trap 'sleep 0.5; exit 0' TERM
echo $$ > "${pidFile}"
while true; do sleep 0.2; done
`,
    );
    let stdout = "";
    const { child, exited } = await startWrapper(
      ["bash", "-c", `bash "${step}"; echo NEXT-STEP-RAN`],
      env,
      lock,
    );
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    expect(await eventually(() => readFileSync(pidFile, { flag: "a+" }).length > 0)).toBe(true);
    const stepPid = Number(readFileSync(pidFile, "utf8").trim());

    child.kill(signal);
    expect(await exited).toEqual({ code: 128 + number, signal: null });
    // At the moment the wrapper returns: no step left, lock free, record cleared.
    expect(alive(stepPid)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("");
    expect(lockIsFree(lock)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(stdout).not.toContain("NEXT-STEP-RAN");
  }, 15_000);
}

it("keeps a record that is not its own when the session ends", async () => {
  const { lock, env } = fixture();
  const foreign = 'printf "4242 m1-sweep.sh\\n" > "$MYCO_VM_LOCK_PATH"';
  expect(runSync([WRAPPER, "--", "bash", "-c", foreign], env).status).toBe(0);
  expect(readFileSync(lock, "utf8")).toBe("4242 m1-sweep.sh\n");

  writeFileSync(lock, "");
  const wrapper = spawn("bash", [WRAPPER, "--", "bash", "-c", `${foreign}; exec sleep 30`], {
    env,
    cwd: REPO,
  });
  running.push(wrapper);
  const exited = new Promise<number | null>((resolve) =>
    wrapper.on("exit", (code) => resolve(code)),
  );
  expect(await eventually(() => readLock(lock).startsWith("4242"))).toBe(true);
  wrapper.kill("SIGTERM");
  expect(await exited).toBe(143);
  expect(readFileSync(lock, "utf8")).toBe("4242 m1-sweep.sh\n");
});

it("clears its record on a signal that arrives before the supervisor starts", async () => {
  // The legacy-driver scan (pgrep) runs after the record is written and before
  // the supervisor; a slow stub holds the wrapper in that window.
  const { dir, lock, env } = fixture();
  const marker = join(dir, "in-window");
  writeFileSync(join(dir, "bin", "pgrep"), `#!/bin/bash\n: > "${marker}"\nsleep 1\nexit 1\n`, {
    mode: 0o755,
  });
  const wrapper = spawn("bash", [WRAPPER, "--", "echo", "SHOULD-NOT-RUN"], { env, cwd: REPO });
  running.push(wrapper);
  let stdout = "";
  wrapper.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const exited = new Promise((resolve) =>
    wrapper.on("exit", (code, signal) => resolve({ code, signal })),
  );
  expect(
    await eventually(() => existsSync(marker) && readLock(lock).includes("vm-session.sh")),
  ).toBe(true);
  wrapper.kill("SIGTERM");
  expect(await exited).toEqual({ code: 143, signal: null });
  expect(stdout).not.toContain("SHOULD-NOT-RUN");
  expect(readFileSync(lock, "utf8")).toBe("");
  expect(lockIsFree(lock)).toBe(true);
});

it("exits 125, runs nothing and clears its record when the supervisor cannot start", () => {
  // PATH holds only what the wrapper needs, and a python3 that works once (the
  // lock helper) and then makes itself non-executable, so `exec python3` fails.
  const { dir, lock, env } = fixture();
  const bin = join(dir, "bin");
  const real = spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
  for (const tool of ["bash", "dirname", "ps", "chmod", "sleep"]) {
    const found = spawnSync("bash", ["-c", `command -v ${tool}`], {
      encoding: "utf8",
    }).stdout.trim();
    symlinkSync(found, join(bin, tool));
  }
  writeFileSync(join(bin, "python3"), `#!/bin/bash\nchmod -x "$0"\nexec "${real}" "$@"\n`, {
    mode: 0o755,
  });
  const result = spawnSync(join(bin, "bash"), [WRAPPER, "--", "echo", "SHOULD-NOT-RUN"], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...env, PATH: bin },
    cwd: REPO,
  });
  expect(result.status, result.stderr).toBe(125);
  expect(result.stdout).not.toContain("SHOULD-NOT-RUN");
  expect(result.stderr).toContain("cannot start the python3 supervisor");
  expect(readFileSync(lock, "utf8")).toBe("");
  expect(lockIsFree(lock)).toBe(true);
});

it("never treats pid 1 as a session owner in the shell gate", () => {
  // pid 1 is an ancestor of everything, so the ancestry step alone would pass it.
  const { lock, env } = fixture();
  writeFileSync(lock, "1 vm-session.sh\n");
  const result = runSync(
    [
      "-c",
      'exec 9>>"$MYCO_VM_LOCK_PATH"; source "$GUARD"; vm_lock_fd_is_holders 1 && echo ACCEPTED',
    ],
    env,
  );
  expect(result.stdout).not.toContain("ACCEPTED");
  expect(lockIsFree(lock)).toBe(true);
});

it("exits 125 without taking the lock when python3 is missing", () => {
  // PATH holds bash and dirname only: no python3 anywhere.
  const { dir, lock, env } = fixture();
  const bin = join(dir, "nopython");
  mkdirSync(bin);
  for (const tool of ["bash", "dirname"]) {
    const found = spawnSync("bash", ["-c", `command -v ${tool}`], {
      encoding: "utf8",
    }).stdout.trim();
    symlinkSync(found, join(bin, tool));
  }
  const probe = spawnSync(join(bin, "bash"), ["-c", "command -v python3"], {
    env: { ...env, PATH: bin },
  });
  expect(probe.status).not.toBe(0);
  const result = spawnSync(join(bin, "bash"), [WRAPPER, "--", "echo", "SHOULD-NOT-RUN"], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...env, PATH: bin },
    cwd: REPO,
  });
  expect(result.status, result.stderr).toBe(125);
  expect(result.stdout).not.toContain("SHOULD-NOT-RUN");
  expect(result.stderr).toContain("python3 not found");
  expect(readLock(lock)).toBe("");
});

/** Why the terminal test cannot run here, or null when it can. */
function noPtyReason(): string | null {
  const probe = spawnSync("python3", ["-I", "-c", "import os, pty; os.close(os.openpty()[0])"], {
    encoding: "utf8",
  });
  if (probe.error) return `python3 cannot be started (${probe.error.message})`;
  if (probe.status !== 0) return `no pseudo-terminal available: ${probe.stderr.trim()}`;
  return null;
}
const ptyMissing = noPtyReason();

// When skipped, the reason is part of the title, so the run shows it.
it.skipIf(ptyMissing !== null)(
  `under a terminal: Ctrl-Z/fg, one Ctrl-C lets EXIT traps finish, SIGTERM, and no silent wait${
    ptyMissing ? ` (skipped: ${ptyMissing})` : ""
  }`,
  () => {
    // test/fixtures/vm-session-pty.py runs an interactive bash on a pty and drives
    // seven sessions (a-g, mostly the runbook's `bash -c '<step>; <next step>'`)
    // with real control characters; see its docstring for what each one asserts.
    // Among them: one Ctrl-C reaches a deploy-like step once, so its EXIT trap
    // finishes (d, e); a background child left holding FD 9 gets a waiting report
    // (f); a step stopped by SIGTTIN gets a stopped report (g).
    const { dir, env } = fixture();
    const result = spawnSync(
      "python3",
      ["-I", join(REPO, "test", "fixtures", "vm-session-pty.py"), WRAPPER, dir],
      { encoding: "utf8", timeout: 90_000, env, cwd: REPO },
    );
    expect(result.stdout + result.stderr).toContain("PTY-OK");
    expect(result.status).toBe(0);
  },
  100_000,
);
