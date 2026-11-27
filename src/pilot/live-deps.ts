/**
 * The real outside world for a live launch (`src/pilot/live-launch.ts`): the process
 * environment (names checked; passed to `claude` by allowlist only), the VM lock check, the
 * real VM backend (built lazily, only after every precondition held) and `child_process.spawn`.
 * Only the runner CLIs import this; tests pass fakes to `launchR1Live` / `launchAbLive`.
 */
import { spawn } from "node:child_process";
import { lockOwnedByAncestor } from "../integration/vm-lock.ts";
import type { SpawnFn } from "./claude-transport.ts";
import type { LiveDeps } from "./live-launch.ts";
import { realVmBackend } from "./vm-capture.ts";

export function realLiveDeps(
  repoRoot: string,
  tokenFile: string | undefined,
  log: (line: string) => void,
): LiveDeps {
  return {
    env: process.env,
    vmLockOwned: () => lockOwnedByAncestor(),
    vmBackend: () =>
      realVmBackend({
        repoRoot,
        inheritLockFd: true,
        ...(tokenFile === undefined ? {} : { tokenFile }),
      }),
    spawn: spawn as unknown as SpawnFn,
    claudeCommand: "claude",
    log,
  };
}
