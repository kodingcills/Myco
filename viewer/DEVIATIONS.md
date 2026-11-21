# Viewer Stage 2 decisions

- Now is omitted per §9. Why can be selected with its tab or `2` and shows a short unavailable state until Stage 3. Source chips open Raw in Proof, including trace references that will navigate to Why in Stage 3.
- Open opens a two-option picker menu. This gives `Mod+O` a keyboard path to both native picker types while preserving the single empty-state button.
- Stored sidebar references contain only names, run IDs, and open times. A reload requires choosing the local files again, and restores hash selection when the matching run is reopened.
- A fixed-height sidebar allows overflow scrolling when runs exceed the viewport so the entire ARIA tree remains reachable. The fixed Verdict Bar keeps its rule transition, while verdict words update immediately so provisional evidence never lingers during a fade.
- Input artifacts have a start time and event timestamps, but no terminal elapsed-duration field. The header shows the recorded start in the viewer's time zone. It does not label the last trace event as run completion.
- Before a trace finishes, absent trace counts read `not recorded` rather than zero. A witnessed absence in the persisted store reads `absent`; `not recorded` is reserved for missing evidence. The two were distinguishable in the Stage 1 data model.

## Stage 3 decisions

- A Proof trace reference with a step opens Why in Detail, following J2. Clicking an evidence chip from Why opens Raw at the source. Result check references and trace lines without an identifiable step remain available directly in Raw.
- Why rows follow the recorded result's step order and use the real step IDs for selection. Legacy observations often lack a step ID. The join uses the last preceding observation with the recorded before-state version when it encounters the step's action or guard. Unscoped fault and recovery events use the active trace step. The next action after a recovery tied to a failed step is indented as a recovery attempt. Unlinked run-level events remain accessible through Proof.
- An unresolved check is marked only when the trace ties it to a step. A fault injection uses the secondary text color with its own glyph and label because §1.1 reserves verdict colors for verdict semantics. A step can have several marks. Where marks overlap on the timeline, a guard failure has priority, followed by recovery, unresolved, and fault.
- The timeline uses recorded elapsed time when step offsets are strictly increasing. Missing, duplicate, or non-monotonic timestamps switch the ruler to step order. Wheel and +/− zoom around the cursor or playhead. Drag the range edges to resize, drag inside to pan, and Shift+drag to draw a new range. The brush draws at its 24-unit lane height with a 28-unit hit target extending into the marker lane. Both mode layouts keep the Scrubber in place.
- Screenshots require a step-linked event or a matching PNG/WebP and metadata file with an explicit step ID. An unscoped capture such as the M1 mid-typing artifact stays unassigned. Filmstrip slots are sampled from the visible axis and clipped at its edges. Raw shows original trace lines and pretty-prints JSON pointer excerpts. Step rows expose their evidence through the Inspector so the virtual listbox can keep a single Tab stop.
- Inspector width persists locally and is constrained by the available center width on desktop. Below the minimum design viewport the Inspector overlays the center. Panel collapse and expand are immediate for both pointer and keyboard input. State-diff artifacts are accessible as source links and have no dedicated view in v0.
- The opt-in browser render test uses MYCO_VIEWER_PERF_DIR after building the viewer and skips when the generated 1,000-step fixture is absent. MYCO_VIEWER_CHROMIUM optionally selects a local Chromium executable.

## Stage 4 decisions

- Proof includes recorded state-version transitions to cover J1. Every step and version links to its source. State-diff evidence stays under its existing Inspector source link.
- The Verdict Bar now updates its rule immediately in this finished-run viewer. Seek updates commit during the pointer event. Range-brush updates remain frame-coalesced, and the sidebar resize handle stays inside the rail so it leaves the left edge of the playhead lane accessible.
- Check rows retain the outcome badge specified by §2.6 for each check. A passing check in a refuted run can therefore be green inside Checks while the run verdict is Failed. This needs outer-loop clarification against §5's broader wording.

## v0 conformance decisions

- The viewer parses the result first. A scored result can display a sourced Unknown while the worker checks the remaining evidence. The worker must finish trace validation, integrity checks, and cross-file checks before a positive run verdict can display. J1 timing measures the final verdict. See [PERF.md](PERF.md) for the 10,000-step budget miss.
- A supplied manifest must identify the result and cover the required files and supplied viewer evidence. The viewer checks every listed SHA-256 against the original bytes. A folder or pair without a manifest can still be scored using its schema and cross-file evidence. That form can detect missing run starts, mismatched identity, missing recorded actions or guards, and failed steps whose corresponding failure and recovery events are both missing. A matching unsigned manifest establishes consistency within the selected files. It does not authenticate the producer.
- The recovery classification ignores `none`. Aborted recovery remains Unknown. Failed and incomplete attempts require recorded completion. The guard-failure fallback accepts a new passing postcondition from the failed step or its immediate continuation in the recorded state. A continuation needs a matching action after the failure. The postcondition must match the result and the step must have no earlier passing postcondition.
- Up/Down move the playhead globally when the focused widget leaves those keys available. A multi-row Comparator keeps its roving Up/Down. J/K remain available from every Comparator row. Collapsing a focused sidebar or Inspector moves focus to the Verdict Bar or center respectively. Reopening from that fallback restores focus to the previous control when available.
- Why row time and guard summaries name their sources in their tooltips. A source strip alongside the selected row's list exposes the corresponding controls in the next Tab stop sequence. The listbox has one Tab stop and its options remain free of nested controls. Clicking a Verdict Bar count opens the contributing evidence list. The result/trace links still open Raw or J2's Why Detail as appropriate.
- A recorded screenshot shows a loading state while neither size is decoded. The decoded thumbnail stays visible until the browser has decoded the full image. Decode failure has its own unavailable state. The image lifecycle test uses an independent viewer-only session with a generated image.

## PR #69 review follow-up

- An unscoped recovery or fault source carries the preceding scoped step in the staged trace payload. Its chip resolves to the same step in Why before and after indexing. A source without step context opens Raw.
- The Runs sidebar keeps the newest open for each known run ID. A superseded worker is aborted as soon as the duplicate is identified. Different run IDs keep separate entries in open order.
- The 10,000-step verdict improved to **133.2 ms median and 179.9 ms max** in the isolated Chromium benchmark. The 150 ms maximum remains open. See [PERF.md](PERF.md) for the comparable runs and worker/main profile.

## Remaining v0 gates

- Exact J2 evidence. The checked-in M1 normal run passed verification, and its mid-typing capture lacks a step association. The refuted M1 result is a live-document mismatch before persisted readback. The Foundry false-success fixture verifies the keyboard journey using its own claim, absent value, and check source. The exact B39 disagreement, trace line, and step-linked capture require the corresponding authoritative run.
- Full J3 screenshot experience on a real run. The viewer-only test verifies the loading, preview, full-image and lightbox states. It leaves the real evidence unchanged.
- The 150 ms final Verdict Bar limit at 10,000 steps. The diagnostic result and hard limit are recorded in [PERF.md](PERF.md).
- Scrub input to playhead and selected-row rendering. This gate uses its own input-to-render measurement. The adjacent rAF interval is reported separately.
- Screenshot budgets. Cached and cold full-image latency and memory at 1,000 screenshots remain unmeasured.
- Chrome Stable and CI. Repeat on the specified M-series Chrome Stable setup and enforce the hard limits in CI. Printed diagnostics and the current fixture test do not enforce those limits.
- §2.6 CheckRow and §5 color conflict. Passing checks still use their check-level Verified badge. Outer-loop interpretation is pending.
- Written sign-off for the earlier layout tokens and individual deviations remains pending.
- Grok Bot screenshot review and attaching the refreshed screenshots to PR #69 remain pending.
