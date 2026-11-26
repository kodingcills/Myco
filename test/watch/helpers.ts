import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

export const MARKER = "PLANTED_FAKE_MARKER";
/** A fake absolute host path (never exists); planted to prove paths do not reach the stream. */
export const FAKE_ABS_PATH = "/srv/planted-fake-host/operator/secret-vault/ground-truth.json";

export function tempDir(prefix = "myco-watch-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Raw {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

/**
 * One raw HTTP request (no URL normalisation, so `..` and `%2e` reach the server as sent).
 * `maxMs` cuts a streaming response (SSE) after that long.
 */
export function raw(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; maxMs?: number } = {},
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        };
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", finish);
        res.on("close", finish);
        if (opts.maxMs !== undefined)
          setTimeout(() => {
            finish();
            res.destroy();
          }, opts.maxMs);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** path -> size, mtime, mode and sha256 of every entry under `root` (symlinks not followed). */
export function treeSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) {
        out.set(path, `dir ${st.mode} ${st.mtimeMs}`);
        walk(path);
      } else if (st.isFile()) {
        const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
        out.set(path, `file ${st.size} ${st.mode} ${st.mtimeMs} ${sha}`);
      } else {
        out.set(path, `other ${st.mode} ${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk with a correct CRC (test encoder, independent of the sanitizer). */
export function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export interface PngSpec {
  readonly width: number;
  readonly height: number;
  readonly colorType: number;
  readonly bitDepth?: number;
  /** Filtered scanlines (each row starts with its filter byte). */
  readonly raw: Buffer;
  readonly palette?: Buffer;
  readonly trns?: Buffer;
  /** Chunks placed after IHDR (before IDAT). */
  readonly extra?: readonly Buffer[];
  /** Bytes appended after IEND. */
  readonly trailer?: Buffer;
  /** zlib level for IDAT (0 stores the scanlines verbatim). */
  readonly level?: number;
  readonly interlace?: number;
}

export function encodePng(spec: PngSpec): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(spec.width, 0);
  ihdr.writeUInt32BE(spec.height, 4);
  ihdr[8] = spec.bitDepth ?? 8;
  ihdr[9] = spec.colorType;
  ihdr[12] = spec.interlace ?? 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    ...(spec.extra ?? []),
    ...(spec.palette === undefined ? [] : [pngChunk("PLTE", spec.palette)]),
    ...(spec.trns === undefined ? [] : [pngChunk("tRNS", spec.trns)]),
    pngChunk("IDAT", deflateSync(spec.raw, { level: spec.level ?? 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
    spec.trailer ?? Buffer.alloc(0),
  ]);
}

/** A valid 2x2 RGBA PNG (the earlier hand-written fixture had a bad zlib checksum). */
export const PNG = encodePng({
  width: 2,
  height: 2,
  colorType: 6,
  raw: Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 1, 2, 3, 255]),
});
