# arm-003d: the spend ceiling already carries prior spend — verify before launching

**Written 2026-11-24 by the M1 coordinator, at the VM owner's request.** The owner halted
arm-003d because the $9 cap appeared not to carry the $3.19 already committed. **That
finding is correct, and it was already fixed before the report was written.**

## The fix exists, is merged, and names this exact case

[`6c6b77a7`] `fix(TIF-164): a spend ceiling that counts prior committed spend (#334)`
— **2026-11-23 15:21:58 -0500**, on `origin/main`. Its own commit message states the
arithmetic the owner re-derived:

> arm-003d hit this: $3.190688 was committed against a $9.00 ceiling … True exposure
> was $3.19 + $4.50 = $7.69 on a ceiling that reports $9.00 — **it did not overspend,
> but only because the per-arm default happened to be lower than the remainder. That is
> luck, not a ceiling.**

So option (b) is **already done**, and done better than "seed the ledger": prior spend is
a **separate parameter added to both ceilings**, rather than fabricated ledger entries —
because writing it into `c1`/`c2` would invent trials this run did not execute and force
the row validator to accept them.

## Verified live, at this head

The boundary refuses to start without both numbers:

```
$ npx tsx -e "parseSpendCeiling({})"
REFUSED: MYCO_PRIOR_SPEND_MICROS and MYCO_ARM_LIMIT_MICROS must both be set to safe non-negative integers;
         the spend ceiling is the project's, not this directory's
```

Both numbers are carried when set — **the exact pair for this run**:

```
$ MYCO_PRIOR_SPEND_MICROS=3190688 MYCO_ARM_LIMIT_MICROS=5809312
{ priorSpendMicros: 3190688, remainingMicros: 5809312 }
```

And the ceiling is enforced **per trial**, not once at the start
(`src/baseline/sweep.ts`, corrected by TIF-187):

```ts
const reservation = planner.paid ? MAX_TRIAL_MICROS : 0;
const c1 = charged(ledger.c1);
if (stopReason ||
    c1 + reservation > armLimit ||                                          // this RUN
    priorSpend + c1 + charged(ledger.c2) + reservation > COMBINED_LIMIT) {  // PROJECT
```

**`priorSpend` belongs in the COMBINED check only, and an earlier version of this section
said "both" — that was wrong, and it described a real bug.** `armLimit` is already the
*remaining* budget (`ceiling − prior`), so adding prior spend to it subtracted the same
amount twice. Against the pre-fix code, a launcher who followed this document's own advice
(`MYCO_ARM_LIMIT_MICROS=<remaining>`) had **every trial omitted**:

```
prior 4,480,732 + reservation 607,200 = 5,087,932  >  armLimit 4,519,268   ->  all omitted
```

`r6` ran only because it was launched with `MYCO_ARM_LIMIT_MICROS=9000000`, **the ceiling
rather than the remainder** — which made the arm check non-binding and hid the defect.

**TIF-187 fixed the code; this section now matches it.** The launch advice below is
unchanged and correct: pass the **remaining** budget, and it works.

## Also fail-closed, three ways

- a seed that is not a safe non-negative integer is **refused**, not treated as zero
- prior spend + the per-arm default exceeding the combined limit is **refused**, with an
  instruction to pass the **remaining** budget instead
- `c1-sweep.ts` requires **both** environment variables and will not start without them

## The launch command

Option (a) as the owner proposed is **not needed** — no code change, and no launch under a
stated-but-unenforced ceiling. The correct invocation is the remaining-budget form:

```sh
MYCO_PRIOR_SPEND_MICROS=3190688 \
MYCO_ARM_LIMIT_MICROS=<remaining> \
  <detached launcher>
```

where `remaining = 9000000 - 3190688 = 5809312` **if the full $9 ceiling is to be spent**.
Pass a smaller number for a tighter cap.

**Do not pass `4_500_000`.** That is `DEFAULT_ARM_LIMIT` (`src/baseline/sweep.ts:21`),
which is what a caller gets when it does not state the remaining budget — and with
`priorSpend` set, `prior + default = 7_690_688` would silently enforce a **$7.69** ceiling
while the run plan says $9.00. That is the same "artifact says one thing, mechanism does
another" shape the owner correctly refused to launch under.

### What actually guards the $9, stated precisely

**Corrected after testing.** An earlier draft of this note said "the guard refuses an arm
limit that overshoots." **That is only true for the default.** The startup check is:

```ts
if (priorSpend + armLimit > COMBINED_LIMIT && armLimit === DEFAULT_ARM_LIMIT) throw …
```

`&& armLimit === DEFAULT_ARM_LIMIT` means an **explicit** overshooting arm limit is
accepted, verified: `priorSpendMicros: 3190688, armLimitMicros: 6000000` starts without
complaint.

**The $9 is still enforced** — by the per-trial combined check, which is the real
backstop and includes `priorSpend`:

```ts
priorSpend + c1 + charged(ledger.c2) + reservation > COMBINED_LIMIT   // stops the trial
```

So an overshooting `armLimitMicros` raises the per-arm ceiling but **cannot** breach the
combined one: spend stops once `prior + c1 + reservation` reaches 9,000,000. **Passing the
remaining budget is therefore about making the arm ceiling honest, not about avoiding an
overspend.**

**The practical consequence, which is why the instruction stands:** with
`armLimitMicros` overshooting, the run can *start* against a ceiling it will later be
stopped by — rows already written, then a `spend-limit` stop partway. The run plan would
again predict one number and the arm report another. Pass the remainder.

## If the guard refuses at the first trial

Check which condition tripped. `prior + c1 + reservation > armLimit` is the arm ceiling;
`… > COMBINED_LIMIT` is the project ceiling. Only the latter is absolute — and if it
trips, the project budget is genuinely exhausted, so **the answer is not to raise it.**


## Round-2 status: already merged, and the coverage is real (2026-11-24)

The request for a round-2 verifier at `a406f99` arrived after the work had merged. **All of
it is on `main` in `6c6b77a7`**, which is #334 itself — `a406f99` is not an ancestor, but
`scripts/spend-ceiling.ts` and `test/baseline/spend-ceiling.test.ts` are both present, with
**8 cases, all passing**:

```
accepts the pair the arm-003d relaunch uses
refuses an EMPTY prior spend rather than reading it as zero
refuses an empty remaining budget rather than reading it as zero
refuses every form that lenient coercion would accept
accepts a zero PRIOR spend, which is legitimate
refuses a missing variable
refuses a zero remaining budget
refuses a value beyond the safe-integer range
```

**The negative control reproduces, verified here rather than taken on report.** Reverting
the parse to plain `Number(raw)` fails exactly **2 of 8**, including the empty-string case:

```
× refuses an EMPTY prior spend rather than reading it as zero
× refuses every form that lenient coercion would accept
Tests  2 failed | 6 passed (8)
```

So the test is bound to the real parse — not a restatement of it — and **the defect cannot
return without a test failing.** That is the durable part, and it is the reason round 1's
finding is closed rather than merely worked around.

## The live arm-003d-r5 run and its ceiling

A run (`c1-arm003d-r5`) was live while this was written, on
`myco-m1-baseline-7e3d9d6a63257831` at `d40f6539` — a tree that **does** carry the #334
guard. Its environment:

```
MYCO_PRIOR_SPEND_MICROS=4030512   MYCO_ARM_LIMIT_MICROS=9000000
```

**`prior + arm = 13,030,512` against a 9,000,000 ceiling, and it was accepted at startup.**
That is the documented limitation, not a new one: the startup refusal fires only when
`armLimit === DEFAULT_ARM_LIMIT`, and `9000000 !== 4500000`.

**The run is nevertheless capped at $9.00**, by the per-trial combined check:

```
prior 4,030,512 + c1 607,200 + reservation > 9,000,000 ?   -> trial proceeds while under
```

**Effective headroom: $9.00 − $4.030512 = $4.969488.** The oversized arm limit makes the
*arm* ceiling permissive; it cannot breach the *combined* one.

### The lesson for launchers

`MYCO_ARM_LIMIT_MICROS` should be the **remaining** budget (`ceiling − prior`), not the
ceiling. Passing the ceiling is accepted and the run still stops at $9.00 — but the arm
report will show an arm limit of $9.00 that was never spendable, which is the
artifact-says-one-thing shape this whole thread is about.

## The relaunch values, verified end to end (2026-11-24)

`#334` merged at `6c6b77a7` (20:21 ET), so the mechanism is on `main`. The owner's
proposed relaunch parameters, run through the real parser and guard:

```
MYCO_PRIOR_SPEND_MICROS=3570688   (3190688 committed + 376800 aborted reservation)
MYCO_ARM_LIMIT_MICROS=5429312     (9000000 − 3570688)
  -> parsed { priorSpendMicros: 3570688, remainingMicros: 5429312 }
  -> prior + arm = 9000000 vs COMBINED 9000000 -> WITHIN
  -> accepted at startup
```

**Counting the aborted `376800` is the conservative direction and correct:** it was real
spend, not a reservation to reclaim, so carrying it in prior spend understates the
remaining budget rather than overstating it.

### The empty-string hole is closed, at this head

`Number('')` is `0`, so an empty `MYCO_PRIOR_SPEND_MICROS` used to parse as "no prior
spend" and silently restore the unlimited ceiling — reachable by the likeliest operator
mistake. The parser is now `/^\d+$/`-gated (`scripts/spend-ceiling.ts:25`). Every case
the owner named, re-run here:

| input | result |
|---|---|
| empty prior / empty arm | REFUSE |
| whitespace | REFUSE |
| `abc` | REFUSE |
| `1.5` | REFUSE |
| arm limit `0` | REFUSE |
| **`priorSpend` > COMBINED** | **accepted by `parseSpendCeiling`, REFUSED by `runC1Sweep`** |
| valid pair | PASS |

### Correction: over-limit is refused one layer later, not by the parser

The owner reported that "over-limit refuses" alongside the other cases. **It does refuse —
but not where they tested.** `parseSpendCeiling` accepts `99999999`; `runC1Sweep` then
throws `invalid prior spend` at `src/baseline/sweep.ts:171` because the value exceeds
`COMBINED_LIMIT`. **The behaviour is correct and intentionally layered** — the environment
boundary parses, the sweep validates against the ceiling — but the two layers differ, so
the table above records which layer does which.

### No fabricated rows

`priorSpend` appears only in the ceiling comparisons (`sweep.ts:238-239`); it is never
written to the ledger. A fresh `outDir` therefore starts empty and produces exactly the
rows it executed, which is why the owner's choice of a fresh directory plus an env seed is
right rather than carrying the old ledger forward.
