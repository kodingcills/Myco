# C1 arm-002 — why the baseline refutes

Offline analysis of the recorded transcripts. No VM, no API calls: every figure
below is re-derivable from `rows/*.json` with the command at the bottom.

**Snapshot: 21 scored rows, all `refuted`, 0 false successes, $1.6272 committed.**
This file is written mid-run; the numbers move until the arm ends.

## The question this answers

The Coordinator needs the baseline checked apples-to-apples: is the screenshot
agent failing because it misclicks (a coordinate problem), or because it
misreads the task (a grounding problem)? The two have different fixes and only
one of them is about the model.

## Answer: neither is quite it — it is a third thing

**The agent never saves, and it does not click the data grid at all.**

Of **308 clicks** across all 21 rows:

| coordinate | clicks |
|---|---|
| (75, 146) | 191 |
| (70, 146) | 102 |
| (80, 146) | 6 |
| (75, 147) | 3 |
| everything else | 6 |

**296 of 308 clicks land in a 10-pixel band at y=146.** That is one UI element,
not a distribution of attempts at different cells. On a Calc window, (70–80, 146)
is the **Name Box** — the little reference field at the top left — not the
spreadsheet.

The transcripts confirm it: 12 of 21 rows type a bare cell reference
(`"A39\n"`, `"A97\n"`) into it, which is Name-Box *navigation*, not cell entry.

## The failure modes, individually

| reason | n | what actually happened |
|---|---|---|
| `modified` | 12 | Typed a value, **never saved**. The document was left open, so the judge could not read a persisted value and reported `modified`. |
| `step-budget` | 5 | Clicked the **same coordinate 30 times**. A click loop — the planner is stuck, not searching. |
| `persisted-mismatch` | 4 | Saved (or never acted) with a value that does not match, including one row that typed `"A97"` into the Name Box. |

**Zero `press_key` calls across all 21 rows.** No row ever attempted Ctrl+S.

## Why `modified` is not a coordinate miss

If the agent had clicked a *neighbouring cell*, it would have typed the right
value into the wrong place and then saved — producing `persisted-mismatch`, not
`modified`. `modified` means the document was still open with unsaved changes
(`c1-judge.ts:32`). Every `modified` row typed the correct value and then stopped
without a save. That is a **task-completion failure**, not a targeting failure.

## The instruction gap, and it is ours not the model's

The system prompt says *"Save and close it"* (`planner.ts:78`). The per-trial
instruction says only *"Set the X cell for record Y to Z"* (`c1-trial.ts:46`).

So the agent is told to save in the prompt and given a task that never mentions
saving. A planner that treats the task line as the whole job will type the value
and stop — which is what 12 of 21 rows did. This is an **instruction-fidelity
difference between the two arms**, and it belongs in the comparison write-up: if
Myco's arm is told to save and the baseline's task line is not, the arms are not
measuring the same thing.

## What this does NOT say

- It does not say the model cannot find a cell. It says it navigated by Name Box
  and never targeted the grid, which is a different capability.
- It does not validate the spike. The earlier spike row (`c1-spike/0.json`) has
  the **same** (70,146)/(75,146) pattern and typed `"A39\n"` — it is the same
  failure mode, and describing it as proof the stack "works end to end" was
  accurate about the plumbing and wrong about the task.

## Reproduce

```
node --import tsx scripts/c1-arm-report.ts /tmp/baseline/c1-arm2
```
