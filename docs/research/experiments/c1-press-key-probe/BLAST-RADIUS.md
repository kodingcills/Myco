# The delivery-mode refusal: blast radius, and what it does not touch

**Assessment 2026-11-23.** Written after the probe established that background
`key_combo` on a `SALFRAME` window is refused before the app is reached.

## The scoring question, answered from the record

The escalation asked whether any recorded verdict scored a `press_key` refusal as
a save failure. **The answer is none, and it is checkable rather than arguable:**

| Arm | Rows scored | `press_key` calls | Affected? |
|---|---|---|---|
| arm-002 | 30 (29 scored, 1 omitted) | **0** | **No** — the conflation never fired |
| arm-003 | 0 | — | **No** — no rows exist |
| arm-003b | 0 | — | **No** |
| arm-003c | **0** (infrastructure abort) | attempted a save | **No** — ledgers wiped with `/tmp` |

**arm-002 is the only committed 30-row arm, and its own FINAL records
`press_key calls | 0`** — *"no trial ever attempted Ctrl+S"*. `C1.execute`'s
`refused: isError || effect === "refused"` was therefore **never reached on a
`press_key` in any recorded arm.**

**arm-003c did attempt a save** and saw `cua-action-refused`, but it is recorded
as an **infrastructure abort with 0 scored rows** — its two rows were in `/tmp`
and died with the reboot. Nothing was scored from it, so nothing needs
re-annotating.

**Conclusion: the conflation (`src/baseline/c1.ts:92`) has affected zero committed
verdicts. It is a prospective defect.** It would mislead arm-003d and anything
after it; it has not damaged the record.

## What the conflation still costs

`refused: result.isError === true || effect === "refused"` collapses **three
distinguishable outcomes into one boolean**:

| Outcome | Raw signal | `refused` |
|---|---|---|
| routing refusal (delivery layer declined) | `code=background_unavailable` | `true` |
| delivered then stalled | `effect=ok` + 2000 ms stall | `false` + no `verified` |
| delivered then verified | `effect=ok`, `verified=true` | `false` |

So a reader of `refused` cannot tell **"the tool would not deliver the key"** from
**"the app did not save"**. Those are different claims about different layers, and
only the raw response separates them. That is worth fixing before arm-003d
produces rows, not after.

## The two decisions that remain (not mine)

1. **Delivery mode.** Background refuses `key_combo` here; `foreground` delivers
   it and costs the window coming forward — which changes what a *background*
   baseline is measuring. That tradeoff is a baseline-design call.
2. **Whether arm-003d runs before that call.** Running as-is produces ~30 rows in
   which every save is refused before the app is reached. That is real data about
   **the harness**, not the agent, and must be annotated accordingly or it will be
   read as "the baseline cannot save" — the reading the probe disproved.

## A third outcome the vocabulary lacks

`foreground_restored: false` plus a driver-reported stall means Cua itself says
*inspect before repeating*. **A blind retry turns one save into two**, so a retry
policy is needed alongside the delivery-mode choice, not after it.
