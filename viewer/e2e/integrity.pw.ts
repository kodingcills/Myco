import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { boot, checkOffline, runs, screenshotDir } from "./support.ts";

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
