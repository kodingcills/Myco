/**
 * Clip GIF encoder and the postable budget (spec #589 §2.7 encoder output, §2.9 budget, RS-15;
 * issue #666). Structure is checked by an independent reader (gif-decode.ts) and by Chromium.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PALETTE } from "../../src/watch/clip/band.ts";
import { encodeGif, GifWriter, lzwEncode } from "../../src/watch/clip/gif.ts";
import { CLIP_BUDGET, exportMockPreview } from "../../src/watch/clip/mock-preview.ts";
import { decodeGif } from "./gif-decode.ts";
import { encodePng, tempDir } from "./helpers.ts";
import { OWN, previewInput, RUN, recordedRun, TASK } from "./recorded-run.ts";
import { manifestBytes, recordTrial } from "./timeline-fixture.ts";

function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s % 251;
  }
  return out;
}

describe("GIF encoder (§2.7)", () => {
  it("round-trips through an independent reader, including LZW table resets", () => {
    const width = 97;
    const height = 61;
    const frames = [
      { pixels: noise(width * height, 1), delayCs: 10 },
      { pixels: new Uint8Array(width * height).fill(7), delayCs: 250 },
      { pixels: noise(width * height, 2), delayCs: 33 },
    ];
    const gif = decodeGif(encodeGif(width, height, PALETTE, frames));
    expect([gif.width, gif.height, gif.loops]).toEqual([width, height, 0]);
    expect(Buffer.from(gif.palette).equals(Buffer.from(PALETTE))).toBe(true);
    gif.frames.forEach((frame, i) => {
      expect(frame.delayCs).toBe(frames[i]?.delayCs);
      expect(Buffer.from(frame.pixels).equals(Buffer.from(frames[i]?.pixels ?? []))).toBe(true);
    });
    // Noise this large overflows the 4096-entry table at least once.
    expect(lzwEncode(noise(width * height, 1)).length).toBeGreaterThan(4096);
  });

  it("a capped writer refuses the first frame that would cross the cap, and adds nothing", () => {
    const frame = { pixels: noise(64 * 64, 5), delayCs: 10 };
    const full = encodeGif(64, 64, PALETTE, [frame, frame]).length;
    const writer = new GifWriter(64, 64, PALETTE, full - 1);
    expect(writer.add(frame)).toBe(true);
    expect(writer.add(frame)).toBe(false);
    const out = writer.finish();
    expect(decodeGif(out).frames).toHaveLength(1);
    expect(out.length).toBeLessThan(full);
    expect(new GifWriter(64, 64, PALETTE, full).add(frame)).toBe(true);
  });

  it("is deterministic: the same frames give the same bytes", () => {
    const frames = [{ pixels: noise(40 * 30, 9), delayCs: 20 }];
    expect(encodeGif(40, 30, PALETTE, frames).equals(encodeGif(40, 30, PALETTE, frames))).toBe(
      true,
    );
  });

  it("carries no comment, plain-text or extra application extension and nothing after the trailer", () => {
    const bytes = encodeGif(8, 8, PALETTE, [{ pixels: noise(64, 3), delayCs: 10 }]);
    expect(bytes.subarray(0, 6).toString("latin1")).toBe("GIF89a");
    expect(bytes.at(-1)).toBe(0x3b);
    expect(() => decodeGif(bytes)).not.toThrow();
    expect(bytes.includes(Buffer.from([0x21, 0xfe]))).toBe(false);
    expect(bytes.includes(Buffer.from([0x21, 0x01]))).toBe(false);
    expect(() => decodeGif(Buffer.concat([bytes, Buffer.from([0])]))).toThrow(/after the trailer/);
  });
});

describe("Chromium decodes the exported preview (independent decoder)", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  it("the first frame's pixels in Chromium equal the palette colours of the decoded indices", async () => {
    const rec = await recordedRun();
    const preview = exportMockPreview(previewInput(rec, 0, 1));
    if (!preview.ok) throw new Error(preview.code);
    const decoded = decodeGif(preview.gif);
    const page = await browser.newPage();
    const data = `data:image/gif;base64,${preview.gif.toString("base64")}`;
    const pixels = (await page.evaluate(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(data)};
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return [c.width, c.height, Array.from(g.getImageData(0, 0, c.width, c.height).data)];
    })()`)) as [number, number, number[]];
    await page.close();
    expect([pixels[0], pixels[1]]).toEqual([decoded.width, decoded.height]);
    const first = decoded.frames[0]?.pixels as Uint8Array;
    let mismatches = 0;
    for (let p = 0; p < first.length; p += 1) {
      const idx = first[p] as number;
      for (let c = 0; c < 3; c += 1)
        if (pixels[2][p * 4 + c] !== decoded.palette[idx * 3 + c]) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  }, 60_000);
});

describe("postable budget (§2.9, RS-15)", () => {
  it("a caught false-done clip fits: GIF89a, loops, <= 5 MiB, <= 15 s, <= 150 frames, <= 10 fps, 720 px", async () => {
    const rec = await recordedRun();
    const preview = exportMockPreview(previewInput(rec, 0, 3));
    if (!preview.ok) throw new Error(preview.code);
    const gif = decodeGif(preview.gif);
    expect(gif.loops).toBe(0);
    expect(preview.gif.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    const total = gif.frames.reduce((s, f) => s + f.delayCs, 0);
    expect(total).toBeLessThanOrEqual(1500);
    expect(gif.frames.length).toBeLessThanOrEqual(150);
    for (const f of gif.frames) expect(f.delayCs).toBeGreaterThanOrEqual(10);
    expect(gif.frames.at(-1)?.delayCs).toBe(250);
    expect(gif.width).toBe(720);
  });

  it("refuses over budget with CLIP_BUDGET, never a silent downscale", async () => {
    const steps = [...Array.from({ length: 126 }, (_, i) => ({ frame: `f${i}` })), { call: OWN }];
    const rec = await recordedRun(steps);
    expect(exportMockPreview(previewInput(rec, 0, 125))).toEqual({
      ok: false,
      code: "CLIP_BUDGET",
    });
    const ok = exportMockPreview(previewInput(rec, 0, 124));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.delaysCs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1500);
    for (const width of [CLIP_BUDGET.maxWidth + 1, CLIP_BUDGET.minWidth - 1, 720.5])
      expect(exportMockPreview({ ...previewInput(rec, 0, 1), width })).toEqual({
        ok: false,
        code: "CLIP_BUDGET",
      });
  }, 60_000);

  it("refuses output over 5 MiB (CLIP_BUDGET): full-size noise frames", async () => {
    const width = 960;
    const height = 1080;
    const noisy = (i: number) => {
      const row = width * 3 + 1;
      const raw = Buffer.alloc(row * height);
      // xorshift32: noise the frame backstop accepts and LZW cannot compress.
      let s = (0x9e3779b1 ^ (i * 7919)) >>> 0 || 1;
      for (let y = 0; y < height; y += 1)
        for (let x = 1; x < row; x += 1) {
          s ^= s << 13;
          s >>>= 0;
          s ^= s >>> 17;
          s ^= s << 5;
          s >>>= 0;
          raw[y * row + x] = s & 0xff;
        }
      return encodePng({ width, height, colorType: 2, raw, level: 1 });
    };
    const steps = [...Array.from({ length: 8 }, (_, i) => ({ frame: `n${i}` })), { call: OWN }];
    const trial = await recordTrial({ taskId: TASK, runId: RUN }, steps, { encode: noisy });
    const root = tempDir("myco-clip-noise-");
    mkdirSync(join(root, RUN));
    for (const [i, bytes] of trial.frames.entries())
      writeFileSync(join(root, RUN, `f${i}.png`), bytes);
    writeFileSync(join(root, RUN, "timeline.jsonl"), manifestBytes(trial.records));
    const rec = { root, log: join(root, "log"), trial };
    expect(exportMockPreview({ ...previewInput(rec, 0, 7), width: 960 })).toEqual({
      ok: false,
      code: "CLIP_BUDGET",
    });
  }, 120_000);

  it("refuses an invalid join (CLIP_TIMELINE), an out-of-range span (CLIP_FRAMES) and a bad frame", async () => {
    const rec = await recordedRun();
    const input = previewInput(rec, 0, 1);
    expect(exportMockPreview({ ...input, join: { ok: false, code: "TL_LOG_PREFIX" } })).toEqual({
      ok: false,
      code: "CLIP_TIMELINE",
    });
    expect(exportMockPreview(previewInput(rec, 2, 9))).toEqual({ ok: false, code: "CLIP_FRAMES" });
    expect(exportMockPreview(previewInput(rec, 3, 2))).toEqual({ ok: false, code: "CLIP_FRAMES" });
    expect(exportMockPreview({ ...input, frame: () => null })).toEqual({
      ok: false,
      code: "CLIP_FRAME_REFUSED",
    });
    const svg = {
      bytes: Buffer.from("<svg/>"),
      contentType: "image/svg+xml",
      provenance: "rendered" as const,
    };
    expect(exportMockPreview({ ...input, frame: () => svg })).toEqual({
      ok: false,
      code: "CLIP_FRAME_REFUSED",
    });
    // A decision before the first frame has no frame to stand on.
    const early = await recordedRun([{ call: OWN }, { frame: "a" }, { frame: "b" }]);
    expect(exportMockPreview(previewInput(early, 0, 1))).toEqual({
      ok: false,
      code: "CLIP_TIMELINE",
    });
  });
});
