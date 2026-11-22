import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import type { ResultRecord } from "../src/data/types.ts";
import { boot, checkOffline, screenshotDir, waitForRun } from "./support.ts";

test("a viewer-only screenshot hands off from loading to preview to full image", async ({
  page,
}) => {
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
            const blob: unknown = event.data.blob;
            if (!(blob instanceof Blob) || released.has(blob.type) || replayed.has(event)) return;
            event.stopImmediatePropagation();
            const rest = queued.get(blob.type) ?? [];
            rest.push(() => {
              const message = new MessageEvent("message", { data: event.data });
              replayed.add(message);
              this.dispatchEvent(message);
            });
            queued.set(blob.type, rest);
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
    ],
  };
  const trace = [
    { type: "run-start", runId: result.runId, taskId: result.taskId, startedAt: result.startedAt },
    { type: "action", step: 0, timestamp: result.startedAt, action: result.steps[0]!.action },
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
        }),
      ),
    });
  await waitForRun(page, "Unknown");
  await page.keyboard.press("2");
  await page.keyboard.press("j");

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const screenshot = inspector.getByRole("button", { name: "Enlarge screenshot" });
  const image = screenshot.locator("img");
  const sized = () =>
    image.evaluate((element) => (element instanceof HTMLImageElement ? element.naturalWidth : 0));
  const release = (type: string) =>
    page.evaluate((detail) => {
      document.dispatchEvent(new CustomEvent("release-test-image", { detail }));
    }, type);

  await expect(inspector.getByText("Loading screenshot", { exact: true })).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Open source artifacts/viewer-test-meta.json#/step" }),
  ).toBeVisible();
  await page.screenshot({
    path: join(screenshotDir, "viewer-test-screenshot-loading-1440.png"),
    animations: "disabled",
  });
  await release("image/webp");
  await expect(image).toHaveAttribute("data-image-size", "preview");
  await expect.poll(sized).toBe(96);
  await page.screenshot({
    path: join(screenshotDir, "viewer-test-screenshot-preview-1440.png"),
    animations: "disabled",
  });

  await release("image/png");
  await expect(image).toHaveAttribute("data-image-size", "full");
  await expect.poll(sized).toBe(width);
  await screenshot.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Step screenshot" })).toBeVisible();
  await page.screenshot({
    path: join(screenshotDir, "viewer-test-screenshot-full-1440.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
    "aria-valuetext",
    "#00",
  );
  offline();
});
