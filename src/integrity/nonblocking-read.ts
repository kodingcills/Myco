/**
 * A host read that never blocks and reads only a regular file (#541 R3-1).
 *
 * The vault reads its own sealed files, its manifests and the oracle's sources by host path.
 * On an unprivileged backend (`linux-plain`) an agent runs as the same uid as the harness, so
 * it can replace any of those paths. A plain `readFileSync` on a FIFO planted there waits in
 * `open()` for a writer forever and freezes the harness's whole event loop: every trial,
 * timeout and watchdog in the process stops with it. A symlink to `/dev/zero` (or a huge
 * sparse file) makes the read unbounded.
 *
 * `readRegularNoBlock` opens with `O_NONBLOCK | O_NOFOLLOW` (a FIFO opens at once, a symlink
 * at the last component is refused), checks the open fd with `fstat` (regular file only,
 * optionally the same inode as a caller's earlier `lstat`, at most `maxBytes`), and reads
 * from that fd. Every refusal is immediate and carries a code. For a regular file the bytes
 * are exactly what `readFileSync` returns.
 */

import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";

/** Why a read was refused. `missing` covers every open error except a refused symlink. */
export type NoBlockReadRefusal = "missing" | "not-regular" | "swapped" | "too-large";

export type NoBlockRead =
  | { readonly ok: true; readonly bytes: Buffer; readonly stat: Stats }
  | { readonly ok: false; readonly code: NoBlockReadRefusal; readonly error?: unknown };

export interface NoBlockReadOptions {
  /** A file larger than this is refused, never read. */
  readonly maxBytes: number;
  /**
   * The caller's earlier `lstat` of the same path. When given, the open fd must be that
   * same file (device and inode): a swap between the `lstat` and the `open` is refused.
   */
  readonly expect?: Stats;
}

// Not defined on Windows; there a FIFO cannot be planted at a path and the vault's `lstat`
// pre-checks still refuse a symlink.
const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export function readRegularNoBlock(path: string, opts: NoBlockReadOptions): NoBlockRead {
  let fd: number;
  try {
    fd = openSync(path, FLAGS);
  } catch (error) {
    // ELOOP: the last component is a symlink (O_NOFOLLOW). Anything else: unreadable.
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, code: code === "ELOOP" ? "not-regular" : "missing", error };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: "not-regular" };
    if (opts.expect && (stat.ino !== opts.expect.ino || stat.dev !== opts.expect.dev))
      return { ok: false, code: "swapped" };
    if (stat.size > opts.maxBytes) return { ok: false, code: "too-large" };
    const buf = Buffer.alloc(stat.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { ok: true, bytes: off === buf.length ? buf : buf.subarray(0, off), stat };
  } catch (error) {
    return { ok: false, code: "missing", error };
  } finally {
    closeSync(fd);
  }
}
