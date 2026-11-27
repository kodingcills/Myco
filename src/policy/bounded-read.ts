/**
 * Track O: a host read of the policy config that never blocks and never reads without bound.
 *
 * The same technique as `src/integrity/nonblocking-read.ts` (#541 R3-1), kept inside the policy
 * module because the policy boundary (`test/policy/boundary.test.ts`) forbids reaching
 * `src/integrity/`: open with `O_NONBLOCK | O_NOFOLLOW` (a FIFO opens at once instead of waiting
 * for a writer; a symlink at the last component is refused), `fstat` the open fd (regular file
 * only, the same device and inode as the caller's earlier `lstat`), then read
 * at most `maxBytes + 1` bytes from that fd, so a file that grows after the `fstat` is caught
 * rather than read on. Every refusal is immediate and carries a code.
 */

import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";

export type BoundedReadRefusal = "missing" | "not-regular" | "swapped" | "too-large";

export type BoundedRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly code: BoundedReadRefusal };

// O_NOFOLLOW and O_NONBLOCK are undefined on Windows, where a FIFO cannot be planted at a path;
// the caller's `lstat` pre-check still refuses a symlink there.
const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export function readBoundedNoBlock(path: string, maxBytes: number, expect: Stats): BoundedRead {
  let fd: number;
  try {
    fd = openSync(path, FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, code: code === "ELOOP" ? "not-regular" : "missing" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: "not-regular" };
    if (stat.ino !== expect.ino || stat.dev !== expect.dev) return { ok: false, code: "swapped" };
    const buf = Buffer.alloc(maxBytes + 1);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    if (off > maxBytes) return { ok: false, code: "too-large" };
    return { ok: true, bytes: buf.subarray(0, off) };
  } catch {
    return { ok: false, code: "missing" };
  } finally {
    closeSync(fd);
  }
}
