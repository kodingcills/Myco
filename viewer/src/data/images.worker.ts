import tokens from "../../../docs/design/tokens.json";
import { loadRunFiles, type RunFileInput, type RunFiles } from "./loaders.ts";

type ImageJob = { id: number; path: string; full: boolean; priority: boolean };
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
    const job = jobs.find(({ full }) => full) ?? jobs.find(({ priority }) => priority) ?? jobs[0]!;
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

async function respond({ id, path, full }: ImageJob) {
  try {
    const source = (await files).read(path);
    if (!source || canceled.has(id)) {
      if (!canceled.has(id)) self.postMessage({ id });
      return;
    }
    // The browser decodes the original image for the Inspector and lightbox. Round-tripping
    // through a worker bitmap and PNG encoder would duplicate the full decode on every miss.
    const type = /\.webp$/i.test(path) ? "image/webp" : "image/png";
    const blob = full ? source.slice(0, source.size, type) : await thumbnail(source);
    if (!canceled.has(id)) self.postMessage({ id, blob });
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
