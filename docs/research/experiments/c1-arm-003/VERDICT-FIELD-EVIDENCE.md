# Which verdict field grades a C1 row — evidence note

**Asked for by the lead (outer loop, 2026-11-24).** The two fields disagree on r6's every
row, so this decides what r6's result actually is, and it feeds the row-7 Tier-2 check.
Per the lead: **do not state 29/30 as the baseline's pass rate anywhere** until that check
settles it. This note does not state a pass rate; it states which field is graded and why
they differ.

## The two fields

`report.json` carries two per-row fields that look like the same thing and are not:

| field | source | meaning |
|---|---|---|
| `mycoVerdict` | **`src/baseline/sweep-v3.json`** (the pinned manifest) | a verdict **recorded by a previous run**, shipped in the manifest and copied through |
| `verdict` | **`src/baseline/index.ts:131` `judge()`** via `src/baseline/c1-trial.ts:148` | **this run's** graded outcome for the C1 agent's task |

## Where each is set, in code

**`mycoVerdict` is not computed. It is copied.** `src/baseline/sweep.ts:894`:

```ts
const rows = manifest.rows.map(({ index, mycoVerdict }) => {
  const entry = ledger.c1[index];
  return entry?.status === "scored"
    ? { index, mycoVerdict, verdict: entry.row.verdict, ... }
```

It comes straight out of the manifest row. Each manifest row carries `index`, `mycoVerdict`,
`params`, **`runId`**, and **`resultSha256`** — a run id and a result digest, i.e. it is a
record of a run that already happened. `src/baseline/sweep-v3.json` has 30 rows pinned
**29 `verified` / 1 `refuted`**, and the file's own `sourceSha256` pins the tree it came
from.

**`verdict` is computed per trial.** `src/baseline/c1-trial.ts:148` calls
`judge(transcript, driver, observation)`. `judge` (`src/baseline/index.ts:131`) is a pure
function of the independent observation:

```ts
switch (observation.kind) {
  case "persisted":
    return observation.actual === observation.expected
      ? { status: "verified", reasons: ["persisted-match"] }
      : { status: "refuted",  reasons: ["persisted-mismatch"] };
  case "unavailable": return { status: "uncertain", reasons: ["unavailable"] };
  default:            return { status: "refuted",  reasons: [observation.kind] };
}
```

`c1-trial.ts:163` writes `verdict: verdict.status` into the row, and
`verdictReason: verdict.reasons[0]`. **This is the field that grades the C1 agent's task:**
the row is `verified` only when the cell independently shows the expected value
(`persisted-match`). Everything else — `modified`, `dialog`, `step-budget`,
`driver-action` — is `refuted`.

## Why r6's rows can read `mycoVerdict: verified` while `verdict: refuted`

**Because `mycoVerdict` is not about r6 at all.** It is the verdict recorded by the run the
manifest was pinned from. r6's rows are `verdict: refuted` — 29 on `step-budget`, 1 on
`modified` (index 23) — while the manifest still says `verified` for 29 of them. The two
fields answer different questions in the same row:

- `mycoVerdict` — "what did the manifest's source run find for this fixture?"
- `verdict` — "what did **this** run's independent check find?"

Nothing reconciles them. Neither file states which is graded.

## Why `step-budget` rows are `mycoVerdict: verified`

`step-budget` is produced **only** by the local driver's step count, never by the manifest.
`c1-trial.ts:146`:

```ts
if (steps === STEP_BUDGET && observation.kind !== "driver-action")
  observation = { kind: "step-budget" };
```

The agent used its whole step budget without the independent check ever observing a
persisted cell. `judge` then takes the `default` branch and returns `refuted` /
`step-budget`. **The manifest's `verified` was recorded by a run where the agent finished
inside its budget and the cell showed the expected value.** r6's agent did not finish inside
its budget, so the same fixture grades `refuted` here and `verified` there.

That is also why `acceptedScoredCauses: ["refuted:step-budget"]` appears in r6's
`report.json`: 29 of 30 rows share one cause, so the sweep treats `refuted:step-budget` as an
accepted cause when resuming rather than as a fresh fault (`sweep.ts:69`).

## What this means for r6

- **r6's graded outcome is `verdict`: 30 rows `refuted` — 29 `step-budget`, 1 `modified` —
  with 0 false successes.**
- `falseSuccess` is `false` on 30/30 (`falseSuccess()` returns `false` for any non-`verified`
  verdict, `src/baseline/index.ts:84`), so the 0-false-successes criterion is unaffected by
  this question.
- `independentValuePresent` is `null` on 30/30, because the independent audit only runs when
  `verdict.status === "verified"` (`c1-trial.ts:150`). **No row reached the audit.**
- **The 27/30 criterion is therefore NOT demonstrated by r6.** The manifest's pinned
  `mycoVerdict` does not show it either — that is a prior run's result, not this sweep's.
- **No pass rate is claimed here.** Which field the acceptance criterion should grade is the
  lead's / Coordinator's row-7 Tier-2 decision.

## The reporting hazard (filed)

`report.json` is the artifact a reader opens to see how a sweep went, and it puts the
**stale expectation** and the **measured outcome** side by side with no label saying which is
which. `{"mycoVerdict":"verified","verdict":"refuted"}` is a normal line. Filed as **M1-033**
in `docs/backlog/m1.md`.

**I was caught by it.** I reported r6 as "29/30 verified, acceptance met" twice before
checking which field was measured. That statement was wrong and is retracted in
`docs/coordination/m1-state.md`.

## A third field, and why it matters to row 7: `trials.jsonl` `status`

Row 3 of `docs/m1-scorecard.md` claims **29/30 verified, MEETS NUMERIC THRESHOLD**, and the
26.8.3 row-1 line repeats it. That number is **not** the manifest's `mycoVerdict` and **not**
r6's `verdict`. It is a third field, from a third place:

| artifact | field | sweep | value |
|---|---|---|---|
| `docs/research/experiments/m1-013-sweep-v3/trials.jsonl` | `status` | v3 @ `aa96974` | **29 verified / 1 refuted** (measured) |
| `src/baseline/sweep-v3.json` | `mycoVerdict` | pinned from that run | 29 / 1 |
| `~/Projects/myco-runs/c1-r6/*` | `verdict` | r6 | **30 refuted** |

`scripts/m1-scorecard.py` reads `status` from `trials.jsonl` and counts only `"verified"`
(line 10: *"Only status 'verified' counts as a pass"*). The v3 record it counts is a real
measurement — its single `refuted` row is index 3, `EMP-0009`/`salary`, with the reason
recorded: *"cell E10 expected `$12458.13` but live document has `$77544.00`"*. That is an
independent persisted-state comparison, i.e. the graded kind.

So the scorecard's 29/30 is **v3's measured outcome, and is legitimately grounded.** It is
not derived from the pinned manifest. The 29/1 split matching the manifest's pin is a
coincidence of both describing the same v3 run.

**The distinction that matters for row 7:**

- **v3 (29/30) and r6 (0/30 `verified`) disagree completely, on the same 30 fixtures.** v3's
  agent finished inside budget and the cell matched; r6's ran to the step budget on 29 of 30.
- The manifest's `mycoVerdict` is v3's result frozen into a file. **It cannot be evidence for
  r6.**
- Therefore the scorecard's row 3 is a statement about **v3**, and r6 neither confirms nor
  contradicts it — r6 measures a different agent run under different conditions.

**No pass rate for r6 is stated here.** Whether row 3 stays DONE on v3's evidence, and what
r6's 30 `refuted` rows mean for it, is the row-7 Tier-2 decision.
