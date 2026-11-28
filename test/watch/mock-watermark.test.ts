import { describe, expect, it } from "vitest";
import { compileIdentity, SHAPES_ONLY } from "../../src/proof/identity.ts";
import {
  BAND_H,
  type BandFields,
  bandLines,
  displayId,
  drawBand,
  MOCK_LINE_3,
  MOCK_RED,
  watermarkMask,
} from "../../src/watch/clip/band.ts";
import { exportMockPreview, type MockPreviewInput } from "../../src/watch/clip/mock-preview.ts";
import { decodeGif } from "./gif-decode.ts";
import { previewInput, RUN, recordedRun, TASK } from "./recorded-run.ts";

describe("every exported frame carries the MOCK watermark and its reference band (RS-08)", () => {
  it("every frame, end card included: watermark pixels set, band equal to its reference render", async () => {
    const rec = await recordedRun();
    const preview = exportMockPreview(previewInput(rec, 0, 3));
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.mock).toBe(true);
    const gif = decodeGif(preview.gif);
    expect(gif.frames).toHaveLength(5); // 4 source frames and the end card
    const width = gif.width;
    const contentH = gif.height - BAND_H;
    const mask = watermarkMask(width, contentH);
    const masked = mask.reduce((n, v) => n + v, 0);
    expect(masked).toBeGreaterThan(500);
    // The pins of this recording: call 1 on frame 0, call 2 on frame 2.
    const decisionFor = [1, 1, 2, 2];
    gif.frames.forEach((frame, i) => {
      for (let p = 0; p < mask.length; p += 1)
        if (mask[p] === 1) expect(frame.pixels[p], `frame ${i} pixel ${p}`).toBe(MOCK_RED);
      const fields: BandFields = {
        run: displayId(RUN, SHAPES_ONLY),
        task: displayId(TASK, SHAPES_ONLY),
        frame: Math.min(i, 3),
        frames: 4,
        decision: {
          call: decisionFor[Math.min(i, 3)] as number,
          verdict: "refuted",
          reasonCodes: ["ORACLE_FAIL", "CLAIM_RECORDED"],
        },
      };
      const reference = new Uint8Array(width * (contentH + BAND_H));
      drawBand(reference, width, contentH, fields);
      const band = frame.pixels.subarray(width * contentH);
      expect(
        Buffer.from(band).equals(Buffer.from(reference.subarray(width * contentH))),
        `band of frame ${i}`,
      ).toBe(true);
      expect(bandLines(fields, width)[2]).toBe("GATE MYCO.GATE/V1  MOCK · NOT EVIDENCE");
    });
    expect(MOCK_LINE_3).toBe("GATE MYCO.GATE/V1  MOCK · NOT EVIDENCE");
  });

  it("no input drops the watermark: extra fields that claim a real run are ignored", async () => {
    const rec = await recordedRun();
    const forged = {
      ...previewInput(rec, 0, 1),
      mock: false,
      watermark: false,
      evidence: true,
      real: true,
      verified: { runId: RUN, transport: "vm", simulated: false },
    } as unknown as MockPreviewInput;
    const preview = exportMockPreview(forged);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const gif = decodeGif(preview.gif);
    const mask = watermarkMask(gif.width, gif.height - BAND_H);
    for (const frame of gif.frames)
      for (let p = 0; p < mask.length; p += 1)
        if (mask[p] === 1) expect(frame.pixels[p]).toBe(MOCK_RED);
  });

  it("source content never uses the reserved palette indices 0-7", async () => {
    const rec = await recordedRun();
    const preview = exportMockPreview(previewInput(rec, 0, 0));
    if (!preview.ok) throw new Error(preview.code);
    const gif = decodeGif(preview.gif);
    const contentH = gif.height - BAND_H;
    const mask = watermarkMask(gif.width, contentH);
    const first = gif.frames[0]?.pixels as Uint8Array;
    for (let p = 0; p < gif.width * contentH; p += 1)
      if (mask[p] === 0) expect(first[p]).toBeGreaterThanOrEqual(8);
  });

  it("an id carrying an identity is shown hashed on the band, never as written", () => {
    const guard = compileIdentity({ names: ["planted-fake-user"], homes: [] });
    const shown = displayId("run-planted-fake-user-1", guard);
    expect(shown).toMatch(/^H-[0-9A-F]{12}$/);
    expect(displayId("run-r", guard)).toBe("RUN-R");
    expect(displayId("../etc", guard)).toMatch(/^H-[0-9A-F]{12}$/);
  });
});
