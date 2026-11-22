# Myco Viewer performance

This file is the single record of the measured numbers. Earlier per-round tables were removed because they mixed builds and benchmark settings. Their values are in git history.

## Final verdict after drop (GUI spec §8, 150 ms)

Spec §8: "10,000 steps: Verdict ≤ 150 ms" and "Verdict visible after drop ≤ 150 ms for any trace". Each budget is judged on the **maximum**, not the median.

**Machine and browser:** Apple M4 Pro (14 cores, 24 GiB), macOS 27.0, Playwright Chromium headless shell 159.0.8154.6, multi-process (no `--single-process`), 1440×900, offline context. Chrome Stable could not be launched in this environment (`SIGABRT`), so these numbers describe this browser build.

**Method (the independent verifier's):** a fresh page per load in one offline context. The file handles are staged outside the timer, and the drop is dispatched inside the page. One warmup load is discarded, then N = 20. Timing starts at the drop event and ends two animation frames after `data-verdict-final="true"` commits, so the provisional `Checking run evidence` Unknown never counts.

**Before** is the commit before this round's perf work (`22d304e`). **After** is this branch. Both were measured back to back with the same script. N = 20 per cell, so the nearest-rank p95 is the second-largest sample.

| Input | Run | Before median / p95 / max (ms) | After median / p95 / max (ms) | 150 ms (max) |
| --- | --- | ---: | ---: | --- |
| pair | normal (real M1) | 42.3 / 46.1 / 46.3 | 23.4 / 24.1 / 24.4 | Pass |
| pair | refuted-autocorrect (real M1) | 42.7 / 45.4 / 46.5 | 23.6 / 24.6 / 24.8 | Pass |
| pair | kill (real M1) | 42.1 / 44.9 / 45.0 | 23.1 / 24.9 / 26.4 | Pass |
| pair | perf-1000 | 58.5 / 61.3 / 63.3 | 39.8 / 42.8 / 43.9 | Pass |
| pair | **perf-10000** | 141.1 / 159.8 / 160.2 | **122.7 / 126.0 / 136.4** | **Pass (13.6 ms margin)** |
| folder (manifest checked) | perf-1000 | 57.6 / 59.1 / 59.2 | 38.5 / 40.4 / 41.5 | Pass |
| folder (manifest checked) | **perf-10000** | 173.6 / 174.3 / 174.3 | **123.4 / 139.0 / 139.1** | **Pass (10.9 ms margin)** |

`pair` is `result.json` plus `trace.jsonl` only. `folder` is every file in the run folder, so every manifest SHA-256 is also checked against the original bytes (33.6 MB of trace at 10,000 steps). The 10,000-step trace has 90,001 lines. The 10,000-step before samples were bimodal (about 141 ms or about 160 ms). That is the second animation frame landing on the next 60 Hz tick, so a sample near the median can still miss the next frame.

The 1,000-step run has the same 150 ms budget and passes with about 3.5× headroom.

Exact commands, from the repository root after `pnpm install`:

```sh
export PLAYWRIGHT_BROWSERS_PATH=/private/tmp/myco-stage4-browsers   # or: pnpm --filter viewer exec playwright install --only-shell chromium
pnpm --filter viewer build
npx tsx scripts/gen-viewer-fixtures.ts --perf /private/tmp/viewer-fix2-perf
cd viewer
for run in <runs>; do
  node scripts/final-verdict-bench.mjs dist/myco-viewer.html "$run" pair 20     # or: folder 20
done
```

`<runs>` are `docs/research/experiments/m1-013-session1/{normal-711e16c1,refuted-autocorrect-d7ad45bf,kill-87ee5b14}` and `/private/tmp/viewer-fix2-perf/perf-{1000,10000}`. For the "before" column, build the viewer at `22d304e`, save `viewer/dist/myco-viewer.html`, and pass that path as the first argument. The script prints `{median, p95, max, min, all}`.

## What changed

A positive verdict still waits for every check it waited for before: the result schema, every trace line's schema, run identity and recorded-action/guard cross-checks, ledger identity, and every manifest digest when a manifest is supplied. Only ordering and parallelism changed.

- **Two workers per load.** The trace worker streams and validates `trace.jsonl`. A second worker validates `result.json`, `manifest.json` and `ledger.jsonl` and checks the manifest digests at the same time, then hands the result to the trace worker over a `MessageChannel`. The trace worker joins both, runs the cross-file checks, and publishes the verdict. The result's post to the main thread no longer sits in front of the trace scan.
- **Workers are started before the drop.** Two idle workers are spawned after the Open screen paints, and the pool refills after each load. Worker start-up and script parse left the verdict path (about 15–20 ms on every run, including the small real ones).
- **Same checks, same order of reported errors.** `parseRunEvidence` is now the sequential composition of `parseResultPhase`, `parseTracePhase`, `parseLedgerPhase` and `finishEvidence`. The two-thread join uses the same functions. `phases.test.ts` asserts that the join equals the sequential result for all seven runs and for malformed trace, bad result schema, and bad ledger row inputs, including error order.
- **Message order is guaranteed on the main thread.** The two workers post independently, so the client holds every message except the result until the result has arrived. The existing late-load and provisional-verdict integrity tests cover this.

## Enforcement

`viewer/e2e/verdict-budget.pw.ts` runs in the standard `pnpm --filter viewer e2e`. It generates the 1,000- and 10,000-step runs itself (or reuses `MYCO_VIEWER_PERF_DIR`) and takes N = 20 loads (plus a discarded warmup) with the method above.

- `MYCO_VIEWER_STRICT_BUDGET=1` asserts a 150 ms **maximum** for both sizes. This is the spec limit and is what to use on a development machine. It passes on the machine above and **fails on the pre-change build** (163.5 ms max at 10,000 steps).
- A local run without the flag keeps the 150 ms (1,000 steps) and 250 ms (10,000 steps) maximum smoke-test limits.
- The `viewer-perf` job in `.github/workflows/ci.yml` runs this file on both GitHub Actions runner images for PRs and pushes to main. The root CI commands do not run the full Playwright suite. The job uses the Chromium headless shell pinned by the frozen Playwright lockfile and caches it by OS and lockfile hash. It publishes the raw timings even when an assertion fails.

### GitHub Actions calibration

[PR #69 CI runs 307](https://github.com/kodingcills/Myco/actions/runs/44967228840) and [308](https://github.com/kodingcills/Myco/actions/runs/44967388441) measured the generated result/trace pair in Chromium. Each job measured 20 drops after one warmup. Run 307 printed the samples to 0.1 ms in its assertion failures. Run 308 returned identical macOS samples for all six requested job IDs, so only one macOS job from that run counts. All times are in milliseconds.

| Runner | Jobs × 10,000-step drops | Pooled median / p95 / max | Highest job p95 | Hard median limit | Effective median limit |
|---|---:|---:|---:|---:|---:|
| macos-latest (provisional) | 2 × 20 | 315.4 / 499.9 / 586.8 | 503.5 | 580 | 425.8 |
| ubuntu-latest | 7 × 20 | 403.0 / 519.8 / 655.1 | 544.3 | 630 | 544.1 |

At 10,000 steps the job median must clear both limits in `viewer/e2e/perf-baseline.json`. The hard limit is the highest observed job p95 plus 15%, rounded upward to the next 10 ms. The relative limit allows 35% above the pooled median, rounded to 0.1 ms before storage. Ubuntu job medians ranged from 277.0 to 505.4 ms, leaving about 39 ms above the slowest job. The two macOS medians were 289.4 and 370.6 ms. The 1,000-step CI median limit stays at 150 ms. A single delayed sample has little effect on the median of 20. Runner-wide contention still shifts the median, and two macOS jobs give limited evidence of its frequency.

The independent review reproduced the two-job macOS calibration. It verified two of the seven Ubuntu jobs. The remaining five Ubuntu job or attempt IDs are needed to independently reproduce the pooled baseline.

Both hosted runner images already exceed 150 ms at baseline. Their checks can detect drift relative to runner performance. The strict local check still enforces the 150 ms spec maximum.

## Other §8 measurements (current build)

Same machine and browser, N = 15 fresh pages per case (one warmup discarded), 300 scrub movements for the generated runs. This is the standard `e2e/perf.pw.ts` benchmark (`MYCO_VIEWER_PERF_DIR=/private/tmp/viewer-fix2-perf MYCO_VIEWER_PERF_REPORT=<json> pnpm --filter viewer e2e perf.pw.ts`). Its "Final verdict" rows use its own harness and agree with the table above to within a few ms. Times are milliseconds. Pass/fail compares the maximum with the budget.

| Run | Metric | Budget | N | Min | Median | p95 | Max | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| normal | Open screen first paint | 300 | 15 | 56 | 56 | 60 | 60 | Pass |
| normal | Final verdict visible | 150 | 15 | 24.5 | 27.1 | 30.5 | 30.5 | Pass |
| normal | First Why rows | — | 15 | 72.6 | 75.9 | 78.2 | 78.2 | — |
| normal | Keyboard input → render proxy | 50 | 15 | 2.5 | 11.3 | 12.9 | 12.9 | Pass |
| refuted-autocorrect | Final verdict visible | 150 | 15 | 25.8 | 27.8 | 33.8 | 33.8 | Pass |
| refuted-autocorrect | Keyboard input → render proxy | 50 | 15 | 7.6 | 11.5 | 12.5 | 12.5 | Pass |
| kill | Final verdict visible | 150 | 15 | 23.9 | 25.6 | 27.5 | 27.5 | Pass |
| kill | Indexed and usable | — | 15 | 57.1 | 59.2 | 61.3 | 61.3 | — |
| perf-1000 | Final verdict visible | 150 | 15 | 38.6 | 42.7 | 43.5 | 43.5 | Pass |
| perf-1000 | Indexed and usable | 800 | 15 | 86.8 | 92.3 | 93.4 | 93.4 | Pass |
| perf-1000 | Keyboard input → render proxy | 50 | 15 | 10.4 | 11.4 | 12.6 | 12.6 | Pass |
| perf-1000 | Scrub input → playhead and selected row render proxy | 16 | 300 | 3.4 | 4.7 | 5.4 | 5.9 | Pass |
| perf-1000 | Scrub input → Inspector commit | 50 | 300 | 2.1 | 3.1 | 3.6 | 4.0 | Pass |
| perf-10000 | Final verdict visible | 150 | 15 | 122.4 | 126.4 | 127.7 | 127.7 | Pass |
| perf-10000 | First Why rows | 500 | 15 | 236.8 | 245.4 | 264.3 | 264.3 | Pass |
| perf-10000 | Indexed and usable | 4000 | 15 | 236.8 | 245.4 | 264.3 | 264.3 | Pass |
| perf-10000 | Keyboard input → render proxy | 50 | 15 | 4.2 | 8.9 | 15.0 | 15.0 | Pass |
| perf-10000 | Scrub input → playhead and selected row render proxy | 16 | 300 | 5.1 | 6.0 | 6.9 | 7.6 | Pass |
| perf-10000 | Scrub input → Inspector commit | 50 | 300 | 3.8 | 4.5 | 5.2 | 5.9 | Pass |

The adjacent rAF interval is a display-cadence diagnostic, not an input latency. It is 16.5–16.8 ms at the measured 60 Hz cadence for both generated runs (median 16.63 ms, N = 300). It is above the 16 ms reference by display refresh alone. The input-to-render proxy above is the scrub budget measurement.

**Bundle.** Initial JS is **189,581 B gzip** (576,894 B raw), under the 200,000 B gzip limit (189,058 B gzip before the two-worker change). Fonts total 88,912 B (limit 120,000 B). CSS alone is 33,218 B raw / 6,719 B gzip, and the single HTML is 729,047 B.

## Remaining cost

The cost is measured, not re-profiled in the browser this round. A Node profile of the same 10,000-step input (V8, warm) measures `result.json` read 3 ms, parse 10 ms and schema validation 12 ms. For `trace.jsonl` (90,001 lines) it measures read 7 ms, JSON parse 28–30 ms and schema validation 45–55 ms. The trace is now the critical path: about 80–90 ms of single-thread work on the trace worker, followed by the cross-file checks and verdict classification (earlier instrumented browser probes measured them at about 11 ms and about 3 ms), then the main-thread commit and the two animation frames that bound the timer (roughly 17–25 ms). The result worker finishes well before the trace worker. Per-stage browser timings were not re-collected for the new pipeline.

Further headroom, if the 10–14 ms margin proves too thin on other hardware: split the trace scan by byte range across the idle second worker (needs line-number and `activeStep` fix-ups at the join) or compile the schemas to closures (needs a differential test against `schemas/validate.ts`). Neither was done: the budget is met on the specified machine without them.

## Limits of this evidence

- Chrome Stable (the browser named in the spec) could not run here, so the numbers are for Playwright Chromium headless shell 159.
- One machine, one sitting, N = 20. The nearest-rank p95 at N = 20 is the second-largest sample.
- The verdict timing above covered manifested inputs up to 33.6 MB. The screenshot benchmark below uses a larger manifested input. Responsiveness throughout the full indexing window remains unmeasured.

## Timing definitions

- Open screen first paint is Chromium's first-contentful-paint from file navigation.
- Load marks begin on the app's drop event. The harness preloads local file handles outside the timer, then dispatches a drop with those same handles. Final verdict timing ends two animation frames after the committed terminal verdict (`data-verdict-final="true"`). First Why rows and indexed and usable use the same render proxy; the latter also requires the worker's completion to be reflected in the DOM. The kill record has zero steps, so its indexed measurement uses the empty Why list.
- Scrub uses actual Playwright mouse drags in Why, approximately 2% to 99.9% of the timeline. A capture listener marks pointer input. The Inspector commit mark requires changed slider selection and matching Inspector text. The next animation frame is a conservative render proxy for the playhead and selected row. Neither is a compositor presentation timestamp.
- Keyboard uses physical Playwright key events and measures from `J` to the next frame after the matching Inspector and playhead update.
- The verdict fixtures have no step-linked screenshots. The benchmark below uses a dedicated screenshot run.

## Screenshots: select latency and memory at 1,000 screenshots (MVD-008)

Apple M4 Pro (14 cores, 24 GiB), macOS 27.0 (26A428), arm64. Playwright 1.65.1 Chromium headless shell 159.0.8154.6 (revision 1255), offline at 1440×900. Both builds use Playwright’s default headless launch flags, including `--headless`, `--no-sandbox`, `--disable-background-networking` and `--enable-unsafe-swiftshader`, with no custom flags and no `--single-process`. The benchmark JSON records the exact command line.

The deterministic folder contains 1,000 distinct 1440×900 synthetic desktop PNGs (270,637–271,405 bytes each, 271,054,803 PNG bytes, 274,011,763 total file bytes). The generator extends the verified fixture’s result, trace and ledger records and emits a SHA-256 manifest. Each step links its own PNG through a §6.4 screenshot event. The harness asserted the terminal `Verified` verdict and 1,000 steps before every measurement.

Each keyboard pair uses a fresh page. It selects a previously unopened full image with J, moves away with J, then reselects it with K. The scrub uses one held mouse drag across the filmstrip, pausing each move for its distinct target image. Each timing series discards its first sample. Capture listeners mark the physical Playwright key or pointer event. Preview time ends at the first rAF with a visible decoded 96 px image. The first-frame count is relative to the first rAF with the new selection committed. Full-image time ends one rAF after the correct Inspector image is in the viewport and its own `img.decode()` has resolved at 1440×900. These frame boundaries are render proxies. The full-image budget compares the maximum and p95 is nearest rank. Preview statistics include only selections where a preview appeared.

Memory uses a separate fresh browser, with sampling about every 200 ms from opening the manifested folder through 320 distinct keyboard-selected full images, 181 mouse moves across the scrubber end to end, and a 2 s settle. Both benchmark phases run serially. Only the launched browser’s CDP-reported PIDs are passed to `ps`. MB is decimal.

Latency entries are **min / median / p95 / max (N)**.

| Metric | Before | After | §8 after |
| --- | ---: | ---: | --- |
| Cold keyboard select, full (ms) | 54.7 / 64.3 / 69.3 / 70.4 (20) | 59.0 / 63.2 / 69.0 / 69.1 (20) | Pass ≤ 250 ms |
| Cold keyboard select, preview (ms) | 4.7 / 9.9 / 15.5 / 16.2 (20), 20/20 first frame | 4.9 / 11.6 / 16.8 / 17.8 (20), 20/20 first frame | Pass |
| Cached keyboard reselect, full (ms) | 63.8 / 65.5 / 66.4 / 67.0 (20) | 46.8 / 48.9 / 49.8 / 49.9 (20) | Pass ≤ 100 ms |
| Cached keyboard reselect, preview (ms) | 14.2 / 15.6 / 16.4 / 16.5 (20), 20/20 first frame | — (0), 0/20 first frame | Full image first |
| Cold filmstrip scrub, full (ms) | 49.6 / 51.0 / 65.5 / 67.9 (20) | 48.5 / 50.1 / 51.5 / 51.7 (20) | Pass ≤ 250 ms |
| Cold filmstrip scrub, preview (ms) | 15.0 / 15.0 / 15.0 / 15.0 (1), 0/20 first frame | — (0), 0/20 first frame | Miss **only when the seek target has no decoded thumbnail** (see the preview note below) |
| Open screen RSS (MB) | 324.8 | 325.8 | — |
| Loaded RSS, before selecting a full image (MB) | 541.1 | 547.7 | — |
| Browsing peak RSS (MB) | 1,696.5 | 1,370.5 | — |
| Peak total process RSS (MB) | 1,871.3 (76 samples) | 1,575.5 (76 samples) | **MISSED** ≤ 400 MB on this headless shell (see the memory note below) |
| Renderer / browser / GPU / network RSS at total peak (MB) | 1,579.6 / 163.8 / 86.1 / 41.7 | 1,310.5 / 128.5 / 94.8 / 41.7 | — |
| Settled RSS, 2 s after scrub (MB) | 1,595.7 | 1,561.6 | — |
| Peak / settled page JS heap (MB) | 42.4 / 27.6 | 41.9 / 34.2 | — |
| Peak / settled DOM nodes | 30,622 / 18,102 | 37,756 / 22,879 | — |
| Peak / settled tracked worker ImageBitmaps | 65 / 64 | 1 / 0 | — |
| Peak / settled full image URLs | 1 / 1 | 13 / 12 | ≤ 64 cache entries |
| Peak / settled thumbnail URLs | 35 / 34 | 35 / 34 | Visible consumers only |

The image worker sends the original full PNG or WebP to the browser decoder and requests a resized bitmap for the thumbnail. The Inspector and lightbox reuse the decoded image’s URL. The Viewer retains up to 64 full image entries with a 64 MiB decoded-pixel estimate cap, which fits 12 of these 1440×900 frames plus a transient in-flight image. The worker retains zero full bitmaps after browsing, down from 64. The selected preview reads through the shared thumbnail cache on the first render and moves ahead of background thumbnail jobs if still queued. The regression test verifies the preview-to-full handoff, lightbox, and URL reuse.

Thumbnail requests come from mounted virtual-list rows, sampled slots on the visible filmstrip axis, and the selected Inspector. The Viewer releases a thumbnail URL when its last consumer unmounts. There is no extra thumbnail prefetch beyond the visible views, so it stays within the ±20 allowance. A scrub can land outside the ready thumbnails. Those cold targets missed the first-frame preview criterion. Cached reselects went straight to the full image.

Exact commands from the repository root (the baseline HTML was built at `e8f70b2` before editing and copied to `/private/tmp/mvd-008/before.html`):

```sh
pnpm install --offline --frozen-lockfile
mkdir -p /private/tmp/mvd-008
node viewer/scripts/gen-screenshot-run.mjs /private/tmp/mvd-008/run
pnpm --filter viewer build
export PLAYWRIGHT_BROWSERS_PATH=/private/tmp/myco-stage4-browsers
cd viewer
node scripts/screenshot-bench.mjs /private/tmp/mvd-008/before.html /private/tmp/mvd-008/run 20 > /private/tmp/mvd-008/before-final.json
node scripts/screenshot-bench.mjs dist/myco-viewer.html /private/tmp/mvd-008/run 20 > /private/tmp/mvd-008/after-final.json
```

The generator takes a new output directory outside the repository. It uses fixed seed `0x4d59434f`; no image artifacts are checked in. The benchmark JSON also emits the raw latency samples.

RSS sums the browser, renderer, GPU and network utility processes listed by CDP. Shared pages can be counted by multiple PIDs, and RSS includes an idle browser baseline. It excludes Node, external processes, swapped/compressed pages and any GPU memory outside those processes. The sampled maximum can miss shorter spikes. `JSHeapUsedSize` and `Memory.getDOMCounters` describe the page target and do not account for worker/V8 or native image allocations. The harness wraps image URL creation/revocation and the image worker’s bitmap creation/close during the memory pass only. It counts app-owned resources. Chromium’s native decoder cache and actual residency of decoded `HTMLImageElement` pixels are opaque to the harness. These results are from one before/after pair on one machine (start load averages 7.23 / 7.83 / 7.89), so treat small timing changes as run-to-run noise.

### Independent re-measurement and corrections (Claude verifier, same machine, serial runs)

An independent verifier re-ran the harness and its own, N=15 per metric after one discarded warmup, offline, 1440×900. Latency reproduces within noise: repo harness cold keyboard select 56.8 / 64.1 / 70.0 / 70.0 ms (min / median / p95 / max), cached reselect 47.4 / 48.8 / 49.5 / 49.5 ms, cold filmstrip scrub 50.1 / 50.2 / 50.3 / 50.3 ms. The verifier's own harness ends one animation frame earlier and read lower (cold 37.0 / 42.9 / 66.7 / 66.7 ms, cached 31.0 / 32.0 / 33.8 / 33.8 ms); the pass/fail outcome is the same and every sample is more than 3× inside budget. The strict 10,000-step verdict guard is unchanged by this PR (median 126.8 ms, max 129.7 ms against the 150 ms limit, N=20).

**Memory: MISSED, and the retained memory is not held by the app.** The sampled "total RSS" mixes the browser baseline with the run. Same shell, same machine:

| State | RSS | Private footprint |
| --- | ---: | ---: |
| Idle viewer on a tiny verified fixture | 382–391 MB (browser 97, renderer 175–182, GPU 72, network 39) | 125–130 MB |
| 1,000-screenshot run loaded, idle | 520 MB | 202 MB |
| After 700 browsed steps and an end-to-end scrub, settled | 1,531 MB | 1,161 MB |
| Run-attributable delta | about +1,150 MB | about +1,030 MB (renderer about +930 MB) |

The app-held state is small: JS heap about 17–42 MB, 12 live full-image URLs and about 35 thumbnail URLs. The rest is native renderer memory. After four forced GCs, `Memory.forciblyPurgeJavaScriptMemory` and a critical memory-pressure notification, the renderer footprint was still about 888 MB, so the LRU does **not** bound it. It keeps growing with the number of distinct steps viewed (about 0.4 MB per step at 1440×900 between steps 100 and 700, decelerating but not plateaued). On `main` the same test reached 1,745 MB RSS; this PR removes about 350 MB of JS-held bitmap garbage but the retained native floor is essentially unchanged. The root cause is **not isolated** (suspects: Chromium's decode and resource caches, and worker allocator retention of full-size PNG decodes, including the thumbnail path that decodes each full PNG). Under the most generous accounting (renderer-only private footprint delta after purge, about 750 MB) it is still about 2× over 400 MB. The spec does not define its accounting, and headless shell with SwiftShader may place decoded images differently from Chrome Stable with GPU raster, so on the spec's target browser this budget is **undecided**, not passed. Follow-up: MVD-009.

**Preview note.** Clicking a visible filmstrip thumbnail shows that thumbnail's preview in the first frame (13/13 clicks in the independent check, 8.7–15.5 ms). The 0/20 above is for arbitrary-position drags, whose target step usually has no decoded thumbnail, so the Inspector shows "Loading screenshot" for 1–2 frames while the full image completes at about 25–45 ms. There is no honest cheap fix: the thumbnail needs the same full PNG decode plus resize as the full image, and showing a neighbouring step's thumbnail would mislabel evidence.

**Limits to know.**
- The effective full-image cache at 1440×900 is **12 entries**, not the spec's 64, because of the 64 MiB decoded-pixel estimate cap. The estimate does not bound Chromium's native decode memory. Recorded in `DEVIATIONS.md` as a decision for the outer loop.
- Full images are now decoded by the browser's `<img>` decoder, which is permissive: a truncated or partially corrupt PNG whose manifest digest still matches (so the run stays Verified) shows a partial image in the Inspector while the list thumbnail says "Screenshot unavailable". On `main` both said "Screenshot unavailable". The content is real file content, not fabricated, but there is no truncation indicator. Recorded in `DEVIATIONS.md`.
- The generator needs Node 22.2 or later (`zlib.crc32`).
- The e2e change moved three `viewer/screenshots/viewer-test-screenshot-*.png` captures to the Playwright output path, so the tracked copies are stale.
- Chrome Stable was not measured by anyone.

### Chrome Stable spot-check (Tiffany; NOT run by the build agent)

- Result: _pending: Tiffany to fill in. Build environment could not launch Chrome Stable (SIGABRT); every number above is Playwright's headless Chromium._
- Suggested steps: open `viewer/dist/myco-viewer.html` in Chrome Stable, open the verified fixture and a 10,000-step perf run, confirm the verdict appears within about a frame or two of drop, step/scrub feels instant, and note Chrome version/OS.

## Screenshots: bounded retained memory (MVD-009 / TIF-64)

The hard **400,000,000-byte** gate remains open. All three saved runs of the prior
implementation exceeded it on summed peak physical footprint and peak RSS. One offline
Chromium Headless Shell rerun of the measured-width build sampled 373,229,920 B peak
renderer footprint, 457,070,232 B peak summed footprint, and 838,172,672 B peak summed
RSS (38 sample rows, same synthetic workload). The wide PNG and original-only fallback
browser tests passed on this build. Chrome Stable remains unmeasured.

### Saved Headless Shell measurements

Apple M4 Pro, macOS 27.0, Chromium Headless Shell 159.0.8154.6 (Playwright 1.65.1),
offline at 1440×900 and DPR 1. Each fresh browser opens the same folder of 1,000 synthetic
1440×900 PNGs, selects 320 distinct steps, scrubs across the full range and settles for 2 s.
Each run has 38 rows. The sampler waits 400 ms after collecting a row and takes physical
footprints every third row and at checkpoints, reading PIDs sequentially. Short spikes can
fall between samples and RSS and footprint can peak at different times. The folder workload
does not cover archive copies, the lightbox, high DPR or visiting all 1,000 full images.
The saved runs were serial on a shared host.

| Build and run | Peak summed RSS (B) | Settled summed RSS (B) | Peak summed footprint (B) | Settled summed footprint (B) | Peak renderer footprint (B) | Settled renderer footprint (B) | Peak summed footprint minus each run’s idle (B) | Raw result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Baseline 1 | 1,570,488,320 | 1,557,135,360 | 1,204,017,704 | 1,190,910,504 | 1,102,187,520 | 1,090,653,184 | 1,110,181,616 | `base-full-1.json` |
| Baseline 2 | 1,571,176,448 | 1,566,998,528 | 1,209,146,016 | 1,204,951,712 | 1,113,033,800 | 1,108,839,496 | 1,115,408,256 | `base-full-2.json` |
| Baseline 3 | 1,575,616,512 | 1,571,700,736 | 1,210,850,072 | 1,206,917,912 | 1,115,360,328 | 1,111,428,168 | 1,117,783,888 | `base-full-3.json` |
| Prior implementation 1 | 863,633,408 | 852,410,368 | 482,072,120 | 430,528,128 | 390,056,288 | 348,539,304 | 388,252,440 | `view64-mem-1.json` |
| Prior implementation 2 | 860,864,512 | 852,688,896 | 467,981,952 | 436,999,808 | 385,042,808 | 353,225,080 | 373,949,208 | `view64-mem-2.json` |
| Prior implementation 3 | 896,581,632 | 888,995,840 | 498,833,144 | 459,085,584 | 416,975,272 | 376,310,208 | 405,472,072 | `view64-mem-3.json` |

The prior implementation missed summed peak and settled footprint and summed peak and settled
RSS in all three runs. Two of three met peak renderer footprint and peak summed footprint
minus idle. All three met settled renderer footprint. The worst summed peak footprint missed
by 98,833,144 B. Renderer-only, settled and idle-subtracted figures describe separate metrics.

Raw run outputs are retained locally. Artifact SHA-256 values follow.

- Baseline `base.html` (recorded as `3379ab3` in the builder handoff)
  `f8f4c482fd9b49191eff2632fe494dcd9a389f68cf858e8a47f6fb60e814b591`.
- Prior implementation `view64.html` (fixed 560 px CSS width × DPR)
  `ace20435a8abf0b33ef4ace075e3334c40e98ed00290fc6672def9f565b18305`.
- Measured-width build `dist/myco-viewer.html`
  `fc85fc972bb57b2d3d51417c417e2ce1f4720ef679c7bd64689b30615b5740bd`.

The saved latency runs use the same workload and timing approach, adapted for canvas.
The timer checks visible Inspector image metadata and a paint opportunity. Each row has 20
samples after one discarded warmup. Original-size lightbox timing remains open.

| Inspector latency | Baseline median / max | Prior implementation median / max | Budget |
| --- | ---: | ---: | ---: |
| Cold keyboard | 64.7 / 70.5 ms | 48.8 / 54.9 ms | ≤250 ms |
| Cached keyboard | 48.9 / 49.6 ms | 32.2 / 32.7 ms | ≤100 ms |
| Cold drag | 50.2 / 50.8 ms | 33.4 / 51.1 ms | ≤250 ms |

Both saved runs had a first-frame preview in 20/20 cold keyboard samples and 0/20 cold drag
samples (`lat-base.json`, `lat-view64.json`). After a 40-step revisit, the 64-entry
variant took 26.4 ms median versus 45.7 ms at 12 entries. The harness did not assert asset
identity for that comparison. The strict 10,000-step verdict guard intermittently exceeded
150 ms before and after. Regression status remains unresolved.

### What the evidence isolates

The baseline full-image DOM path is the dominant measured contributor. In the 160-selection
diagnostic, thumbnail-only, full-image-only and combined runs settled at 195, 769 and 784 MB
renderer footprint respectively (`base-no-full-1.json`, `base-no-thumbs-1.json`,
`base-control-1.json`). The zero-cache baseline settled at 1,098–1,107 MB, overlapping the
normal baseline. Full-resolution worker bitmaps with a 12-entry cache settled at 377–389 MB.
Native region totals cannot identify allocation owners. In one cycling run over 100 distinct
steps, footprint grew more slowly and nonmonotonically with bitmaps (`base-cycle-1.json`,
`view64-cycle-1.json`). The cause of the residual footprint remains unverified.

### Implementation

- The Inspector decodes to the rendered width rounded up to a 32 CSS px bucket, multiplied
  by DPR and capped at the source width. Width and DPR are part of the view cache key. Resize
  and DPR changes are coalesced with a 100 ms trailing update. Only the lightbox requests
  original pixels, and it releases them on close.
- The view LRU holds up to 64 entries and 64 MiB of bitmap pixels. Live evicted entries,
  canvas backing stores, originals and in-flight work are outside that accounting.
- The worker checks PNG chunk CRCs and IEND and WebP RIFF structure before decode. These
  checks and decoder rejection drive the warning. Compressed pixel data accepted by the
  decoder has no independent validation. A failed bitmap transfer releases the worker bitmap
  and reports unavailable.
- Canceled active jobs waiting for the run skip the archive read. Selection work already
  takes precedence in the queue, which has two active slots. Two in-flight thumbnails can
  still make a selection wait. Simultaneous same-path jobs can repeat encoded reads and
  container scans. The saved runs do not isolate savings from reserving a slot or sharing
  encoded data, so scheduling and sharing policy remain as before.

### Reproduce

```sh
pnpm install --offline --frozen-lockfile
bench_dir="$(mktemp -d)"
node viewer/scripts/gen-screenshot-run.mjs "$bench_dir/run"
pnpm --filter viewer build
pnpm --filter viewer exec playwright install --only-shell chromium
cd viewer
# memory: footprint of the launched PIDs, one fresh browser per run
MYCO_SCREENSHOT_BENCH_PHASE=memory MYCO_SCREENSHOT_BENCH_FOOTPRINT=1 \
  node scripts/screenshot-bench.mjs dist/myco-viewer.html "$bench_dir/run" 15 > after-mem.json
# one-factor diagnostics: MYCO_SCREENSHOT_BENCH_DIAGNOSTIC=control|no-full|no-thumbs (160 steps),
# MYCO_SCREENSHOT_BENCH_CYCLE=100 (700 presses over 100 distinct steps),
# MYCO_SCREENSHOT_BENCH_NATIVE_DUMP=<prefix> (vmmap and footprint of the renderer at the end)
# latency (N = 20): MYCO_SCREENSHOT_BENCH_PHASE=latency; MYCO_SCREENSHOT_BENCH_REVISIT=40 reselects after 40 steps
MYCO_SCREENSHOT_BENCH_PHASE=latency node scripts/screenshot-bench.mjs dist/myco-viewer.html "$bench_dir/run" 20 > after-lat.json
```
