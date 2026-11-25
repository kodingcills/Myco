/**
 * TIF-191 (F12): `run-live` must hold the VM lock, and must fail closed when a
 * driver already owns it.
 *
 * Every case uses MYCO_VM_LOCK_PATH in a temp dir, so none of these tests can touch
 * `/tmp/myco-win11.vm.lock` or the real guest. Contention is real contention: a
 * python3 process takes the flock and is then asked for it from another process.
 *
 * The entrypoint assertions read the exit code, which is the contract the drivers
 * already use: 10 means `REFUSED_VM_LOCKED`, and any other code means the lock was
 * not the thing that stopped it.
 */

import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import { acquireVmLock, lockOwnedByAncestor, VmLockedError } from "../src/integration/vm-lock.ts";

const REPO = join(__dirname, "..");
const RUN_LIVE = join(REPO, "src", "integration", "run-live.ts");
const REFUSED = 10;
// A HOME with no `.myco-token`, so a test that gets past the lock stops at the token
// check instead of dialling the real guest with this host's credentials.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "myco-tif191-home-"));

const HOLDER = `
import fcntl, os, sys
path, driver = sys.argv[1:3]
f = open(path, "a")
fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
f.seek(0)
f.truncate(0)
f.write(f"{os.getpid()} {driver}\\n")
f.flush()
print("locked", flush=True)
sys.stdin.read()
`;

/** Tries the same non-blocking flock the lock module uses; prints HELD or FREE. */
const PROBER = `
import fcntl, sys
try:
    fcntl.flock(open(sys.argv[1], "a"), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("HELD")
else:
    print("FREE")
`;

const holders: ChildProcess[] = [];

afterEach(() => {
  for (const holder of holders.splice(0)) holder.kill("SIGKILL");
});

function tempLock(): { dir: string; lock: string } {
  const dir = mkdtempSync(join(tmpdir(), "myco-tif191-"));
  return { dir, lock: join(dir, "vm.lock") };
}

/** Start a real owner of the lock and wait until it reports holding it. */
async function startHolder(lock: string, driver = "m1-sweep.sh"): Promise<ChildProcess> {
  const holder = spawn("python3", ["-c", HOLDER, lock, driver], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  holders.push(holder);
  await new Promise<void>((resolve, reject) => {
    let seen = "";
    holder.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes("locked")) resolve();
    });
    holder.on("exit", (code) => reject(new Error(`holder exited ${String(code)}`)));
  });
  return holder;
}

function runLive(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", RUN_LIVE, ...args], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HOME: SANDBOX_HOME, MYCO_AGENT_TOKEN: "", ...env },
  });
  return { status: result.status, stderr: result.stderr };
}

it("refuses a held lock and names the holder", async () => {
  const { lock } = tempLock();
  await startHolder(lock, "m1-sweep.sh");
  const holderPid = Number(readFileSync(lock, "utf8").split(/\s+/)[0]);

  let caught: unknown;
  try {
    acquireVmLock({ path: lock, driver: "run-live.ts" });
  } catch (error) {
    caught = error;
  }
  // The record is the diagnosis: which pid, which driver.
  expect(caught).toBeInstanceOf(VmLockedError);
  expect((caught as VmLockedError).holder).toBe(`${holderPid} m1-sweep.sh`);
});

it("takes a free lock, records itself, excludes another process, and frees it on release", () => {
  const { lock } = tempLock();
  const probe = () =>
    spawnSync("python3", ["-c", PROBER, lock], { encoding: "utf8" }).stdout.trim();

  expect(probe()).toBe("FREE");

  const held = acquireVmLock({ path: lock, driver: "run-live.ts" });
  expect(held.holder).toBe(`${process.pid} run-live.ts`);
  expect(readFileSync(lock, "utf8").trim()).toBe(`${process.pid} run-live.ts`);
  // A second process is the case that matters: an in-process flag would pass here.
  expect(probe()).toBe("HELD");

  held.release();
  expect(probe()).toBe("FREE");
  // Releasing twice must not close an unrelated descriptor.
  expect(() => held.release()).not.toThrow();
});

it("fails closed before touching the guest: exit 10, no runs dir, no tunnel", async () => {
  const { dir, lock } = tempLock();
  await startHolder(lock);
  const runsDir = join(dir, "runs");
  const holderPid = Number(readFileSync(lock, "utf8").split(/\s+/)[0]);

  const result = runLive(["--mode", "values", "--limit", "1", "--runs-dir", runsDir], {
    MYCO_VM_LOCK_PATH: lock,
  });

  expect(result.status, result.stderr).toBe(REFUSED);
  expect(result.stderr).toContain(`REFUSED_VM_LOCKED: holder ${holderPid} m1-sweep.sh`);
  // The refusal is *before* the work: no run dir, no ssh tunnel, no ping.
  expect(existsSync(runsDir)).toBe(false);
  expect(result.stderr).not.toContain("agent ping ok");
});

it("inherits the lock its ancestor sweep owns instead of refusing it", () => {
  const { lock } = tempLock();
  // A sweep holds the lock and spawns run-live as a child. If run-live refused, every
  // sweep trial would exit 10 — so the pass condition is "not REFUSED", and a missing
  // token (exit 1) proves it got past the lock without touching the guest.
  const sweep = spawnSync(
    "bash",
    [
      "-c",
      `source "$REPO/scripts/vm-lock.sh"
export MYCO_VM_LOCK_PATH="$LOCK"
vm_lock_acquire m1-sweep.sh || exit "$?"
# Not the last command: bash must not exec it away, or the owning pid would vanish
# and the ancestor check would correctly report no owner.
"$NODE" --import tsx "$RUNLIVE" --mode values --limit 1 --runs-dir "$RUNS"
rc=$?
echo "sweep-still-alive rc=$rc"
exit $rc`,
    ],
    {
      cwd: REPO,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        REPO,
        LOCK: lock,
        RUNS: join(lock, "..", "runs-inherited"),
        NODE: process.execPath,
        RUNLIVE: RUN_LIVE,
        HOME: SANDBOX_HOME,
        MYCO_VM_LOCK_PATH: lock,
        MYCO_VM_LOCK_OWNER: "",
        MYCO_AGENT_TOKEN: "",
      },
    },
  );
  expect(sweep.status, sweep.stderr).not.toBe(REFUSED);
  expect(sweep.status, sweep.stderr).toBe(1);
  expect(sweep.stdout).toContain("sweep-still-alive rc=1");
  expect(sweep.stderr).toContain("no agent token");
});

it("does not accept a lock record naming a pid that is not an ancestor", async () => {
  const { lock } = tempLock();
  await startHolder(lock);
  const holderPid = Number(readFileSync(lock, "utf8").split(/\s+/)[0]);

  // Claiming ownership of someone else's lock must not be enough: the pid must also
  // be a live ancestor, so a stale or borrowed record cannot unlock the guest.
  const result = runLive(["--mode", "values", "--limit", "1"], {
    MYCO_VM_LOCK_PATH: lock,
    MYCO_VM_LOCK_OWNER: String(holderPid),
  });

  expect(result.status, result.stderr).toBe(REFUSED);
});

/**
 * The ownership rules in `lockOwnedByAncestor`, each pinned by a case that fails
 * when that rule is removed.
 *
 * These call the predicate directly with its two seams (`owner`, `ancestorOf`)
 * rather than building a real driver ancestor. That is not a shortcut: on macOS the
 * pid a shell reports for itself is not reliably an ancestor of what it goes on to
 * spawn, so no harness can construct that chain on purpose — an earlier version of
 * this file did try, and every case passed while the predicate returned false for an
 * unrelated reason. `isAncestor`'s own walk is covered by the sweep-child case above.
 */
function owned(options: {
  owner?: number;
  record: string;
  ancestorOf?: (pid: number) => boolean;
}): boolean {
  const { lock } = tempLock();
  writeFileSync(lock, options.record);
  return lockOwnedByAncestor({
    path: lock,
    owner: options.owner ?? LIVE_SELF,
    ancestorOf: options.ancestorOf ?? (() => true),
  });
}

// A live pid that is not special: this test runner's own.
const LIVE_SELF = process.pid;

it("rejects a claim naming pid 1, which is a live ancestor nobody may own", () => {
  expect(owned({ owner: 1, record: "1 m1-sweep.sh\n" })).toBe(false);
  expect(owned({ owner: 0, record: "0 m1-sweep.sh\n" })).toBe(false);
});

it("rejects a record whose driver is not allowed to own the lock", () => {
  expect(owned({ record: `${LIVE_SELF} not-a-driver.sh\n` })).toBe(false);
  // The same pid with a real driver is accepted, so the rejection is the driver.
  expect(owned({ record: `${LIVE_SELF} m1-sweep.sh\n` })).toBe(true);
});

it("rejects a record naming a live process when the owner variable names someone else", () => {
  expect(owned({ owner: LIVE_SELF, record: `${process.ppid} m1-sweep.sh\n` })).toBe(false);
});

it("rejects a stale record whose pid is dead even though it names a real driver", () => {
  // This runner's own short-lived child, reaped before the predicate runs.
  const dead = Number(spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim());
  expect(Number.isInteger(dead) && dead > 1).toBe(true);
  expect(owned({ owner: dead, record: `${dead} m1-sweep.sh\n` })).toBe(false);
});

it("rejects an unreadable or corrupt record rather than assuming ownership", () => {
  const { lock } = tempLock();
  expect(lockOwnedByAncestor({ path: lock, owner: LIVE_SELF, ancestorOf: () => true })).toBe(false);
  writeFileSync(lock, "not-a-pid m1-sweep.sh\n");
  expect(lockOwnedByAncestor({ path: lock, owner: LIVE_SELF, ancestorOf: () => true })).toBe(false);
  writeFileSync(lock, `${LIVE_SELF}\n`);
  // A record with no driver fails the driver rule, not the parse.
  expect(lockOwnedByAncestor({ path: lock, owner: LIVE_SELF, ancestorOf: () => true })).toBe(false);
});

it("requires the walk to confirm ancestry, not just a live matching pid", () => {
  expect(owned({ record: `${LIVE_SELF} m1-sweep.sh\n`, ancestorOf: () => false })).toBe(false);
  expect(owned({ record: `${LIVE_SELF} m1-sweep.sh\n`, ancestorOf: () => true })).toBe(true);
});
