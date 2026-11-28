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

## The cost basis — CORRECTED 2026-11-24 05:16Z

An earlier revision of this note gave **266,804 u$ per scored trial**. **That was wrong.**
It divided the booked ledger total (which includes reservations for reserved trials and the
full reservation for omitted ones) by the number of SCORED rows, and so charged the arm for
spend it had not incurred.

**The measured cost, from r6's own ledger:**

```
9 scored rows          total 1,012,370 u$   = $1.012370
per scored row         112,485 u$           = $0.112485
prior committed        4,480,732 u$
REAL PROJECT SPEND     5,493,102 u$         = $5.493102  of $9.00
HEADROOM               3,506,898 u$         = $3.506898
```

**21 rows remain, needing 21 x 112,485 = 2,362,185 u$ — which fits inside the 3,506,898
headroom.** So **arm-003 is expected to complete all 30 rows under the $9 ceiling**, and a
PARTIAL arm applies **only if the fail-closed cap actually binds**, which the projection says
it will not.

The earlier note's ~8.0M figure for a full arm was derived from the same wrong rate and is
also withdrawn.

**What remains true from that section:** arm-002's $0.054/trial is not a valid basis either,
because its completions were clipped at `MAX_OUTPUT=256`. The current rate is 2x that, not
5x, and the reason is the same — post-#340 replies are real.
