/**
 * Per-trial isolation for orchestrated workers: the small interface track V needs from
 * track L (per-trial isolated desktops). The real desktop implementation lands with L; this
 * file holds the interface and a local, $0 implementation (a fresh 0700 directory per trial)
 * that the scripted end-to-end test uses.
 *
 * Contract every implementation keeps:
 *  - one `provision` per worker trial, never shared: the workspace is new and disjoint from
 *    every other workspace the orchestrator has seen (it re-checks; see `orchestrator.ts`);
 *  - `release` tears the trial down; the orchestrator counts a desktop as live from
 *    `provision` until `release` settles, which is what `maxConcurrentDesktops` caps.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { realish } from "./limits.ts";

export interface IsolatedTrial {
  /** The trial's run id (the orchestrator mints it; the isolation does not choose it). */
  readonly runId: string;
  /** Host path of the trial's own workspace (the worker's only writable place). */
  readonly workspace: string;
  release(): Promise<void>;
}

export interface TrialIsolation {
  /** Host roots every workspace lives under: agent-reachable, so never the vault or ledger. */
  readonly agentRoots: readonly string[];
  provision(runId: string): Promise<IsolatedTrial>;
}

/** Local isolation: one fresh `mkdtemp` directory (mode 0700) per trial under `root`. */
export function tempDirIsolation(root: string): TrialIsolation {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const real = realish(root);
  return {
    agentRoots: Object.freeze([real]),
    async provision(runId) {
      const workspace = mkdtempSync(join(real, `${runId}-`));
      chmodSync(workspace, 0o700);
      let released = false;
      return Object.freeze({
        runId,
        workspace,
        async release() {
          if (released) return;
          released = true;
          rmSync(workspace, { recursive: true, force: true });
        },
      });
    },
  };
}
