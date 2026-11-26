/**
 * Track L (safe parallelism) — run-id claims that survive case folding.
 *
 * Two trials whose run ids differ only by case (`Run-A` and `run-a`) are the same trial
 * on a case-insensitive filesystem (macOS APFS by default, Windows NTFS): their vault
 * dirs, evidence roots and workspaces would alias. So a run id is claimed by its FOLDED
 * form, and a second claim of the same folded form is refused while the first is held:
 *
 * - in-process, by `RunIdRegistry` (one pool, many concurrent trials);
 * - across processes, by an exclusive lock file per folded id in a shared registry dir
 *   (two pools started against the same run root). The lock is `open(..., "wx")`, so the
 *   kernel decides the race, not a check-then-create.
 *
 * Fail closed: a malformed id, a held claim or an existing lock file (even a stale one
 * from a crashed pool) is a refusal. Stale locks are not reaped automatically: the
 * operator removes them after checking that the pool that wrote them is gone.
 */

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/** The vault's run-id rule (`src/integrity/vault.ts` `safeRunId`), restated here. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type RunIdRefusal = "bad-run-id" | "duplicate-folded" | "claimed" | "locked";

export class RunIdError extends Error {
  constructor(
    readonly code: RunIdRefusal,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RunIdError";
  }
}

/**
 * The folded form two run ids collide on. NFKC then a full upper→lower round trip, so
 * compatibility forms and case variants (`ﬁ`/`fi`, `ß`/`SS`/`ss`, `K` Kelvin sign) fold
 * together even though the run-id rule only admits ASCII today.
 */
export function foldRunId(runId: string): string {
  return runId.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

export function checkRunId(runId: unknown): string {
  if (typeof runId !== "string" || !RUN_ID.test(runId) || runId.includes(".."))
    throw new RunIdError("bad-run-id", JSON.stringify(runId));
  return runId;
}

/** Refuse a batch whose run ids collide after folding, before anything starts. */
export function assertDistinctFolded(runIds: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const id of runIds) {
    checkRunId(id);
    const folded = foldRunId(id);
    const prior = seen.get(folded);
    if (prior !== undefined)
      throw new RunIdError(
        "duplicate-folded",
        `${JSON.stringify(prior)} and ${JSON.stringify(id)} are the same run after case folding`,
      );
    seen.set(folded, id);
  }
}

export interface RunIdClaim {
  readonly runId: string;
  readonly folded: string;
  release(): void;
}

/** File name of the lock for a folded id: a digest, so no case or path issue reaches disk. */
export function lockName(folded: string): string {
  return `${createHash("sha256").update(folded).digest("hex")}.lock`;
}

export class RunIdRegistry {
  private readonly held = new Map<string, string>();

  /** @param lockDir shared dir for cross-process locks; omit for in-process only. */
  constructor(private readonly lockDir?: string) {
    if (lockDir) mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  }

  claim(runId: string): RunIdClaim {
    checkRunId(runId);
    const folded = foldRunId(runId);
    const holder = this.held.get(folded);
    if (holder !== undefined)
      throw new RunIdError(
        "claimed",
        `${JSON.stringify(runId)} folds to the running trial ${JSON.stringify(holder)}`,
      );
    let lockPath: string | undefined;
    if (this.lockDir) {
      lockPath = join(this.lockDir, lockName(folded));
      let fd: number;
      try {
        fd = openSync(lockPath, "wx", 0o600);
      } catch {
        throw new RunIdError(
          "locked",
          `${JSON.stringify(runId)} is claimed by another pool (lock ${lockName(folded)})`,
        );
      }
      try {
        writeSync(fd, `${JSON.stringify({ runId, folded, pid: process.pid })}\n`);
      } finally {
        closeSync(fd);
      }
    }
    this.held.set(folded, runId);
    let released = false;
    return {
      runId,
      folded,
      release: () => {
        if (released) return;
        released = true;
        this.held.delete(folded);
        if (lockPath) rmSync(lockPath, { force: true });
      },
    };
  }

  /** Folded ids currently held by this registry. */
  heldIds(): string[] {
    return [...this.held.keys()];
  }
}
