/**
 * Bounded framing for the `myco-gate` MCP server's stdin (track H, finding H-01 in
 * docs/security/gate-api-review.md).
 *
 * `serveStdio` reads newline-delimited JSON-RPC with `readline`, which buffers a line until
 * it sees a newline, with no size limit. A single oversized frame (a `claim` of a gigabyte,
 * or a frame that never ends) would grow the gate process until it dies. `CLAIM_LIMIT` is
 * checked only after the whole frame has been buffered and parsed.
 *
 * `boundFrames` sits in front of stdin. A frame longer than `maxBytes` (not counting its
 * newline) is dropped while it streams, so at most `maxBytes` of it is ever held. In its
 * place, once its newline arrives (or stdin ends), the stream emits `OVERSIZED_FRAME_LINE`:
 * a fixed line that `handleLine` answers with JSON-RPC `-32600 invalid request` (id null),
 * in order with the other replies. The server then keeps serving. Frames within the cap
 * pass through byte for byte.
 *
 * Nothing here parses JSON or reads a request field: the gate's own parser stays the only
 * judge of a request. Depth needs no separate cap, because V8's `JSON.parse` is iterative,
 * the gate reads only top-level keys, and the byte cap bounds depth anyway.
 */
import { type Readable, Transform, type TransformCallback } from "node:stream";

/** 1 MiB: about 250 times the largest valid request (a 4000-character claim, escaped). */
export const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * What replaces an oversized frame. It has an `id` but no `jsonrpc`, so `handleLine` replies
 * `-32600 invalid request` with id null. It carries no method, so no handler runs.
 */
export const OVERSIZED_FRAME_LINE = '{"id":null}';

const NEWLINE = 0x0a;

export interface BoundFramesOptions {
  /** Longest frame passed through, in bytes, not counting its newline. */
  readonly maxBytes?: number;
  /** Operator-side note that a frame was dropped (the CLI writes it to stderr). */
  readonly onOversized?: () => void;
}

/** A newline-framing transform that never holds more than `maxBytes` of one frame. */
export class FrameBound extends Transform {
  readonly maxBytes: number;
  private readonly onOversized: (() => void) | undefined;
  private held: Buffer[] = [];
  private heldBytes = 0;
  private dropping = false;
  /** The most bytes of one partial frame ever held at once (for tests and diagnostics). */
  peakHeldBytes = 0;

  constructor(options: BoundFramesOptions = {}) {
    super();
    const maxBytes = options.maxBytes ?? MAX_FRAME_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1)
      throw new RangeError("maxBytes must be a positive integer");
    this.maxBytes = maxBytes;
    this.onOversized = options.onOversized;
  }

  override _transform(chunk: Buffer | string, _enc: BufferEncoding, done: TransformCallback) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let start = 0;
    while (start < bytes.length) {
      const nl = bytes.indexOf(NEWLINE, start);
      const end = nl === -1 ? bytes.length : nl;
      this.holdPart(bytes.subarray(start, end));
      if (nl === -1) break;
      this.endFrame(true);
      start = nl + 1;
    }
    done();
  }

  override _flush(done: TransformCallback) {
    if (this.dropping || this.heldBytes > 0) this.endFrame(false);
    done();
  }

  /** Hold part of the current frame, or start dropping it once it passes the cap. */
  private holdPart(part: Buffer) {
    if (part.length === 0 || this.dropping) return;
    if (this.heldBytes + part.length > this.maxBytes) {
      this.dropping = true;
      this.held = [];
      this.heldBytes = 0;
      return;
    }
    this.held.push(part);
    this.heldBytes += part.length;
    if (this.heldBytes > this.peakHeldBytes) this.peakHeldBytes = this.heldBytes;
  }

  private endFrame(newline: boolean) {
    const tail = newline ? "\n" : "";
    if (this.dropping) {
      this.dropping = false;
      try {
        this.onOversized?.();
      } catch {
        // A diagnostic never changes what is served.
      }
      this.push(`${OVERSIZED_FRAME_LINE}${tail}`);
    } else {
      this.push(Buffer.concat([...this.held, Buffer.from(tail)]));
    }
    this.held = [];
    this.heldBytes = 0;
  }
}

/** `input`, re-framed so no frame over `maxBytes` reaches the line reader. */
export function boundFrames(input: Readable, options: BoundFramesOptions = {}): FrameBound {
  const bound = new FrameBound(options);
  input.on("error", (error) => bound.destroy(error));
  return input.pipe(bound);
}
