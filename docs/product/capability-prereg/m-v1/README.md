# Track M pre-registration, m-v1

**Status: frozen as proposed, not ratified.** No measurement has run. Nothing here is a result.

This folder holds track M's pre-registration, as `docs/product/capability-spec.md` §3 asks.
Track M is "Learning from verified outcomes".

| File | What it is |
| --- | --- |
| `prereg.json` | The pre-registration. Its SHA-256 over canonical JSON is the **pre-registration hash**, and every pack must record it. |
| `rep-v1-manifest.json` | The `rep-v1` task set: 20 learn tasks, 20 repeat units and 20 similar units, all from fc-v1. The builder is `src/skills/rep-taskset.ts`, run with `seeds.taskBuild`. |

## What it fixes before any run

- **The bar.** The spec's bar, as written: an exact one-sided McNemar test, skills-on against
  cold, on the 40 test units. The bar is shown only at p ≤ 0.05 with at least 5 discordant
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

## Pending lead rulings

`ratification.pending` lists five items, each written as proposed:

1. Whether to raise n (spec §6).
2. The learn split is `calc-record-edit` only, because `calc-multi-step` has no published,
   graded task set yet.
3. The tie-break when both I and J are shown.
4. The model id.
5. How advice reaches the agent.

When the lead rules, the ruling is written into `prereg.json` and its status becomes
`ratified`. That changes the hash, and it must happen before the first run. Any change after
the first run is a new version, `m-v2` (spec §3.3).
