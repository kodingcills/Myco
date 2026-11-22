// Enforces gui-spec §8: "10,000 steps: Verdict <= 150 ms" and "Verdict visible after drop <= 150 ms".
// Always runs in the standard e2e suite. It generates the 1k and 10k perf runs itself unless
// MYCO_VIEWER_PERF_DIR already holds them.
//   MYCO_VIEWER_STRICT_BUDGET=1  -> 150 ms maximum for both sizes (the spec; use on a dev machine)
//   default (shared CI runners)  -> a drift guard, not the spec: the MEDIAN of N samples must stay under
//   a per-OS hard threshold and (when CI=true) within a tolerance of the recorded per-OS baseline, both
//   in perf-baseline.json and explained in viewer/PERF.md. A single slow sample cannot fail it.
//   MYCO_VIEWER_BUDGET_REPORT=<file>  -> append one JSON line of the measured samples per size.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { boot } from "./support.ts";

const strict = process.env.MYCO_VIEWER_STRICT_BUDGET === "1";
const samples = Number(process.env.MYCO_VIEWER_BUDGET_SAMPLES ?? 20);

type Thresholds = { baselineMedian: number | null; hardMedian: number };
type Baseline = {
  relativeTolerance: number;
  platforms: Record<string, Record<"1000" | "10000", Thresholds>>;
};
const baseline: Baseline = JSON.parse(
  readFileSync(new URL("./perf-baseline.json", import.meta.url), "utf8"),
);
// darwin = macos-latest, linux = ubuntu-latest. Any other platform uses the looser linux entry.
const thresholds = (steps: 1000 | 10000) =>
  (baseline.platforms[process.platform] ?? baseline.platforms.linux!)[`${steps}`]!;

function summarize(sorted: number[]) {
  const n = sorted.length;
  return {
    median: (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2,
    p95: sorted[Math.ceil(0.95 * n) - 1]!,
    max: sorted[n - 1]!,
  };
}

let generated: string | undefined;
function perfDir() {
  if (generated) return generated;
  const configured = process.env.MYCO_VIEWER_PERF_DIR;
  if (
    configured &&
    existsSync(join(configured, "perf-1000", "trace.jsonl")) &&
    existsSync(join(configured, "perf-10000", "trace.jsonl"))
  ) {
    generated = configured;
    return generated;
  }
  const dir = mkdtempSync(join(tmpdir(), "myco-viewer-verdict-budget-"));
  execFileSync("npx", ["tsx", "scripts/gen-viewer-fixtures.ts", "--perf", dir], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stdio: "ignore",
  });
  generated = dir;
  return generated;
}

for (const steps of [1000, 10000] as const) {
  test(`final verdict after drop stays within budget at ${steps} steps`, async ({ context }) => {
    test.setTimeout(180_000);
    const dir = join(perfDir(), `perf-${steps}`);
    const timings: number[] = [];
    for (let i = 0; i <= samples; i++) {
      const page = await context.newPage();
      try {
        await boot(page);
        await page.evaluate(() => {
          const input = document.createElement("input");
          input.type = "file";
          input.multiple = true;
          input.id = "budget-files";
          input.hidden = true;
          document.body.append(input);
        });
        // Staging the files stays outside the timer.
        await page
          .locator("#budget-files")
          .setInputFiles(["result.json", "trace.jsonl"].map((name) => join(dir, name)));
        const ms = await page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              const input = document.querySelector<HTMLInputElement>("#budget-files")!;
              const transfer = new DataTransfer();
              for (const file of input.files!) transfer.items.add(file);
              input.remove();
              const observer = new MutationObserver(() => {
                if (!document.querySelector('[data-verdict-bar][data-verdict-final="true"]'))
                  return;
                observer.disconnect();
                // The second animation frame bounds the first paint of the committed verdict.
                requestAnimationFrame(() =>
                  requestAnimationFrame(() =>
                    resolve(performance.measure("verdict", "drop").duration),
                  ),
                );
              });
              observer.observe(document.body, {
                subtree: true,
                childList: true,
                attributes: true,
              });
              performance.mark("drop");
              document.querySelector("[data-app]")!.dispatchEvent(
                new DragEvent("drop", {
                  bubbles: true,
                  cancelable: true,
                  dataTransfer: transfer,
                }),
              );
            }),
        );
        await expect(page.locator("[data-verdict-bar]")).toHaveAttribute(
          "data-verdict",
          "Verified",
        );
        if (i > 0) timings.push(ms);
      } finally {
        await page.close();
      }
    }
    timings.sort((a, b) => a - b);
    const { median, p95, max } = summarize(timings);
    const limits = thresholds(steps);
    test.info().annotations.push({
      type: "final verdict ms",
      description: `${steps} steps, N=${timings.length}: median ${median.toFixed(1)}, p95 ${p95.toFixed(1)}, max ${max.toFixed(1)}`,
    });
    const report = process.env.MYCO_VIEWER_BUDGET_REPORT;
    if (report) {
      appendFileSync(
        report,
        `${JSON.stringify({ platform: process.platform, steps, median, p95, max, samples: timings })}\n`,
      );
    }
    const all = `samples: ${timings.map((t) => t.toFixed(1))}`;
    if (strict) {
      // The spec limit, judged on the maximum.
      expect(max, `final verdict at ${steps} steps (spec 150 ms max). ${all}`).toBeLessThanOrEqual(
        150,
      );
      return;
    }
    expect(
      median,
      `final verdict median at ${steps} steps over the hard threshold ${limits.hardMedian} ms. ${all}`,
    ).toBeLessThanOrEqual(limits.hardMedian);
    if (process.env.CI && limits.baselineMedian !== null) {
      const allowed = limits.baselineMedian * (1 + baseline.relativeTolerance);
      expect(
        median,
        `final verdict median at ${steps} steps regressed more than ${baseline.relativeTolerance * 100}% over the ${process.platform} baseline ${limits.baselineMedian} ms (limit ${allowed.toFixed(1)}). ${all}`,
      ).toBeLessThanOrEqual(allowed);
    }
  });
}
