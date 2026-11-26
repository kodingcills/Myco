/**
 * The real filesystem and process spawner behind `myco init` (src/setup/init.ts).
 * Kept apart so tests can wrap them (to record every path touched) or replace them.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { SetupFs, Spawner } from "./init.ts";

export const nodeSetupFs: SetupFs = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, "utf8"),
  mode: (path) => statSync(path).mode & 0o777,
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  // COPYFILE_EXCL: a backup never replaces an existing file.
  copy: (from, to) => copyFileSync(from, to, 1),
  writeAtomic: (path, content, mode) => {
    const tmp = `${path}.myco-tmp-${process.pid}`;
    writeFileSync(tmp, content, { mode: mode ?? 0o644 });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
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
