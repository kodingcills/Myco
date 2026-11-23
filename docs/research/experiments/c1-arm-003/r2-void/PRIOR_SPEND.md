# arm-003d prior spend and ceiling

Written before launch so the ledger below is auditable without reading my notes.

| Source | micros | dollars |
|---|---|---|
| committed before today | 3,190,688 | $3.190688 |
| today's aborted arm-003d reservation | 376,800 | $0.376800 |
| **prior spend (seeded)** | **3567488** | **$3.567488** |
| combined ceiling | 9,000,000 | $9.00 |
| **remaining for this arm** | **5432512** | **$5.432512** |

## Why the aborted reservation counts

`sweep.ts`'s `charged()` sums ALL ledger entries - scored, omitted AND reserved -
so a live reservation is treated as committed. The 19:26Z attempt reserved trial 0
($0.376800) and died at VM reset with no scored row and no planner call, so no
money was actually billed; but counting it is the conservative direction and it is
what this codebase's own accounting does. The prior spend therefore includes it.

## How the ceiling is enforced

`MYCO_PRIOR_SPEND_MICROS=3567488` and `MYCO_ARM_LIMIT_MICROS=5432512` are
passed to the launcher, which requires both (fail-closed) and adds prior spend to
BOTH cap checks. Without the seed a fresh directory's ledger would start at zero
and the $9 ceiling would be measured against a run that had already spent part of
it - which is exactly what this PR (#334, merged 20:21:59Z) fixed.

## Provenance

- committed figure: `docs/research/experiments/c1-arm-003-run-plan.md`, the rebuilt ledger
- aborted reservation: `/Users/tofuinparis/Projects/myco-runs/c1-arm003d/accounting.json`
