# Pre-registration (DRAFT, not frozen): confirmatory R1 on the public OSWorld office subset

> **Status: draft.** This document is not frozen and no data exists for it. The canonical
> record is [`r1-public-prereg.json`](r1-public-prereg.json). `src/benchmark/upstream/prereg.ts`
> refuses "shown" while the status is draft, while any lead ruling is pending, or while any
> field still says PENDING (#652 rule; `test/benchmark/upstream-prereg.test.ts`).

Lead ruling #675: the confirmatory R1 runs on a public subset, graded by the benchmark's own
evaluator. The armed R1 pilot on fc-v1 continues as plumbing only.

## What is fixed in this draft (before any results)

| Item | Value |
|---|---|
| **Task set** | `osworld-office-v1`, OSWorld @ `0ad41bee56565efe7bb3c3a5ebc67590a1b8276f` |
| **Subset rule** | Every task whose placement target is `linux-namespace-desktop` in `benchmark/upstream/osworld-office-v1/tasks.jsonl`. The importer computes placement from apps and evaluator getters only, before any run. No task is added or dropped for difficulty, outcome or evaluator type. |
| **Subset size** | 130 |
| **Grader** | The OSWorld metric code at the pin, run unmodified (`upstream-evaluator-grader/1`, `src/benchmark/upstream/evaluate.ts`). The gate never sees it. |
| **Arms** | (1) `myco-gate`: Claude Code with Myco's gate; it may not report done without a `verified` verdict. (2) `hcu-shell`: the same model and budget, checking its own work with hcu+shell and a good prompt (the R2 arm). (3) `screenshot-only`: the same model and budget, screenshot-only (C1-style), no gate. |
| **False done** | The agent says done. The upstream evaluator, run on the saved end state, says failed (a score below the pass threshold, or ungradable). The gate either caught it (did not return `verified`) or did not (returned `verified`: a false accept). |
| **Primary outcome** | False accepts in the `myco-gate` arm. Bar: 0, with the Wilson 95% upper bound on the false-accept rate reported. An accepted claim the evaluator cannot grade counts against the bar. |
| **Secondary outcomes** | Each arm's false-done rate and success rate under the same grader. The paired `myco-gate` vs `hcu-shell` table, with an exact sign test on discordant pairs (underpowered below 6, as R2). Cost per verified task per arm (R7). |
| **Evidence rules** | Only LIVE rows graded by the upstream evaluator count. MOCK, scripted and simulated rows are refused. Every result line states task set, n, model, baseline, grader, and live or mock. |

## Pending lead rulings (the analysis refuses "shown" while any remain)

1. **`asset-license`.** How the seed and gold files are obtained (README §1). No live run is
   possible without them.
2. **`model`.** The exact model id: the Claude Code model the R1 pilot runs on (Claude Ultra).
3. **`budget`.** One step, wall-clock and output budget, shared by all three arms.
4. **`n`.** This draft proposes 130: every desktop-ready task, one trial each. Not ratified.
   Repetitions are open.
5. **`pass-threshold`.** This draft proposes that an upstream score of exactly 1.0 is a pass.
   Most OSWorld metrics return 0 or 1; a few return fractions.
6. **`gate-oracle`.** Which gate oracle the `myco-gate` arm uses on these tasks. Today the gate
   has families for Myco's own tasks, not for generic OSWorld end states. This needs a gate
   change and a runner change, which #682 proposes for a separate PR. This PR changes neither.
7. **`harness`.** On the Linux namespace desktops: a display, a postconfig executor (upstream
   activates the window and presses Ctrl+S before grading), and end-state capture.

## Known property of the ground truth (a finding, not a fix)

Upstream evaluators can be lenient. On MOCK input, WAA's `compare_table`, through
`pandas.read_excel`, accepts an unpadded id `45678` where the gold has `0045678`. Task
`0bf05a7d-…-WOS` asks for exactly that padding. Myco reports the upstream verdict unchanged
(`test/benchmark/upstream-evaluator.test.ts`). A false done that the upstream evaluator scores
as a pass is invisible to this R1. That limitation is accepted by using the upstream evaluator
as ground truth, and it belongs in the #671 audit.
