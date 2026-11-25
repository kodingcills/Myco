import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

// Paths resolve from the repo root (this file's parent directory), so the script
// works from any cwd. Copying the screenshots to an extra directory (an agent's
// artifact folder, say) is opt-in: set MYCO_VIEWER_PROOF_COPY_DIR to enable it.
const REPO_ROOT = resolve(import.meta.dirname, "..");
const copyDir = process.env.MYCO_VIEWER_PROOF_COPY_DIR?.trim() || undefined;

async function runViewerVerification() {
  const viewerHtmlPath = resolve(REPO_ROOT, "viewer/dist/myco-viewer.html");
  if (!existsSync(viewerHtmlPath)) {
    throw new Error(`myco-viewer.html not found at ${viewerHtmlPath}`);
  }

  const archivePath = resolve(REPO_ROOT, "runs/direction-a-todo-save.mycotrace");
  if (!existsSync(archivePath)) {
    throw new Error(`Run archive not found at ${archivePath}`);
  }

  const screenshotsDir = resolve(REPO_ROOT, "viewer/screenshots");
  mkdirSync(screenshotsDir, { recursive: true });
  if (copyDir) mkdirSync(copyDir, { recursive: true });

  process.stdout.write("[verifier] Launching headless Chromium (1440x900)...\n");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // 1. Boot Viewer
  const viewerUrl = pathToFileURL(viewerHtmlPath).href;
  await page.goto(viewerUrl);
  await expect(page.getByRole("heading", { name: "Open a Myco run" })).toBeVisible();

  process.stdout.write(
    "[verifier] Staging archive and measuring open & verdict latency inside browser...\n",
  );

  // Stage file in input outside timer to exclude DevTools protocol RPC transfer latency
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "benchmark-archive";
    input.hidden = true;
    document.body.append(input);
  });
  await page.locator("#benchmark-archive").setInputFiles(archivePath);

  // Measure in-browser drop -> verdict duration using string script to avoid tsx/esbuild __name helper
  const timing = (await page.evaluate(`
    (async () => {
      const input = document.querySelector("#benchmark-archive");
      const file = input.files[0];
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.remove();

      const pending = new Map();
      const markPaint = (name) => {
        if (pending.has(name)) return;
        pending.set(
          name,
          new Promise((resolve) => {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                performance.mark(name);
                resolve();
              }),
            );
          }),
        );
      };

      const indexed = new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (
            document.querySelector('[data-verdict-bar][data-verdict-final="true"]') &&
            !pending.has("verdict")
          ) {
            markPaint("verdict");
          }
          if (document.querySelector('[data-indexed="true"]')) {
            markPaint("indexed");
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      });

      performance.mark("drop");
      document
        .querySelector("[data-app]")
        .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
      await indexed;
      await Promise.all(pending.values());
      const verdictMs = performance.measure("verdict", "drop", "verdict").duration;
      const indexedMs = performance.measure("indexed", "drop", "indexed").duration;
      return {
        verdictDurationMs: Math.round(verdictMs),
        indexedDurationMs: Math.round(indexedMs),
      };
    })()
  `)) as { verdictDurationMs: number; indexedDurationMs: number };

  process.stdout.write(
    `[verifier] In-browser verdict derivation latency: ${timing.verdictDurationMs} ms (budget: <= 150 ms)\n`,
  );
  process.stdout.write(
    `[verifier] In-browser full indexing latency:      ${timing.indexedDurationMs} ms\n`,
  );

  // Assert latency budget (gui-spec §8: initial open + verdict derivation under 150 ms)
  expect(timing.verdictDurationMs).toBeLessThanOrEqual(150);

  // 2. Wait for indexed run & verdict
  await expect(page.locator("[data-run-view]")).toHaveAttribute("data-indexed", "true");
  await expect(page.locator("[data-verdict-bar]")).toHaveAttribute("data-verdict", "Failed");

  // 3. Verify Proof view contents
  const verdictBar = page.locator("[data-verdict-bar]");
  const statusEl = verdictBar.getByRole("status");
  await expect(statusEl).toContainText("Failed");
  await expect(statusEl).toContainText("False success");

  // Verify simulated / dry-run badge is visibly rendered in VerdictBar
  const simBadge = page.locator("[data-simulated-badge]").first();
  await expect(simBadge).toBeVisible();
  await expect(simBadge).toHaveText("Simulated");

  // Check counts: 2 passed out of 4 checks
  const countsEl = page.locator("[data-counts]");
  await expect(countsEl).toContainText("checks 2/4");

  // Check comparator rows
  const comparatorRows = page.locator("[data-comparison]");
  await expect(comparatorRows).toHaveCount(4);

  // Assert the 2 false-success items disagree and display 'absent'
  const disagreeRows = page.locator('[data-comparison="disagree"]');
  await expect(disagreeRows).toHaveCount(2);
  await expect(disagreeRows.nth(0)).toContainText("bug: login page crashes on save");
  await expect(disagreeRows.nth(0)).toContainText("absent");
  await expect(disagreeRows.nth(1)).toContainText("BUG: token expires too early");
  await expect(disagreeRows.nth(1)).toContainText("absent");

  // Assert the 2 persisted items agree
  const agreeRows = page.locator('[data-comparison="agree"]');
  await expect(agreeRows).toHaveCount(2);
  await expect(agreeRows.nth(0)).toContainText("update the release notes");
  await expect(agreeRows.nth(1)).toContainText("write the incident summary");

  // 4. Capture Proof View Screenshot (1440x900)
  const proofShotPath = join(screenshotsDir, "direction-a-proof-1440.png");
  await page.screenshot({ path: proofShotPath, animations: "disabled" });
  process.stdout.write(`[verifier] Captured Proof screenshot: ${proofShotPath}\n`);

  // 5. Navigate to Why View & Capture Screenshot
  process.stdout.write("[verifier] Navigating to Why view (tab 2)...\n");
  await page.keyboard.press("2");
  await expect(page.getByRole("tab", { name: "2 Why", selected: true })).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Run steps" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Playhead" })).toBeVisible();

  const whyShotPath = join(screenshotsDir, "direction-a-why-1440.png");
  await page.screenshot({ path: whyShotPath, animations: "disabled" });
  process.stdout.write(`[verifier] Captured Why screenshot: ${whyShotPath}\n`);

  // 6. Navigate to Raw View & Capture Screenshot
  process.stdout.write("[verifier] Navigating to Raw inspection view...\n");
  await page.keyboard.press("3"); // Return to Proof
  await expect(page.getByRole("tab", { name: "3 Proof", selected: true })).toBeVisible();

  // Focus the first disagree row and hit Enter to inspect
  await disagreeRows.first().focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("tab", { name: "Raw", selected: true })).toBeVisible();
  await expect(page.locator("[data-raw-body]")).toContainText('"passed": false');
  await expect(page.locator("[data-raw]")).toContainText("result.json#/verdict/checks/");

  const rawShotPath = join(screenshotsDir, "direction-a-raw-1440.png");
  await page.screenshot({ path: rawShotPath, animations: "disabled" });
  process.stdout.write(`[verifier] Captured Raw screenshot: ${rawShotPath}\n`);

  // Optionally copy all 3 screenshots to MYCO_VIEWER_PROOF_COPY_DIR for embedding elsewhere
  let copies: { proof: string; why: string; raw: string } | undefined;
  if (copyDir) {
    copies = {
      proof: join(copyDir, "direction-a-proof-1440.png"),
      why: join(copyDir, "direction-a-why-1440.png"),
      raw: join(copyDir, "direction-a-raw-1440.png"),
    };
    copyFileSync(proofShotPath, copies.proof);
    copyFileSync(whyShotPath, copies.why);
    copyFileSync(rawShotPath, copies.raw);
    process.stdout.write(`[verifier] Copied screenshots to ${copyDir}.\n`);
  }

  await browser.close();

  return {
    verdictDurationMs: timing.verdictDurationMs,
    indexedDurationMs: timing.indexedDurationMs,
    proofShotPath,
    whyShotPath,
    rawShotPath,
    copies,
  };
}

runViewerVerification()
  .then((res) => {
    process.stdout.write("[verifier] SUCCESS: All assertions passed!\n");
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(`[verifier] FAILED: ${String(err)}\n`);
    process.exit(1);
  });
