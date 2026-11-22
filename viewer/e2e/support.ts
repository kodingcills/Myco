import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

export const html = new URL("../dist/myco-viewer.html", import.meta.url);
export const screenshotDir = fileURLToPath(new URL("../screenshots/", import.meta.url));

const real = "../../docs/research/experiments/m1-013-session1";
const foundry = "../../foundry/viewer-fixtures";
export const runs = [
  ["normal", `${real}/normal-711e16c1`, "Verified"],
  ["refuted-autocorrect", `${real}/refuted-autocorrect-d7ad45bf`, "Failed"],
  ["kill", `${real}/kill-87ee5b14`, "Unknown"],
  ["verified", `${foundry}/verified`, "Verified"],
  ["recovered", `${foundry}/recovered`, "Recovered"],
  ["false-success", `${foundry}/false-success`, "Failed"],
  ["unknown", `${foundry}/unknown`, "Unknown"],
].map(([name, folder, verdict]) => ({
  name: name!,
  folder: fileURLToPath(new URL(folder!, import.meta.url)),
  verdict: verdict!,
}));

export function checkOffline(page: Page) {
  const diagnostics: string[] = [];
  page.context().on("request", (request) => {
    const url = request.url();
    // The document and inline workers use local file/blob URLs.
    if (url !== html.href && !url.startsWith("blob:") && !url.startsWith("data:")) {
      diagnostics.push(url);
    }
  });
  page.on("pageerror", (error) => diagnostics.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(message.text());
  });
  return () => expect(diagnostics).toEqual([]);
}

export async function boot(page: Page) {
  await page.goto(html.href);
  await expect(page.getByRole("heading", { name: "Open a Myco run" })).toBeVisible();
}

export async function waitForRun(page: Page, verdict: string) {
  await expect(page.locator("[data-run-view]")).toHaveAttribute("data-indexed", "true");
  await expect(page.locator("[data-verdict-bar]")).toHaveAttribute("data-verdict", verdict);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
}

export async function openFolder(page: Page, folder: string) {
  await page.locator("input[webkitdirectory]").first().setInputFiles(folder);
}

export async function zipUpload(folder: string, name: string) {
  const { zipSync } = await import("fflate");
  const files = ["result.json", "trace.jsonl"];
  const entries = await Promise.all(
    files.map(async (file) => [file, await readFile(join(folder, file))] as const),
  );
  return {
    name: `${name}.mycotrace`,
    mimeType: "application/zip",
    buffer: Buffer.from(zipSync(Object.fromEntries(entries))),
  };
}
