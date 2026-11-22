import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ImageRequest } from "../data/images.worker.ts";
import ImageWorker from "../data/images.worker.ts?worker&inline";
import type { RunFileInput } from "../data/loaders.ts";

type SettledImage = { kind: "ready"; url: string } | { kind: "unavailable" };
type ImageAsset = SettledImage | { kind: "loading" } | { kind: "unrecorded" };

type ImageEntry = {
  id: number;
  key: string;
  full: boolean;
  url?: string;
  image?: HTMLImageElement;
  asset?: SettledImage;
  listeners: Set<() => void>;
};

const fullImageLimit = 64;
// 64 desktop captures can exceed 300 MB of decoded pixels on their own.
const fullImageByteLimit = 64 * 1024 * 1024;
const loading = { kind: "loading" } as const;
const unrecorded = { kind: "unrecorded" } as const;
const imageKey = (path: string, full: boolean) => JSON.stringify([path, full]);

class RunImages {
  private worker?: Worker;
  private nextId = 0;
  private entries = new Map<string, ImageEntry>();
  private pending = new Map<number, ImageEntry>();
  private fullLRU = new Map<ImageEntry, number>();
  private fullBytes = 0;

  constructor(private files: readonly RunFileInput[]) {}

  get(path: string, full: boolean) {
    return this.entries.get(imageKey(path, full))?.asset ?? loading;
  }

  acquire(path: string, full: boolean, priority: boolean, listener: () => void) {
    const key = imageKey(path, full);
    let entry = this.entries.get(key);
    if (!entry) {
      this.startWorker();
      entry = { id: ++this.nextId, key, full, listeners: new Set() };
      this.entries.set(key, entry);
      this.pending.set(entry.id, entry);
      this.worker?.postMessage({ id: entry.id, path, full, priority } satisfies ImageRequest);
    } else if (priority && this.pending.has(entry.id)) {
      this.worker?.postMessage({ prioritize: entry.id } satisfies ImageRequest);
    }

    const bytes = this.fullLRU.get(entry);
    if (bytes !== undefined) {
      this.fullLRU.delete(entry);
      this.fullLRU.set(entry, bytes);
    }

    const acquired = entry;
    acquired.listeners.add(listener);
    return () => {
      acquired.listeners.delete(listener);
      if (!acquired.listeners.size && !this.fullLRU.has(acquired)) this.release(acquired);
    };
  }

  private retain(entry: ImageEntry, bytes: number) {
    if (bytes > fullImageByteLimit) return;
    this.fullLRU.set(entry, bytes);
    this.fullBytes += bytes;
    for (const [oldest, cost] of this.fullLRU) {
      if (this.fullLRU.size <= fullImageLimit && this.fullBytes <= fullImageByteLimit) break;
      this.fullLRU.delete(oldest);
      this.fullBytes -= cost;
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
  }

  private startWorker() {
    if (this.worker) return;
    this.worker = new ImageWorker();
    this.worker.onmessage = ({ data }: MessageEvent<{ id: number; blob?: Blob }>) => {
      const entry = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (!entry) return;

      const publish = (asset: SettledImage) => {
        if (!entry.listeners.size || this.entries.get(entry.key) !== entry) return;
        entry.asset = asset;
        for (const listener of entry.listeners) listener();
      };
      if (!data.blob) {
        publish({ kind: "unavailable" });
        return;
      }

      const url = URL.createObjectURL(data.blob);
      entry.url = url;
      const image = new Image();
      entry.image = image;
      image.src = url;
      void image.decode().then(
        () => {
          if (entry.full && entry.listeners.size && this.entries.get(entry.key) === entry) {
            this.retain(entry, image.naturalWidth * image.naturalHeight * 4);
          }
          publish({ kind: "ready", url });
        },
        () => publish({ kind: "unavailable" }),
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
    this.fullLRU.clear();
    this.fullBytes = 0;
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

export function useScreenshotAsset(path?: string, full = false, priority = false): ImageAsset {
  const images = useContext(ImageContext);
  const subscribe = useCallback(
    (listener: () => void) =>
      path && images ? images.acquire(path, full, priority, listener) : () => {},
    [path, full, priority, images],
  );
  const snapshot = () => (path ? (images?.get(path, full) ?? loading) : unrecorded);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
