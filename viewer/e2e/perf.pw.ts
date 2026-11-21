import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import { boot, checkOffline, html, runs, waitForRun } from "./support.ts";

const perfDir = process.env.MYCO_VIEWER_PERF_DIR;
const sampleCount = 15;
const scrubMoves = 20;
type ScrubSample = { update: number; frame: number; commit: number };
type BenchmarkWindow = Window & {
  scrubSample?: Promise<ScrubSample>;
  keyboardSample?: Promise<number>;
};

function summarize(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const n = sorted.length;
  const round = (value: number) => Number(value.toFixed(2));
  const middle = (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2;
  return {
    n,
    min: round(sorted[0]!),
    median: round(middle),
    p95: round(sorted[Math.ceil(0.95 * n) - 1]!),
    max: round(sorted[n - 1]!),
  };
}

async function dropRun(page: Page, folder: string, hasSteps: boolean) {
  // Stage the files outside the app. Picker automation and file transfer stay outside the timer.
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    input.id = "benchmark-files";
    document.body.append(input);
  });
  await page
    .locator("#benchmark-files")
    .setInputFiles(["result.json", "trace.jsonl"].map((name) => join(folder, name)));

  return page.evaluate(async (hasSteps) => {
    const input = document.querySelector<HTMLInputElement>("#benchmark-files")!;
    const dataTransfer = new DataTransfer();
    for (const file of input.files!) dataTransfer.items.add(file);
    input.remove();
    const pending = new Map<string, Promise<void>>();
    // A second rAF bounds the first render opportunity after the committed DOM.
    const markPaint = (name: string) => {
      if (pending.has(name)) return;
      pending.set(
        name,
        new Promise<void>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              performance.mark(name);
              resolve();
            }),
          );
        }),
      );
    };
    const indexed = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (document.querySelector("[data-verdict-bar][data-verdict]") && !pending.has("verdict")) {
          markPaint("verdict");
          // Expose Why at the earliest opportunity after the initial Proof paint.
          void pending.get("verdict")!.then(() => {
            document.querySelector<HTMLButtonElement>('[aria-keyshortcuts="2"]')!.click();
          });
        }
        const rows = document.querySelector("[data-why-panel] [data-step-row]");
        if (rows) markPaint("firstRows");
        if (
          (!hasSteps || rows) &&
          document.querySelector('[data-indexed="true"] [data-step-options]')
        ) {
          markPaint("indexedAndUsable");
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    });

    performance.mark("drop");
    document
      .querySelector("[data-app]")!
      .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    await indexed;
    await Promise.all(pending.values());
    return Object.fromEntries(
      [...pending.keys()].map((name) => [name, performance.measure(name, "drop", name).duration]),
    );
  }, hasSteps);
}

async function measureKeyboard(page: Page) {
  await page.evaluate(() => {
    (window as BenchmarkWindow).keyboardSample = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("J did not select the first step")), 2000);
      window.addEventListener(
        "keydown",
        () => {
          performance.mark("key-down");
          const observer = new MutationObserver(() => {
            const slider = document.querySelector("[data-scrub-seek]");
            const inspector = document.querySelector("[data-detail-heading] h2");
            const label = slider?.getAttribute("aria-valuetext");
            if (!label || label !== inspector?.textContent) return;
            observer.disconnect();
            requestAnimationFrame(() => {
              clearTimeout(timeout);
              resolve(performance.measure("key-response", "key-down").duration);
            });
          });
          observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        },
        { capture: true, once: true },
      );
    });
  });
  await page.keyboard.press("j");
  return page.evaluate(() => (window as BenchmarkWindow).keyboardSample!);
}

async function measureScrub(page: Page, lastStep: number) {
  const playhead = page.getByRole("slider", { name: "Playhead" });
  const box = (await playhead.boundingBox())!;
  const y = box.y + box.height / 2;
  const start = box.x + box.width * 0.02;
  const end = box.x + box.width * 0.999;
  const hit = await page.evaluate(
    ({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return {
        seek: target?.hasAttribute("data-scrub-seek"),
        target: target?.outerHTML.slice(0, 250),
        x,
        y,
      };
    },
    { x: start, y },
  );
  expect(hit, JSON.stringify(hit)).toMatchObject({ seek: true });
  await page.mouse.move(start, y);
  await page.mouse.down();
  const updates: number[] = [];
  const frames: number[] = [];
  const inspector: number[] = [];
  for (let i = 1; i <= scrubMoves; i++) {
    await page.evaluate(async () => {
      const slider = document.querySelector("[data-scrub-seek]")!;
      const previous = slider.getAttribute("aria-valuenow");
      let previousFrame = 0;
      let raf = 0;
      function tick(time: number) {
        previousFrame = time;
        raf = requestAnimationFrame(tick);
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame((time) => {
          tick(time);
          resolve();
        });
      });
      (window as BenchmarkWindow).scrubSample = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                JSON.stringify({
                  previous,
                  current: slider.getAttribute("aria-valuenow"),
                  label: slider.getAttribute("aria-valuetext"),
                  inspector: document.querySelector("[data-detail-heading] h2")?.textContent,
                  input: performance.getEntriesByName("scrub-input").at(-1)?.startTime,
                }),
              ),
            ),
          2000,
        );
        slider.addEventListener(
          "pointermove",
          () => {
            performance.mark("scrub-input");
            const observer = new MutationObserver(() => {
              if (slider.getAttribute("aria-valuenow") === previous) return;
              const label = slider.getAttribute("aria-valuetext");
              if (document.querySelector("[data-detail-heading] h2")?.textContent !== label) return;
              observer.disconnect();
              performance.mark("scrub-commit");
              const commit = performance.measure(
                "scrub-commit",
                "scrub-input",
                "scrub-commit",
              ).duration;
              cancelAnimationFrame(raf);
              const before = previousFrame;
              requestAnimationFrame((time) => {
                performance.mark("scrub-render");
                const update = performance.measure(
                  "scrub-render",
                  "scrub-input",
                  "scrub-render",
                ).duration;
                clearTimeout(timeout);
                resolve({ update, frame: time - before, commit });
              });
            });
            observer.observe(document.body, { subtree: true, childList: true, attributes: true });
          },
          { once: true, capture: true },
        );
      });
    });
    await page.mouse.move(start + ((end - start) * i) / scrubMoves, y);
    const sample = await page.evaluate(() => (window as BenchmarkWindow).scrubSample!);
    updates.push(sample.update);
    frames.push(sample.frame);
    inspector.push(sample.commit);
  }
  await page.mouse.up();
  const finalIndex = Number(await playhead.getAttribute("aria-valuenow"));
  expect(finalIndex).toBeGreaterThanOrEqual(Math.floor(lastStep * 0.99));
  await expect(page.getByRole("option", { selected: true })).toHaveAttribute(
    "id",
    `step-row-${finalIndex}`,
  );
  return { updates, frames, inspector };
}

test("measure GUI spec §8 on real and generated runs", async ({ browser }) => {
  test.skip(!perfDir, "Set MYCO_VIEWER_PERF_DIR to enable benchmarking");
  test.setTimeout(240_000);
  const cases = [
    ...runs.slice(0, 3).map((run) => ({ ...run, steps: undefined })),
    ...[1000, 10000].map((steps) => ({
      name: `perf-${steps}`,
      folder: join(perfDir!, `perf-${steps}`),
      verdict: "Verified",
      steps,
    })),
  ];
  const results = [];
  for (const run of cases) {
    process.stdout.write(`Measuring ${run.name}\n`);
    const loads: Record<string, number[]> = {};
    const updates: number[] = [];
    const frames: number[] = [];
    const inspector: number[] = [];
    for (let i = 0; i <= sampleCount; i++) {
      const page = await browser.newPage({
        offline: true,
        viewport: { width: 1440, height: 900 },
        timezoneId: "America/New_York",
        reducedMotion: "reduce",
      });
      try {
        const offline = checkOffline(page);
        await boot(page);
        const metrics = await dropRun(page, run.folder, run.name !== "kill");
        const paint = await page.evaluate(
          () => performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
        );
        await waitForRun(page, run.verdict);
        expect(paint).toBeDefined();
        const keyResponse = run.name === "kill" ? undefined : await measureKeyboard(page);
        if (i > 0) {
          for (const [key, value] of Object.entries({
            ...metrics,
            openPaint: paint!,
            ...(keyResponse !== undefined && { keyResponse }),
          })) {
            loads[key] ??= [];
            loads[key].push(value);
          }
        }
        if (run.steps !== undefined) {
          const visible = page.getByRole("option");
          await expect(visible.first()).toHaveAttribute("aria-setsize", String(run.steps));
          expect(await visible.count()).toBeLessThan(50);
          const scrub = await measureScrub(page, run.steps - 1);
          if (i > 0) {
            updates.push(...scrub.updates);
            frames.push(...scrub.frames);
            inspector.push(...scrub.inspector);
          }
        }
        offline();
      } finally {
        await page.close();
      }
    }
    results.push({
      run: run.name,
      ...Object.fromEntries(
        Object.entries(loads).map(([name, values]) => [name, summarize(values)]),
      ),
      ...(updates.length && {
        scrubUpdate: summarize(updates),
        scrubFrame: summarize(frames),
        inspectorCommit: summarize(inspector),
      }),
    });
  }

  const markup = await readFile(html, "utf8");
  const collect = (tag: string) =>
    [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))]
      .map((match) => match[1])
      .join("\n");
  const js = collect("script");
  const css = collect("style");
  expect(js.length).toBeGreaterThan(0);
  expect(css.length).toBeGreaterThan(0);
  const encodedFont = /data:font\/woff2;base64,[\w+/=]+/g;
  const fonts = [...css.matchAll(encodedFont)].map(([url]) =>
    Buffer.from(url.split(",")[1]!, "base64"),
  );
  expect(fonts).toHaveLength(2);
  const bytes = (data: string | Buffer) => ({
    raw: Buffer.byteLength(data),
    gzip: gzipSync(data).length,
  });
  const report = {
    chromium: browser.version(),
    results,
    sizes: {
      js: bytes(js),
      css: bytes(css.replace(encodedFont, "")),
      cssWithFonts: bytes(css),
      fonts: fonts.map(bytes),
      html: (await stat(html)).size,
    },
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.MYCO_VIEWER_PERF_REPORT)
    await writeFile(process.env.MYCO_VIEWER_PERF_REPORT, json);
  else process.stdout.write(json);
});
