# The 256-token ceiling, and why it contaminates the arm-002 baseline

**2026-11-24. Verified against committed data by the M1 coordinator, at the Shot owner's
request.** `MAX_OUTPUT` was **256** (`src/baseline/planner.ts`), and `stop_reason` was
inspected **only** for `"refusal"` — so a reply cut off at the ceiling was silently
scored as an agent decision. Fixed in **#340** (`b5eb801b`): `MAX_OUTPUT` → **1024**, and
`stop_reason == "max_tokens"` now raises `PlannerFailure` so the sweep omits the trial
instead of grading a partial reply.

## The ceiling is real, not a distribution tail

arm-003d r2's completions pile up at exactly 256, and the largest **non**-truncated
completion anywhere in the run is **248**.

The sharper evidence is in the committed baseline's row totals. `tokens.out / modelCalls`
across **all 29 arm-002 rows**:

```
max       256.0        <- exactly the ceiling
mean      173.3
median    169.7
rows at exactly 256.0 : 2
rows in 250..255      : 0     <- nothing approaches the cap
rows in 240..249      : 0
rows above 256        : 0
```

**A natural maximum would show values crowding toward it.** Instead there is a **gap from
240 to 256 with two rows pinned exactly at the ceiling** — the fingerprint of a hard limit,
not the tail of a distribution.

## PARITY: the defect is in the committed baseline, not just arm-003d

**arm-002 ran at 256 too.** Its rows include `refuted/persisted-mismatch` results at 1 and
3 steps — the same shape as arm-003d r2's trials 3 and 4.

**This means the fix changes comparability.** arm-002's **16 modified rows may include
truncation artifacts**, so *"arm-003d does better than arm-002"* could be **entirely an
artifact of the fix** rather than an agent improvement. **Any arm-003d-vs-arm-002 comparison
made before #340 is unsound**, and the PR body records this rather than quietly improving
the number.

## The abort was MIS-WIRED, not missing

A correction to an earlier claim of mine, which said the two-consecutive rule was missing.
**The rule existed** (`sweep.ts:193-205`, from TIF-181) and its comment already said
*"two consecutive identical exclusion causes mean the sweep is measuring the harness, not
the agent."* **It was only called for omissions and `driver-unreachable`.** Two identical
**scored** failures incremented nothing — which is exactly r2's shape. `#340` wires
`noteCause("scored:…")` for scored rows, keyed on verdict + reason + action signature.

**The step-count component is a deliberate tradeoff worth keeping:** `s0, s1, s2, s2` stops
on the third row rather than the second. **A delayed abort costs one trial; a false abort
discards a healthy arm and misreports it as a harness fault.**

## Relaunch arithmetic, verified from the ledger

```
prior committed before today   3,190,688
c1-arm003d-r2 booked             463,024   <- verified: sum of row micros, exact match
prior spend (seed)            3,653,712
combined ceiling              9,000,000
REMAINING                     5,346,288
```

Use `MYCO_PRIOR_SPEND_MICROS=3653712` and `MYCO_ARM_LIMIT_MICROS=5346288`, **not** the
ceiling — passing the ceiling is accepted but makes the arm report claim headroom that was
never spendable (the arm-vs-remaining distinction documented in `SPEND-CEILING.md`).
