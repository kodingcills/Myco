# Myco Viewer performance

Apple M4 Pro, 24 GiB RAM, macOS 27.0 (26A428), Playwright Chromium Headless Shell 159.0.8154.6, 1440×900 CSS pixels, offline. This is Playwright's pinned headless Chromium. The GUI spec names Chrome stable, so the results describe this browser build. Cases ran serially. Each timed run discarded one warmup and then used 15 fresh pages. Each scrub pass contributed 20 measured drag movements, for 300 samples per fixture. Sizes are deterministic measurements of the built file and use decimal byte limits.

**Budget misses** · perf-1000 drag frame interval 16.8 ms max against 16 ms, perf-10000 drag frame interval 16.8 ms max against 16 ms.

## Reproduce

From the repository root after installing dependencies:

```sh
export PLAYWRIGHT_BROWSERS_PATH="$(mktemp -d /tmp/myco-viewer-browsers.XXXXXX)"
pnpm --filter viewer exec playwright install --only-shell chromium
pnpm --filter viewer build
export MYCO_VIEWER_PERF_DIR="$(mktemp -d /tmp/myco-viewer-perf.XXXXXX)"
npx tsx scripts/gen-viewer-fixtures.ts --perf "$MYCO_VIEWER_PERF_DIR"
MYCO_VIEWER_PERF_REPORT=/tmp/myco-viewer-perf.json pnpm --filter viewer e2e perf.pw.ts
pnpm --filter viewer e2e viewer.pw.ts
```

This run used `/tmp/myco-stage4-browsers` and `/tmp/myco-viewer-perf.Jx3XIA`. After rebuilding, the final invocation set `MYCO_VIEWER_PERF_REPORT=/tmp/myco-stage4/after.json` and ran `pnpm --filter viewer e2e`. The generator produced 3,344,077 B of result and trace JSON for 1k steps (9,001 trace lines) and 33,592,186 B for 10k steps (90,001 trace lines).

## Timing definitions

- Open screen first paint is Chromium's first-contentful-paint from file navigation.
- Load marks begin on the app's drop event. The harness preloads local file handles outside the timer, then dispatches a drop with those same handles. Verdict timing ends after the first committed terminal verdict has a render opportunity. To expose the first Why rows, the harness switches modes immediately after that point.
- First Why rows and indexed and usable use the same render proxy. The latter also requires the worker's completion to be reflected in the DOM and the Why list to be present. The kill record contains zero steps. Its indexed measurement uses the empty Why list. Keyboard input and virtualization are exercised separately after indexing. A second animation frame bounds the render opportunity for load metrics and can overcount by a frame.
- Scrub uses actual Playwright mouse drags in Why, approximately 2% to 99.9% of the timeline. A capture listener marks pointer input. The Inspector commit mark requires changed slider selection and matching Inspector text. React's layout effect has drawn the playhead by then. The next animation frame is a conservative render proxy. The frame interval is the difference between adjacent rAF timestamps around the update, so the observed 60 Hz cadence alone is about 16.7 ms. Both metrics are shown against 16 ms. Neither is a compositor presentation timestamp.
- Keyboard uses physical Playwright key events and measures from `J` to the next frame after the matching Inspector and playhead update. Kill has no step to select.
- The fixture set has no step-linked screenshots. Cached and cold full-image latency, the 1,000-screenshot memory budget, and responsiveness throughout the full indexing window were not measured. The harness verifies that the generated runs mount fewer than 50 of their steps at once.

## Final measurements

Times in milliseconds. Pass/fail compares the measured maximum with the stated limit.

| Run | Metric | Budget | N | Median | Min | p95 | Max | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| normal | Open screen first paint | 300 | 15 | 52 | 52 | 60 | 60 | Pass |
| normal | Verdict visible | 150 | 15 | 30.7 | 29.3 | 45.7 | 45.7 | Pass |
| normal | First Why rows | — | 15 | 80.7 | 78.5 | 95.6 | 95.6 | — |
| normal | Indexed and usable | — | 15 | 80.7 | 78.5 | 95.6 | 95.6 | — |
| normal | Keyboard response | 50 | 15 | 10.9 | 7.3 | 13 | 13 | Pass |
| refuted-autocorrect | Open screen first paint | 300 | 15 | 56 | 52 | 64 | 64 | Pass |
| refuted-autocorrect | Verdict visible | 150 | 15 | 43.4 | 29.3 | 53.4 | 53.4 | Pass |
| refuted-autocorrect | First Why rows | — | 15 | 93.5 | 79.3 | 102.1 | 102.1 | — |
| refuted-autocorrect | Indexed and usable | — | 15 | 93.5 | 79.3 | 102.1 | 102.1 | — |
| refuted-autocorrect | Keyboard response | 50 | 15 | 11.3 | 8.1 | 13.6 | 13.6 | Pass |
| kill | Open screen first paint | 300 | 15 | 56 | 52 | 60 | 60 | Pass |
| kill | Verdict visible | 150 | 15 | 44.8 | 29.4 | 46.5 | 46.5 | Pass |
| kill | Indexed and usable | — | 15 | 78.1 | 62.2 | 79.7 | 79.7 | — |
| perf-1000 | Open screen first paint | 300 | 15 | 56 | 56 | 60 | 60 | Pass |
| perf-1000 | Verdict visible | 150 | 15 | 46.4 | 44 | 60.9 | 60.9 | Pass |
| perf-1000 | First Why rows | — | 15 | 95.4 | 93.1 | 111.1 | 111.1 | — |
| perf-1000 | Indexed and usable | 800 | 15 | 95.4 | 93.1 | 111.1 | 111.1 | Pass |
| perf-1000 | Keyboard response | 50 | 15 | 11.5 | 10.2 | 13 | 13 | Pass |
| perf-1000 | Drag input → render proxy | 16 | 300 | 4.4 | 3.2 | 4.9 | 5.7 | Pass |
| perf-1000 | Drag frame interval | 16 | 300 | 16.63 | 16.5 | 16.7 | 16.8 | **Fail** |
| perf-1000 | Drag input → Inspector commit | 50 | 300 | 2.9 | 2.1 | 3.2 | 4.1 | Pass |
| perf-10000 | Open screen first paint | 300 | 15 | 56 | 52 | 60 | 60 | Pass |
| perf-10000 | Verdict visible | 150 | 15 | 115.6 | 111.9 | 119.6 | 119.6 | Pass |
| perf-10000 | First Why rows | 500 | 15 | 257.2 | 248.3 | 280.8 | 280.8 | Pass |
| perf-10000 | Indexed and usable | 4000 | 15 | 258.2 | 249.3 | 282.1 | 282.1 | Pass |
| perf-10000 | Keyboard response | 50 | 15 | 11.9 | 3.4 | 18.4 | 18.4 | Pass |
| perf-10000 | Drag input → render proxy | 16 | 300 | 4.2 | 3.1 | 4.9 | 5.6 | Pass |
| perf-10000 | Drag frame interval | 16 | 300 | 16.63 | 16.5 | 16.73 | 16.8 | **Fail** |
| perf-10000 | Drag input → Inspector commit | 50 | 300 | 2.7 | 2 | 3.2 | 3.8 | Pass |


## Bundled assets

| Asset | Raw bytes | gzip bytes |
| --- | ---: | ---: |
| Inline initial JavaScript, including worker payloads | 553,872 | 183,341 |
| CSS only, excluding WOFF2 data URLs | 33,038 | 6,693 |
| Inter Latin WOFF2 | 48,432 | 48,440 |
| JetBrains Mono Latin WOFF2 | 40,480 | 40,513 |
| CSS with embedded fonts | 151,636 | 97,539 |


Initial JS **183,341 B gzip** (limit 200,000 B), 553,872 B raw. The two Latin WOFF2 files total 88,912 B (limit 120,000 B). CSS alone adds 33,038 B raw or 6,693 B gzip. CSS with both embedded fonts is 151,636 B raw or 97,539 B gzip. The whole single HTML file is 705,845 B raw. The gzip column compresses each payload separately, so the columns do not add up to Vite's full HTML gzip size.

## Before and after

The first instrumented build used the stage 1–3 state at `a2f6212` plus the index marker and the picker focus marker. It still scheduled seek updates through an app-side animation frame. The saved baseline HTML was copied to `viewer/dist/myco-viewer.html` and measured with `MYCO_VIEWER_PERF_REPORT=/tmp/myco-stage4/before.json pnpm --filter viewer e2e perf.pw.ts --output=/tmp/myco-stage4/perf-tests`. The optimized HTML was restored before the final run. The final build commits pointer seeks synchronously inside the browser's pointer event and keeps brush/pan updates frame-coalesced. The sidebar resize hit area stays inside the sidebar and the J1 State changes section was added between builds, so the load numbers are whole-build comparisons.

| Run | Metric | Before median / p95 / max | After median / p95 / max | N per build |
| --- | --- | ---: | ---: | ---: |
| normal | Verdict visible | 42.2 / 46.1 / 46.1 | 30.7 / 45.7 / 45.7 | 15 |
| normal | Indexed and usable | 91.8 / 96.2 / 96.2 | 80.7 / 95.6 / 95.6 | 15 |
| refuted-autocorrect | Verdict visible | 30.1 / 46.7 / 46.7 | 43.4 / 53.4 / 53.4 | 15 |
| refuted-autocorrect | Indexed and usable | 80.1 / 96.7 / 96.7 | 93.5 / 102.1 / 102.1 | 15 |
| kill | Verdict visible | 30.5 / 44.9 / 44.9 | 44.8 / 46.5 / 46.5 | 15 |
| kill | Indexed and usable | 63.7 / 78.2 / 78.2 | 78.1 / 79.7 / 79.7 | 15 |
| perf-1000 | Verdict visible | 44.4 / 60.5 / 60.5 | 46.4 / 60.9 / 60.9 | 15 |
| perf-1000 | Indexed and usable | 94.4 / 110.4 / 110.4 | 95.4 / 111.1 / 111.1 | 15 |
| perf-1000 | Drag input → render proxy | 18.4 / 19.1 / 20.1 | 4.4 / 4.9 / 5.7 | 300 |
| perf-1000 | Drag frame interval | 16.7 / 16.7 / 16.8 | 16.63 / 16.7 / 16.8 | 300 |
| perf-1000 | Drag input → Inspector commit | 2.8 / 3.7 / 8.5 | 2.9 / 3.2 / 4.1 | 300 |
| perf-10000 | Verdict visible | 109.4 / 113.9 / 113.9 | 115.6 / 119.6 / 119.6 | 15 |
| perf-10000 | Indexed and usable | 257.5 / 270.1 / 270.1 | 258.2 / 282.1 / 282.1 | 15 |
| perf-10000 | Drag input → render proxy | 18.2 / 19.7 / 21.1 | 4.2 / 4.9 / 5.6 | 300 |
| perf-10000 | Drag frame interval | 16.7 / 16.7 / 16.8 | 16.63 / 16.73 / 16.8 | 300 |
| perf-10000 | Drag input → Inspector commit | 2.6 / 3.8 / 4.3 | 2.7 / 3.2 / 3.8 | 300 |
