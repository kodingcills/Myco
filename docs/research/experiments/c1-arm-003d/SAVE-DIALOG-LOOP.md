# r6's rows fail on the LibreOffice format dialog, and the abort rule cannot see it

**2026-11-24. The Shot owner's diagnosis, verified independently against r6's ledger, plus
one consequence they did not state.**

## The cause: Ctrl+S then Escape, cancelling the save

Saving an `.xlsx` in LibreOffice opens a **"Keep Current Format"** dialog. `Escape` dismisses
that dialog **and cancels the save**. The planner types the value, presses Ctrl+S, gets the
dialog, dismisses it — and retries forever.

**Counts across the 9 scored rows, measured from the ledger (owner's figures confirmed exactly):**

```
row  0: ctrl+s 13  escape 13      row  6: ctrl+s 11  escape  9
row  1: ctrl+s  7  escape 11      row  7: ctrl+s 10  escape  7
row  3: ctrl+s 13  escape 13      row  8: ctrl+s  8  escape 11
row  5: ctrl+s  4  escape  8      row  9: ctrl+s  9  escape  9
row 10: ctrl+s  1  escape  1
TOTAL  ctrl+s 76  escape 82
```

**Row 9 is the cleanest evidence** — its raw sequence is
`Ctrl+s, Escape, Ctrl+s, Escape, …` nine times with only three cell clicks before it.

**The edit itself works.** Row 7's action 9 types the correct value into the correct cell.
**Only the save fails.** All 9 rows got the value in; none saved it.

## Consequence 1: all 30 rows will fail identically

**9 of 9 scored rows carry the identical `(refuted, step-budget)` verdict.** Resuming r6 to
the cap will spend ~$2.36 producing **21 more refutations for the same cause**.

**So arm-003 as it stands cannot measure agent capability** — it measures whether the planner
can dismiss a format dialog it has never been told about. That is a **task-design** question,
not a harness bug, and it decides whether resuming is worth the money.

## Consequence 2: the two-consecutive abort rule is structurally unable to fire here

**This is the part worth acting on.** Every row has the same verdict and reason, so the coarse
signal was there — yet the run never aborted:

```
sweep.ts  noteCause(`scored:${verdict}:${verdictReason}:actions=${actionSignature(row)}`)
```

**`actionSignature` differs on every row** (13/13 vs 7/11 vs 4/8 …), so
`consecutive` never reaches 2 even though all nine failures are one cause.

**This is the same defect as TIF-181 and TIF-186, one level up:**

| ticket | key was too fine | fixed to |
|---|---|---|
| TIF-181 | verdict + step count | action histogram |
| TIF-186 | `trial-interrupted:${message}` | the fault class |
| **this** | verdict + reason + **action signature** | **verdict + reason alone** |

**A run that fails 9/9 for one reason should stop at 2.** The action signature was added to
avoid a false abort on "a real agent trajectory" — but when the *verdict and reason* already
match, the signature is not evidence of a different cause, it is evidence of the same cause
being approached differently.

## What this does NOT establish

**The artifact cannot prove the planner saw the dialog.** Rows record only
`actions`/`claims`/`deliveries` — no frames, no screenshot hashes. The alternation strongly
implies it reacted to something that appeared, but **a frame-hash record is the missing
evidence**, and that is a diagnostic gap in the artifact rather than proof of either reading.
