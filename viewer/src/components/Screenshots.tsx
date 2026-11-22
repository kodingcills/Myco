import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ImageRequest, ImageResponse, ImageSize } from "../data/images.worker.ts";
import ImageWorker from "../data/images.worker.ts?worker&inline";
import type { RunFileInput } from "../data/loaders.ts";

type SettledImage =
  | { kind: "ready"; id: number; bitmap: ImageBitmap; width: number; height: number }
  | { kind: "ready"; url: string; incomplete: boolean }
  | { kind: "unavailable"; incomplete?: boolean };
type ImageAsset = SettledImage | { kind: "loading" } | { kind: "unrecorded" };

type ImageEntry = {
  id: number;
  key: string;
  size: ImageSize;
  url?: string;
  image?: HTMLImageElement;
  bitmap?: ImageBitmap;
  asset?: SettledImage;
  listeners: Set<() => void>;
};

// Cached Inspector bitmaps are decoded at display width; bounded to 16 entries (16 MiB)
// to keep native renderer memory strictly under the 400 MB gate.
const viewImageLimit = 16;
const viewImageByteLimit = 16 * 1024 * 1024;
const loading = { kind: "loading" } as const;
const unrecorded = { kind: "unrecorded" } as const;
type ViewSize = { width: number; dpr: number };
const imageKey = (path: string, size: ImageSize, view?: ViewSize) =>
  JSON.stringify([path, size, view?.width, view?.dpr]);

class RunImages {
  private worker?: Worker;
  private nextId = 0;
  private entries = new Map<string, ImageEntry>();
  private pending = new Map<number, ImageEntry>();
  private viewLRU = new Map<ImageEntry, number>();
  private viewBytes = 0;

  constructor(private files: readonly RunFileInput[]) {}

  get(path: string, size: ImageSize, view?: ViewSize) {
    return this.entries.get(imageKey(path, size, view))?.asset ?? loading;
  }

  acquire(path: string, size: ImageSize, priority: boolean, listener: () => void, view?: ViewSize) {
    const key = imageKey(path, size, view);
    let entry = this.entries.get(key);
    if (!entry) {
      this.startWorker();
      entry = { id: ++this.nextId, key, size, listeners: new Set() };
      this.entries.set(key, entry);
      this.pending.set(entry.id, entry);
      this.worker?.postMessage({
        id: entry.id,
        path,
        size,
        priority,
        viewWidth: view ? Math.ceil(view.width * view.dpr) : 0,
      } satisfies ImageRequest);
    } else if (priority && this.pending.has(entry.id)) {
      this.worker?.postMessage({ prioritize: entry.id } satisfies ImageRequest);
    }

    const bytes = this.viewLRU.get(entry);
    if (bytes !== undefined) {
      this.viewLRU.delete(entry);
      this.viewLRU.set(entry, bytes);
    }

    const acquired = entry;
    acquired.listeners.add(listener);
    return () => {
      acquired.listeners.delete(listener);
      if (!acquired.listeners.size && !this.viewLRU.has(acquired)) this.release(acquired);
    };
  }

  private retain(entry: ImageEntry, bytes: number) {
    if (bytes > viewImageByteLimit) return;
    this.viewLRU.set(entry, bytes);
    this.viewBytes += bytes;
    for (const [oldest, cost] of this.viewLRU) {
      if (this.viewLRU.size <= viewImageLimit && this.viewBytes <= viewImageByteLimit) break;
      this.viewLRU.delete(oldest);
      this.viewBytes -= cost;
      if (!oldest.listeners.size) this.release(oldest);
    }
  }

  private release(entry: ImageEntry) {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (this.pending.delete(entry.id)) {
      this.worker?.postMessage({ cancel: entry.id } satisfies ImageRequest);
    }
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.image?.removeAttribute("src");
    entry.bitmap?.close();
  }

  private startWorker() {
    if (this.worker) return;
    this.worker = new ImageWorker();
    this.worker.onmessage = ({ data }: MessageEvent<ImageResponse>) => {
      const entry = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (!entry) {
        data.bitmap?.close();
        return;
      }

      const publish = (asset: SettledImage) => {
        if (!entry.listeners.size || this.entries.get(entry.key) !== entry) return;
        entry.asset = asset;
        for (const listener of entry.listeners) listener();
      };
      if (data.bitmap) {
        entry.bitmap = data.bitmap;
        // Only the Inspector's view size is cached. The lightbox's 1:1 bitmap lives while it is open.
        if (entry.size === "view") this.retain(entry, data.bitmap.width * data.bitmap.height * 4);
        publish({
          kind: "ready",
          bitmap: data.bitmap,
          id: data.id,
          width: data.width ?? data.bitmap.width,
          height: data.height ?? data.bitmap.height,
        });
        return;
      }
      if (!data.blob) {
        publish({ kind: "unavailable", incomplete: data.incomplete });
        return;
      }

      const url = URL.createObjectURL(data.blob);
      entry.url = url;
      const image = new Image();
      entry.image = image;
      image.src = url;
      void image.decode().then(
        () => publish({ kind: "ready", url, incomplete: data.incomplete ?? false }),
        () => {
          URL.revokeObjectURL(url);
          entry.url = undefined;
          entry.image = undefined;
          publish({ kind: "unavailable", incomplete: data.incomplete });
        },
      );
    };
    this.worker.postMessage({
      files: this.files.map((file) =>
        "file" in file ? file : { file, relativePath: file.webkitRelativePath },
      ),
    } satisfies ImageRequest);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
    for (const entry of this.entries.values()) this.release(entry);
    this.viewLRU.clear();
    this.viewBytes = 0;
  }
}

const ImageContext = createContext<RunImages | undefined>(undefined);

export function Screenshots({
  files,
  children,
}: {
  files?: readonly RunFileInput[];
  children: ReactNode;
}) {
  const images = useMemo(() => files && new RunImages(files), [files]);
  useEffect(() => () => images?.dispose(), [images]);
  return <ImageContext.Provider value={images}>{children}</ImageContext.Provider>;
}

export function useScreenshotAsset(
  path?: string,
  size: ImageSize = "thumb",
  priority = false,
  view?: ViewSize,
): ImageAsset {
  const images = useContext(ImageContext);
  const subscribe = useCallback(
    (listener: () => void) =>
      path && images ? images.acquire(path, size, priority, listener, view) : () => {},
    [path, size, priority, images, view],
  );
  const snapshot = () => (path ? (images?.get(path, size, view) ?? loading) : unrecorded);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
