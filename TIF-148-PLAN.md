# TIF-148 — plan

**Goal:** make `intake()` reachable in the app, and state which `ArmSource` the app can
construct — which decides whether the scorecard can deep-link the compare table.

## What is true today (read from the source, not the summary)

- `intake(sources)` lives in `viewer/src/data/live-report.ts:161`. It is **dead code in the
  app**: the only reachable import of the module is `viewer/test/live-report.test.ts`.
- The compare view opens two ways, both by **file**: the `Compare` button (a `.json` picker,
  `App.tsx:450`) and `?compare=<url>` (same-origin only since #324). Neither builds an
  `ArmSource`.
- `ArmSourceKind` is `"myco-run-dir" | "foundry-arm" | "foundry-final" | "foundry-report"`.
  `armFromMycoResult` is the branch a run that the app already has open would take.
- A dropped run resolves through `viewer/src/data/loaders.ts`: the loader requires
  `trace.jsonl`, pairs it with `result.json`, and reads `ledger.jsonl`/`manifest.json` when
  present. So an opened run directory *is* a `myco-run-dir` source, with `content` = its
  `result.json` text.
- The scorecard links are `docs/research/experiments/m1-runs/<pack>/trial-<n>/`, and the
  viewer's deep-link form is `#?run=trial-<n>` where `run` is **the top-level directory under
  the folder you open** (`scripts/check-scorecard-links.py`). 56 such links exist.

## The design decision this PR must state

**The app can construct `kind: "myco-run-dir"` sources, one per opened run, and nothing
else without new plumbing.** A scorecard link names a run directory; opening it gives the
app `result.json`; that is exactly one `ArmSource`. So `intake()` can become reachable as
"the arms are the runs I have open", and the compare table becomes reachable by the same
`#?run=` deep link the scorecard already uses — no new URL surface, no new loader.

The consequence to state plainly in the PR: a **single** opened run yields a one-arm
comparison, which is a legitimate but thin head-to-head; the table is only meaningful with
two or more runs open, or with a foundry artifact dropped alongside. The PR will say which
of those it enables and leave the other named.

## Steps

1. Build a `RunSource` mapping in one place: an opened run's `result.json` text plus its
   path → `ArmSource { kind: "myco-run-dir", armId, path, content }`. Reuse the existing
   `runLayout`/`OpenRun` data rather than a new parse.
2. Add an app entry point that calls `intake()` over the open runs and shows the result in
   the compare view — keyboard reachable, and labelled per gui-spec (no new words; the
   provenance line already exists and must read `live`/`mixed`/`unknown` correctly).
3. Keep the run view untouched (TIF-155, merged): the run loader and trial-row links are not
   in scope, per the handoff.
4. Tests: `intake()` over two synthetic run dirs yields two arms and a `live` provenance
   only when both carry their flags; a run whose `result.json` has no verdict is refused by
   name, not invented. Negative control: the reachability test must fail if the entry point
   is removed.
5. Verify in the browser with a real committed run pair under
   `docs/research/experiments/m1-runs/`, and capture screenshots at 1440×900 for the
   outer loop (gui-spec §11).

## Not in scope

- Any launcher, runtime, or TIF-170 change.
- Changing the scorecard itself, or adding links: the outer loop adds those after the
  paired-table links exist.
