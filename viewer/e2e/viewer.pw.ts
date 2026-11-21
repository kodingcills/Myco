import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
