// Time from drop to the final Verdict Bar (data-verdict-final="true") plus two animation frames.
// Fresh page per load, offline context, files staged outside the timer, one warmup discarded.
// Usage (from viewer/): node scripts/final-verdict-bench.mjs <myco-viewer.html> <run dir> <pair|folder> [N]
//   pair   = result.json + trace.jsonl only (no manifest, no ledger)
//   folder = every file in the run folder, so manifest digests are checked too
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const [htmlArg, dirArg, mode = "pair", nArg = "20"] = process.argv.slice(2);
const html = resolve(htmlArg);
const dir = resolve(dirArg);
const N = Number(nArg);
const browser = await chromium.launch();
const context = await browser.newContext({ offline: true, viewport: { width: 1440, height: 900 } });
const samples = [];
for (let i = 0; i <= N; i++) {
  const page = await context.newPage();
  await page.goto(`file://${html}`);
  await page.waitForSelector("[data-app]");
  await page.evaluate((folder) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "bench-files";
    if (folder) input.webkitdirectory = true;
    input.hidden = true;
    document.body.append(input);
  }, mode === "folder");
  if (mode === "folder") await page.locator("#bench-files").setInputFiles(dir);
  else
    await page
      .locator("#bench-files")
      .setInputFiles(["result.json", "trace.jsonl"].map((n) => join(dir, n)));
  const ms = await page.evaluate(async () => {
    const input = document.querySelector("#bench-files");
    const dt = new DataTransfer();
    const files = [...input.files];
    for (const f of files) dt.items.add(f);
    input.remove();
    const done = new Promise((resolve) => {
      const check = () => {
        if (document.querySelector('[data-verdict-bar][data-verdict-final="true"]')) {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              performance.mark("end");
              resolve();
            }),
          );
          return true;
        }
        return false;
      };
      const obs = new MutationObserver(() => {
        if (check()) obs.disconnect();
      });
      obs.observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    performance.mark("drop");
    // Folder files keep webkitRelativePath, as they do from the folder picker.
    document
      .querySelector("[data-app]")
      .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    await done;
    return performance.measure("v", "drop", "end").duration;
  });
  const verdict = await page.locator("[data-verdict-bar]").getAttribute("data-verdict");
  await page.close();
  if (i > 0) samples.push(ms);
  if (i === 1) process.stderr.write(`verdict=${verdict}\n`);
}
samples.sort((a, b) => a - b);
const r = (v) => Number(v.toFixed(1));
const n = samples.length;
const median = (samples[Math.floor((n - 1) / 2)] + samples[Math.floor(n / 2)]) / 2;
const report = {
  html: html.split("/").pop(),
  dir: dir.split("/").pop(),
  mode,
  n,
  median: r(median),
  p95: r(samples[Math.ceil(0.95 * n) - 1]),
  max: r(samples[n - 1]),
  min: r(samples[0]),
  all: samples.map(r),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
await browser.close();
