/**
 * Test-side GIF89a reader for the clip tests (spec #589 §2.7 "Encoder output"). It parses the
 * structure strictly: a global palette, at most one NETSCAPE2.0 application extension, one
 * Graphic Control extension per image, no comment, plain-text or other extension, no local
 * palette, and nothing after the trailer. It LZW-decodes every frame to palette indices.
 * Written independently of src/watch/clip/gif.ts (it shares no code with it).
 */

export interface DecodedGif {
  readonly width: number;
  readonly height: number;
  readonly palette: Uint8Array;
  readonly loops: number;
  readonly frames: readonly { readonly pixels: Uint8Array; readonly delayCs: number }[];
}

export class GifStructureError extends Error {}

function lzwDecode(data: Uint8Array, minCodeSize: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  let outAt = 0;
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i += 1) dict.push([i]);
    dict.push([], []);
    codeSize = minCodeSize + 1;
  };
  reset();
  let bitPos = 0;
  const read = (): number => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const byte = data[(bitPos + i) >> 3];
      if (byte === undefined) throw new GifStructureError("LZW data ran out");
      code |= ((byte >> ((bitPos + i) & 7)) & 1) << i;
    }
    bitPos += codeSize;
    return code;
  };
  let prev: number[] | null = null;
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length && dict[code] !== undefined && (dict[code] as number[]).length > 0)
      entry = dict[code] as number[];
    else if (code === dict.length && prev !== null) entry = [...prev, prev[0] as number];
    else throw new GifStructureError("bad LZW code");
    for (const v of entry) {
      if (outAt >= count) throw new GifStructureError("too many pixels");
      out[outAt++] = v;
    }
    if (prev !== null && dict.length < 4096) {
      dict.push([...prev, entry[0] as number]);
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = entry;
  }
  if (outAt !== count) throw new GifStructureError("too few pixels");
  return out;
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  const b = Buffer.from(bytes);
  if (b.toString("latin1", 0, 6) !== "GIF89a") throw new GifStructureError("not GIF89a");
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  const packed = b[10] as number;
  if ((packed & 0x80) === 0) throw new GifStructureError("no global palette");
  const size = 3 * (1 << ((packed & 7) + 1));
  let at = 13;
  const palette = new Uint8Array(b.subarray(at, at + size));
  at += size;
  let loops = -1;
  let delay: number | null = null;
  const frames: { pixels: Uint8Array; delayCs: number }[] = [];
  const subBlocks = (): Uint8Array => {
    const parts: Buffer[] = [];
    for (;;) {
      const n = b[at++] as number;
      if (n === 0) break;
      parts.push(b.subarray(at, at + n));
      at += n;
    }
    return Buffer.concat(parts);
  };
  for (;;) {
    const tag = b[at++];
    if (tag === undefined) throw new GifStructureError("no trailer");
    if (tag === 0x3b) break;
    if (tag === 0x21) {
      const label = b[at++];
      if (label === 0xff) {
        if (loops !== -1) throw new GifStructureError("a second application extension");
        const n = b[at++] as number;
        const id = b.toString("latin1", at, at + n);
        at += n;
        if (id !== "NETSCAPE2.0")
          throw new GifStructureError("an application extension other than NETSCAPE2.0");
        const data = subBlocks();
        loops = data[1] === undefined ? -1 : (data[1] as number) | ((data[2] ?? 0) << 8);
      } else if (label === 0xf9) {
        if (delay !== null) throw new GifStructureError("two graphic controls before one image");
        const data = subBlocks();
        delay = (data[1] as number) | ((data[2] as number) << 8);
      } else throw new GifStructureError(`a forbidden extension 0x${(label ?? 0).toString(16)}`);
      continue;
    }
    if (tag === 0x2c) {
      const w = b.readUInt16LE(at + 4);
      const h = b.readUInt16LE(at + 6);
      const flags = b[at + 8] as number;
      at += 9;
      if (flags & 0x80) throw new GifStructureError("a local palette");
      if (w !== width || h !== height) throw new GifStructureError("a partial frame");
      if (delay === null) throw new GifStructureError("an image without a graphic control");
      const minCode = b[at++] as number;
      frames.push({ pixels: lzwDecode(subBlocks(), minCode, w * h), delayCs: delay });
      delay = null;
      continue;
    }
    throw new GifStructureError(`unknown block 0x${tag.toString(16)}`);
  }
  if (at !== b.length) throw new GifStructureError("bytes after the trailer");
  return { width, height, palette, loops, frames };
}
