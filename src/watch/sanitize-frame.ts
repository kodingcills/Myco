/**
 * Live watch view: the frame redaction boundary (round 2, D1).
 *
 * A frame file is operator-side input the view does not control, so its bytes are never
 * served as they are. Every frame goes through `servableFrame` before it reaches a response:
 *
 *  1. Provenance. A file-backed frame source yields PNG only. SVG (text, so it can carry
 *     anything) is served only from the in-process demo renderer (`render-frame.ts`), which
 *     escapes and clips every string and never reads host facts. JPEG, GIF, WebP and SVG
 *     files are never listed (`frames.ts`), and the server refuses any frame type other
 *     than these two.
 *  2. Rebuild, not copy. A PNG is decoded and re-encoded from its pixels alone: a fresh
 *     IHDR, one IDAT re-compressed by this process, IEND. Every ancillary chunk (tEXt, zTXt,
 *     iTXt, eXIf, tIME, iCCP, private chunks), any bytes after IEND and any PLTE are dropped;
 *     a palette image is expanded to RGB(A), so palette bytes never pass through either.
 *     Interlaced, malformed, oversized or CRC-failing PNGs are refused.
 *  3. Backstop scan. The bytes about to be served are refused if they contain the home
 *     directory, the username, the temp directory, an absolute host-path prefix, a
 *     key-shaped prefix, or (for a PNG, which is compressed binary) a run of 16 or more
 *     identifier/path characters, which is what text smuggled into pixel bytes stored
 *     verbatim by deflate looks like. A refused frame is a 404; the view fails closed.
 *
 * What it cannot do: pixels are the frame. A screenshot shows what was on the guest's
 * screen, and a crafted image can draw any text. The sealed capture is the guest VM's
 * desktop, not the host's (docs/gate/watch.md, Limits).
 */
import { homedir, tmpdir, userInfo } from "node:os";
import { deflateSync, inflateSync } from "node:zlib";
import type { Frame } from "./frames.ts";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Largest decoded image this view re-encodes (bytes of filtered scanlines). */
export const MAX_RAW_BYTES = 64 * 1024 * 1024;
const MAX_SIDE = 16_384;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: readonly Buffer[]): number {
  let c = 0xffffffff;
  for (const part of parts)
    for (let i = 0; i < part.length; i++)
      c = (CRC_TABLE[(c ^ (part[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([head.subarray(4), data]), 0);
  return Buffer.concat([head, data, crc]);
}

/** Channels per color type, and the bit depths PNG allows for it. */
const COLOR: Readonly<Record<number, { channels: number; depths: readonly number[] }>> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undo PNG scanline filters in place; returns the rows without their filter bytes. */
function unfilter(data: Buffer, height: number, rowBytes: number, bpp: number): Buffer | null {
  const out = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (rowBytes + 1)] as number;
    const src = y * (rowBytes + 1) + 1;
    const at = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[src + x] as number;
      const a = x >= bpp ? (out[at + x - bpp] as number) : 0;
      const b = y > 0 ? (out[at - rowBytes + x] as number) : 0;
      const c = x >= bpp && y > 0 ? (out[at - rowBytes + x - bpp] as number) : 0;
      let value: number;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + a;
      else if (filter === 2) value = raw + b;
      else if (filter === 3) value = raw + ((a + b) >> 1);
      else if (filter === 4) value = raw + paeth(a, b, c);
      else return null;
      out[at + x] = value & 0xff;
    }
  }
  return out;
}

/**
 * Re-encode a PNG from its pixels alone, or null if it is not a PNG this view will serve.
 * The result carries no ancillary chunk, no palette and no byte of the input's framing.
 */
export function sanitizePng(input: Buffer): Buffer | null {
  if (input.length < SIGNATURE.length + 12 || !input.subarray(0, 8).equals(SIGNATURE)) return null;
  let at = 8;
  let ihdr: Buffer | null = null;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  let ended = false;
  while (at + 12 <= input.length) {
    const length = input.readUInt32BE(at);
    const type = input.toString("latin1", at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || length > input.length - at - 12) return null;
    const data = input.subarray(at + 8, at + 8 + length);
    const crc = input.readUInt32BE(at + 8 + length);
    if (crc !== crc32([input.subarray(at + 4, at + 8), data])) return null;
    at += 12 + length;
    if (ihdr === null && type !== "IHDR") return null;
    if (type === "IHDR") {
      if (ihdr !== null || length !== 13) return null;
      ihdr = data;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") {
      ended = true;
      break; // anything after IEND is never read
    } else if (type.charCodeAt(0) < 0x61) return null; // an unknown critical chunk
    // Every other (ancillary) chunk is dropped unread.
  }
  if (ihdr === null || !ended || idat.length === 0) return null;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8] as number;
  const colorType = ihdr[9] as number;
  const color = COLOR[colorType];
  if (
    color === undefined ||
    !color.depths.includes(depth) ||
    ihdr[10] !== 0 ||
    ihdr[11] !== 0 ||
    ihdr[12] !== 0 || // interlaced images are refused
    width < 1 ||
    height < 1 ||
    width > MAX_SIDE ||
    height > MAX_SIDE
  )
    return null;
  const bitsPerPixel = depth * color.channels;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const expected = height * (rowBytes + 1);
  if (expected > MAX_RAW_BYTES) return null;
  let data: Buffer;
  try {
    data = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    return null;
  }
  if (data.length !== expected) return null;

  let outColorType = colorType;
  let outDepth = depth;
  let raw: Buffer;
  if (colorType === 3) {
    if (palette === null || palette.length % 3 !== 0 || palette.length === 0) return null;
    const entries = palette.length / 3;
    const pixels = unfilter(data, height, rowBytes, 1);
    if (pixels === null) return null;
    const alpha = trns !== null && trns.length > 0;
    const channels = alpha ? 4 : 3;
    const outRow = width * channels;
    if (height * (outRow + 1) > MAX_RAW_BYTES) return null;
    raw = Buffer.alloc(height * (outRow + 1));
    const mask = (1 << depth) - 1;
    for (let y = 0; y < height; y++) {
      const dst = y * (outRow + 1);
      raw[dst] = 0;
      for (let x = 0; x < width; x++) {
        const bit = x * depth;
        const byte = pixels[y * rowBytes + (bit >> 3)] as number;
        const index = (byte >> (8 - depth - (bit & 7))) & mask;
        if (index >= entries) return null;
        const o = dst + 1 + x * channels;
        raw[o] = palette[index * 3] as number;
        raw[o + 1] = palette[index * 3 + 1] as number;
        raw[o + 2] = palette[index * 3 + 2] as number;
        if (alpha)
          raw[o + 3] = index < (trns as Buffer).length ? ((trns as Buffer)[index] as number) : 255;
      }
    }
    outColorType = alpha ? 6 : 2;
    outDepth = 8;
  } else {
    // Keep the filtered scanlines (the decoder undoes them), but check every filter byte.
    for (let y = 0; y < height; y++) if ((data[y * (rowBytes + 1)] as number) > 4) return null;
    raw = data;
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = outDepth;
  head[9] = outColorType;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Host-identifying strings the backstop refuses (only ones long enough to be specific). */
export function hostNeedles(): string[] {
  const needles = new Set<string>();
  const add = (value: string | undefined) => {
    if (value !== undefined && value.length >= 4) needles.add(value);
  };
  try {
    add(homedir());
  } catch {}
  try {
    add(tmpdir());
  } catch {}
  try {
    const user = userInfo().username;
    if (user.length >= 3) {
      needles.add(`/${user}`);
      needles.add(`\\${user}`);
    }
  } catch {}
  return [...needles];
}

/** Absolute host-path prefixes and key-shaped prefixes: refused in any served frame. */
const LEAK_PATTERNS: readonly RegExp[] = [
  /\/(?:Users|home|root|private|var\/folders|Volumes|srv|etc|opt|tmp)\//,
  /[A-Za-z]:[\\/](?:Users|Windows|ProgramData|Documents and Settings)[\\/]/,
  /\\\\[A-Za-z0-9._-]+\\/, // UNC path
  /sk-ant-|ghp_|gho_|github_pat_|xox[abp]-|AKIA[0-9A-Z]{12}|-----BEGIN /,
];
/** In compressed binary, 16+ identifier/path characters in a row means smuggled text. */
const TEXT_RUN = /[A-Za-z0-9_./\\:-]{16,}/;

/** True when `bytes` carry something host-identifying or text-like that must not be served. */
export function frameLeaks(bytes: Buffer, binary: boolean, needles: readonly string[]): boolean {
  const text = bytes.toString("latin1");
  for (const needle of needles) if (text.includes(needle)) return true;
  for (const pattern of LEAK_PATTERNS) if (pattern.test(text)) return true;
  return binary && TEXT_RUN.test(text);
}

/**
 * The only path from a frame source to a response. Returns what may be served, or null
 * (served as 404). SVG only with `rendered` provenance; PNG always rebuilt; nothing else.
 */
export function servableFrame(frame: Frame, needles: readonly string[]): Frame | null {
  let bytes: Buffer | null;
  let binary: boolean;
  if (frame.contentType === "image/png") {
    bytes = sanitizePng(frame.bytes);
    binary = true;
  } else if (frame.contentType === "image/svg+xml" && frame.provenance === "rendered") {
    bytes = frame.bytes;
    binary = false;
  } else {
    return null;
  }
  if (bytes === null || frameLeaks(bytes, binary, needles)) return null;
  return { bytes, contentType: frame.contentType, provenance: frame.provenance };
}
