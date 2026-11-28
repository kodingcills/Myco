/**
 * Clip export: decode a frame to RGBA pixels. Only a PNG that `sanitizePng` already rebuilt is
 * decoded (one IHDR, one IDAT, IEND; no palette; not interlaced), so every byte decoded here
 * passed the watch view's frame redaction first. Anything else is null (CLIP_FRAME_REFUSED).
 * No I/O.
 */
import { inflateSync } from "node:zlib";

export interface Rgba {
  readonly width: number;
  readonly height: number;
  /** 4 bytes per pixel, row-major. */
  readonly data: Uint8Array;
}

/** Most pixels a source frame may have (8 Mpx); larger frames are refused. */
export const MAX_SOURCE_PIXELS = 8 * 1024 * 1024;

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode a sanitized PNG to RGBA, or null. Never throws. */
export function decodeSanitizedPng(png: Buffer): Rgba | null {
  try {
    if (png.length < 33 || png.toString("latin1", 12, 16) !== "IHDR") return null;
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const depth = png[24] as number;
    const colorType = png[25] as number;
    const channels = CHANNELS[colorType];
    if (channels === undefined || png[28] !== 0) return null;
    if (width < 1 || height < 1 || width * height > MAX_SOURCE_PIXELS) return null;
    if (![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && colorType !== 0)) return null;
    let at = 33;
    const idat: Buffer[] = [];
    while (at + 12 <= png.length) {
      const length = png.readUInt32BE(at);
      const type = png.toString("latin1", at + 4, at + 8);
      if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
      if (type === "IEND") break;
      at += 12 + length;
    }
    const bpp = Math.max(1, (depth * channels) >> 3);
    const rowBytes = Math.ceil((width * depth * channels) / 8);
    const expected = height * (rowBytes + 1);
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
    if (raw.length !== expected) return null;
    const rows = new Uint8Array(height * rowBytes);
    for (let y = 0; y < height; y += 1) {
      const filter = raw[y * (rowBytes + 1)] as number;
      const src = y * (rowBytes + 1) + 1;
      const dst = y * rowBytes;
      for (let x = 0; x < rowBytes; x += 1) {
        const v = raw[src + x] as number;
        const left = x >= bpp ? (rows[dst + x - bpp] as number) : 0;
        const up = y > 0 ? (rows[dst - rowBytes + x] as number) : 0;
        const upLeft = y > 0 && x >= bpp ? (rows[dst - rowBytes + x - bpp] as number) : 0;
        let out: number;
        if (filter === 0) out = v;
        else if (filter === 1) out = v + left;
        else if (filter === 2) out = v + up;
        else if (filter === 3) out = v + ((left + up) >> 1);
        else if (filter === 4) out = v + paeth(left, up, upLeft);
        else return null;
        rows[dst + x] = out & 0xff;
      }
    }
    const data = new Uint8Array(width * height * 4);
    const sample = (y: number, i: number): number => {
      // The i-th sample of row y, scaled to 8 bits.
      if (depth === 8) return rows[y * rowBytes + i] as number;
      if (depth === 16) return rows[y * rowBytes + i * 2] as number;
      const bit = i * depth;
      const byte = rows[y * rowBytes + (bit >> 3)] as number;
      const v = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      return Math.round((v * 255) / ((1 << depth) - 1));
    };
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        const s = x * channels;
        if (channels === 1 || channels === 2) {
          const g = sample(y, s);
          data[o] = g;
          data[o + 1] = g;
          data[o + 2] = g;
          data[o + 3] = channels === 2 ? sample(y, s + 1) : 255;
        } else {
          data[o] = sample(y, s);
          data[o + 1] = sample(y, s + 1);
          data[o + 2] = sample(y, s + 2);
          data[o + 3] = channels === 4 ? sample(y, s + 3) : 255;
        }
      }
    return { width, height, data };
  } catch {
    return null;
  }
}
