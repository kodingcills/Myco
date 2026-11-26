/**
 * The real filesystem and process spawner behind `myco init` (src/setup/init.ts).
 * Kept apart so tests can wrap them (to record every path touched) or replace them.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { PathKind, SetupFs, Spawner } from "./init.ts";

function code(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

export const nodeSetupFs: SetupFs = {
  exists: (path) => existsSync(path),
  kind: (path): PathKind => {
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) return "symlink";
      if (st.isFile()) return st.nlink > 1 ? "hardlink" : "file";
      return st.isDirectory() ? "dir" : "other";
    } catch (error) {
      if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return "missing";
      throw error;
    }
  },
  realpath: (path) => realpathSync.native(path),
  readText: (path) => {
    // O_NOFOLLOW: a link swapped in after the lstat check is refused, not followed.
    // O_NONBLOCK: a FIFO swapped in opens at once (and is then refused) instead of hanging.
    const fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      // Checked on the open descriptor, so a swap after the caller's lstat cannot get past it.
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error(`${path} is not a regular file`);
      if (st.nlink > 1) throw new Error(`${path} has more than one hard link`);
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  },
  mode: (path) => statSync(path).mode & 0o777,
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  // COPYFILE_EXCL opens the target O_CREAT|O_EXCL: anything at `to`, even a dangling link,
  // makes it fail instead of being written through or replaced.
  copyExclusive: (from, to) => {
    try {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      return true;
    } catch (error) {
      if (code(error) === "EEXIST") return false;
      throw error;
    }
  },
  writeAtomic: (path, content, mode) => {
    const tmp = `${path}.myco-tmp-${process.pid}`;
    // flag "wx": the temp file is always new; an existing file or link there is an error.
    writeFileSync(tmp, content, { mode: mode ?? 0o644, flag: "wx" });
    try {
      // writeFileSync's mode is masked by the umask; chmod restores the original bits.
      if (mode !== undefined) chmodSync(tmp, mode);
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  },
};

export const nodeSpawner: Spawner = (command, args, options) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env,
    timeout: options.timeoutMs,
    ...(options.input === undefined
      ? { stdio: ["ignore", "pipe", "pipe"] as const }
      : { input: options.input }),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error.message } : {}),
  };
};
