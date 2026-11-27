/**
 * Clip export (spec #589 §2.5, §2.7): a deterministic GIF89a encoder. The same indexed frames
 * and delays always give the same bytes. The output carries exactly: the header, one global
 * 256-colour palette, one NETSCAPE2.0 loop extension (loops forever), and per frame one
 * Graphic Control extension and one image. No comment, plain-text or other application
 * extension, no local palette, and no byte after the trailer `0x3B`. No I/O.
 */

export interface IndexedFrame {
  /** One palette index per pixel, row-major, `width * height` long. */
  readonly pixels: Uint8Array;
  /** Delay in hundredths of a second. */
  readonly delayCs: number;
}

/** 256 RGB entries (768 bytes). */
export type Palette = Uint8Array;

const MIN_CODE_SIZE = 8;
const MAX_CODES = 4096;

/** Pack variable-width codes LSB first, as GIF's LZW expects. */
class BitWriter {
  private readonly bytes: number[] = [];
  private acc = 0;
  private bits = 0;
  write(code: number, size: number): void {
    this.acc |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.bits -= 8;
    }
  }
  finish(): number[] {
    if (this.bits > 0) this.bytes.push(this.acc & 0xff);
    return this.bytes;
  }
}

/** LZW-compress one frame's indices (minimum code size 8). */
export function lzwEncode(pixels: Uint8Array): number[] {
  const clear = 1 << MIN_CODE_SIZE;
  const eoi = clear + 1;
  const out = new BitWriter();
  let codeSize = MIN_CODE_SIZE + 1;
  let next = eoi + 1;
  let table = new Map<number, number>();
  out.write(clear, codeSize);
  if (pixels.length === 0) {
    out.write(eoi, codeSize);
    return out.finish();
  }
  let current = pixels[0] as number;
  for (let i = 1; i < pixels.length; i += 1) {
    const k = pixels[i] as number;
    const key = (current << 8) | k;
    const found = table.get(key);
    if (found !== undefined) {
      current = found;
      continue;
    }
    out.write(current, codeSize);
    if (next === MAX_CODES) {
      out.write(clear, codeSize);
      table = new Map();
      codeSize = MIN_CODE_SIZE + 1;
      next = eoi + 1;
    } else {
      if (next >= 1 << codeSize) codeSize += 1;
      table.set(key, next);
      next += 1;
    }
    current = k;
  }
  out.write(current, codeSize);
  out.write(eoi, codeSize);
  return out.finish();
}

function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}

/** Encode frames of one size into a GIF89a that loops forever. */
export function encodeGif(
  width: number,
  height: number,
  palette: Palette,
  frames: readonly IndexedFrame[],
): Buffer {
  if (palette.length !== 768) throw new Error("palette must hold 256 RGB entries");
  const parts: number[][] = [];
  parts.push([...Buffer.from("GIF89a", "latin1")]);
  // Logical screen: global colour table present, 8 bits colour resolution, 256 entries.
  parts.push([...u16(width), ...u16(height), 0xf7, 0, 0]);
  parts.push([...palette]);
  // NETSCAPE2.0: loop forever.
  parts.push([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "latin1"), 0x03, 0x01, 0, 0, 0]);
  for (const frame of frames) {
    if (frame.pixels.length !== width * height) throw new Error("frame size mismatch");
    // Graphic Control: disposal 1 (leave in place), no transparency.
    parts.push([0x21, 0xf9, 0x04, 0x04, ...u16(frame.delayCs), 0, 0]);
    parts.push([0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0]);
    const data = lzwEncode(frame.pixels);
    const blocks: number[] = [MIN_CODE_SIZE];
    for (let at = 0; at < data.length; at += 255) {
      const chunk = data.slice(at, at + 255);
      blocks.push(chunk.length, ...chunk);
    }
    blocks.push(0);
    parts.push(blocks);
  }
  parts.push([0x3b]);
  return Buffer.from(parts.flat());
}
