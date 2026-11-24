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

## The decisive argument: the edit lands 9/9, only the save fails

**Verified independently from the ledger** — for every scored row, does a `type_text` carry the
row's own `expected` value?

```
row  0  B39   REVISED-908578   typed   row  6  D6   2024-03-26    typed
row  1  C24   9733             typed   row  7  E96  $36824.23     typed
row  3  E10   $12458.13        typed   row  8  B126 REVISED-545101 typed
row  5  C23   9986             typed   row  9  C5   7897          typed
row 10  D35   2024-06-29       typed
```

**9 of 9 typed the correct value into the correct cell.** This is the argument that settles
harness-versus-agent: **if the planner were working from a stale frame, or the coordinateswere
wrong, the EDIT would not land.** It landed every time. Observation and the coordinate path
work; only the save fails.

**A second false signal was ruled out.** Escalation is per-TOOL policy (`press_key` always
foreground, `click`/`type_text` background — #327's routing), so a Ctrl+S/Escape foreground
pattern is **not** evidence that a dialog exists. Removing it is why the value-typed test
carries the weight.

**And the harness path was read for a stale-frame fault:** `screenshot()` calls
`get_window_state` with `include_screenshot` on **every** step and returns the bytes unmodified;
`planner.act` puts those bytes in the request. No cache, no reuse, no fallback.

**Verdict: genuine agent failure on the save dialog. The 9 rows stand.**

## What the artifact still cannot show — and the fix

**No frames, no hashes.** The transcript records only `actions`/`claims`/`deliveries`, so the
9/9 argument is **inference from behaviour — strong, but not visual.** Nobody can show a picture
of the dialog.

**Recommended instrumentation, and it is small:** record a per-step `frameSha256` (and the
`element_token`) in the transcript. Then the remaining rows answer the question **directly**,
and a future reviewer never has to reason from key sequences again.

**Worth doing before the resume**, in its own small PR so it does not disturb an in-flight
verifier round. It does not change any verdict; it closes a diagnostic gap permanently.
