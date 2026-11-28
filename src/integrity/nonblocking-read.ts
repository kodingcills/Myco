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

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";

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
    // ELOOP: the last component is a symlink (O_NOFOLLOW). ENXIO: a unix socket, which
    // `open` cannot open (#578 N1); like a FIFO it is a special file, not a missing one.
    // Anything else: unreadable.
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      code: code === "ELOOP" || code === "ENXIO" ? "not-regular" : "missing",
      error,
    };
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

/** Why a directory read was refused (#578 F1). */
export type NoFollowDirRefusal = "missing" | "not-directory" | "swapped" | "too-many";

export type NoFollowDir =
  | { readonly ok: true; readonly names: readonly string[]; readonly stat: Stats }
  | { readonly ok: false; readonly code: NoFollowDirRefusal; readonly error?: unknown };

export interface NoFollowDirOptions {
  /** More entries than this refuses the read (`too-many`); at most this many + 1 are read. */
  readonly maxEntries: number;
  /**
   * The caller's earlier `lstat` of the same path. When given, the opened dir must be that
   * same dir (device and inode): a dir swapped between the `lstat` and the `open` is refused.
   */
  readonly expect?: Stats;
}

const DIR_FLAGS =
  constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

/** Linux: list the dir through its open fd, so a later swap of the path cannot redirect it. */
const FD_DIR = process.platform === "linux" && existsSync("/proc/self/fd") ? "/proc/self/fd" : null;

/**
 * List a directory without following a symlink at its path, and without being redirected by
 * a swap (#578 F1). A walk that decides to recurse from an `lstat` (or a `readdir` d_type)
 * and then re-opens the child by path can be led anywhere: a same-uid agent that swaps a dir
 * for a symlink to `/usr` between the two steps makes the walk list all of `/usr`.
 *
 * - open the path `O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK`: a symlink or a non-dir is refused
 *   at once (`not-directory`), and nothing that could block is opened;
 * - `fstat` the fd: a directory, and the same dir as the caller's `lstat` when one is given
 *   (`swapped`);
 * - read the entries from that fd (Linux: `/proc/self/fd/<fd>`, which names the opened dir
 *   itself, never the path); elsewhere read by path and re-`lstat` afterwards, refusing a
 *   path that no longer names the opened dir (`swapped`);
 * - stop after `maxEntries + 1` entries (`too-many`), so a huge tree cannot stall the walk.
 *
 * `.` and `..` are never returned. Every refusal is immediate and carries a code.
 */
export function readDirNoFollow(path: string, opts: NoFollowDirOptions): NoFollowDir {
  let fd: number;
  try {
    fd = openSync(path, DIR_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      code: code === "ELOOP" || code === "ENOTDIR" ? "not-directory" : "missing",
      error,
    };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) return { ok: false, code: "not-directory" };
    if (opts.expect && (stat.ino !== opts.expect.ino || stat.dev !== opts.expect.dev))
      return { ok: false, code: "swapped" };
    const names: string[] = [];
    const dir = opendirSync(FD_DIR ? `${FD_DIR}/${fd}` : path);
    try {
      for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
        if (e.name === "." || e.name === "..") continue;
        if (names.length >= opts.maxEntries) return { ok: false, code: "too-many" };
        names.push(e.name);
      }
    } finally {
      dir.closeSync();
    }
    if (!FD_DIR) {
      const after = lstatSync(path);
      if (!after.isDirectory() || after.ino !== stat.ino || after.dev !== stat.dev)
        return { ok: false, code: "swapped" };
    }
    return { ok: true, names, stat };
  } catch (error) {
    return { ok: false, code: "missing", error };
  } finally {
    closeSync(fd);
  }
}
