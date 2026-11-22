import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { ImageRequest } from "../data/images.worker.ts";
import ImageWorker from "../data/images.worker.ts?worker&inline";
import type { RunFileInput } from "../data/loaders.ts";

type SettledImage = { kind: "ready"; url: string } | { kind: "unavailable" };
type ImageAsset = SettledImage | { kind: "loading" } | { kind: "unrecorded" };

type ImageEntry = {
  count: number;
  id: number;
  url?: string;
  asset?: SettledImage;
  listeners: Set<(asset: SettledImage) => void>;
};

class RunImages {
  private worker?: Worker;
  private nextId = 0;
  private entries = new Map<string, ImageEntry>();
  private pending = new Map<number, ImageEntry>();

  constructor(private files: readonly RunFileInput[]) {}

  acquire(path: string, full: boolean, onLoad: (asset: SettledImage) => void) {
    const key = JSON.stringify([path, full]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (!this.worker) {
        this.worker = new ImageWorker();
        this.send({
          files: this.files.map((file) =>
            "file" in file ? file : { file, relativePath: file.webkitRelativePath },
          ),
        });
        this.worker.onmessage = ({ data }: MessageEvent<{ id: number; blob?: Blob }>) => {
          const requested = this.pending.get(data.id);
          this.pending.delete(data.id);
          if (!requested) return;
          function publish(asset: SettledImage) {
            if (!requested?.count) return;
            requested.asset = asset;
            for (const listener of requested.listeners) listener(asset);
          }
          if (!data.blob) {
            publish({ kind: "unavailable" });
            return;
          }
          const url = URL.createObjectURL(data.blob);
          requested.url = url;
          const image = new Image();
          image.src = url;
          void image.decode().then(
            () => publish({ kind: "ready", url }),
            () => publish({ kind: "unavailable" }),
          );
        };
      }
      entry = { count: 0, id: ++this.nextId, listeners: new Set() };
      this.entries.set(key, entry);
      this.pending.set(entry.id, entry);
      this.send({ id: entry.id, path, full });
    }
    entry.count++;
    entry.listeners.add(onLoad);
    if (entry.asset) onLoad(entry.asset);
    return () => {
      entry.listeners.delete(onLoad);
      entry.count -= 1;
      if (entry.count) return;
      this.entries.delete(key);
      if (this.pending.delete(entry.id)) this.send({ cancel: entry.id });
      if (entry.url) URL.revokeObjectURL(entry.url);
    };
  }

  private send(request: ImageRequest) {
    this.worker?.postMessage(request);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
    for (const entry of this.entries.values()) if (entry.url) URL.revokeObjectURL(entry.url);
    this.entries.clear();
    this.pending.clear();
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

export function useScreenshotAsset(path?: string, full = false): ImageAsset {
  const images = useContext(ImageContext);
  const [state, setState] = useState<{
    images: RunImages;
    path: string;
    full: boolean;
    asset: SettledImage;
  }>();
  useEffect(() => {
    if (path && images) {
      return images.acquire(path, full, (asset) => setState({ images, path, full, asset }));
    }
  }, [path, full, images]);
  if (!path) return { kind: "unrecorded" };
  if (state?.images === images && state?.path === path && state.full === full) return state.asset;
  return { kind: "loading" };
}
