/**
 * Replay scrubber page (spec #589 RS-04 page check, issue #666), in a real browser: the MOCK
 * watermark is on every frame of a mock run, and stepping or jumping by decision shows each
 * decision only from its pinned frame on, never before.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { directoryFrameSource } from "../../src/watch/frames.ts";
import { startWatchServer, type WatchServer } from "../../src/watch/server.ts";
import { encodePng, tempDir } from "./helpers.ts";
import { manifestBytes, recordTrial } from "./timeline-fixture.ts";

const TASK = "df-s02";
const RUN = "run-r";
const OWN = { taskId: TASK, runId: RUN, claim: "all saved" };

let browser: Browser;
let server: WatchServer;

function pngFrame(index: number): Buffer {
  const v = (index * 37) % 256;
  return encodePng({
    width: 2,
    height: 2,
    colorType: 6,
    raw: Buffer.from([0, v, 0, 0, 255, v, 255, 0, 255, 0, v, 0, 255, 255, v, 2, 3, 255]),
  });
}

beforeAll(async () => {
  // Frame 0, call 1 (refuted), frames 1-2, call 2 (named another run), frame 3, call 3.
  const trial = await recordTrial(
    { taskId: TASK, runId: RUN },
    [
      { frame: "a" },
      { call: OWN },
      { frame: "b" },
      { frame: "c" },
      { call: { taskId: TASK, runId: "run-s" } },
      { frame: "d" },
      { call: OWN },
    ],
    { encode: pngFrame },
  );
  const root = tempDir("myco-replay-page-");
  mkdirSync(join(root, RUN));
  for (const [i, bytes] of trial.frames.entries())
    writeFileSync(join(root, RUN, `f${i}.png`), bytes);
  writeFileSync(join(root, RUN, "timeline.jsonl"), manifestBytes(trial.records));
  const log = join(root, "log.jsonl");
  writeFileSync(log, trial.log);
  server = await startWatchServer({
    runs: [RUN],
    tasks: [TASK],
    decisionLog: log,
    frames: directoryFrameSource(root, "per-run", new Set([RUN])),
    pollMs: 20,
  });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe("scrubber page", () => {
  it("watermarks every frame MOCK and shows each decision only from its pinned frame on", async () => {
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.locator("#joininfo").filter({ hasText: "replay:" }).waitFor();
    const shown = async () => ({
      wm: await page.locator("#wm").isVisible(),
      wmText: await page.locator("#wm").textContent(),
      band: await page.locator("#wmband").textContent(),
      bandVisible: await page.locator("#wmband").isVisible(),
      pinned: (await page.locator("#pinned").textContent()) ?? "",
      frame: (await page.locator("#frameinfo").textContent()) ?? "",
    });
    // Drag the slider to each frame and read what is shown.
    const seen: { frame: string; pinned: string }[] = [];
    for (let i = 0; i < 4; i += 1) {
      await page.locator("#scrub").fill(String(i));
      const s = await shown();
      expect(s.wm, `frame ${i}`).toBe(true);
      expect(s.wmText).toBe("MOCK");
      expect(s.bandVisible).toBe(true);
      expect(s.band).toBe("MOCK · NOT EVIDENCE");
      seen.push({ frame: s.frame, pinned: s.pinned });
    }
    expect(seen).toEqual([
      { frame: "frame 1 / 4", pinned: expect.stringContaining("call 1: refuted") },
      { frame: "frame 2 / 4", pinned: expect.stringContaining("call 1: refuted") },
      { frame: "frame 3 / 4", pinned: expect.stringContaining("call 2: uncertain") },
      { frame: "frame 4 / 4", pinned: expect.stringContaining("call 3: refuted") },
    ]);
    expect(seen[2]?.pinned).toContain("named another trial");
    // Jump by decision from the start: frames 1, 3 and 4 hold the pins.
    await page.locator("#scrub").fill("0");
    await page.locator("#nextdec").click();
    expect(await page.locator("#frameinfo").textContent()).toBe("frame 3 / 4");
    await page.locator("#nextdec").click();
    expect(await page.locator("#frameinfo").textContent()).toBe("frame 4 / 4");
    await page.locator("#prevdec").click();
    expect(await page.locator("#frameinfo").textContent()).toBe("frame 3 / 4");
    await page.locator("#prevframe").click();
    expect(await page.locator("#pinned").textContent()).toContain("call 1: refuted");
    await page.close();
  }, 60_000);

  it("the watermark stays on when the timeline never arrives, or realRuns is missing or contradicted", async () => {
    const visible = async (setup: (p: import("@playwright/test").Page) => Promise<void>) => {
      const page = await browser.newPage();
      await setup(page);
      await page.goto(server.url);
      await page.locator("#frameinfo").filter({ hasText: "frame" }).waitFor();
      await page.waitForTimeout(300);
      const out = [
        await page.locator("#wm").isVisible(),
        await page.locator("#wmband").isVisible(),
      ];
      await page.close();
      return out;
    };
    // The timeline request fails: no mock mark arrives, the watermark stays.
    const blockTimeline = async (p: import("@playwright/test").Page) => {
      await p.route("**/timeline/**", (r) => r.abort());
    };
    expect(await visible(blockTimeline)).toEqual([true, true]);
    // A timeline that says mock: false is not enough while the state does not name the run.
    const timelineSaysReal = async (p: import("@playwright/test").Page) => {
      await p.route("**/timeline/**", async (route) => {
        const response = await route.fetch();
        const view = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...view, mock: false, watermark: null } });
      });
    };
    expect(await visible(timelineSaysReal)).toEqual([true, true]);
    // ... nor when the state's realRuns field is missing altogether.
    const noRealRunsField = async (p: import("@playwright/test").Page) => {
      await timelineSaysReal(p);
      await p.addInitScript("window.EventSource = undefined;");
      await p.route("**/api/state", async (route) => {
        const response = await route.fetch();
        const { realRuns: _gone, ...state } = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: state });
      });
    };
    expect(await visible(noRealRunsField)).toEqual([true, true]);
    // A state with realRuns stripped (and no EventSource) keeps it too.
    const rewriteState =
      (edit: (s: Record<string, unknown>) => void) =>
      async (p: import("@playwright/test").Page) => {
        await p.addInitScript("window.EventSource = undefined;");
        await p.route("**/api/state", async (route) => {
          const response = await route.fetch();
          const state = (await response.json()) as Record<string, unknown>;
          edit(state);
          await route.fulfill({ response, json: state });
        });
      };
    expect(
      await visible(
        rewriteState((s) => {
          delete s.realRuns;
        }),
      ),
    ).toEqual([true, true]);
    // A state that names the run real while its timeline says mock: still watermarked.
    expect(
      await visible(
        rewriteState((s) => {
          s.realRuns = [RUN];
        }),
      ),
    ).toEqual([true, true]);
    // Only both together (state names it real and the timeline is not mock) would turn it off.
    const both = async (p: import("@playwright/test").Page) => {
      await rewriteState((s) => {
        s.realRuns = [RUN];
      })(p);
      await p.route("**/timeline/**", async (route) => {
        const response = await route.fetch();
        const view = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...view, mock: false, watermark: null } });
      });
    };
    expect(await visible(both)).toEqual([false, false]);
  }, 60_000);
});
