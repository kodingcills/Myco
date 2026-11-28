/**
 * Clip export (spec #589 §2.6, build PR B5): the mock preview. A GIF of a chosen frame span of
 * one run, with the verdict band and the MOCK watermark burned into every frame, and no
 * sidecar or digest: a mock preview is never evidence, and `myco clip verify` refuses it
 * (CLIP_NO_SIDECAR).
 *
 * The watermark is not optional: this function has no parameter that turns it off. A real,
 * verified run is exported by the evidence path (build PR B6, receipt-bound), never here.
 *
 * Inputs are already read-only: frames come from a `FrameSource` and pass the watch view's
 * redaction (`servableFrame`, so a PNG is rebuilt from its pixels and scanned) before they are
 * decoded; pins come from the replay join only. Pure; renders in memory and writes nothing.
 */
import type { IdentityGuard } from "../../proof/identity.ts";
import type { Frame } from "../frames.ts";
import { servableFrame } from "../sanitize-frame.ts";
import type { JoinedDecision, TimelineJoin } from "../timeline.ts";
import {
  BAND_H,
  type BandFields,
  composeFrame,
  displayId,
  endCard,
  PALETTE,
  quantizeScaled,
  watermarkMask,
} from "./band.ts";
import { GifWriter } from "./gif.ts";
import { decodeSanitizedPng } from "./png-decode.ts";

/** The closed clip codes (§1.1). A code used here is a member of exactly this enum. */
export const CLIP_CODES = [
  "CLIP_NO_SIDECAR",
  "CLIP_SCHEMA",
  "CLIP_DIGEST",
  "CLIP_FILE",
  "CLIP_FRAMES",
  "CLIP_BAND",
  "CLIP_LOG_LINE",
  "CLIP_LOG_PREFIX",
  "CLIP_LOG_BINDING",
  "CLIP_DECISION",
  "CLIP_LOG_ONLY",
  "CLIP_SEAL",
  "CLIP_MOCK",
  "CLIP_EVIDENCE",
  "CLIP_TIMELINE",
  "CLIP_CLAIM",
  "CLIP_RUN_RECORD",
  "CLIP_RECOMPUTE",
  "CLIP_SOURCE",
  "CLIP_OCR_HIT",
  "CLIP_OCR_UNAVAILABLE",
  "CLIP_BUDGET",
  "CLIP_FRAME_REFUSED",
] as const;
export type ClipCode = (typeof CLIP_CODES)[number];

/** The postable budget (§2.9). */
export const CLIP_BUDGET = {
  maxBytes: 5 * 1024 * 1024,
  maxSpanFrames: 125,
  maxTotalCs: 1500,
  endCardCs: 250,
  minDelayCs: 10,
  maxDelayCs: 50,
  defaultWidth: 720,
  minWidth: 160,
  maxWidth: 960,
  maxContentHeight: 1080,
} as const;

export interface MockPreviewInput {
  readonly runId: string;
  readonly taskId: string;
  /** Inclusive frame ordinals of the span. */
  readonly from: number;
  readonly to: number;
  /** The run's replay join (spec §2.2). An invalid join refuses the clip. */
  readonly join: TimelineJoin;
  /** Raw frame `index` from the run's frame source. */
  readonly frame: (index: number) => Frame | null;
  /** The watch view's host needles for the frame backstop (`hostNeedles()`). */
  readonly needles: readonly string[];
  /** The identity guard ids are checked with (`guardWithHost`). */
  readonly guard: IdentityGuard;
  readonly width?: number;
}

export type MockPreview =
  | {
      readonly ok: true;
      readonly gif: Buffer;
      /** Machine mark: a mock preview is always mock. */
      readonly mock: true;
      readonly frames: number;
      readonly width: number;
      readonly height: number;
      readonly delaysCs: readonly number[];
    }
  | { readonly ok: false; readonly code: ClipCode };

const refuse = (code: ClipCode): MockPreview => ({ ok: false, code });

/** The latest decision pinned at or before frame `f`. */
function decisionAt(decisions: readonly JoinedDecision[], f: number): JoinedDecision | null {
  let latest: JoinedDecision | null = null;
  for (const d of decisions) if (d.frame !== null && d.frame <= f) latest = d;
  return latest;
}

/** Render the mock preview, or refuse with a code. Total: never throws. */
export function exportMockPreview(input: MockPreviewInput): MockPreview {
  try {
    const { join, from, to } = input;
    if (!join.ok) return refuse("CLIP_TIMELINE");
    // A decision before the first frame has no frame to stand on: refuse rather than guess.
    if (join.decisions.some((d) => d.frame === null)) return refuse("CLIP_TIMELINE");
    const total = join.frames.length;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from)
      return refuse("CLIP_FRAMES");
    if (to >= total) return refuse("CLIP_FRAMES");
    const span = to - from + 1;
    const width = input.width ?? CLIP_BUDGET.defaultWidth;
    if (
      span > CLIP_BUDGET.maxSpanFrames ||
      !Number.isSafeInteger(width) ||
      width < CLIP_BUDGET.minWidth ||
      width > CLIP_BUDGET.maxWidth
    )
      return refuse("CLIP_BUDGET");
    // Frames are decoded, composed and encoded one at a time: at most one source frame and one
    // output frame are held, and the writer stops at the first frame over the byte cap.
    const decode = (f: number) => {
      const raw = input.frame(f);
      if (raw === null || raw.provenance !== "file" || raw.contentType !== "image/png") return null;
      const served = servableFrame(raw, input.needles);
      return served === null ? null : decodeSanitizedPng(served.bytes);
    };
    const first = decode(from);
    if (first === null) return refuse("CLIP_FRAME_REFUSED");
    const contentH = Math.max(1, Math.round((width * first.height) / first.width));
    if (contentH > CLIP_BUDGET.maxContentHeight) return refuse("CLIP_BUDGET");
    const delay = Math.max(
      CLIP_BUDGET.minDelayCs,
      Math.min(
        CLIP_BUDGET.maxDelayCs,
        Math.floor((CLIP_BUDGET.maxTotalCs - CLIP_BUDGET.endCardCs) / span),
      ),
    );
    if (span * delay + CLIP_BUDGET.endCardCs > CLIP_BUDGET.maxTotalCs) return refuse("CLIP_BUDGET");
    const run = displayId(input.runId, input.guard);
    const task = displayId(input.taskId, input.guard);
    const mask = watermarkMask(width, contentH);
    const height = contentH + BAND_H;
    const writer = new GifWriter(width, height, PALETTE, CLIP_BUDGET.maxBytes);
    const delaysCs: number[] = [];
    let last: BandFields | null = null;
    for (let f = from; f <= to; f += 1) {
      const rgba = f === from ? first : decode(f);
      if (rgba === null) return refuse("CLIP_FRAME_REFUSED");
      const d = decisionAt(join.decisions, f);
      const fields: BandFields = {
        run,
        task,
        frame: f,
        frames: total,
        decision:
          d === null ? null : { call: d.call, verdict: d.verdict, reasonCodes: [...d.reasonCodes] },
      };
      last = fields;
      const pixels = composeFrame(
        quantizeScaled(rgba, width, contentH),
        width,
        contentH,
        mask,
        fields,
      );
      if (!writer.add({ pixels, delayCs: delay })) return refuse("CLIP_BUDGET");
      delaysCs.push(delay);
    }
    if (last === null) return refuse("CLIP_FRAMES");
    const card = endCard(width, contentH, mask, last);
    if (!writer.add({ pixels: card, delayCs: CLIP_BUDGET.endCardCs })) return refuse("CLIP_BUDGET");
    delaysCs.push(CLIP_BUDGET.endCardCs);
    const gif = writer.finish();
    return { ok: true, gif, mock: true, frames: delaysCs.length, width, height, delaysCs };
  } catch {
    // A character outside the band font (RenderRefused) or any render failure: refuse.
    return refuse("CLIP_FRAME_REFUSED");
  }
}
