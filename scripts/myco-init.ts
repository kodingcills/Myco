/**
 * `myco init`: one-command local setup (M2 scope add, track D).
 *
 *   bin/myco init [--dry-run] [--global [--yes]] [--project <dir>] [--task <id>] [--run <id>]
 *   pnpm myco init ...
 *
 * All logic lives in src/setup/init.ts. This shell supplies the real filesystem and
 * process spawner, and passes in only the five environment names init reads
 * (`pickInitEnv`): the environment is never enumerated or forwarded.
 */
import { resolve } from "node:path";
import { initCwd, mainInit, pickInitEnv } from "../src/setup/init.ts";
import { nodeSetupFs, nodeSpawner } from "../src/setup/node-io.ts";

process.exitCode = mainInit(process.argv.slice(2), {
  fs: nodeSetupFs,
  spawn: nodeSpawner,
  env: pickInitEnv(process.env),
  platform: process.platform,
  now: () => new Date(),
  cwd: initCwd(
    {
      INIT_CWD: process.env.INIT_CWD,
      npm_lifecycle_event: process.env.npm_lifecycle_event,
      npm_package_name: process.env.npm_package_name,
    },
    process.cwd(),
  ),
  mycoRoot: resolve(import.meta.dirname, ".."),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
