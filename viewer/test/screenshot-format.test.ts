import { crc32, deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { inspectScreenshot } from "../src/data/screenshot-format.ts";

function chunk(type: string, data: Uint8Array) {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(Buffer.from(type), 4);
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));
  return bytes;
}

function png(width = 3, height = 2) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 7);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
}

function riff(chunks: [string, Buffer][]) {
  const body = Buffer.concat(
    chunks.map(([type, data]) => {
      const head = Buffer.alloc(8);
      head.write(type, 0);
      head.writeUInt32LE(data.length, 4);
      return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
    }),
  );
  const head = Buffer.alloc(12);
  head.write("RIFF", 0);
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WEBP", 8);
  return Buffer.concat([head, body]);
}

const inspect = (bytes: Uint8Array, format: "png" | "webp") =>
  inspectScreenshot(new Blob([Uint8Array.from(bytes)]), format);

describe("screenshot container check", () => {
  test("a complete PNG reports its declared size", async () => {
    expect(await inspect(png(1440, 900), "png")).toEqual({
      container: "complete",
      width: 1440,
      height: 900,
    });
  });

  test("truncation, a missing IEND and a chunk CRC mismatch are incomplete", async () => {
    const whole = png();
    expect((await inspect(whole.subarray(0, whole.length - 20), "png")).container).toBe(
      "incomplete",
    );
    expect((await inspect(whole.subarray(0, whole.length - 12), "png")).container).toBe(
      "incomplete",
    );
    const flipped = Buffer.from(whole);
    flipped[flipped.length - 20] = flipped[flipped.length - 20]! ^ 1;
    expect((await inspect(flipped, "png")).container).toBe("incomplete");
    expect((await inspect(Buffer.concat([whole, Buffer.from([0])]), "png")).container).toBe(
      "incomplete",
    );
  });

  test("bytes without a PNG or WebP signature are unavailable", async () => {
    expect((await inspect(Buffer.from("garbage bytes"), "png")).container).toBe("unavailable");
    expect((await inspect(Buffer.from("garbage bytes"), "webp")).container).toBe("unavailable");
    expect((await inspect(png(), "webp")).container).toBe("unavailable");
  });

  test("WebP reports VP8X, VP8L and VP8 sizes and detects truncation", async () => {
    const extended = Buffer.alloc(10);
    extended.writeUIntLE(1440 - 1, 4, 3);
    extended.writeUIntLE(900 - 1, 7, 3);
    const x = riff([
      ["VP8X", extended],
      ["VP8 ", Buffer.alloc(10)],
    ]);
    expect(await inspect(x, "webp")).toEqual({ container: "complete", width: 1440, height: 900 });

    const lossless = Buffer.alloc(5);
    lossless[0] = 0x2f;
    lossless.writeUInt32LE(((900 - 1) << 14) | (1440 - 1), 1);
    expect(await inspect(riff([["VP8L", lossless]]), "webp")).toEqual({
      container: "complete",
      width: 1440,
      height: 900,
    });

    const lossy = Buffer.alloc(10);
    lossy.set([0x9d, 0x01, 0x2a], 3);
    lossy.writeUInt16LE(1440, 6);
    lossy.writeUInt16LE(900, 8);
    const l = riff([["VP8 ", lossy]]);
    expect(await inspect(l, "webp")).toEqual({ container: "complete", width: 1440, height: 900 });
    expect((await inspect(l.subarray(0, l.length - 4), "webp")).container).toBe("incomplete");
  });
});
