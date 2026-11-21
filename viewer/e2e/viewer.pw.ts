import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import tokens from "../../docs/design/tokens.json" with { type: "json" };
import {
  boot,
  checkOffline,
  openFolder,
  runs,
  screenshotDir,
  waitForRun,
  zipUpload,
} from "./support.ts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

async function pickerByKeyboard(page: Page, kind: "files" | "folder") {
  await page.keyboard.press(`${mod}+o`);
  const item = page.getByRole("menuitem", { name: `Open ${kind}…` });
  await expect(item).toBeVisible();
  await expect(page.locator('[role="menu"] :focus, [role="menu"]:focus')).toHaveCount(1);
  await page.keyboard.press("Home");
  if (kind === "folder") await page.keyboard.press("ArrowDown");
  await expect(item).toBeFocused();
  const picker = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  return picker;
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(screenshotDir, `${name}.png`), animations: "disabled" });
}

for (const { name, folder, verdict } of runs) {
  test(`${name} renders Proof and Why offline`, async ({ page }) => {
    const offline = checkOffline(page);
    await boot(page);
    await openFolder(page, folder);
    await waitForRun(page, verdict);
    const status = page.locator("[data-verdict-bar]").getByRole("status");
    await expect(status).toContainText(verdict);
    await expect(status.locator("svg")).toBeVisible();
    if (name === "false-success") await expect(status).toContainText("False success");
    await expect(page.getByRole("tab", { name: "3 Proof", selected: true })).toBeVisible();
    await shot(page, `${name}-proof-1440`);
    if (name === "normal") {
      await page.setViewportSize({ width: 1280, height: 800 });
      const startsFits = await page.locator("[data-run-start]").evaluate((start) => {
        const parent = start.parentElement!;
        const range = document.createRange();
        range.selectNodeContents(start);
        return range.getBoundingClientRect().right <= parent.getBoundingClientRect().right;
      });
      expect(startsFits).toBe(true);
      expect(await page.locator("[data-run-id]").evaluate((id) => id.clientWidth)).toBeGreaterThan(
        0,
      );
      await shot(page, `${name}-proof-1280`);
      await page.keyboard.press("2");
      await expect(page.getByRole("listbox", { name: "Run steps" })).toBeVisible();
      await shot(page, `${name}-why-1280`);
      await page.setViewportSize({ width: 1440, height: 900 });
    } else await page.keyboard.press("2");
    await expect(page.getByRole("tab", { name: "2 Why", selected: true })).toBeVisible();
    const list = page.getByRole("listbox", { name: "Run steps" });
    if (name === "kill") await expect(list).toContainText("not recorded");
    else await expect(list.getByRole("option").first()).toBeVisible();
    await expect(status).toContainText(verdict);
    await shot(page, `${name}-why-1440`);
    offline();
  });
}

test("J1 opens a finished archive by keyboard", async ({ page }) => {
  const offline = checkOffline(page);
  await boot(page);
  await shot(page, "open-screen-1440");
  // Headless Chromium delegates the OS file dialog to Playwright.
  const picker = await pickerByKeyboard(page, "files");
  await picker.setFiles(await zipUpload(runs[0]!.folder, "normal"));
  await waitForRun(page, "Verified");
  await expect(page.getByRole("tab", { name: "3 Proof", selected: true })).toBeVisible();
  await expect(page.locator("[data-comparison]").first()).toBeFocused();
  await expect(page.getByRole("region", { name: "State changes" })).toBeVisible();
  await expect(page.getByRole("treeitem", { selected: true }).first()).toBeVisible();
  await expect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
    "aria-valuemax",
    "3",
  );
  offline();
});

test("J2 follows a false-success claim and flags by keyboard", async ({ page }) => {
  const offline = checkOffline(page);
  await boot(page);
  const fixture = runs.find(({ name }) => name === "false-success")!;
  await (await pickerByKeyboard(page, "folder")).setFiles(fixture.folder);
  await waitForRun(page, fixture.verdict);
  const first = page.locator("[data-comparison]").first();
  await expect(first).toHaveAttribute("data-comparison", "disagree");
  await expect(first).toContainText("call mom");
  await expect(first).toContainText("absent");
  await expect(page.locator("[data-counts]")).toContainText("checks 1/2");
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Raw", selected: true })).toBeVisible();
  await expect(page.locator("[data-raw-body]")).toContainText('"passed": false');
  await expect(page.locator("[data-raw]")).toContainText("result.json#/verdict/checks/1");
  await shot(page, "false-success-raw-1440");
  for (const key of ["3", "Tab", "Tab"]) await page.keyboard.press(key);
  await expect(
    page.getByRole("button", { name: "Open source trace.extended.jsonl:111" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "2 Why", selected: true })).toBeVisible();
  await expect(page.getByRole("option", { selected: true })).toHaveAttribute("id", "step-row-11");
  await expect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
    "aria-valuenow",
    "11",
  );
  await expect(page.getByRole("tab", { name: "Detail", selected: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Postconditions" })).toBeVisible();
  for (const key of ["Escape", "3"]) await page.keyboard.press(key);
  await expect(first).toBeFocused();
  expect(new URL(page.url()).hash).not.toContain("step=");

  // The claim is on the last step. Check next-flag navigation on the recovery run.
  const recovered = runs.find(({ name }) => name === "recovered")!;
  await (await pickerByKeyboard(page, "folder")).setFiles(recovered.folder);
  await waitForRun(page, recovered.verdict);
  for (const key of ["2", "]"]) await page.keyboard.press(key);
  const flagged = page.getByRole("option", { selected: true });
  await expect(flagged).toHaveAttribute("data-marker", /failed|recovered|fault/);
  offline();
});

test("J3 steps and moves the playhead by keyboard with missing artifacts", async ({ page }) => {
  const offline = checkOffline(page);
  await boot(page);
  const { folder, verdict } = runs.find(({ name }) => name === "unknown")!;
  await (await pickerByKeyboard(page, "files")).setFiles(
    ["result.json", "trace.jsonl"].map((name) => join(folder, name)),
  );
  await waitForRun(page, verdict);
  await page.keyboard.press("2");
  await expect(page.getByRole("heading", { name: "Run summary" })).toBeVisible();
  const selected = page.getByRole("option", { selected: true });
  const playhead = page.getByRole("slider", { name: "Playhead" });
  await page.keyboard.down("j");
  await expect(selected).toHaveAttribute("id", "step-row-0");
  await expect(playhead).toHaveAttribute("aria-valuetext", "#00");
  await expect(page.getByRole("heading", { name: "#00" })).toBeVisible();
  await page.keyboard.down("j");
  await page.keyboard.up("j");
  await expect(selected).toHaveAttribute("id", "step-row-1");
  await expect(playhead).toHaveAttribute("aria-valuenow", "1");
  for (const key of ["F6", "F6"]) await page.keyboard.press(key);
  await expect(playhead).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(selected).toHaveAttribute("id", "step-row-0");
  await expect(
    page
      .getByRole("complementary", { name: "Inspector" })
      .getByText("not recorded", { exact: true })
      .first(),
  ).toBeVisible();
  await shot(page, "unknown-missing-artifacts-1440");
  offline();
});

test("global step keys, local widget keys and panel focus follow the keyboard order", async ({
  page,
}) => {
  const offline = checkOffline(page);
  await boot(page);
  await (await pickerByKeyboard(page, "folder")).setFiles(runs[0]!.folder);
  await waitForRun(page, "Verified");

  const first = page.locator("[data-comparison]").first();
  const playhead = page.getByRole("slider", { name: "Playhead" });
  await expect(first).toBeFocused();
  for (const key of ["ArrowDown", "j", "ArrowUp"]) await page.keyboard.press(key);
  await expect(first).toBeFocused();
  await expect(playhead).toHaveAttribute("aria-valuetext", "#00");

  const region = (name: string) =>
    page.locator(`[data-region="${name}"]:focus, [data-region="${name}"] :focus`);
  await page.keyboard.press("2");
  const list = page.getByRole("listbox", { name: "Run steps" });
  await expect(list).toBeFocused();
  await page.keyboard.press("F6");
  const detail = page.getByRole("tab", { name: "Detail", selected: true });
  await expect(detail).toBeFocused();
  await page.keyboard.press(`${mod}+d`);
  await expect(list).toBeFocused();
  await page.keyboard.press(`${mod}+d`);
  await expect(detail).toBeFocused();
  for (const name of ["scrubber", "runs"]) {
    await page.keyboard.press("F6");
    await expect(region(name)).toHaveCount(1);
  }
  const treeItem = page.getByRole("treeitem", { selected: true });
  await expect(treeItem).toBeFocused();
  await page.keyboard.press(`${mod}+b`);
  await expect(region("verdict")).toHaveCount(1);
  await page.keyboard.press(`${mod}+b`);
  await expect(treeItem).toBeFocused();
  for (const name of ["scrubber", "inspector", "center", "verdict", "runs"]) {
    await page.keyboard.press("Shift+F6");
    await expect(region(name)).toHaveCount(1);
  }

  await (await pickerByKeyboard(page, "folder")).setFiles(
    runs.find(({ name }) => name === "false-success")!.folder,
  );
  await waitForRun(page, "Failed");
  await page.keyboard.press("3");
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[data-comparison]").nth(1)).toBeFocused();
  await expect(playhead).toHaveAttribute("aria-valuetext", "No step selected");
  await page.keyboard.press("j");
  await expect(playhead).toHaveAttribute("aria-valuetext", "#00");
  offline();
});

test("Why row facts and Verdict Bar counts lead to their contributing evidence", async ({
  page,
}) => {
  const offline = checkOffline(page);
  await boot(page);
  await (await pickerByKeyboard(page, "folder")).setFiles(
    runs.find(({ name }) => name === "recovered")!.folder,
  );
  await waitForRun(page, "Recovered");
  // Proof lists every step, including the unchanged recovery step #06 (v6→v6).
  const states = page.getByRole("region", { name: "State changes" });
  await expect(states).toContainText("#05");
  await expect(
    states.locator("[data-state-row][data-unchanged]", { hasText: "#06" }),
  ).toContainText("unchanged");
  // Every icon-only button names itself; the bar's source chips are one Tab stop.
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .filter((button) => !button.textContent?.trim() && !button.getAttribute("aria-label"))
      .map((button) => button.outerHTML.slice(0, 80)),
  );
  expect(unnamed).toEqual([]);
  const barChips = page.locator("[data-verdict-bar] [data-source]");
  expect(await barChips.count()).toBeGreaterThan(3);
  expect(await page.locator('[data-verdict-bar] [data-source][tabindex="0"]').count()).toBe(1);
  await expect(barChips.first()).toHaveAttribute("title", /Recovered verdict/);
  await barChips.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(barChips.nth(1)).toBeFocused();
  await expect(page.locator('[data-verdict-bar] [data-source][tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("2");
  await page.keyboard.press("j");
  await expect(page.getByRole("group", { name: /Sources for step/ })).toHaveCount(0);
  const action = page
    .locator("[data-detail]")
    .getByRole("button", { name: /Open source trace\.jsonl:\d+/ })
    .first();
  await action.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Raw", selected: true })).toBeVisible();
  await expect(page.locator("[data-raw-body]")).toContainText('"type"');
  await page.keyboard.press("Escape");

  const count = page.getByRole("button", { name: "guard failures 1" });
  await count.focus();
  await page.keyboard.press("Enter");
  const evidence = page.getByRole("region", { name: "Failures & recovery" });
  await expect(evidence).toBeFocused();
  await expect(evidence.getByRole("button", { name: "Open source trace.jsonl:60" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(evidence.getByRole("button", { name: "Open source trace.jsonl:60" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Detail", selected: true })).toBeVisible();
  await expect(page.getByRole("option", { selected: true })).toHaveAttribute("id", "step-row-6");
  offline();
});

test("every rendered text uses a token font-size / line-height pair", async ({ page }) => {
  const offline = checkOffline(page);
  await boot(page);
  const fixture = runs.find(({ name }) => name === "recovered")!;
  await (await pickerByKeyboard(page, "folder")).setFiles(fixture.folder);
  await waitForRun(page, fixture.verdict);
  const allowed = new Set(
    Object.values(tokens.font.size).map((size) => `${size.size}px/${size.lineHeight}px`),
  );
  for (const key of ["3", "2", "3"]) {
    await page.keyboard.press(key);
    await page.keyboard.press("j");
    const off = await page.evaluate(() =>
      [...document.querySelectorAll("body *")].flatMap((el) => {
        if (![...el.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim())) {
          return [];
        }
        const style = getComputedStyle(el);
        return [`${style.fontSize}/${style.lineHeight}`];
      }),
    );
    expect([...new Set(off)].filter((pair) => !allowed.has(pair))).toEqual([]);
  }
  offline();
});
