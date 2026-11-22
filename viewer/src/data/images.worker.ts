import tokens from "../../../docs/design/tokens.json";
import { loadRunFiles, type RunFileInput, type RunFiles } from "./loaders.ts";

import { inspectScreenshot } from "./screenshot-format.ts";

/** thumb: 96 px preview. view: decoded at display width for the Inspector. original: 1:1 for the lightbox. */
export type ImageSize = "thumb" | "view" | "original";
export type ImageResponse = {
  id: number;
  blob?: Blob;
  bitmap?: ImageBitmap;
  /** Pixel size declared by the source image (the bitmap can be smaller for the view size). */
  width?: number;
  height?: number;
  incomplete?: boolean;
};

type ImageJob = { id: number; path: string; size: ImageSize; priority: boolean; viewWidth: number };
export type ImageRequest =
  | { files: RunFileInput[] }
  | { cancel: number }
  | { prioritize: number }
  | ImageJob;

let files: Promise<RunFiles>;
const queue = new Map<number, ImageJob>();
const active = new Set<number>();
const canceled = new Set<number>();

function drain() {
  while (active.size < 2 && queue.size) {
    const jobs = [...queue.values()];
    const job =
      jobs.find(({ size }) => size !== "thumb") ??
      jobs.find(({ priority }) => priority) ??
      jobs[0]!;
    queue.delete(job.id);
    active.add(job.id);
    void respond(job).finally(() => {
      active.delete(job.id);
      canceled.delete(job.id);
      drain();
    });
  }
}

async function thumbnail(source: Blob) {
  const { width, height } = tokens.layout.filmstripThumb;
  const bitmap = await createImageBitmap(source, { resizeWidth: width, resizeQuality: "high" });
  const canvas = new OffscreenCanvas(width, height);
  try {
    const scale = Math.min(width / bitmap.width, height / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    canvas.getContext("2d")?.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
  } finally {
    bitmap.close();
  }
  return canvas.convertToBlob({ type: "image/webp" });
}

async function respond({ id, path, size, viewWidth }: ImageJob) {
  try {
    const run = await files;
    if (canceled.has(id)) return;
    const source = run.read(path);
    if (!source) {
      self.postMessage({ id });
      return;
    }
    const format = /\.webp$/i.test(path) ? "webp" : "png";
    const { container, width, height } = await inspectScreenshot(source, format);
    if (canceled.has(id)) return;
    if (container === "complete" && width && height) {
      if (size === "thumb") {
        const blob = await thumbnail(source).catch(() => undefined);
        if (blob) {
          if (!canceled.has(id)) self.postMessage({ id, blob } satisfies ImageResponse);
          return;
        }
      } else {
        const resize = size === "view" && width > viewWidth;
        const bitmap = await createImageBitmap(
          source,
          resize ? { resizeWidth: viewWidth, resizeQuality: "high" } : undefined,
        ).catch(() => undefined);
        if (bitmap) {
          if (canceled.has(id)) bitmap.close();
          else {
            try {
              self.postMessage({ id, bitmap, width, height } satisfies ImageResponse, {
                transfer: [bitmap],
              });
            } catch (error) {
              bitmap.close();
              throw error;
            }
          }
          return;
        }
      }
    }
    if (!canceled.has(id)) {
      const incomplete = container !== "unavailable";
      // The DOM decoder can display partial evidence. Only the larger views carry the marker.
      const blob =
        size !== "thumb" && incomplete
          ? source.slice(0, source.size, `image/${format}`)
          : undefined;
      self.postMessage({ id, blob, incomplete } satisfies ImageResponse);
    }
  } catch {
    if (!canceled.has(id)) self.postMessage({ id });
  }
}

self.onmessage = ({ data }: MessageEvent<ImageRequest>) => {
  if ("files" in data) {
    files = loadRunFiles(data.files);
    void files.catch(() => undefined);
  } else if ("cancel" in data) {
    queue.delete(data.cancel);
    if (active.has(data.cancel)) canceled.add(data.cancel);
  } else if ("prioritize" in data) {
    const job = queue.get(data.prioritize);
    if (job) job.priority = true;
  } else {
    queue.set(data.id, data);
    drain();
  }
};
