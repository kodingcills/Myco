/**
 * Clip export (spec #589 §2.5, §2.7): a deterministic GIF89a encoder. The same indexed frames
 * and delays always give the same bytes. The output carries exactly: the header, one global
 * 256-colour palette, one NETSCAPE2.0 loop extension (loops forever), and per frame one
 * Graphic Control extension and one image. No comment, plain-text or other application
 * extension, no local palette, and no byte after the trailer `0x3B`. No I/O.
 *
 * Bounded memory: frames are encoded one at a time into growing byte buffers, and a writer
 * with a byte cap stops at the first frame that would cross it, so an over-budget clip is
 * refused without ever being held whole.
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

/** A growing byte buffer. */
class Bytes {
  private buf = new Uint8Array(4096);
  length = 0;
  push(byte: number): void {
    if (this.length === this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.length++] = byte;
  }
  pushAll(bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i += 1) this.push(bytes[i] as number);
  }
  view(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }
}

/** LZW-compress one frame's indices (minimum code size 8), codes packed LSB first. */
export function lzwEncode(pixels: Uint8Array): Uint8Array {
  const clear = 1 << MIN_CODE_SIZE;
  const eoi = clear + 1;
  const out = new Bytes();
  let acc = 0;
  let bits = 0;
  let codeSize = MIN_CODE_SIZE + 1;
  const write = (code: number) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };
  let next = eoi + 1;
  let table = new Map<number, number>();
  write(clear);
  if (pixels.length > 0) {
    let current = pixels[0] as number;
    for (let i = 1; i < pixels.length; i += 1) {
      const k = pixels[i] as number;
      const key = (current << 8) | k;
      const found = table.get(key);
      if (found !== undefined) {
        current = found;
        continue;
      }
      write(current);
      if (next === MAX_CODES) {
        write(clear);
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
    write(current);
  }
  write(eoi);
  if (bits > 0) out.push(acc & 0xff);
  return out.view();
}

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];

/** Writes one GIF frame by frame; refuses a frame that would take it over `maxBytes`. */
export class GifWriter {
  private readonly parts: Uint8Array[] = [];
  private size = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    palette: Palette,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
  ) {
    if (palette.length !== 768) throw new Error("palette must hold 256 RGB entries");
    this.put(Buffer.from("GIF89a", "latin1"));
    // Logical screen: global colour table present, 8 bits colour resolution, 256 entries.
    this.put(Uint8Array.from([...u16(width), ...u16(height), 0xf7, 0, 0]));
    this.put(palette);
    // NETSCAPE2.0: loop forever.
    this.put(
      Uint8Array.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "latin1"), 3, 1, 0, 0, 0]),
    );
  }

  private put(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.size += bytes.length;
  }

  /** Add one frame. False (and nothing added) when it would cross the byte cap. */
  add(frame: IndexedFrame): boolean {
    if (frame.pixels.length !== this.width * this.height) throw new Error("frame size mismatch");
    const data = lzwEncode(frame.pixels);
    const block = new Bytes();
    // Graphic Control: disposal 1 (leave in place), no transparency.
    block.pushAll([0x21, 0xf9, 0x04, 0x04, ...u16(frame.delayCs), 0, 0]);
    block.pushAll([0x2c, 0, 0, 0, 0, ...u16(this.width), ...u16(this.height), 0]);
    block.push(MIN_CODE_SIZE);
    for (let at = 0; at < data.length; at += 255) {
      const chunk = data.subarray(at, at + 255);
      block.push(chunk.length);
      block.pushAll(chunk);
    }
    block.push(0);
    // The trailer still has to fit.
    if (this.size + block.length + 1 > this.maxBytes) return false;
    this.put(block.view());
    return true;
  }

  finish(): Buffer {
    return Buffer.concat([...this.parts, Uint8Array.from([0x3b])]);
  }
}

/** Encode frames of one size into a GIF89a that loops forever (no byte cap). */
export function encodeGif(
  width: number,
  height: number,
  palette: Palette,
  frames: readonly IndexedFrame[],
): Buffer {
  const writer = new GifWriter(width, height, palette);
  for (const frame of frames) writer.add(frame);
  return writer.finish();
}
