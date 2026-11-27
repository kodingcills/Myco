# Track M pre-registration, m-v1

**Status: frozen and ratified** (lead rulings 2026-11-27 06:21Z and 06:30Z). No measurement has run. Nothing here is a result.

This folder holds track M's pre-registration, as `docs/product/capability-spec.md` §3 asks.
Track M is "Learning from verified outcomes".

| File | What it is |
| --- | --- |
| `prereg.json` | The pre-registration. Its SHA-256 over canonical JSON is the **pre-registration hash**, and every pack must record it. |
| `rep-v1-manifest.json` | The `rep-v1` task set: 30 learn tasks, 30 repeat units and 30 similar units, all from fc-v1. The builder is `src/skills/rep-taskset.ts`, run with `seeds.taskBuild`. |

## What it fixes before any run

- **The bar.** The spec's bar, as written: an exact one-sided McNemar test, skills-on against
  cold, on the 60 test units. The bar is shown only at p ≤ 0.05 with at least 5 discordant
  units. Repeat and similar units are also reported separately; they are not part of the bar.
- **The arms.** skills-on reads the store frozen after the learn phase. cold runs the same
  surface with an empty store.
- **The base surface and its order.** The base is the best shown of I and J, else C1. M is
  measured only after I's bar is decided, and after J's if J has run. The pack records the
  surface and the I and J outcomes it was chosen from. The analysis applies the rule again.
- **Seeds.** One builds the task set, one sets the run order (ABBA blocks over test units),
  and one is for bootstrap intervals.
- **Run settings.** Step budget 30, retry budget 0, model `claude-sonnet-5-5`, all on Claude
  Ultra.
- **The analysis.** `scripts/m-learning-analysis.ts` and the `src/skills` modules it runs.
  Each file is pinned by SHA-256, and a test checks that the list matches the analysis's
  runtime imports.

## Grading

Test rows are gate-less. A test trial is verified when the agent claimed done and the
independent grader graded the captured document `pass`.

Learn rows are gated. The store stores a skill only from a learn trial that meets all of
these:

- the agent claimed done;
- the gate verified and accepted it;
- the grader graded it `pass`, on the same bytes.

The gate's verdict alone never stores a skill (`src/skills/rep-row.ts`,
`src/skills/admission.ts`).

## What the analysis refuses

The analysis refuses a pack in each of these cases:

- the pack's hash does not match `prereg.json`;
- `prereg.json` is not committed at the pack's recorded commit;
- an analysis file has changed since the freeze;
- the pack mixes simulated and real rows;
- the pack is real and `ratification.status` is not `ratified`.

A simulated pack is plumbing. Its result is `simulated`, never `shown`.

## Lead rulings (2026-11-27 06:21Z and 06:30Z)

The lead's rulings are recorded in `leadRulings`, and they ratify this pre-registration. Four
06:21Z rulings match what was proposed:

- `rep-v1`, `calc-record-edit` only;
- the base-surface tie-break: whichever of I or J has the higher grader-verified rate, and a
  tie goes to I;
- the model, `claude-sonnet-5-5`;
- harness-side advice delivery, with the cold arm on an empty store.

**n = 60, confirmatory, k = 1** (06:30Z, option B). This ruling replaces the 06:21Z n = 90 for
track M. `rep-v1` allows at most n = 60, because:

- fc-v1 has 60 no-fault tasks on 20 fixture seeds, 3 tasks each;
- a similar task may share no fixture seed with a learn task.

So the learn split uses all 30 tasks on 10 fixture seeds. The 30 similar units use the other
10 seeds, and the 30 repeat units re-run the learn tasks. The ruling chose B over the other
options: A (adding fc-v1's fault-class tasks) changes what is measured, and C (generating new
tasks) adds a task-set build.

`vmHoursEstimate` gives 150 trials, 15.6 VM-hours at the repo's measured 375 s per trial.
The figure doubles if Ultra trials are twice as slow.

Any change from now on, and any change after the first run, is a new version: `m-v2` (spec
§3.3).
