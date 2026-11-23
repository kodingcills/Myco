# arm-002: the 0-false-success audit (TIF-219)

**Answer: 0 false successes observed, 0 audited. No bound is supported.**

This is not a failure of the arm. It is a limit on what its number can be used to
claim, and it is computed from the artifact rather than asserted here:

```
$ node --import tsx scripts/audit-false-success.ts docs/research/experiments/c1-arm-002/accounting.json
  rows        : 29 (verified 0, refuted 29, uncertain 0)
  audited     : 0 of 29 (unaudited 29)
  falseSuccess: 0 true
  bounded?    : false
```

## Why zero audits

The independent audit runs only when the verdict is `verified`
(`src/baseline/c1-trial.ts:91`), and `c1-judge.ts:35` is what it calls:

```ts
if (verdict.status === "verified") {
  independentValuePresent = await prepared.audit();
}
```

arm-002 has **29 refuted rows and 0 verified rows**, so the branch never executes
and every row carries `audited: false, independentValuePresent: null`. The
validator enforces the pairing — `x.audited === (x.independentValuePresent !== null)`
— so these two fields cannot drift apart.

## Observed vs bounded — the distinction that matters

| Claim | Means | Supported by arm-002? |
|---|---|---|
| **0 false successes observed** | no row was scored a success while the document disagreed | **yes** — all 29 rows are `falseSuccess: false`, and none is `true` |
| **0 false successes, bounded** | the audit ran on the rows that could have produced one and found none | **no** — 0 rows were audited |

An observation is a statement about the **scorer**: it says the scorer did not
invent a success in the trials that ran. A bound is a statement about a
**population**: it says that when a success occurs, the independent check would
have caught a false one.

arm-002 supports the first and not the second. Saying "0 false successes" without
qualification reads as the second, which is why the scorecard must not do it.

## What would produce a bound

A bound needs rows that reached `verified`. arm-003 (TIF-90) is the arm that can
produce them: it runs the same task with the save requirement present, so an agent
that completes the task should persist a value and be scored `verified`, at which
point `audit()` runs and the row becomes auditable.

If arm-003 also yields zero verified rows, the honest conclusion is not "zero
false successes" but "the arm cannot produce successes, so false successes are
unmeasurable" — a statement about the task or the agent, not about the scorer.

## Reproduce

```
node --import tsx scripts/audit-false-success.ts docs/research/experiments/c1-arm-002/accounting.json
```

`test/baseline/false-success-audit.test.ts` pins this outcome against the recorded
artifact, so a future edit to the corpus or the gate fails the suite rather than
silently turning "observed" into "bounded".
