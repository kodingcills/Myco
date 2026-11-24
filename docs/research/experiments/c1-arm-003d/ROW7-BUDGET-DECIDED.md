# Row 7 budget: DECIDED — stay under $9, record arm-003 as a PARTIAL arm

**Lead decision, 2026-11-24 05:05Z. Supersedes the open question in `R6-BUDGET-WALL.md`.**

## The decision

**Stay under the approved $9.00 ceiling. Do not raise it without Tiffany's approval.**

- The Screenshot owner is pausing r6 to diagnose the E96 planner loop off-VM.
- **If the loop is genuine**, r6 resumes via the new `--resume` and runs **to the cap**.
- **arm-003 is then recorded as a PARTIAL arm**: `N of 30 scored, stopped at cap`.
- **That counts as the row-7 comparison** unless a higher cap is approved.

## Why a partial arm is the right answer here

The alternative — voiding the arm for incompleteness — would discard the only row-7 evidence
that exists, after arm-002 was already ruled out as a baseline. **A partial arm with a stated
stop reason is evidence; a voided arm is nothing.**

**It is honest in the same way the 5-row arm was made honest:** the count is recorded, the
reason is recorded, and nothing claims 30 rows that were not produced. The difference is that
this time the stop is the **cap** — a deliberate, approved ceiling — rather than a fault.

## What the row-7 entry must say

The scorecard entry must carry, in the row itself rather than in a note:

- the **number scored** and the **number attempted** (e.g. "16 of 30 scored")
- **"stopped at cap"** as the reason, distinguishing it from a fault stop
- the **cash** figure, not the booked figure — reservations are holds, not spend
- that arm-002 remains **not** a baseline, so a reader does not substitute it

## The cost basis for any future re-budget

**Do not project from arm-002's $0.054/trial.** That rate was measured on r2, whose
completions were clipped at `MAX_OUTPUT=256` — cheap *and* truncated. Post-#340 replies run
7,265–9,723 output tokens, and the measured cost is **266,804 u$ per scored trial**, roughly
5× arm-002's rate.

**At that rate, a full 30-trial arm needs ~8.0M u$ for the arm alone** — which is why the $9
ceiling cannot fund 30 trials on top of $4.48M of prior spend. A higher cap is the only way
to get a complete arm, and that is a spend decision, not an engineering one.

## Status

- `R6-BUDGET-WALL.md` — the measurement and the three options; option (2) is the one taken.
- `c1-r6` — 9 scored, 2 omitted at the time of the decision; paused for the E96 diagnosis.
- No further action from me on the budget unless the cap is raised.
