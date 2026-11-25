// Measures the final painted verdict after a drop using generated 1k and 10k traces.
// MYCO_VIEWER_STRICT_BUDGET=1 checks the GUI spec's 150 ms maximum for both sizes.
// CI checks the median against the runner limits documented in viewer/PERF.md.
// A CI budget miss is re-measured once with a fresh set of samples; the test fails only
// when both measurements miss. Both are logged (see "GitHub Actions calibration" in PERF.md).
// Local runs without the strict flag retain the existing smoke-test limits.
// MYCO_VIEWER_BUDGET_REPORT=<file>  -> append one JSON line of the measured samples per size
//                                      and attempt.
// MYCO_VIEWER_BUDGET_INJECT_MS=<ms> -> test-only: block the page's main thread for <ms> inside
//                                      the timed window of every drop, to prove the check
//                                      catches a regression. Never set in normal CI.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, test } from "@playwright/test";
import { boot } from "./support.ts";

const strict = process.env.MYCO_VIEWER_STRICT_BUDGET === "1";
const ci = process.env.CI === "true";
const samples = ci ? 20 : Number(process.env.MYCO_VIEWER_BUDGET_SAMPLES ?? 20);
const injectMs = Number(process.env.MYCO_VIEWER_BUDGET_INJECT_MS ?? 0);

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

// One warmup drop, then `samples` timed drops, each on a fresh page. Returns sorted timings.
async function measure(context: BrowserContext, dir: string) {
  const timings: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const page = await context.newPage();
    try {
      await boot(page);
      await page.evaluate((injectMs) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.id = "budget-files";
        input.hidden = true;
        document.body.append(input);
        if (injectMs > 0) {
          // Test-only regression: a capture listener runs before the app's drop handler.
          window.addEventListener(
            "drop",
            () => {
              const end = performance.now() + injectMs;
              while (performance.now() < end) {}
            },
            { capture: true },
          );
        }
      }, injectMs);
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
              if (!document.querySelector('[data-verdict-bar][data-verdict-final="true"]')) return;
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
      await expect(page.locator("[data-verdict-bar]")).toHaveAttribute("data-verdict", "Verified");
      if (i > 0) timings.push(ms);
    } finally {
      await page.close();
    }
  }
  return timings.sort((a, b) => a - b);
}

// The hosted-runner median checks. Returns one message per limit the median exceeds.
function ciMisses(steps: 1000 | 10000, timings: number[]) {
  const { median } = summarize(timings);
  const limits = thresholds(steps);
  const all = `samples: ${timings.map((t) => t.toFixed(1))}`;
  const misses: string[] = [];
  if (median > limits.hardMedian)
    misses.push(
      `final verdict median ${median.toFixed(1)} at ${steps} steps over the hard threshold ${limits.hardMedian} ms. ${all}`,
    );
  if (limits.baselineMedian !== null) {
    const allowed = limits.baselineMedian * (1 + baseline.relativeTolerance);
    if (median > allowed)
      misses.push(
        `final verdict median ${median.toFixed(1)} at ${steps} steps regressed more than ${baseline.relativeTolerance * 100}% over the ${process.platform} baseline ${limits.baselineMedian} ms (limit ${allowed.toFixed(1)}). ${all}`,
      );
  }
  return misses;
}

for (const steps of [1000, 10000] as const) {
  test(`final verdict after drop stays within budget at ${steps} steps`, async ({ context }) => {
    test.setTimeout(300_000);
    const dir = join(perfDir(), `perf-${steps}`);
    const record = (attempt: number, timings: number[]) => {
      const { median, p95, max } = summarize(timings);
      test.info().annotations.push({
        type: "final verdict ms",
        description: `${steps} steps, attempt ${attempt}, N=${timings.length}: median ${median.toFixed(1)}, p95 ${p95.toFixed(1)}, max ${max.toFixed(1)}${injectMs > 0 ? `, injected ${injectMs} ms` : ""}`,
      });
      const report = process.env.MYCO_VIEWER_BUDGET_REPORT;
      if (report) {
        appendFileSync(
          report,
          `${JSON.stringify({ platform: process.platform, steps, attempt, injectMs, median, p95, max, samples: timings })}\n`,
        );
      }
    };

    const timings = await measure(context, dir);
    record(1, timings);
    if (strict || !ci) {
      const { max } = summarize(timings);
      const limit = strict || steps === 1000 ? 150 : 250;
      expect(
        max,
        `final verdict at ${steps} steps (maximum ${limit} ms). samples: ${timings.map((t) => t.toFixed(1))}`,
      ).toBeLessThanOrEqual(limit);
      return;
    }

    const first = ciMisses(steps, timings);
    if (first.length === 0) return;
    // Hosted-runner speed varies from job to job; one fresh re-measurement separates a
    // borderline runner from a slowdown that misses twice. Both attempts are reported.
    test.info().annotations.push({
      type: "verdict budget retry",
      description: `attempt 1 missed; re-measuring once.\n${first.join("\n")}`,
    });
    const retry = await measure(context, dir);
    record(2, retry);
    const second = ciMisses(steps, retry);
    expect(
      second,
      `both measurements missed the budget.\nattempt 1: ${first.join("\n")}\nattempt 2: ${second.join("\n")}`,
    ).toEqual([]);
  });
}
