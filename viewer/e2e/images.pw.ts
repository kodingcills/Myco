import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import type { ResultRecord } from "../src/data/types.ts";
import { boot, checkOffline, runs, screenshotDir, waitForRun } from "./support.ts";

test("screenshots hand off from preview to full and reuse the cached bitmap on reselect", async ({
  page,
}, testInfo) => {
  const offline = checkOffline(page);
  await page.addInitScript(() => {
    // Gate delivery of actual image worker results to make both handoffs deterministic.
    const replayed = new WeakSet<MessageEvent>();
    const released = new Set<string>();
    const queued = new Map<string, (() => void)[]>();
    document.addEventListener("release-test-image", (event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
      released.add(event.detail);
      for (const replay of queued.get(event.detail) ?? []) replay();
      queued.delete(event.detail);
    });
    window.Worker = class extends Worker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener(
          "message",
          (event) => {
            const { blob, bitmap } = event.data;
            const type =
              bitmap instanceof ImageBitmap ? "full" : blob instanceof Blob ? blob.type : undefined;
            if (!type || released.has(type) || replayed.has(event)) return;
            event.stopImmediatePropagation();
            const rest = queued.get(type) ?? [];
            rest.push(() => {
              const message = new MessageEvent("message", { data: event.data });
              replayed.add(message);
              this.dispatchEvent(message);
            });
            queued.set(type, rest);
          },
          { capture: true },
        );
      }
    };
  });
  await boot(page);
  const width = 256;
  const png = await page.evaluate(
    ({ width }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = 160;
      const drawing = canvas.getContext("2d")!;
      drawing.fillStyle = "navy";
      drawing.fillRect(0, 0, 256, 160);
      drawing.fillStyle = "white";
      drawing.fillRect(32, 32, 192, 96);
      drawing.fillStyle = "navy";
      drawing.font = "24px monospace";
      drawing.fillText("VIEWER TEST", 48, 90);
      return canvas.toDataURL("image/png").split(",")[1]!;
    },
    { width },
  );
  const result: ResultRecord = {
    recordKind: "session",
    runId: "viewer-image-test",
    taskId: "Viewer image test",
    startedAt: "2026-11-21T12:00:00.000Z",
    steps: [
      {
        step: 0,
        action: { kind: "type", text: "Viewer image test" },
        preconditionResults: [],
        postconditionResults: [],
        stateVersionBefore: 0,
        stateVersionAfter: 1,
      },
      {
        step: 1,
        action: { kind: "type", text: "Second screenshot" },
        preconditionResults: [],
        postconditionResults: [],
        stateVersionBefore: 1,
        stateVersionAfter: 2,
      },
    ],
  };
  const trace = [
    { type: "run-start", runId: result.runId, taskId: result.taskId, startedAt: result.startedAt },
    ...result.steps.map(({ step, action }) => ({
      type: "action",
      step,
      timestamp: result.startedAt,
      action,
    })),
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  await page
    .locator("input[multiple]:not([webkitdirectory])")
    .first()
    .setInputFiles({
      name: "viewer-image-test.mycotrace",
      mimeType: "application/zip",
      buffer: Buffer.from(
        zipSync({
          "result.json": Buffer.from(JSON.stringify(result)),
          "trace.jsonl": Buffer.from(trace),
          "artifacts/viewer-test.png": Buffer.from(png, "base64"),
          "artifacts/viewer-test-meta.json": Buffer.from('{"step":0}'),
          "artifacts/viewer-second.png": Buffer.from(png, "base64"),
          "artifacts/viewer-second-meta.json": Buffer.from('{"step":1}'),
        }),
      ),
    });
  await waitForRun(page, "Unknown");
  await page.keyboard.press("2");
  await page.keyboard.press("j");

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const screenshot = inspector.getByRole("button", { name: "Enlarge screenshot" });
  const preview = screenshot.locator("img");
  const image = screenshot.locator("canvas");
  const release = (type: string) =>
    page.evaluate((detail) => {
      document.dispatchEvent(new CustomEvent("release-test-image", { detail }));
    }, type);

  await expect(inspector.getByText("Loading screenshot", { exact: true })).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Open source artifacts/viewer-test-meta.json#/step" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("viewer-test-screenshot-loading-1440.png"),
    animations: "disabled",
  });
  await release("image/webp");
  await expect(preview).toHaveAttribute("data-image-size", "preview");
  await expect
    .poll(() => preview.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(96);
  await page.screenshot({
    path: testInfo.outputPath("viewer-test-screenshot-preview-1440.png"),
    animations: "disabled",
  });

  await release("full");
  await expect(image).toHaveAttribute("data-image-size", "full");
  await expect(image).toHaveAttribute("width", String(width));
  expect(
    await image.evaluate((canvas: HTMLCanvasElement) =>
      Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data),
    ),
  ).toEqual([0, 0, 128, 255]);
  await screenshot.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Step screenshot" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("viewer-test-screenshot-full-1440.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
    "aria-valuetext",
    "#00",
  );
  const firstFullID = await image.getAttribute("data-image-id");
  await page.keyboard.press("j");
  await expect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
    "aria-valuetext",
    "#01",
  );
  await expect(image).toHaveAttribute("data-image-size", "full");
  expect(await image.getAttribute("data-image-id")).not.toBe(firstFullID);
  await page.keyboard.press("k");
  await expect(image).toHaveAttribute("data-image-size", "full");
  await expect(image).toHaveAttribute("data-image-id", firstFullID!);
  offline();
});

for (const variant of [
  "png",
  "wide png",
  "original-only fallback",
  "truncated PNG",
  "PNG missing IEND",
  "PNG CRC mismatch",
  "webp",
  "truncated WebP",
  "garbage",
] as const) {
  test(`manifested screenshot display handles ${variant}`, async ({ page }) => {
    const offline = checkOffline(page);
    await boot(page);
    const folder = runs.find(({ name }) => name === "verified")!.folder;
    const result = await readFile(join(folder, "result.json"));
    const trace = await readFile(join(folder, "trace.jsonl"));
    const ledger = await readFile(join(folder, "ledger.jsonl"));
    const webp = variant === "webp" || variant === "truncated WebP";
    const extension = webp ? "webp" : "png";
    const [wide, high] =
      variant === "wide png" || variant === "original-only fallback" ? [1440, 900] : [480, 300];
    const encoded = await page.evaluate(
      ({ extension, wide, high }) => {
        const canvas = document.createElement("canvas");
        canvas.width = wide;
        canvas.height = high;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#283763";
        context.fillRect(0, 0, wide, high);
        context.fillStyle = "white";
        context.font = "32px sans-serif";
        context.fillText("Recorded screenshot", 32, 60);
        return canvas.toDataURL(`image/${extension}`).split(",")[1]!;
      },
      { extension, wide, high },
    );
    let image = Buffer.from(encoded, "base64");
    if (variant === "truncated PNG") image = image.subarray(0, Math.floor(image.length * 0.75));
    if (variant === "PNG missing IEND") image = image.subarray(0, image.length - 12);
    if (variant === "PNG CRC mismatch") image[image.length - 1] = image[image.length - 1]! ^ 1;
    if (variant === "truncated WebP") image = image.subarray(0, image.length - 8);
    if (variant === "garbage") image = Buffer.from("garbage bytes");
    const entries = {
      "result.json": result,
      "trace.jsonl": trace,
      "ledger.jsonl": ledger,
      [`artifacts/capture.${extension}`]: image,
      "artifacts/capture-meta.json": Buffer.from('{"step":0}'),
    };
    // The digests cover the corrupted bytes, so the run stays Verified.
    const manifest = {
      format: "mycotrace/1",
      runId: JSON.parse(result.toString()).runId,
      files: Object.fromEntries(
        Object.entries(entries).map(([path, bytes]) => [
          path,
          createHash("sha256").update(bytes).digest("hex"),
        ]),
      ),
    };
    await page
      .locator("input[multiple]:not([webkitdirectory])")
      .first()
      .setInputFiles({
        name: "manifested-image.mycotrace",
        mimeType: "application/zip",
        buffer: Buffer.from(
          zipSync({ ...entries, "manifest.json": Buffer.from(JSON.stringify(manifest)) }),
        ),
      });
    await waitForRun(page, "Verified");
    await page.keyboard.press("2");
    await page.keyboard.press("j");
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    const marker = "Screenshot truncated or incomplete";
    const trigger = inspector.getByRole("button", { name: "Enlarge screenshot" });
    const thumbnail = page.locator("#step-row-0 [data-step-thumb]");
    if (["png", "webp", "wide png", "original-only fallback"].includes(variant)) {
      await expect(trigger.locator("canvas")).toHaveAttribute("data-image-size", "full");
      await expect(thumbnail.locator("img")).toBeVisible();
      await expect(inspector.getByText(marker)).toHaveCount(0);
      if (variant === "wide png") {
        // The Inspector decodes at its display width; only the lightbox decodes 1:1.
        const canvas = trigger.locator("canvas");
        await expect(canvas).toHaveAttribute("data-image-width", "1440");
        const displayWidth = await trigger.evaluate((button) => button.clientWidth);
        await expect(canvas).toHaveAttribute("width", String(Math.ceil(displayWidth / 32) * 32));
        await trigger.click();
        const lightbox = page.getByRole("dialog", { name: "Step screenshot" });
        await expect(lightbox.locator("canvas")).toHaveAttribute("width", "1440");
        await expect(lightbox.getByText(marker)).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const id = await canvas.getAttribute("data-image-id");
        const resize = page.getByRole("slider", { name: "Inspector width" });
        await resize.press("End");
        await expect(canvas).not.toHaveAttribute("data-image-id", id!);
        const wider = await trigger.evaluate((button) => button.clientWidth);
        expect(wider).toBeGreaterThan(displayWidth);
        await expect(canvas).toHaveAttribute("width", String(Math.ceil(wider / 32) * 32));
      }
      if (variant === "original-only fallback") {
        await Promise.all(
          page.workers().map((worker) =>
            worker.evaluate(() => {
              const decode = self.createImageBitmap.bind(self);
              self.createImageBitmap = ((
                source: ImageBitmapSource,
                options?: ImageBitmapOptions,
              ) => {
                if (!options?.resizeWidth)
                  return Promise.reject(new DOMException("Original decode failed"));
                return decode(source, options);
              }) as typeof createImageBitmap;
            }),
          ),
        );
        await trigger.click();
        const lightbox = page.getByRole("dialog", { name: "Step screenshot" });
        await expect(
          lightbox.getByRole("img", { name: "Step screenshot at original size" }),
        ).toBeVisible();
        await expect(lightbox.getByText(marker, { exact: true })).toBeVisible();
      }
    } else if (variant === "garbage") {
      await expect(inspector.getByText("Screenshot unavailable")).toBeVisible();
      await expect(inspector.getByText(marker)).toHaveCount(0);
      await expect(trigger).toHaveCount(0);
    } else {
      await expect(inspector.getByText(marker, { exact: true })).toBeVisible();
      await expect(thumbnail.getByLabel("Screenshot unavailable")).toBeVisible();
      if (!webp) {
        await expect(trigger.locator("img")).toHaveAttribute("data-image-size", "full");
        if (variant === "truncated PNG") {
          await page.screenshot({ path: join(screenshotDir, "screenshot-truncated-1440.png") });
        }
        await trigger.click();
        const lightbox = page.getByRole("dialog", { name: "Step screenshot" });
        await expect(lightbox.locator("img")).toBeVisible();
        await expect(lightbox.getByText(marker, { exact: true })).toBeVisible();
      }
    }
    offline();
  });
}
