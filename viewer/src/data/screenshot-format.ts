type Format = "png" | "webp";
type Container = "complete" | "incomplete" | "unavailable";
export type ScreenshotInfo = { container: Container; width?: number; height?: number };

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) {
    byte = (byte >>> 1) ^ (byte & 1 ? 0xedb88320 : 0);
  }
  return byte;
});

function pngContainer(bytes: Uint8Array, view: DataView): Container {
  if (!pngSignature.every((byte, index) => bytes[index] === byte)) return "unavailable";
  let hasData = false;
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const type = view.getUint32(offset + 4);
    const size = view.getUint32(offset);
    const end = offset + 8 + size;
    if (offset === 8 && (type !== 0x49484452 || size !== 13)) return "incomplete"; // IHDR
    if (end + 4 > bytes.length) break;
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]!) & 255]!;
    }
    if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(end)) return "incomplete";
    if (type === 0x49444154) hasData = true; // IDAT
    if (type === 0x49454e44) {
      // IEND
      return size === 0 && hasData && end + 4 === bytes.length ? "complete" : "incomplete";
    }
    offset = end + 4;
  }
  return "incomplete";
}

function webpContainer(view: DataView): Container {
  if (
    view.byteLength < 12 ||
    view.getUint32(0) !== 0x52494646 || // RIFF
    view.getUint32(8) !== 0x57454250 // WEBP
  )
    return "unavailable";
  const end = view.getUint32(4, true) + 8;
  if (end > view.byteLength) return "incomplete";
  let offset = 12;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset + 4, true);
    offset += 8 + size + (size % 2);
  }
  return offset === end && end > 12 ? "complete" : "incomplete";
}

/** Pixel size declared by the first image header: PNG IHDR, or WebP VP8X, VP8L or VP8. */
function declaredSize(view: DataView, format: Format) {
  if (format === "png") {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  const kind = view.getUint32(12);
  if (kind === 0x56503858 && view.byteLength >= 30) {
    // VP8X: 24-bit canvas width and height minus one.
    return {
      width: 1 + (view.getUint16(24, true) | (view.getUint8(26) << 16)),
      height: 1 + (view.getUint16(27, true) | (view.getUint8(29) << 16)),
    };
  }
  if (kind === 0x5650384c && view.byteLength >= 25) {
    // VP8L: two 14-bit sizes minus one after the 0x2f signature.
    const bits = view.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (kind === 0x56503820 && view.byteLength >= 30) {
    // VP8: 14-bit sizes after the frame tag and start code.
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  return {};
}

/**
 * Checks the container structure without decoding: PNG signature, IHDR, every chunk CRC, IDAT and
 * IEND at the exact end; WebP RIFF length and chunk walk to the declared end. Any other type, or
 * bytes with no recognizable signature, is unavailable. A complete container can still hold
 * damaged compressed data, so a decoder failure is also treated as incomplete.
 */
export async function inspectScreenshot(source: Blob, format: Format): Promise<ScreenshotInfo> {
  const buffer = await source.arrayBuffer();
  const view = new DataView(buffer);
  const container =
    format === "webp" ? webpContainer(view) : pngContainer(new Uint8Array(buffer), view);
  return container === "complete" ? { container, ...declaredSize(view, format) } : { container };
}
