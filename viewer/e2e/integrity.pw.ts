import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { boot, checkOffline, runs, screenshotDir, waitForRun, zipUpload } from "./support.ts";

for (const scenario of ["manifest mismatch", "malformed trace", "no-op recovery"] as const) {
  test(`worker publishes a safe verdict for ${scenario}`, async ({ page }) => {
    const offline = checkOffline(page);
    await boot(page);
    await page.evaluate(() => {
      const history: string[] = [];
      document.body.dataset.provisionalVerdicts = "";
      let sawFinal = false;
      new MutationObserver((mutations) => {
        if (!sawFinal && document.querySelector('[data-verdict-final="true"]')) {
          sawFinal = true;
          document.body.dataset.indexedAtVerdict = String(
            !!document.querySelector('[data-indexed="true"]'),
          );
        }
        for (const mutation of mutations) {
          if (
            !(mutation.target instanceof HTMLElement) ||
            !mutation.target.matches("[data-verdict-bar]")
          )
            continue;
          if (mutation.attributeName !== "data-verdict") continue;
          history.push(mutation.oldValue ?? "");
          if (!mutation.target.dataset.verdictFinal)
            history.push(mutation.target.dataset.verdict ?? "");
        }
        document.body.dataset.provisionalVerdicts = history.join(",");
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["data-verdict", "data-verdict-final"],
      });
    });

    const folder = runs.find(
      ({ name }) => name === (scenario === "manifest mismatch" ? "recovered" : "verified"),
    )!.folder;
    const result = await readFile(join(folder, "result.json"));
    let trace = await readFile(join(folder, "trace.jsonl"), "utf8");
    const entries: Record<string, Uint8Array> = { "result.json": result };
    if (scenario === "manifest mismatch") {
      trace = trace
        .split("\n")
        .filter((line) => !/"type":"(?:guard-failure|recovery)"/.test(line))
        .join("\n");
      entries["manifest.json"] = await readFile(join(folder, "manifest.json"));
      entries["ledger.jsonl"] = await readFile(join(folder, "ledger.jsonl"));
    } else if (scenario === "malformed trace") {
      trace += "{\n";
    } else {
      trace +=
        '{"type":"recovery","timestamp":"2026-11-21T12:00:04.000Z","event":"none","stateVersion":12}\n';
    }
    entries["trace.jsonl"] = Buffer.from(trace);

    await page
      .locator("input[multiple]:not([webkitdirectory])")
      .first()
      .setInputFiles({
        name: "review.mycotrace",
        mimeType: "application/zip",
        buffer: Buffer.from(zipSync(entries)),
      });
    const verdict = page.locator("[data-verdict-bar]");
    await expect(verdict).toHaveAttribute("data-verdict-final", "true");
    await expect(page.locator("body")).toHaveAttribute("data-indexed-at-verdict", "false");
    await expect(verdict).toHaveAttribute(
      "data-verdict",
      scenario === "no-op recovery" ? "Verified" : "Unknown",
    );
    expect(await page.locator("body").getAttribute("data-provisional-verdicts")).not.toMatch(
      /Verified|Recovered/,
    );
    if (scenario === "manifest mismatch") {
      await expect(verdict).toContainText("SHA-256 mismatch for trace.jsonl");
      await expect(page.locator("[data-run-view]")).toHaveAttribute("data-indexed", "true");
      await page.screenshot({
        path: join(screenshotDir, "unknown-manifest-mismatch-1440.png"),
        animations: "disabled",
      });
      await expect(
        verdict
          .getByRole("button", { name: "Open source manifest.json#/files/trace.jsonl" })
          .first(),
      ).toBeVisible();
    } else if (scenario === "malformed trace") {
      await expect(verdict).toContainText("Incomplete evidence in trace.jsonl");
    } else {
      await expect(verdict.getByRole("button", { name: "recoveries 0" })).toBeVisible();
    }
    offline();
  });
}

test("an unscoped recovery source opens the same step before and after indexing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, options) {
      if (message.type === "index") {
        document.body.addEventListener(
          "resume-indexing",
          () => {
            postMessage.call(this, message, options as StructuredSerializeOptions);
          },
          { once: true },
        );
      } else {
        postMessage.call(this, message, options as StructuredSerializeOptions);
      }
    };
  });
  await boot(page);
  const folder = runs.find(({ name }) => name === "recovered")!.folder;
  const result = await readFile(join(folder, "result.json"));
  const trace = await readFile(join(folder, "trace.jsonl"), "utf8");
  const newline = trace.indexOf("\n") + 1;
  const padded = trace.slice(0, newline) + '{"type":"future"}\n'.repeat(260) + trace.slice(newline);
  await page
    .locator("input[multiple]:not([webkitdirectory])")
    .first()
    .setInputFiles({
      name: "padded.mycotrace",
      mimeType: "application/zip",
      buffer: Buffer.from(zipSync({ "result.json": result, "trace.jsonl": Buffer.from(padded) })),
    });
  const bar = page.locator("[data-verdict-bar]");
  await expect(bar).toHaveAttribute("data-verdict", "Recovered");
  const source = bar.getByRole("button", { name: "Open source trace.jsonl:321" });
  await expect(page.locator('[data-indexed="true"]')).toHaveCount(0);
  await source.click();
  await expect(page).toHaveURL(/step=6&file=trace.jsonl&line=321/);
  await expect(page.getByRole("tab", { name: "Detail" })).toHaveAttribute("aria-selected", "true");

  await page.evaluate(() => document.body.dispatchEvent(new Event("resume-indexing")));
  await waitForRun(page, "Recovered");
  await page.keyboard.press("3");
  await source.click();
  await expect(page).toHaveURL(/step=6&file=trace.jsonl&line=321/);
  await expect(page.getByRole("tab", { name: "Detail" })).toHaveAttribute("aria-selected", "true");
});

test("a late same-run load cannot replace the newer sidebar entry", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    // A load uses two workers (trace and result); hold both of the first load's workers.
    let held = 0;
    const queued: { target: EventTarget; data: unknown }[] = [];
    const targets: Worker[] = [];
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (held >= 2) return;
        held++;
        targets.push(this);
        const hold = (event: MessageEvent) => {
          event.stopImmediatePropagation();
          queued.push({ target: this, data: event.data });
          if (event.data.type === "validated") document.body.dataset.olderValidated = "true";
        };
        this.addEventListener("message", hold);
        document.body.addEventListener(
          "release-older",
          () => {
            this.removeEventListener("message", hold);
            if (targets.at(-1) !== this) return;
            for (const { target, data } of queued)
              target.dispatchEvent(new MessageEvent("message", { data }));
          },
          { once: true },
        );
      }
    };
  });
  await boot(page);
  const folder = runs.find(({ name }) => name === "verified")!.folder;
  const input = page.locator("input[multiple]:not([webkitdirectory])").first();
  const result = await readFile(join(folder, "result.json"));
  const trace = await readFile(join(folder, "trace.jsonl"), "utf8");
  await input.setInputFiles({
    name: "older.mycotrace",
    mimeType: "application/zip",
    buffer: Buffer.from(
      zipSync({ "result.json": result, "trace.jsonl": Buffer.from(`${trace}{\n`) }),
    ),
  });
  await expect(page.locator("body")).toHaveAttribute("data-older-validated", "true");
  await input.setInputFiles(await zipUpload(folder, "newer"));
  await waitForRun(page, "Verified");
  await expect(page.locator("[data-run-row]")).toHaveCount(2);
  await page.evaluate(() => document.body.dispatchEvent(new Event("release-older")));
  await expect(page.locator("[data-run-row]")).toHaveCount(1);
  await expect(page.locator('[data-run-row][aria-selected="true"]')).toHaveAttribute(
    "title",
    "newer.mycotrace",
  );
  await waitForRun(page, "Verified");
});

const wrongClaim =
  '{"type":"claim","step":10,"source":"app-ui","field":"item-call-mom-persisted","value":"WRONG","timestamp":"2026-11-21T12:00:04.000Z"}\n';

test("an unknown trace event is shown as extended and cannot change the verdict", async ({
  page,
}) => {
  const offline = checkOffline(page);
  await boot(page);
  const folder = runs.find(({ name }) => name === "verified")!.folder;
  const trace = `${await readFile(join(folder, "trace.jsonl"), "utf8")}{"type":"vendor-note","verdict":"refuted"}\n`;
  await page
    .locator("input[multiple]:not([webkitdirectory])")
    .first()
    .setInputFiles({
      name: "extended.mycotrace",
      mimeType: "application/zip",
      buffer: Buffer.from(
        zipSync({
          "result.json": await readFile(join(folder, "result.json")),
          "trace.jsonl": Buffer.from(trace),
        }),
      ),
    });
  await waitForRun(page, "Verified");
  await page.keyboard.press("2");
  const line = trace.trimEnd().split("\n").length;
  await page
    .getByRole("button", { name: `Open source trace.jsonl:${line}`, exact: false })
    .first()
    .click();
  await expect(page.locator("[data-raw]")).toContainText(`trace.jsonl:${line} · extended`);
  await expect(page.locator("[data-raw-body]")).toContainText("vendor-note");
  offline();
});

test("a Verified result contradicted by its own claim renders Failed · False success", async ({
  page,
}) => {
  const offline = checkOffline(page);
  await boot(page);
  const folder = runs.find(({ name }) => name === "verified")!.folder;
  const trace = await readFile(join(folder, "trace.jsonl"), "utf8");
  await page
    .locator("input[multiple]:not([webkitdirectory])")
    .first()
    .setInputFiles({
      name: "contradicted.mycotrace",
      mimeType: "application/zip",
      buffer: Buffer.from(
        zipSync({
          "result.json": await readFile(join(folder, "result.json")),
          "trace.jsonl": Buffer.from(trace),
          "trace.extended.jsonl": Buffer.from(trace + wrongClaim),
        }),
      ),
    });
  await waitForRun(page, "Failed");
  const bar = page.locator("[data-verdict-bar]");
  await expect(bar).toContainText("False success");
  await expect(bar).toContainText("claim WRONG contradicts persisted call mom");
  offline();
});
