/**
 * Clip export (spec #589 §2.5, §2.6, §2.7): the burned-in band, the MOCK watermark and the
 * palette. Everything drawn here comes from `BandFields`, a closed type: branded display ids
 * (built only by `displayId`), frame ordinals, a verdict, `REASON_CODES` members and fixed
 * text. There is no code path from a claim, a reason string, a file name or a window title to
 * a pixel. Pure; no I/O.
 *
 * Palette: indices 0-7 are reserved for the band and the watermark; source content is
 * quantized to a fixed 6x6x6 cube at indices 8-223 and never uses 0-7.
 */
import { createHash } from "node:crypto";
import { type GateVerdict, isSafeId, type ReasonCode } from "../../gate/api.ts";
import type { IdentityGuard } from "../../proof/identity.ts";
import { GLYPH_H, GLYPH_W, glyphsFor } from "./font.ts";
import type { Rgba } from "./png-decode.ts";

export const BAND_BG = 0;
export const INK = 1;
export const MOCK_RED = 2;
export const VERIFIED_INK = 3;
export const REFUTED_INK = 4;
export const UNCERTAIN_INK = 5;
export const MUTED_INK = 6;
export const RESERVED = 8;

const RESERVED_RGB: readonly (readonly [number, number, number])[] = [
  [16, 20, 24],
  [255, 255, 255],
  [248, 81, 73],
  [63, 185, 80],
  [255, 123, 114],
  [210, 153, 34],
  [154, 163, 178],
  [139, 26, 26],
];

/** The fixed 256-entry palette (reserved band colours, then the 6x6x6 content cube). */
export const PALETTE: Uint8Array = (() => {
  const out = new Uint8Array(768);
  RESERVED_RGB.forEach(([r, g, b], i) => {
    out.set([r, g, b], i * 3);
  });
  for (let r = 0; r < 6; r += 1)
    for (let g = 0; g < 6; g += 1)
      for (let b = 0; b < 6; b += 1)
        out.set([r * 51, g * 51, b * 51], (RESERVED + r * 36 + g * 6 + b) * 3);
  return out;
})();

/** Text scale for the band: glyphs 10x14 px, readable at 720 px wide (>= 12 px high). */
export const BAND_SCALE = 2;
const LINE_H = GLYPH_H * BAND_SCALE + 4;
const PAD = 4;
export const BAND_H = PAD * 2 + LINE_H * 3;

declare const DISPLAY: unique symbol;
/** An id as the band shows it: built only by `displayId`. */
export type DisplayId = string & { readonly [DISPLAY]: true };

/**
 * The band form of an id: the closed id upper-cased when it is a safe id carrying no identity,
 * otherwise `H-` and the first 12 hex digits of its `h-<60hex>` form (§2.5 "display").
 */
export function displayId(value: string, guard: IdentityGuard): DisplayId {
  if (isSafeId(value) && guard.hit(value) === null) return value.toUpperCase() as DisplayId;
  const hex = createHash("sha256").update(`myco.clip/1/text\u0000${value}`).digest("hex");
  return `H-${hex.slice(0, 12).toUpperCase()}` as DisplayId;
}

/** The closed fields one frame's band is drawn from. */
export interface BandFields {
  readonly run: DisplayId;
  readonly task: DisplayId;
  /** 0-based frame ordinal of this frame, and the run's frame count. */
  readonly frame: number;
  readonly frames: number;
  /** The latest decision pinned at or before this frame, or null. */
  readonly decision: {
    readonly call: number;
    readonly verdict: GateVerdict;
    readonly reasonCodes: readonly ReasonCode[];
  } | null;
}

/** Band line 3 of a mock preview (§2.5): never an oracle, never a digest. */
export const MOCK_LINE_3 = "GATE MYCO.GATE/V1  MOCK · NOT EVIDENCE";

export class RenderRefused extends Error {}

/** Draw `text` at (x, y) in `ink`, scaled; refuses a character outside the font. */
function drawText(
  px: Uint8Array,
  width: number,
  height: number,
  text: string,
  x: number,
  y: number,
  scale: number,
  ink: number,
): number {
  const glyphs = glyphsFor(text);
  if (glyphs === null) throw new RenderRefused("a character outside the band font");
  let cx = x;
  for (const bits of glyphs) {
    if (cx + GLYPH_W * scale > width) break;
    for (let gy = 0; gy < GLYPH_H; gy += 1)
      for (let gx = 0; gx < GLYPH_W; gx += 1) {
        if (!bits[gy * GLYPH_W + gx]) continue;
        for (let dy = 0; dy < scale; dy += 1) {
          const yy = y + gy * scale + dy;
          if (yy < 0 || yy >= height) continue;
          const row = yy * width;
          for (let dx = 0; dx < scale; dx += 1) px[row + cx + gx * scale + dx] = ink;
        }
      }
    cx += (GLYPH_W + 1) * scale;
  }
  return cx;
}

const VERDICT_INK: Readonly<Record<GateVerdict, number>> = {
  verified: VERIFIED_INK,
  refuted: REFUTED_INK,
  uncertain: UNCERTAIN_INK,
};

/** The three band lines, as text. Exported so tests can compare them. */
export function bandLines(fields: BandFields, width: number): [string, string, string] {
  const line1 = `RUN ${fields.run}  TASK ${fields.task}  FRAME ${fields.frame + 1}/${fields.frames}`;
  let line2 = "NO DECISION YET";
  if (fields.decision !== null) {
    const head = `CALL ${fields.decision.call} ${fields.decision.verdict.toUpperCase()}`;
    const max = Math.floor((width - PAD * 2) / ((GLYPH_W + 1) * BAND_SCALE));
    line2 = head;
    for (const code of fields.decision.reasonCodes) {
      const nextLine = `${line2} ${code}`;
      if (nextLine.length > max - 4) {
        line2 = `${line2} ...`;
        break;
      }
      line2 = nextLine;
    }
  }
  return [line1, line2, MOCK_LINE_3];
}

/** Draw the band into rows [top, top + BAND_H) of an indexed frame. */
export function drawBand(px: Uint8Array, width: number, top: number, fields: BandFields): void {
  const height = top + BAND_H;
  px.fill(BAND_BG, top * width, height * width);
  const [l1, l2, l3] = bandLines(fields, width);
  drawText(px, width, height, l1, PAD, top + PAD, BAND_SCALE, INK);
  const ink = fields.decision === null ? MUTED_INK : VERDICT_INK[fields.decision.verdict];
  drawText(px, width, height, l2, PAD, top + PAD + LINE_H, BAND_SCALE, ink);
  drawText(px, width, height, l3, PAD, top + PAD + LINE_H * 2, BAND_SCALE, MOCK_RED);
}

/** The pixels the MOCK watermark sets in a content area (a sheared, checkered `MOCK`). */
export function watermarkMask(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const textW = 4 * (GLYPH_W + 1) - 1;
  const scale = Math.max(2, Math.floor((width * 0.6) / textW));
  const glyphs = glyphsFor("MOCK") as (readonly boolean[])[];
  const x0 = Math.floor((width - textW * scale) / 2);
  const y0 = Math.floor((height - GLYPH_H * scale) / 2);
  const cy = y0 + (GLYPH_H * scale) / 2;
  glyphs.forEach((bits, g) => {
    for (let gy = 0; gy < GLYPH_H; gy += 1)
      for (let gx = 0; gx < GLYPH_W; gx += 1) {
        if (!bits[gy * GLYPH_W + gx]) continue;
        for (let dy = 0; dy < scale; dy += 1)
          for (let dx = 0; dx < scale; dx += 1) {
            const y = y0 + gy * scale + dy;
            const x = x0 + (g * (GLYPH_W + 1) + gx) * scale + dx + Math.round((cy - y) * 0.5);
            if (x < 0 || x >= width || y < 0 || y >= height || (x + y) % 2 !== 0) continue;
            mask[y * width + x] = 1;
          }
      }
  });
  return mask;
}

/** Quantize RGBA (composited over black) to the content cube, scaled to width x height. */
export function quantizeScaled(src: Rgba, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const o = (sy * src.width + sx) * 4;
      const a = src.data[o + 3] as number;
      const q = (v: number) => Math.round((v * a) / 255 / 51);
      out[y * width + x] =
        RESERVED +
        q(src.data[o] as number) * 36 +
        q(src.data[o + 1] as number) * 6 +
        q(src.data[o + 2] as number);
    }
  }
  return out;
}

/** One output frame: scaled content, the watermark burned over it, the band below. */
export function composeFrame(
  content: Uint8Array,
  width: number,
  contentH: number,
  mask: Uint8Array,
  fields: BandFields,
): Uint8Array {
  const px = new Uint8Array(width * (contentH + BAND_H));
  px.set(content, 0);
  for (let i = 0; i < mask.length; i += 1) if (mask[i] === 1) px[i] = MOCK_RED;
  drawBand(px, width, contentH, fields);
  return px;
}

/** The end card: the verdict in large type over the watermark, and the same band. */
export function endCard(
  width: number,
  contentH: number,
  mask: Uint8Array,
  fields: BandFields,
): Uint8Array {
  const content = new Uint8Array(width * contentH).fill(BAND_BG);
  const word = fields.decision === null ? "NO DECISION" : fields.decision.verdict.toUpperCase();
  const scale = Math.max(2, Math.floor((width * 0.7) / (word.length * (GLYPH_W + 1))));
  const textW = word.length * (GLYPH_W + 1) * scale;
  const ink = fields.decision === null ? MUTED_INK : VERDICT_INK[fields.decision.verdict];
  const y = Math.max(0, Math.floor(contentH / 2 - GLYPH_H * scale));
  drawText(content, width, contentH, word, Math.floor((width - textW) / 2), y, scale, ink);
  drawText(
    content,
    width,
    contentH,
    MOCK_LINE_3,
    8,
    contentH - GLYPH_H * BAND_SCALE - 8,
    BAND_SCALE,
    MOCK_RED,
  );
  return composeFrame(content, width, contentH, mask, fields);
}
