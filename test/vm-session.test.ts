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
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import {
  acquireVmLock,
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
async function startWrapper(cmd: string[], env: Env, lock: string) {
  const child = spawn("bash", [WRAPPER, "--", ...cmd], { env, cwd: REPO });
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
  const fd = openSync(lock, "a");
  try {
    expect(lockOwnedByAncestor({ path: lock, owner: child.pid, lockFd: fd })).toBe(false);
  } finally {
    closeSync(fd);
  }
  expect(lockOwnedByAncestor({ path: lock, owner: child.pid })).toBe(false);
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
