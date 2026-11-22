// From viewer/: node scripts/screenshot-bench.mjs <myco-viewer.html> <run folder> [N]
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const [html, folder, sampleCount = "20"] = process.argv.slice(2);
assert(html && folder, "Pass the Viewer HTML and the generated screenshot folder");
const N = Number(sampleCount);
const phaseFilter = process.env.MYCO_SCREENSHOT_BENCH_PHASE;
const diagnostic = process.env.MYCO_SCREENSHOT_BENCH_DIAGNOSTIC;
const cycle = Number(process.env.MYCO_SCREENSHOT_BENCH_CYCLE ?? 0);
const revisit = Number(process.env.MYCO_SCREENSHOT_BENCH_REVISIT ?? 0);
const nativeDump = process.env.MYCO_SCREENSHOT_BENCH_NATIVE_DUMP;
const footprint =
  process.platform === "darwin" && process.env.MYCO_SCREENSHOT_BENCH_FOOTPRINT === "1";
assert(!phaseFilter || ["latency", "memory"].includes(phaseFilter));
assert(
  !diagnostic ||
    (phaseFilter === "memory" && ["control", "no-full", "no-thumbs"].includes(diagnostic)),
);
assert(cycle === 0 || (phaseFilter === "memory" && !diagnostic && cycle >= 2 && cycle < 700));
assert(revisit === 0 || (Number.isInteger(revisit) && revisit >= 2 && revisit < 1000));
assert(Number.isInteger(N) && N >= 15);

const run = promisify(execFile);
const errors = [];
const samples = { cold: [], cached: [], scrub: [] };
const inspector = "[data-screenshot-trigger] [data-image-size]";
const max = (rows, key) => Math.max(...rows.map((row) => row[key]));

function stats(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const n = sorted.length;
  const round = (value) => Number(value.toFixed(1));
  return n === 0
    ? { n }
    : {
        n,
        min: round(sorted[0]),
        median: round((sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2),
        p95: round(sorted[Math.ceil(n * 0.95) - 1]),
        max: round(sorted[n - 1]),
        all: sorted.map(round),
      };
}

function watchErrors(page) {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("crash", () => errors.push("Page crashed"));
}

async function open(context) {
  const page = await context.newPage();
  watchErrors(page);
  await page.goto(pathToFileURL(html).href);
  return page;
}

async function load(page) {
  await page.locator("input[webkitdirectory]").first().setInputFiles(folder, { timeout: 60_000 });
  await page.waitForSelector('[data-run-view][data-indexed="true"]', { timeout: 60_000 });
  const badge = page.locator('[data-verdict-bar][data-verdict-final="true"]');
  assert.equal(await badge.getAttribute("data-verdict"), "Verified");
  await page.keyboard.press("2");
  if (diagnostic !== "no-thumbs") {
    await page.waitForSelector("#step-row-0 [data-step-thumb] img");
    await page.waitForSelector("[data-filmstrip] img");
  }
  assert.equal(
    await page.getByRole("slider", { name: "Playhead" }).getAttribute("aria-valuemax"),
    "999",
  );
}

async function installTiming(page) {
  await page.evaluate((selector) => {
    const playhead = document.querySelector("[data-scrub-seek]");
    const imageId = (image) => image?.dataset.imageId ?? image?.src;
    const selected = () => playhead.getAttribute("aria-valuetext");
    let next;
    const arm = (type) => {
      const prior = selected();
      const priorImage = imageId(document.querySelector(selector));
      let resolve;
      let reject;
      const done = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // A timeout can elapse before Playwright retrieves the promise.
      void done.catch(() => {});
      next = { type, prior, priorImage, resolve, reject, done };
    };
    function begin(event) {
      if (
        event.type !== next?.type ||
        (event.type === "keydown" && !/^(j|k|Home)$/i.test(event.key))
      )
        return;
      const measurement = next;
      measurement.type = "";
      performance.clearMarks();
      performance.clearMeasures();
      performance.mark("select");
      const timer = setTimeout(() => {
        cancelAnimationFrame(frame);
        measurement.reject(
          new Error(`Screenshot did not paint from ${measurement.prior}; selection=${selected()}`),
        );
      }, 5000);
      const decoded = new Map();
      let frame;
      let firstFrame = true;
      let immediate = false;
      let preview = null;
      function check() {
        if (selected() !== measurement.prior) {
          const image = document.querySelector(selector);
          if (image && imageId(image) !== measurement.priorImage) {
            const canvas = image instanceof HTMLCanvasElement;
            const id = imageId(image);
            const kind = image.dataset.imageSize;
            if (!canvas && !decoded.has(id)) {
              decoded.set(id, false);
              void image.decode().then(
                () => decoded.set(id, true),
                () => decoded.delete(id),
              );
            }
            const rect = image.getBoundingClientRect();
            const visible =
              rect.width > 0 &&
              rect.height > 0 &&
              rect.top < innerHeight &&
              rect.bottom > 0 &&
              getComputedStyle(image).visibility === "visible";
            if (visible && (canvas || image.currentSrc === id)) {
              if (
                kind === "preview" &&
                image.complete &&
                image.naturalWidth === 96 &&
                preview === null
              ) {
                performance.mark("preview");
                preview = performance.measure("preview", "select", "preview").duration;
              }
              if (
                kind === "full" &&
                (canvas
                  ? image.dataset.imageWidth === "1440" && image.dataset.imageHeight === "900"
                  : decoded.get(id) && image.naturalWidth === 1440 && image.naturalHeight === 900)
              ) {
                clearTimeout(timer);
                // The next rAF follows a paint opportunity for the decoded and visible image.
                requestAnimationFrame(() => {
                  performance.mark("full");
                  const full = performance.measure("full", "select", "full").duration;
                  measurement.resolve({ full, preview, immediate, step: selected() });
                });
                return;
              }
            }
            // A decoded thumbnail can be present in the first rAF even though decode()'s
            // promise reaction is delivered after this callback.
            if (firstFrame)
              immediate =
                visible && kind === "preview" && image.complete && image.naturalWidth === 96;
          }
          firstFrame = false;
        }
        frame = requestAnimationFrame(check);
      }
      frame = requestAnimationFrame(check);
    }
    addEventListener("keydown", begin, { capture: true });
    addEventListener("pointermove", begin, { capture: true });
    window.screenshotBench = { arm, result: () => next.done };
  }, inspector);
}

async function timed(page, type, action) {
  await page.evaluate((event) => window.screenshotBench.arm(event), type);
  await action();
  return page.evaluate(() => window.screenshotBench.result());
}

async function heldDrag(page, callback) {
  const bounds = await page.locator("[data-scrub-seek]").boundingBox();
  const x = (fraction) => bounds.x + fraction * bounds.width;
  const y = bounds.y + 32;
  await page.mouse.move(x(0.001), y);
  await page.mouse.down();
  try {
    await callback((fraction) => page.mouse.move(x(fraction), y));
  } finally {
    await page.mouse.up();
  }
}

async function waitFull(page) {
  const full = page.locator(`${inspector}[data-image-size="full"]`);
  await full.waitFor({ state: "visible" });
  return full.evaluate(async (image) => {
    if (image instanceof HTMLCanvasElement) {
      if (image.dataset.imageWidth !== "1440" || image.dataset.imageHeight !== "900") {
        throw new Error("Expected a full-size source bitmap");
      }
      return image.dataset.imageId;
    }
    await image.decode();
    if (image.naturalWidth !== 1440 || image.naturalHeight !== 900) {
      throw new Error("Expected a full-size screenshot");
    }
    return image.currentSrc;
  });
}

async function measureLatency(context) {
  for (let i = 0; i <= N; i++) {
    const page = await open(context);
    await load(page);
    await installTiming(page);
    const cold = await timed(page, "keydown", () => page.keyboard.press("j"));
    assert.match(cold.step, /^#0+$/);
    await timed(page, "keydown", () => page.keyboard.press("j"));
    if (revisit) {
      for (let distance = 1; distance < revisit; distance++) {
        await page.keyboard.press("j");
        await waitFull(page);
      }
      await page.locator("[data-scrub-seek]").focus();
    }
    const cached = await timed(page, "keydown", () => page.keyboard.press(revisit ? "Home" : "k"));
    assert.equal(cached.step, cold.step);
    if (i) {
      samples.cold.push(cold);
      samples.cached.push(cached);
    }
    await page.close();
  }
  const page = await open(context);
  await load(page);
  await installTiming(page);
  await heldDrag(page, async (move) => {
    await waitFull(page);
    const seen = new Set();
    for (let i = 0; i <= N; i++) {
      const sample = await timed(page, "pointermove", () => move(((i + 1) / (N + 1)) * 0.995));
      assert(!seen.has(sample.step));
      seen.add(sample.step);
      if (i) samples.scrub.push(sample);
    }
  });
  await page.close();
}

async function trackImages(page) {
  await page.addInitScript(() => {
    const bitmaps = new WeakSet();
    const close = ImageBitmap.prototype.close;
    let fullBitmaps = 0;
    ImageBitmap.prototype.close = function () {
      if (bitmaps.delete(this)) fullBitmaps--;
      return close.call(this);
    };
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          if (data.bitmap instanceof ImageBitmap) {
            bitmaps.add(data.bitmap);
            fullBitmaps++;
          }
        });
      }
    };
    const urls = new Map();
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = function (blob) {
      const url = create.call(this, blob);
      if (blob.type === "image/png" || blob.type === "image/webp") urls.set(url, blob.type);
      return url;
    };
    URL.revokeObjectURL = function (url) {
      urls.delete(url);
      return revoke.call(this, url);
    };
    window.screenshotBenchImages = () => ({
      fullBitmaps,
      thumbnails: [...urls.values()].filter((type) => type === "image/webp").length,
      fullUrls: [...urls.values()].filter((type) => type === "image/png").length,
    });
  });
}

async function instrumentBitmaps(worker) {
  await worker.evaluate(() => {
    let count = 0;
    let peak = 0;
    const tracked = new WeakSet();
    const create = self.createImageBitmap;
    const close = ImageBitmap.prototype.close;
    self.createImageBitmap = async (...args) => {
      const image = await create.apply(self, args);
      tracked.add(image);
      peak = Math.max(peak, ++count);
      return image;
    };
    ImageBitmap.prototype.close = function () {
      if (tracked.delete(this)) count--;
      return close.call(this);
    };
    const post = self.postMessage;
    self.postMessage = function (data, options) {
      if (data.bitmap && options?.transfer?.includes(data.bitmap) && tracked.delete(data.bitmap))
        count--;
      return post.call(this, data, options);
    };
    self.screenshotBenchBitmaps = () => ({ workerBitmaps: count, workerBitmapPeak: peak });
  });
}

async function measureMemory(context, root) {
  const page = await context.newPage();
  watchErrors(page);
  await trackImages(page);
  if (diagnostic?.startsWith("no-")) {
    await page.addInitScript((condition) => {
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (data, ...rest) {
        if (typeof data?.full === "boolean" && data.full === (condition === "no-full")) {
          queueMicrotask(() =>
            this.dispatchEvent(new MessageEvent("message", { data: { id: data.id } })),
          );
        } else {
          post.call(this, data, ...rest);
        }
      };
    }, diagnostic);
  }
  await page.goto(pathToFileURL(html).href);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const rows = [];
  const checkpoints = {};
  let phase = "open";
  let stepCount = 0;
  let worker;
  async function sample(checkpoint = false) {
    const { processInfo } = await root.send("SystemInfo.getProcessInfo");
    const { stdout } = await run("ps", [
      "-o",
      "pid=,rss=",
      "-p",
      processInfo.map(({ id }) => id).join(","),
    ]);
    const rss = new Map(
      stdout
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number)),
    );
    const types = {};
    for (const { type, id } of processInfo) {
      types[type] = (types[type] ?? 0) + (rss.get(id) ?? 0) * 1024;
    }
    const { metrics } = await cdp.send("Performance.getMetrics");
    const dom = await cdp.send("Memory.getDOMCounters");
    const images = await page.evaluate(() => window.screenshotBenchImages());
    const bitmaps = worker ? await worker.evaluate(() => self.screenshotBenchBitmaps()) : {};
    const row = {
      phase,
      rss: Object.values(types).reduce((a, b) => a + b, 0),
      types,
      heap: metrics.find(({ name }) => name === "JSHeapUsedSize").value,
      ...dom,
      ...images,
      ...bitmaps,
    };
    if (footprint && (checkpoint || rows.length % 3 === 0)) {
      // phys_footprint of every process this harness launched (browser, renderer, GPU, network).
      let rendererFootprint = 0;
      let totalFootprint = 0;
      for (const { type, id } of processInfo) {
        const { stdout } = await run("footprint", ["--noCategories", "-f", "bytes", String(id)]);
        const bytes = stdout.match(/^\s*phys_footprint:\s+(\d+) B/m)?.[1];
        assert(bytes, stdout);
        totalFootprint += Number(bytes);
        if (type === "renderer") rendererFootprint += Number(bytes);
      }
      row.rendererFootprint = rendererFootprint;
      row.totalFootprint = totalFootprint;
      row.step = stepCount;
    }
    rows.push(row);
    return row;
  }
  checkpoints.open = await sample(true);
  let stopped = false;
  phase = "loading";
  const sampler = (async () => {
    while (!stopped) {
      await sample();
      await delay(400);
    }
  })();
  void sampler.catch(() => {});
  try {
    await load(page);
    if (diagnostic !== "no-thumbs") {
      await page.waitForFunction(() => {
        const thumbs = [
          ...document.querySelectorAll("[data-step-thumb], [data-filmstrip] [data-film-thumb]"),
        ];
        return thumbs.length > 0 && thumbs.every((thumb) => thumb.querySelector("img")?.complete);
      });
    }
    await delay(500);
    worker = page.workers()[0];
    assert(worker, "Image worker unavailable for counting bitmaps");
    await instrumentBitmaps(worker);
    phase = "loaded";
    checkpoints.loaded = await sample(true);
    phase = "browse";
    const seen = new Set();
    const steps = cycle ? 700 : diagnostic ? 160 : 320;
    for (let i = 0; i < steps; i++) {
      stepCount = i;
      const start = performance.now();
      if (cycle && i && i % cycle === 0) {
        // Return to the start so the same cycle steps are decoded again instead of new ones.
        await page.locator("[data-scrub-seek]").focus();
        await page.keyboard.press("Home");
        await waitFull(page);
      }
      await page.keyboard.press("j");
      if (diagnostic !== "no-full") {
        const id = await waitFull(page);
        if (!cycle) {
          assert(!seen.has(id), `Step ${i} did not display a distinct full image`);
          seen.add(id);
        }
      }
      if (diagnostic) await delay(Math.max(0, 75 - (performance.now() - start)));
    }
    const playhead = page.getByRole("slider", { name: "Playhead" });
    if (!cycle) {
      assert.equal(await playhead.getAttribute("aria-valuenow"), String(steps - 1));
    }
    if (!diagnostic && !cycle) {
      phase = "scrub";
      await heldDrag(page, async (move) => {
        for (let i = 0; i <= 180; i++) await move(0.001 + (i / 180) * 0.998);
      });
      assert(Number(await playhead.getAttribute("aria-valuenow")) >= 998);
      await waitFull(page);
    }
    phase = "settled";
    await delay(2000);
    checkpoints.settled = await sample(true);
    if (nativeDump) {
      // Native evidence for the renderer PIDs this harness launched, labelled by checkpoint.
      const { processInfo } = await root.send("SystemInfo.getProcessInfo");
      for (const { type, id } of processInfo.filter(({ type }) => type === "renderer")) {
        const vm = await run("vmmap", ["-summary", String(id)], { maxBuffer: 1 << 26 });
        const fp = await run("footprint", ["-f", "bytes", String(id)], { maxBuffer: 1 << 26 });
        await writeFile(`${nativeDump}.${type}-${id}.vmmap.txt`, vm.stdout);
        await writeFile(`${nativeDump}.${type}-${id}.footprint.txt`, fp.stdout);
      }
    }
  } finally {
    stopped = true;
    await sampler;
    await page.close();
  }
  return {
    n: rows.length,
    peakRSS: rows.reduce((a, b) => (a.rss >= b.rss ? a : b)),
    peakRendererFootprint: footprint
      ? max(
          rows.filter((row) => "rendererFootprint" in row),
          "rendererFootprint",
        )
      : undefined,
    peakTotalFootprint: footprint
      ? max(
          rows.filter((row) => "totalFootprint" in row),
          "totalFootprint",
        )
      : undefined,
    footprintByStep: footprint
      ? rows
          .filter((row) => row.phase === "browse" && "rendererFootprint" in row)
          .map((row) => [row.step, row.rendererFootprint])
      : undefined,
    peakFullBitmaps: max(rows, "fullBitmaps"),
    peakHeap: max(rows, "heap"),
    peakDOMNodes: max(rows, "nodes"),
    peakThumbnailURLs: max(rows, "thumbnails"),
    peakFullURLs: max(rows, "fullUrls"),
    peakWorkerBitmaps: max(
      rows.filter((row) => "workerBitmapPeak" in row),
      "workerBitmapPeak",
    ),
    checkpoints,
    phasePeaks: Object.fromEntries(
      [...new Set(rows.map((row) => row.phase))].map((name) => [
        name,
        max(
          rows.filter((row) => row.phase === name),
          "rss",
        ),
      ]),
    ),
  };
}

async function runPhase(measure) {
  const browser = await chromium.launch();
  try {
    const root = await browser.newBrowserCDPSession();
    const { processInfo } = await root.send("SystemInfo.getProcessInfo");
    const browserPid = processInfo.find(({ type }) => type === "browser").id;
    const { stdout } = await run("ps", ["-ww", "-o", "command=", "-p", String(browserPid)]);
    const context = await browser.newContext({
      offline: true,
      viewport: { width: 1440, height: 900 },
    });
    await context.route(/^https?:/, (route) => {
      errors.push(`Unexpected network request: ${route.request().url()}`);
      return route.abort();
    });
    const result = await measure(context, root);
    return { result, browser: browser.version(), commandLine: stdout.trim() };
  } finally {
    await browser.close();
  }
}

const latencyRun = phaseFilter !== "memory" ? await runPhase(measureLatency) : undefined;
// Fresh browser so the latency workload cannot warm the memory run's allocators.
const memoryRun = phaseFilter !== "latency" ? await runPhase(measureMemory) : undefined;
assert.deepEqual(errors, []);
const browserInfo = memoryRun ?? latencyRun;
const latency =
  latencyRun &&
  Object.fromEntries(
    Object.entries(samples).map(([key, values]) => [
      key,
      {
        full: stats(values.map(({ full }) => full)),
        preview: stats(values.flatMap(({ preview }) => (preview === null ? [] : [preview]))),
        previewFirstFrame: values.filter(({ immediate }) => immediate).length,
      },
    ]),
  );
process.stdout.write(
  `${JSON.stringify(
    {
      verdict: "Verified",
      browser: browserInfo.browser,
      commandLine: browserInfo.commandLine,
      diagnostic,
      cycle: cycle || undefined,
      revisit: revisit || undefined,
      latency,
      memory: memoryRun?.result,
    },
    null,
    2,
  )}\n`,
);
