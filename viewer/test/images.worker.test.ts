import { afterEach, expect, test, vi } from "vitest";
import type { ImageRequest } from "../src/data/images.worker.ts";

const { loadRunFiles, inspectScreenshot } = vi.hoisted(() => ({
  loadRunFiles: vi.fn(),
  inspectScreenshot: vi.fn(),
}));
vi.mock("../src/data/loaders.ts", () => ({ loadRunFiles }));
vi.mock("../src/data/screenshot-format.ts", () => ({ inspectScreenshot }));

async function startWorker(postMessage = vi.fn()) {
  const scope = { postMessage, onmessage: (_event: { data: ImageRequest }) => {} };
  vi.stubGlobal("self", scope);
  await import("../src/data/images.worker.ts");
  return (data: ImageRequest) => scope.onmessage({ data });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.resetAllMocks();
});

test("a failed transfer closes the worker bitmap and reports unavailable without truncation", async () => {
  const bitmap = { close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  loadRunFiles.mockResolvedValue({ read: () => new Blob() });
  inspectScreenshot.mockResolvedValue({ container: "complete", width: 1440, height: 900 });
  const postMessage = vi.fn().mockImplementationOnce(() => {
    throw new DOMException("Transfer failed", "DataCloneError");
  });
  const send = await startWorker(postMessage);
  send({ files: [] });
  send({ id: 1, path: "capture.png", size: "view", viewWidth: 384, priority: true });

  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
  expect(postMessage).toHaveBeenNthCalledWith(
    1,
    { id: 1, bitmap, width: 1440, height: 900 },
    { transfer: [bitmap] },
  );
  expect(postMessage).toHaveBeenNthCalledWith(2, { id: 1 });
  expect(bitmap.close).toHaveBeenCalledTimes(1);
});

test("a canceled active job skips the source read after the archive opens", async () => {
  const read = vi.fn();
  const opening = Promise.withResolvers<{ read: typeof read }>();
  loadRunFiles.mockReturnValue(opening.promise);
  const postMessage = vi.fn();
  const send = await startWorker(postMessage);
  send({ files: [] });
  send({ id: 1, path: "canceled.png", size: "view", viewWidth: 384, priority: true });
  send({ cancel: 1 });
  send({ id: 2, path: "selected.png", size: "view", viewWidth: 384, priority: true });
  opening.resolve({ read });

  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ id: 2 }));
  expect(read.mock.calls).toEqual([["selected.png"]]);
  expect(postMessage).toHaveBeenCalledTimes(1);
});
