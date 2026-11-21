// Enforces gui-spec §8: "10,000 steps: Verdict <= 150 ms" and "Verdict visible after drop <= 150 ms".
// Always runs in the standard e2e suite. It generates the 1k and 10k perf runs itself unless
// MYCO_VIEWER_PERF_DIR already holds them.
//   MYCO_VIEWER_STRICT_BUDGET=1  -> 150 ms maximum for both sizes (the spec; use on a dev machine)
//   default (shared CI runners)  -> 150 ms for 1k, 250 ms for 10k. Shared runners are noisy and
//   several times slower than the M4 Pro the spec was measured on, so the 10k bound is looser.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { boot } from "./support.ts";

const strict = process.env.MYCO_VIEWER_STRICT_BUDGET === "1";
const budgets = { 1000: 150, 10000: strict ? 150 : 250 } as const;
const samples = Number(process.env.MYCO_VIEWER_BUDGET_SAMPLES ?? 20);

function perfDir() {
  const configured = process.env.MYCO_VIEWER_PERF_DIR;
  if (
    configured &&
    existsSync(join(configured, "perf-1000", "trace.jsonl")) &&
    existsSync(join(configured, "perf-10000", "trace.jsonl"))
  ) {
    return configured;
  }
  const dir = mkdtempSync(join(tmpdir(), "myco-viewer-verdict-budget-"));
  execFileSync("npx", ["tsx", "scripts/gen-viewer-fixtures.ts", "--perf", dir], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stdio: "ignore",
  });
  return dir;
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
    const median = timings[Math.floor((timings.length - 1) / 2)]!;
    const max = timings.at(-1)!;
    test.info().annotations.push({
      type: "final verdict ms",
      description: `${steps} steps, N=${timings.length}: median ${median.toFixed(1)}, max ${max.toFixed(1)} (budget ${budgets[steps]})`,
    });
    expect(
      max,
      `final verdict at ${steps} steps: ${timings.map((t) => t.toFixed(1))}`,
    ).toBeLessThanOrEqual(budgets[steps]);
  });
}
