# The 0-false-success audit (TIF-156)

**Conclusion: arm-002's "0 false successes" is an OBSERVATION, not a bound. It is
not evidence of the property, because no success claim was ever independently
checked.**

## The scorecard sentence

> arm-002: 29 scored rows, **0 audited** — no false-success bound is supported;
> the 0 is observed only.

A bound requires rows the audit actually reached. arm-002 has none, so its zero is
a statement about the **scorer** (it did not invent a success in the trials that
ran) and not about the **property** (that a claimed success would have been caught
if false).

## Why: cited to code, not counted

Two lines decide this, and neither is a matter of interpretation.

**The audit runs only on a success verdict** — the guard in `runC1Trial`
(`src/baseline/c1-trial.ts`, `if (verdict.status === "verified")`):

```ts
if (verdict.status === "verified") {
  independentValuePresent = await prepared.audit();
}
```

**`falseSuccess` is defined so that an unaudited row can never be `true`** —
`src/baseline/index.ts`:

```ts
export function falseSuccess(
  verdict: VerdictStatus,
  independentValuePresent: boolean | null,
): boolean | null {
  return verdict === "verified"
    ? independentValuePresent === null
      ? null
      : !independentValuePresent
    : false;
}
```

For any non-`verified` verdict the function returns `false` **before looking at the
independent value at all**. So in an arm with zero verified rows,
`falseSuccess === false` on every row is arithmetically guaranteed — it is not a
measurement. The count cannot distinguish "the scorer never lied" from "the scorer
was never asked".

## The contrast that makes it a finding

The same rule applied to M1-014 gives the opposite result, and that difference is
what makes row 4 DONE and row 7 not.

| | arm-002 (screenshot baseline) | M1-014 (corrupted suite) |
|---|---|---|
| Rows with a verdict | 29 | 21 |
| **`verified`** | **0** | **7** |
| `refuted` | 29 | 11 |
| `uncertain` | 0 | 3 |
| **Audited** | **0** | **7** |
| False successes | 0 | 0 |
| **Supports a bound?** | **no** | **yes — 7 success claims checked, 0 false** |

M1-014's zero is a measurement: seven rows claimed success, `audit()` read the
persisted value independently, and none disagreed. arm-002's zero is a tautology of
its verdict distribution.

Source: `docs/research/experiments/m1-014-combined-audit/summary.json`
(`total 24, withVerdict 21, verified 7, refuted 11, uncertain 3, falseSuccesses 0`).

## The denominator correction: 29, not 30

`accounting.json` has **30 ledger keys** but **29 rows**: entry `9` is
`{status: "omitted", micros: 376800, reason: "trial-interrupted"}` with no `row`
field at all. Anything row-based therefore uses **29**.

This was wrong twice in earlier prose — stated as "0 of 30" when it is **0 of 29**.
It is now pinned by `test/baseline/false-success-audit.test.ts`, which asserts
`rows === 29` against the recorded artifact, so the distinction fails the suite
rather than drifting back into a sentence.

The auditor skips rowless entries by construction
(`Object.values(ledger).flatMap((e) => (e.row ? [e.row] : []))`), and a mutation
that counts them fails the test — the real artifact is the case that caught it,
since entry 9 would inflate 29 → 30.

## What would produce a bound for the baseline

Rows that reach `verified`. arm-003 (TIF-90) runs the same tasks with the save
requirement in the text, so an agent that completes the task should persist a value,
be scored `verified`, and become auditable.

**If arm-003 also yields zero verified rows, the honest line is "the arm cannot
produce successes, so false successes are unmeasurable" — not "zero false
successes."** That is written here before the run so it cannot be spun after it.

## Reproduce

```
node --import tsx scripts/audit-false-success.ts docs/research/experiments/c1-arm-002/accounting.json
node --import tsx scripts/audit-false-success.ts docs/research/experiments/c1-arm-002/accounting.json --json
```

The script also names the cause when nothing was audited: *"no row reached a
success verdict"* when `verified === 0`, and *"N row(s) reached a success verdict
but none was audited — the audit was unavailable for them"* otherwise (which is the
`independent-audit-unavailable` path). A correct count with the wrong explanation
is how a number gets quoted for the wrong reason.
