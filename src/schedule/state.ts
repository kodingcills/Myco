/**
 * Track S: the scheduler's durable state, under the operator's `stateDir`.
 *
 *  - `claims.jsonl`: one line per admitted or budget-refused trigger key, appended (and
 *    fsync'd) BEFORE the run starts. A key in this file never runs again, across restarts:
 *    that is the idempotency guarantee (no double runs). The file is read at start; a line
 *    that does not parse refuses the start (fail closed): skipping it could forget a claim
 *    and run that trigger twice.
 *  - `cursor.json`: the time of the last cron evaluation, for missed-run handling.
 *  - `PAUSED`: the global pause / kill switch. Its presence alone pauses every schedule,
 *    so an operator can `touch` it with the service running or stopped.
 *  - `manual/`: the spool the `trigger` command writes manual requests into.
 *
 * Claims hold ids, sources, run ids and a SHA-256 of the trigger key, never a payload.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { TriggerSource } from "./config.ts";

export interface ClaimRecord {
  readonly keySha256: string;
  readonly scheduleId: string;
  readonly source: TriggerSource;
  readonly runId: string;
  /** ms since epoch, from the scheduler's clock. */
  readonly at: number;
  /** True when the trigger passed the budget checks (counts toward runs/day). */
  readonly admitted: boolean;
}

export class ScheduleStateError extends Error {
  override name = "ScheduleStateError";
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The canonical idempotency key material for one trigger. */
export function triggerKeySha256(scheduleId: string, source: TriggerSource, key: string): string {
  return sha256(`myco.schedule.trigger/v1\0${scheduleId}\0${source}\0${key}`);
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class ScheduleState {
  readonly dir: string;
  private readonly claimsPath: string;
  private readonly cursorPath: string;
  private readonly claims = new Map<string, ClaimRecord>();
  /** `${scheduleId}\0${utcDay}` -> admitted count. */
  private readonly perDay = new Map<string, number>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "manual"), { recursive: true, mode: 0o700 });
    this.claimsPath = join(dir, "claims.jsonl");
    this.cursorPath = join(dir, "cursor.json");
    if (existsSync(this.claimsPath)) {
      const lines = readFileSync(this.claimsPath, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line === "") return;
        let rec: ClaimRecord;
        try {
          rec = JSON.parse(line) as ClaimRecord;
        } catch {
          throw new ScheduleStateError(
            `claims.jsonl line ${i + 1} does not parse; refusing to start`,
          );
        }
        if (
          typeof rec?.keySha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(rec.keySha256) ||
          typeof rec.scheduleId !== "string" ||
          typeof rec.at !== "number" ||
          typeof rec.admitted !== "boolean"
        )
          throw new ScheduleStateError(
            `claims.jsonl line ${i + 1} is malformed; refusing to start`,
          );
        this.remember(rec);
      });
    }
  }

  get manualDir(): string {
    return join(this.dir, "manual");
  }

  private remember(rec: ClaimRecord): void {
    this.claims.set(rec.keySha256, rec);
    if (rec.admitted) {
      const k = `${rec.scheduleId}\0${utcDay(rec.at)}`;
      this.perDay.set(k, (this.perDay.get(k) ?? 0) + 1);
    }
  }

  has(keySha256: string): boolean {
    return this.claims.has(keySha256);
  }

  admittedOn(scheduleId: string, ms: number): number {
    return this.perDay.get(`${scheduleId}\0${utcDay(ms)}`) ?? 0;
  }

  /**
   * Durably record a claim. Throws (and remembers nothing) if the key is already claimed or
   * the write fails: a claim that is not on disk must not run.
   */
  claim(rec: ClaimRecord): void {
    if (this.claims.has(rec.keySha256)) throw new ScheduleStateError("key already claimed");
    const fd = openSync(this.claimsPath, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(rec)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.remember(rec);
  }

  readCursor(): number | undefined {
    if (!existsSync(this.cursorPath)) return undefined;
    try {
      const v = JSON.parse(readFileSync(this.cursorPath, "utf8")) as { lastTickMs?: unknown };
      if (typeof v.lastTickMs === "number" && Number.isFinite(v.lastTickMs)) return v.lastTickMs;
    } catch {
      // fall through
    }
    throw new ScheduleStateError("cursor.json is malformed; refusing to start");
  }

  writeCursor(ms: number): void {
    const tmp = `${this.cursorPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastTickMs: ms }), { mode: 0o600 });
    renameSync(tmp, this.cursorPath);
  }

  get pausePath(): string {
    return join(this.dir, "PAUSED");
  }

  isPaused(): boolean {
    return existsSync(this.pausePath);
  }

  /** The first line of the PAUSED file (e.g. `KILLED`), or undefined when not paused. */
  pauseReason(): string | undefined {
    if (!this.isPaused()) return undefined;
    try {
      return readFileSync(this.pausePath, "utf8").split("\n")[0]?.trim() ?? "";
    } catch {
      return "";
    }
  }

  pause(reasonCode: string): void {
    writeFileSync(this.pausePath, `${reasonCode}\n`, { mode: 0o600 });
  }

  resume(): void {
    rmSync(this.pausePath, { force: true });
  }
}
