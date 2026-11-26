/**
 * Live watch view: a passive, incremental reader of the gate's decision log (the operator's
 * `--audit` JSONL file, one `GateResult` per line).
 *
 * Passive by construction: the file is opened read-only (`O_RDONLY | O_NOFOLLOW`, so a
 * symlink planted at the log path is refused), read from the last offset, and closed. This
 * module has no write, rename, truncate or chmod call, and never creates the file; a log that
 * does not exist yet simply has no records.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** One line longer than this is dropped as malformed (a GateResult is a few KB). */
export const MAX_LINE_BYTES = 1024 * 1024;
const CHUNK = 256 * 1024;

export class DecisionLogTail {
  private offset = 0;
  private pending = "";
  private dropping = false;
  private readonly records: unknown[] = [];
  private malformed = 0;
  private present = false;

  constructor(private readonly path: string) {}

  /** Read whatever was appended since the last poll. Returns true when anything changed. */
  poll(): boolean {
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      const changed = this.present;
      this.present = false;
      return changed;
    }
    let changed = !this.present;
    this.present = true;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return changed;
      if (stat.size < this.offset) {
        // Truncated or replaced: start over rather than show a mix of two logs.
        this.offset = 0;
        this.pending = "";
        this.dropping = false;
        this.records.length = 0;
        this.malformed = 0;
        changed = true;
      }
      const buffer = Buffer.alloc(CHUNK);
      while (this.offset < stat.size) {
        const want = Math.min(CHUNK, stat.size - this.offset);
        const got = readSync(fd, buffer, 0, want, this.offset);
        if (got <= 0) break;
        this.offset += got;
        if (this.take(buffer.toString("utf8", 0, got))) changed = true;
      }
    } finally {
      closeSync(fd);
    }
    return changed;
  }

  private take(text: string): boolean {
    let changed = false;
    const parts = (this.pending + text).split("\n");
    this.pending = parts.pop() ?? "";
    for (const line of parts) {
      if (this.dropping) {
        // The tail of an over-long line.
        this.dropping = false;
        continue;
      }
      changed = true;
      this.accept(line);
    }
    if (Buffer.byteLength(this.pending) > MAX_LINE_BYTES) {
      this.pending = "";
      this.dropping = true;
      this.malformed += 1;
      changed = true;
    }
    return changed;
  }

  private accept(line: string): void {
    if (line.trim().length === 0) return;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      this.malformed += 1;
      return;
    }
    try {
      this.records.push(JSON.parse(line));
    } catch {
      this.malformed += 1;
    }
  }

  /** Every complete record read so far, in log order (unvalidated: project before showing). */
  snapshot(): {
    readonly present: boolean;
    readonly records: readonly unknown[];
    readonly malformed: number;
  } {
    return { present: this.present, records: [...this.records], malformed: this.malformed };
  }
}
