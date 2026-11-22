import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect as browserExpect, chromium } from "@playwright/test";
import { expect, test } from "vitest";

const perf = process.env.MYCO_VIEWER_PERF_DIR;
const fixture = perf && join(perf, "perf-1000");
const html = new URL("../dist/myco-viewer.html", import.meta.url);

test.skipIf(!fixture || !existsSync(join(fixture, "trace.jsonl")))(
  "Why renders a window of a 1,000-step run and keeps Inspector, playhead, and hash in sync",
  async () => {
    if (!fixture) throw new Error("Missing generated run");
    const browser = await chromium.launch({ executablePath: process.env.MYCO_VIEWER_CHROMIUM });
    try {
      const page = await browser.newPage({ offline: true, viewport: { width: 1440, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(html.href);
      await page.locator("input[webkitdirectory]").first().setInputFiles(fixture);
      await browserExpect(page.getByRole("tab", { name: "3 Proof" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.keyboard.press("2");
      const list = page.getByRole("listbox", { name: "Run steps" });
      const rows = list.getByRole("option");
      await browserExpect(rows.first()).toHaveAttribute("aria-setsize", "1000");
      expect(await rows.count()).toBeLessThan(50);
      await browserExpect(list).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await browserExpect(list.getByRole("option", { selected: true })).toHaveAttribute(
        "id",
        "step-row-0",
      );
      await browserExpect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
        "aria-valuenow",
        "0",
      );
      await page.keyboard.press("End");
      await browserExpect(list.getByRole("option", { selected: true })).toHaveAttribute(
        "id",
        "step-row-999",
      );
      expect(new URL(page.url()).hash).toContain("step=999");
      await browserExpect(page.getByRole("tab", { name: "Detail" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.getByRole("tab", { name: "Raw" }).click();
      await browserExpect(page.getByRole("tab", { name: "Raw" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await browserExpect(page.locator("[data-json]").first()).toContainText('"type"');
      await page.getByRole("tab", { name: "Detail" }).click();
      await browserExpect(page.getByRole("heading", { name: "Action", exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
  30_000,
);
