# TIF-200 follow-ups: the "571" denominator, and the aggregate-cost fallback

**Filed from the round-2 verification of TIF-200 (#400). Both are non-blocking.**
File this as one item; the lead asked for both together, post-merge.

## F1 - "the ONE call in 571" states a number the artifacts do not support

`src/baseline/planner.ts` and `test/baseline/output-ceiling.test.ts` both say trial 20 was
"the ONE call in 571". The ledger records **570** completions: 19 scored rows x 30 calls.
Row 20's call was never recorded, because a truncated reply is omitted before its usage is
written.

So the honest statement is **570 recorded completions, with at least one more attempted** -
the denominator is `>=571`, not `571`, and it is not derivable from the artifact. The
claim is true in spirit and wrong in the digit that a reader would try to check.

**Fix:** say "the one call that ran past every other completion in the arm" and cite 570 as
the recorded count.

## F2 - the aggregate-cost fallback discards the actual cost

TIF-200 books a truncation's ACTUAL cost, carried on `PlannerFailure.costMicros`. The
clamp accepts it only if `<= reservation`. But the carried figure is an **aggregate of every
call the trial made**, and a call that could not be verified books the sentinel
`MAX_CALL_MICROS`. One such call makes the aggregate exceed the reservation, so the clamp
rejects the whole figure and the booking silently falls back to the full reservation.

That is **fail-closed, not corrupting** - the safe direction, and unreachable from the
shipped planner because a truncation throws on its first call. But it is the opposite of
the booking's intent, and it would quietly defeat TIF-200 on any future path that fails
after a successful call.

**Fix options:** exclude the sentinel from the aggregate and cap the remainder at the
reservation; or carry per-call usage rather than a sum; or record that the figure is
partial. Any of them is better than the silent fallback.

## Third, smaller: a test fixture names a ceiling no file produces

`test/baseline/output-ceiling.test.ts` constructs
`new PlannerFailure("truncated at max_tokens=2048", ...)`. No code path emits that text -
the real message interpolates `${MAX_OUTPUT}`, which is 1024. Cosmetic fixture drift.

## Also noted, not part of this item

r6's on-disk `report.json` was written before TIF-200 and therefore carries no
`maxOutputTokens` field. The repo does not hold a report naming the ceiling that ended
r6. If that matters for the arm record, it belongs in the arm write-up rather than here.
