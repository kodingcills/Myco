# C1 arm-002 — final result, and why it is not the baseline

**Run:** 2026-11-22 16:10 → 2026-11-23 00:41:50Z.
**Rows recorded:** 30 — of which **29 completed and 1 omitted** (`report.json`:
`completed: 29, partial: true`). Not "complete".
**Spend — two numbers, and they mean different things:**

| | |
|---|---|
| **Booked against the $9.00 cap** | **$1.555362** (`report.json.c1ChargedMicros`) |
| Actually spent on model calls | **$1.178562** (Σ `cost` over the 29 scored rows) |
| Never spent, but still booked | **$0.376800** — row 9's reservation |

`charged()` (`sweep.ts:83`) sums every entry's `micros`, and `sweep.ts:155-161` compares
that total against the arm cap. So **$1.555362 is the figure that answers "how much
of the $9 cap is used"**, and it is the correct one to quote against a budget.

**The $0.376800 is a reservation that was never spent.** Row 9 reserved
`MAX_TRIAL_MICROS` (30 × 12560) before the trial began; `progress.log` shows the
process was killed and a *second* sweep then died on
`EEXIST: mkdir '/tmp/baseline/c1-arm2/.run-lock'`. The trial never reached the
planner, so no Anthropic call was made and no `cost` was recorded — yet the
reservation stays booked. That is the intended fail-closed behaviour (a crashed
trial must not free budget for a retry), not a leak, but it means **the two
numbers legitimately differ by exactly one reservation.**

(`report.json.c1ChargedMicros` — `sweep.ts:83` `charged()` sums every entry,
including the omitted row's 376800 µ$ reservation). **State which question you are answering:** quote **$1.555362** against the cap, and **$1.178562** as cash spent. Never an unqualified "spend".

## The numbers

| | |
|---|---|
| Entries | **30** (0–29) |
| `scored` / completed | **29** |
| `omitted` | **1** (index 9, `trial-interrupted`) |
| `verified` | **0** |
| `refuted` | 29 |
| Not run | 0 |
| Wilson 95% (over 30) | −0.00 – 0.11 |
| Actions | **422** (`click` 398, `type_text` 24) |
| `press_key` calls | **0** |

### False successes: **0 observed, and 0 trials audited**

This arm supports **no** false-success rate — neither zero nor non-zero. The
field is `false` by construction: `falseSuccess()` returns `false` for every
non-`verified` verdict (`src/baseline/index.ts:51-60`), and
`independentValuePresent` is only computed when `verdict.status === "verified"`
(`c1-trial.ts:110-118`). Every row has `audited: false`, so **the audit never ran
on any row**. Criterion 4's positive evidence is the M1-014 corrupted audit (21
eligible trials, 0 false successes), not this arm.

## Refutation reasons — all 30 accounted for

| Reason | n | What the transcript shows |
|---|---|---|
| `modified` | 16 | Document left open, unsaved (`c1-judge.ts:32`). **All 16 ended `planner-no-action`** — the planner returned no parseable decision — and **none declared done** (`claims` empty on all 16). **Only 1 of the 16 had typed the expected value** (index 6, `2024-03-26`); the other 15 each typed a **cell reference** such as `'A24\n'` — not a value. ("Typed nothing" belongs to the `persisted-mismatch` rows, and the Name Box at `(70,146)` is where most of them landed but not all: index 6 acted at `(282,277)`.) |
| `step-budget` | 7 | 30 steps used without concluding. |
| `persisted-mismatch` | 6 | Persisted value ≠ expected. **2 rows took zero actions** (indices 3, 29) and 2 more issued no `type_text` (5, 15); only index 23 typed the expected value and still mismatched. |
| `trial-interrupted` | 1 | Index 9. Not a timeout — see below. |

> Counts are a snapshot of the finished ledger. Re-derive them from
> `accounting.json` rather than trusting this table.

## Timeouts

**No scored trial records a timeout or deadline hit**, and the ledger has **no
timeout field to count**, so no timeout number can be quoted from it. What it
has: `elapsedMs` 18.9–197.4 s (median 69.0) and `resetMs` 22.2–235.1 s (median
182.8) on scored rows only.

The one omission was **not** a timeout. `progress.log` shows `[9] Starting
myco-agent`, then a second sweep invocation dying on `EEXIST: mkdir
'/tmp/baseline/c1-arm2/.run-lock'` — a process/lock collision. The ledger shape
(`reserved` with `micros = 376800`, no `detail`) matches the
`reserved → omitted{trial-interrupted}` conversion at `sweep.ts:144`.

## Why this is NOT the criterion-7 baseline

The two arms were not doing the same job.

| | Myco's arm | arm-002 |
|---|---|---|
| Task given | `windowsProgramFor(params)` — a compiled guarded program with an **explicit save step** (`isSave: true`; `src/integration/trial.ts`, `grep isSave`) | `taskText(params)` — a sentence |
| Includes the save? | **Yes, as a step** | **No** — "Set the X cell for record Y to Z." |
| System prompt | — | "Save and close it" (`planner.ts:78`) |

The baseline's agent was told to save in its system prompt and given a task that
never mentioned saving. **Zero `press_key` calls across 422 actions** — no trial
ever attempted Ctrl+S.

**What the record does and does not support about the mechanism.** All 16
`modified` rows terminated on `planner-no-action` with empty `claims`: the
planner stopped deciding, and did not declare success. So the *stopping* is on
the planner, not on a deliberate "I'm done" choice. Only one of the sixteen had
typed the correct value; the rest typed a cell reference — mostly into the Name Box, and not
universally. The save gap is real and it is a task-completion difference — the
baseline was never told to persist — but **the transcript does not support "it
typed the right value and stopped"**, and an earlier revision of this file said
that.

> **Do not read `report.json`'s `mycoVerdict` as an arm-002 result.** That field
> is Myco's *reference* outcome from the manifest (`sweep.ts:222`), copied onto
> every row including the omitted one. Counting it reports **29 "verified"**,
> which is the opposite of the truth. It should be renamed `referenceVerdict`.

**Consequence:** arm-002 is a **recorded run**, kept for the negative result it
documents. It is not scored against criterion 7, and no pass rate is claimed.

## What replaced it

**arm-003 (TIF-90)** re-runs 30 trials with the baseline told the same job Myco's
program executes. The shared text is `src/tasks/task-text.ts`, and both arms now
record the rendered string, so parity is checkable by diffing artifacts (TIF-104).

## Reproduce

```bash
python3 scripts/c1-scorecard-adapter.py \
  docs/research/experiments/c1-arm-002/accounting.json \
  --manifest src/baseline/sweep-v3.json --out /tmp/c1-trials.jsonl
python3 scripts/m1-scorecard.py /tmp/c1-trials.jsonl
```
