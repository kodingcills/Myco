import tokens from "../../../docs/design/tokens.json";
import { loadRunFiles, type RunFileInput, type RunFiles } from "./loaders.ts";

type DecodeRequest = { id: number; path: string; full: boolean };
export type ImageRequest = { files: RunFileInput[] } | { cancel: number } | DecodeRequest;

let files: Promise<RunFiles>;
const fullImages = new Map<string, Promise<ImageBitmap>>();
const fullImageLimit = 64;

async function decode(path: string) {
  const blob = (await files).read(path);
  if (!blob) throw new Error("Screenshot unavailable");
  return createImageBitmap(blob);
}

function fullImage(path: string) {
  let image = fullImages.get(path);
  if (image) fullImages.delete(path);
  else {
    image = decode(path);
    const pending = image;
    void pending.catch(() => {
      if (fullImages.get(path) === pending) fullImages.delete(path);
    });
  }
  fullImages.set(path, image);
  if (fullImages.size > fullImageLimit) {
    const oldest = fullImages.entries().next().value;
    if (oldest) {
      fullImages.delete(oldest[0]);
      void oldest[1].then(
        (bitmap) => bitmap.close(),
        () => undefined,
      );
    }
  }
  return image;
}

const queue = new Map<number, DecodeRequest>();
const active = new Set<number>();
const canceled = new Set<number>();

function drain() {
  while (active.size < 2 && queue.size) {
    const request = [...queue.values()].find(({ full }) => full) ?? queue.values().next().value;
    if (!request) return;
    queue.delete(request.id);
    active.add(request.id);
    void respond(request).finally(() => {
      active.delete(request.id);
      canceled.delete(request.id);
      drain();
    });
  }
}

async function respond({ id, path, full }: DecodeRequest) {
  try {
    const bitmap = await (full ? fullImage(path) : decode(path));
    if (canceled.has(id)) {
      if (!full) bitmap.close();
      return;
    }
    const thumb = tokens.layout.filmstripThumb;
    const canvas = new OffscreenCanvas(
      full ? bitmap.width : thumb.width,
      full ? bitmap.height : thumb.height,
    );
    const ctx = canvas.getContext("2d");
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    ctx?.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    if (!full) bitmap.close();
    const blob = await canvas.convertToBlob({ type: full ? "image/png" : "image/webp" });
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
  } else {
    queue.set(data.id, data);
    drain();
  }
};
