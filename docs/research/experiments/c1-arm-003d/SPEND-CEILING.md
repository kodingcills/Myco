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
(`src/baseline/sweep.ts:188-195`):

```ts
const reservation = planner.paid ? MAX_TRIAL_MICROS : 0;
const c1 = charged(ledger.c1);
if (stopReason ||
    priorSpend + c1 + reservation > armLimit ||                              // arm
    priorSpend + c1 + charged(ledger.c2) + reservation > COMBINED_LIMIT) {   // combined
```

`priorSpend` is in **both**, so neither ceiling can be satisfied by a run that only knows
about this directory's ledger.

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
Pass a smaller number for a tighter cap; the guard refuses an arm limit that overshoots.

**Do not pass `4_500_000`.** That is `DEFAULT_ARM_LIMIT` (`src/baseline/sweep.ts:21`),
which is what a caller gets when it does not state the remaining budget — and with
`priorSpend` set, `prior + default = 7_690_688` would silently enforce a **$7.69** ceiling
while the run plan says $9.00. That is the same "artifact says one thing, mechanism does
another" shape the owner correctly refused to launch under.

## If the guard refuses at the first trial

That is the guard working. Check which of the two conditions tripped — the message
distinguishes them — and pass the **remaining** budget rather than raising the ceiling.
