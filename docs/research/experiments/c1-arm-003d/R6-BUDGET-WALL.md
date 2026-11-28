# r6 / "r3": the arm will run out of budget at roughly 16 of 30 trials, not 30

**Measured 2026-11-24 by the M1 coordinator, from the live process env and the live ledger.**
The owner's status report gave `booked 607,200 / prior 4,030,512 = 51.5% used` and
projected *"30 trials to ~$1.62, so the cap does not bind."* **Both inputs are stale, and the
conclusion inverts.**

## Measured position

```
prior seeded       4,480,732     (read from the live sweep's MYCO_PRIOR_SPEND_MICROS)
this run booked    2,134,430     (c1-r6/accounting.json, 11 rows)
TOTAL committed    6,615,162     = $6.6152
% of 9,000,000     73.5%
headroom           2,384,838     = $2.3848
```

Rows at the time of writing: **8 scored, 2 omitted, 1 reserved** (11 of 30).

## Why the projection is wrong

**Mean cost per SCORED trial is 266,804 u$, not the 54,000 u$ arm-002 rate used for the
projection.**

```
scored 8 trials, mean 266,804 u$ each
headroom 2,384,838 / 266,804 = ~8 more trials
8 scored + 8 more = ~16 of 30
```

**The cap binds at roughly 16 trials**, leaving 14 unscored. That is not a marginal miss; it
is most of the arm.

**arm-002's $0.054/trial does not transfer, and the reason is the fix in #340.** r2 was
clipped at `MAX_OUTPUT=256`, so its completions were cheap and truncated. r6 runs at 1024 and
its completions are real:

```
r2 outs: [709, 3149, 1182, 256, 256]      <- clipped
r6 outs: [7962, 9081, 9723, 7265, ...]    <- full replies
```

**The cost per trial went up because the replies are no longer being cut off.** Projecting a
post-fix arm from the pre-fix rate is the same error in a new place: **arm-002 is not a valid
cost baseline for r6**, exactly as it is not a valid *score* baseline.

## What this means

**The run should be stopped or re-budgeted before it spends the remaining $2.38 on 8 trials
that cannot reach 30.** Continuing to completion buys a 16-row arm, which cannot be the
canonical baseline for a 27/30 criterion — the same reason the 5-row arm was voided.

**Options, for the owner to choose:**

1. **Stop now** (~$6.62 committed, 8 scored rows) and re-budget with a ceiling that fits 30
   trials at the measured 266,804 u$ — which needs **~8.0M u$ for the arm alone**.
2. **Let it run to the cap** and treat the result as a partial arm with a documented reason,
   which is what r2's rows are already marked as.
3. **Raise the ceiling**, which is a spend decision and not mine.

**This is the owner's run and their call.** Recording it because a paid arm is currently
heading for a budget wall with a plan that says it will not.

## The two stale inputs, separately

- **prior 4,030,512 omits r3 (228,970) and r5 (221,250)** — it is the r2-era sum extended by
  one run. The live process seeded 4,480,732, which includes them.
- **booked 607,200 is a single-trial snapshot** (one reservation at the 1024 ceiling). The
  ledger has moved a long way since.
