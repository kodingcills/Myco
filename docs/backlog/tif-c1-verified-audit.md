# TIF (new): C1 actions report `verified:false` on all 270 actions, and the audit never runs

**Filed from the r6 post-mortem. Post-M1 unless trivial. Non-blocking.**

## Observation

Across r6's 9 scored rows, **270 of 270 actions** carry `verified: false` in the
`cua-action-N-verified:false` deviation, and **zero** carry `verified:true`. Every row
also has `audited: false` and `independentValuePresent: null`.

## Why it is not blocking

The judge scores from the **saved file**, not from the per-action read-back, so the
verdicts are independent of this. r6's rows are valid evidence.

## What to find out

1. **Is `verified:false` expected?** `classify()` in `src/baseline/c1.ts` sets
   `verifiedField = { verified: verified === true }`, so an ABSENT `verified` from Cua
   becomes an explicit `false`. That is deliberate - an unconfirmed delivery must not
   read as confirmed - but it means `false` conflates "Cua said no" with "Cua said
   nothing". Determine which is happening: does the Cua driver ever populate
   `structuredContent.verified`? If it never does, the flag carries no information and
   the deviation list is 30 lines of noise per row.
2. **Why does the audit never run?** `runC1Trial` only calls `prepared.audit()` when
   `verdict.status === "verified"`. Every r6 row is `refuted/step-budget`, so the audit
   is skipped by construction. Confirm that is the only reason, and whether a refuted
   row should still audit (an independent read that CONFIRMS the refutation is
   stronger evidence than one that never looked).
3. **Do the two mask a real fault?** If the read-back is genuinely broken, a future row
   that *looks* delivered may not have landed. The 9/9 "value typed" result suggests
   delivery works for this task, but that was inferred from replaying actions, not from
   the driver's own confirmation.

## Acceptance

State, with evidence, whether `verified:false` reflects a Cua response or a default;
whether the audit gap is by design; and whether either hides a delivery fault. If
`verified` is never populated, decide whether to keep the per-action deviation (noise)
or record the driver's raw response so the distinction survives.

## Constraint

Do not change the planner prompt or `STEP_BUDGET` (parity), and do not amend r6's
recorded rows.
