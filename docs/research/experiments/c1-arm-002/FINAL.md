# C1 arm-002 — final result, and why it is not the baseline

**Run:** 2026-11-22 16:10 → 2026-11-23 00:41:50Z. **Complete:** 30 of 30 rows recorded.
**Spend:** $1.1786. **False successes: 0.**

## The numbers

| | |
|---|---|
| Rows recorded | **30 of 30** |
| `refuted` | 29 |
| `harness-error` | 1 (index 9, `trial-interrupted`) |
| `verified` | **0** |
| False successes | **0** |
| Not run | 0 |
| Wilson 95% (over 30) | −0.00 – 0.11 |

Refutation reasons, and they are not one thing:

| Reason | n | What happened |
|---|---|---|
| `modified` | 16 | Correct value typed, **never saved** (`c1-judge.ts:32`: document left open) |
| `step-budget` | 7 | 30 steps used without concluding |
| `persisted-mismatch` | 6 | Something saved, but not the expected value |
| `trial-interrupted` | 1 | Infrastructure |

**Zero `press_key` calls across 422 actions** (`click` 398, `type_text` 24). No trial ever attempted Ctrl+S.

> Counts are a snapshot of the finished ledger. Re-derive them from
> `accounting.json` rather than trusting this table.

## Why this is NOT the criterion-7 baseline

The two arms were not measuring the same job.

| | Myco's arm | arm-002 |
|---|---|---|
| Task given | `windowsProgramFor(params)` — a compiled guarded program with an **explicit `isSave: true` step** (`src/integration/trial.ts:712`) | `taskText(params)` — a sentence |
| Includes the save? | **Yes, as a step** | **No** — "Set the X cell for record Y to Z." |
| System prompt | — | "Save and close it" (`planner.ts:78`) |

So the baseline's agent was told to save in its system prompt and given a task that
never mentioned saving. A planner that treats the task line as the whole job types
the value and stops — which 16 rows did. A *neighbouring-cell* miss would have saved
a wrong value and produced `persisted-mismatch`; `modified` means the document was
still open. This is a **task-completion difference induced by the instruction**, not
a grounding or targeting failure.

**Consequence:** arm-002 is a **recorded run**, kept for the negative result it
documents. It is not scored against criterion 7, and no pass rate is claimed from it.

**Its real finding**, which is worth keeping: a screenshot agent told to save only in
a system prompt will type the correct value repeatedly and never persist it. That
would have been easy to misread as "the screenshot approach cannot do the task."

## What replaced it

Arm-003 re-runs 30 trials with the baseline told the same job Myco's program
executes. Design: `docs/research/experiments/c1-arm-003-design.md` (lands with PR #212).

## Reproduce

```bash
python3 scripts/c1-scorecard-adapter.py \
  docs/research/experiments/c1-arm-002/accounting.json \
  --manifest src/baseline/sweep-v3.json --out /tmp/c1-trials.jsonl
python3 scripts/m1-scorecard.py /tmp/c1-trials.jsonl
```

The adapter projects the arm ledger into the shape `m1-scorecard.py` reads, so both
arms are counted by the same rules.
