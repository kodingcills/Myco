/**
 * The VM lock, from the TypeScript side (TIF-191 / F12).
 *
 * `scripts/vm-lock.sh` is the contract: FD 9 on `/tmp/myco-win11.vm.lock` holds a
 * kernel `flock`, the record in the file is `<pid> <driver>` for diagnosis only,
 * and the lock belongs to the open file description, so it survives a short-lived
 * helper and is released when the last process holding that description exits.
 *
 * `run-live.ts` is where the F12 hole was: the drivers (`m1-sweep.sh`,
 * `m1-corrupt-suite.sh`, `reset-trial-vm.sh`, `c1-baseline.sh`, `c1-spike.sh`) all
 * acquire the lock, but the entrypoint that actually drives the guest did not — so
 * an operator running §6 by hand held no ownership evidence, and a driver could
 * cold-reset the guest underneath them. Measured 2026-11-24: one verified row, then
 * 19 rows each returning `uncertain` in 0-1 ms because the tunnel had died with the
 * guest.
 *
 * Node has no `flock`, so acquisition follows the same trick vm-lock.sh uses: open
 * the file, hand the descriptor to a short python3 helper as fd 3, let it take the
 * non-blocking lock, and keep Node's copy of that descriptor open. The helper's
 * `dup` shares the open file description, so the lock outlives the helper and is
 * released by `release()` closing the descriptor.
 *
 * Fail closed is the whole point of this module: every path that cannot prove the
 * lock is ours throws, because a run that proceeds without it is exactly the case
 * that produced 19 bogus `uncertain` rows.
 */

import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import process from "node:process";

export const DEFAULT_VM_LOCK_PATH = "/tmp/myco-win11.vm.lock";

/**
 * Drivers allowed to own the lock for us as an ancestor, mirroring
 * `vm_lock_owned_by_parent` in scripts/vm-lock.sh. A sweep spawns run-live as a
 * child, so run-live must not refuse the lock its own parent holds.
 */
export const PARENT_DRIVERS = [
  "m1-sweep.sh",
  "m1-corrupt-suite.sh",
  "c1-baseline.sh",
  "c1-sweep.sh",
  "c1-spike.sh",
] as const;

/**
 * Parents that prove ownership through the inherited descriptor alone (TIF-210),
 * mirroring the `vm-session.sh` case of `vm_lock_owned_by_parent`. The operator
 * session wrapper is not in {@link PARENT_DRIVERS} on purpose: those accept any
 * descendant via the ppid walk, while a session child must carry the wrapper's
 * FD 9 — the open file description that holds the flock. See
 * {@link inheritedFdHoldsLock}.
 */
export const FD_PROVEN_PARENT_DRIVERS = ["vm-session.sh"] as const;

/** The descriptor scripts/vm-lock.sh holds the flock on, inherited by children. */
const LOCK_FD = 9;

export interface VmLockOptions {
  /** Lock file; defaults to MYCO_VM_LOCK_PATH, then DEFAULT_VM_LOCK_PATH. */
  path?: string;
  /** Recorded in the lock file for diagnosis. */
  driver?: string;
}

/**
 * Seams for {@link lockOwnedByAncestor}, kept out of {@link VmLockOptions} on
 * purpose.
 *
 * `ancestorOf` replaces the ancestry walk outright, so a caller that passed it to
 * the real entry point could certify any live pid as an ancestor and skip taking the
 * lock with no error — the exact silence this module exists to remove. Only the
 * predicate accepts it; {@link acquireVmLockUnlessOwnedByAncestor} takes plain
 * {@link VmLockOptions} and calls the predicate with no seams, so production cannot
 * reach it. A verifier round flagged the exported seam as a footgun; this is the
 * narrowing that closes it.
 *
 * The seam exists because no harness can build a real ancestor chain on purpose: the
 * pid a shell reports for itself is not reliably an ancestor of what it spawns on
 * macOS.
 */
interface OwnershipSeams {
  /** The record this process may claim ownership from; defaults to MYCO_VM_LOCK_OWNER. */
  owner?: number;
  /** The ppid chain walk; defaults to walking `/bin/ps`. */
  ancestorOf?: (pid: number) => boolean;
  /**
   * The descriptor checked for an fd-proven parent; defaults to 9. Tests point it
   * at a descriptor they opened, which can only make the proof harder to pass:
   * whatever fd is named must still be the holder's open file description.
   */
  lockFd?: number;
}

/** The lock is held by someone else. `holder` is the record that named them. */
export class VmLockedError extends Error {
  readonly holder: string;

  constructor(holder: string) {
    super(`VM lock is held: ${holder}`);
    this.name = "VmLockedError";
    this.holder = holder;
  }
}

export interface VmLock {
  readonly path: string;
  readonly holder: string;
  /** Idempotent; closes the descriptor, which releases the kernel lock. */
  release(): void;
}

/**
 * Take the lock or throw. Throws {@link VmLockedError} on contention, and a plain
 * Error when the lock state cannot be determined — both are refusals.
 *
 * The record written is `<pid> <driver>` for the same reason vm-lock.sh writes one:
 * a human reading the file must be able to name the owner without `lsof`.
 */
export function acquireVmLock(options: VmLockOptions = {}): VmLock {
  const path = options.path ?? process.env.MYCO_VM_LOCK_PATH ?? DEFAULT_VM_LOCK_PATH;
  const driver = options.driver ?? "run-live.ts";

  let fd: number;
  try {
    fd = openSync(path, "a");
  } catch (error) {
    throw new Error(`VM lock: cannot open ${path}: ${String(error)}`);
  }

  const holder = runLockHelper(path, driver, fd);
  if (holder !== undefined) {
    closeSync(fd);
    throw new VmLockedError(holder);
  }

  let released = false;
  return {
    path,
    holder: `${process.pid} ${driver}`,
    release() {
      if (released) return;
      released = true;
      closeSync(fd);
    },
  };
}

/**
 * Acquire the lock unless an ancestor driver already holds it, in which case there
 * is nothing to take and nothing to release. This is the `vm_lock_owned_by_parent`
 * equivalent, and it is what keeps a sweep's own child trials from refusing.
 */
export function acquireVmLockUnlessOwnedByAncestor(
  options: VmLockOptions = {},
): VmLock | undefined {
  // Never forwards a seam: this is the production entry point, and the ancestry
  // walk is the thing it must not be able to skip.
  if (lockOwnedByAncestor({ path: options.path, driver: options.driver })) return undefined;
  return acquireVmLock(options);
}

/**
 * True when MYCO_VM_LOCK_OWNER names a live ancestor that the lock file records as
 * its owner. Any failure to establish that returns false, which sends the caller to
 * {@link acquireVmLock} — the safe direction, since a genuinely held lock still
 * refuses there.
 */
export function lockOwnedByAncestor(options: VmLockOptions & OwnershipSeams = {}): boolean {
  const path = options.path ?? process.env.MYCO_VM_LOCK_PATH ?? DEFAULT_VM_LOCK_PATH;
  const owner = options.owner ?? Number(process.env.MYCO_VM_LOCK_OWNER ?? "");
  if (!Number.isInteger(owner) || owner <= 1) return false;

  let record: { pid: number; driver: string };
  try {
    record = parseLockRecord(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (record.pid !== owner) return false;
  const fdProven = FD_PROVEN_PARENT_DRIVERS.includes(
    record.driver as (typeof FD_PROVEN_PARENT_DRIVERS)[number],
  );
  if (!fdProven && !PARENT_DRIVERS.includes(record.driver as (typeof PARENT_DRIVERS)[number])) {
    return false;
  }
  // EPERM means the process exists but is not ours to signal, so it is alive.
  try {
    process.kill(owner, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  // No ancestry fallback for an fd-proven parent: descending from the wrapper is
  // not evidence, carrying its descriptor is.
  if (fdProven) return inheritedFdHoldsLock(path, options.lockFd ?? LOCK_FD);
  return options.ancestorOf ? options.ancestorOf(owner) : isAncestor(owner);
}

/**
 * True when `fd` is the open file description holding the flock on `path`.
 *
 * Two checks, both required. `samestat`: the descriptor is the lock file, not a
 * reused fd number (a Node launcher's own fd 9 is a pipe or kqueue). Then a
 * `LOCK_EX | LOCK_NB` on a dup of it: on the holder's description that is a no-op,
 * because the exclusive lock is already on it; on a description this process
 * opened itself it fails while the holder lives. That second check is what turns
 * "has the file open" into "inherited the lock". It runs only after samestat, so it
 * never touches any file but the lock file. Any failure is false.
 */
function inheritedFdHoldsLock(path: string, fd: number): boolean {
  try {
    const held = fstatSync(fd);
    const file = statSync(path);
    if (held.dev !== file.dev || held.ino !== file.ino) return false;
  } catch {
    return false;
  }
  const result = spawnSync(
    "python3",
    ["-c", "import fcntl\nfcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)"],
    // Child fd 3 is a dup of `fd`: the same open file description.
    { stdio: ["ignore", "ignore", "ignore", fd], timeout: 10_000 },
  );
  return result.error === undefined && result.status === 0;
}

function parseLockRecord(text: string): { pid: number; driver: string } {
  const [pidText, ...driverParts] = text.trim().split(/\s+/);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`unreadable lock record: ${text.trim()}`);
  return { pid, driver: driverParts.join(" ") };
}

/** Walk the ppid chain from this process upward, the way vm_lock_owned_by_parent does. */
function isAncestor(pid: number): boolean {
  let curr = process.ppid;
  for (let depth = 0; curr > 1 && depth < 64; depth += 1) {
    if (curr === pid) return true;
    try {
      const out = spawnSync("ps", ["-o", "ppid=", "-p", String(curr)], { encoding: "utf8" });
      const next = Number(out.stdout.trim());
      if (!Number.isInteger(next) || next <= 0 || next === curr) return false;
      curr = next;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Runs the flock helper against an inherited descriptor.
 *
 * Returns the holder record on contention, or undefined once the lock is ours.
 * Anything else — no python3, an unreadable record, an unexpected exit — throws,
 * because "could not determine" must never read as "acquired".
 */
function runLockHelper(path: string, driver: string, fd: number): string | undefined {
  const script = `
import fcntl, os, sys
from pathlib import Path

path, pid, driver = sys.argv[1:]
try:
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    try:
        holder = Path(path).read_text().strip()
    except OSError:
        holder = ""
    print(holder or "initializing lock owner")
    sys.exit(10)
os.ftruncate(3, 0)
os.write(3, f"{pid} {driver}\\n".encode())
`;
  const result = spawnSync("python3", ["-c", script, path, String(process.pid), driver], {
    encoding: "utf8",
    // Child fd 3 is a dup of ours: the same open file description, so the lock
    // taken here is the one Node keeps by leaving `fd` open.
    stdio: ["ignore", "pipe", "pipe", fd],
    timeout: 10_000,
  });

  if (result.error) {
    throw new Error(`VM lock: cannot run python3 to take ${path}: ${result.error.message}`);
  }
  if (result.status === 10) {
    const holder = result.stdout.trim();
    if (!holder) throw new Error(`VM lock: ${path} is held by an unidentified owner`);
    return holder;
  }
  if (result.status !== 0) {
    throw new Error(
      `VM lock: python3 exited ${String(result.status)} taking ${path}: ${result.stderr.trim()}`,
    );
  }
  return undefined;
}
