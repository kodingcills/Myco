# arm-003d trial 0: the planner never attempted a save, so escalation was never reached

**Observed 2026-11-23, run `c1-arm003d-r2`.** Written while the run is still in flight; trial 0 is
one row and nothing here generalises beyond it yet.

## What trial 0 recorded

```
verdict: refuted | verdictReason: modified | steps 3 of 30 | budgetExhausted false
cost: $0.011658 | falseSuccess false | audited false

actions:
  click      (70, 146)          <- the Name Box
  click      (75, 146)
  type_text  (75, 146) "B39\n"  <- a cell REFERENCE, not the value

deliveries:
  {step 1, mode background, escalated false, outcome delivered}
  {step 2, mode background, escalated false, outcome delivered}
  {step 3, mode background, escalated false, outcome delivered}
```

**No `press_key` anywhere, so the escalation path was never exercised.** All three actions were
delivered in background mode on the first attempt.

## This is a model outcome, not a delivery outcome

The instruction was explicit — *"Set the cell at record EMP-0038, column name, to
`REVISED-908578`, and save the file."* The planner:

1. clicked the Name Box,
2. clicked again,
3. typed the **cell reference** `B39` rather than the value,
4. stopped at 3 of 30 steps with budget left.

**It never attempted the save.** `modified` is therefore the judge correctly reporting a document
left unsaved after the planner stopped — **not** a transport refusal, and **not** something
TIF-167's delivery work could have changed. This is the distinction the whole
transport-versus-judge split exists to make, and trial 0 lands on the judge side of it.

## It reproduces arm-002's dominant failure shape

arm-002's FINAL records the same pattern in 15 of its 16 `modified` rows:

> *"the other 15 each typed a **cell reference** such as `'A24\n'` — not a value"*, mostly into
> the Name Box at `(70,146)`.

**arm-003d trial 0 typed `B39\n` at `(75,146)`.** Same behaviour, same coordinates, one trial
later.

That is worth stating precisely, because it cuts against the reason this arm exists:
**if the planner does not attempt a save, the delivery-mode question never arises** — and the
refusal that consumed a day of investigation would not have been reached either. The probe
established that a save *would* be refused in background mode; trial 0 shows the planner does
not get that far.

## What this does not say

- **One row is not a rate.** It says nothing about how often the planner stops early, only that
  it can, and in the same way arm-002 did.
- **The escalation path is still unproven on live traffic.** It is proven by tests and by the
  probe; trial 0 did not exercise it. A run in which the planner *does* attempt a save is what
  would exercise it, and that has not happened yet.
- **No claim about false successes.** `falseSuccess: false, audited: false` — not audited, so
  this row supports no bound either way, exactly as arm-002's unaudited rows did not.
