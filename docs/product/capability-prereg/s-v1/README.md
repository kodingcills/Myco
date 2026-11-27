# Track S pre-registration, s-v1

Status: **frozen before any conformance run. The bar is the spec's proposal, and the lead has not ruled on it yet (not ratified).** Nothing has been run under s-v1.

[`prereg.json`](prereg.json) is track S's pre-registration (capability-spec §3). S's bar is a **property bar** (capability-spec-2 §1.1 and §2 S), not an improvement statistic: there is no agent arm, no model and no step budget. `stepBudget` and `modelId` are `null`, and the file says why.

| Field | Where |
|---|---|
| Bar, as written | `preregistration.bar.text`: the "Pre-registered bar" of capability-spec-2 §2 S, verbatim, with its SHA-256 |
| Corpus | `trg-v1`, in `benchmark/schedule/trg-v1/` (92 cases: 88 in scope, 4 out of scope, plus 1 deferred case named in the manifest), with the manifest SHA-256 |
| Seeds | case order and marker; no task-build seed (the corpus build has no randomness); no assignment or bootstrap seed (no arms, no statistic) |
| Analysis | `scripts/s-v1-analysis.ts` and its modules in `src/schedule/conformance/`, each with its SHA-256 |
| Mutation table (bar item 6) | `scripts/schedule-mutation-proof.py` (#536, 56 mutants), with its SHA-256. The analysis reads the mutant labels and files from this script, so the mutation log must report exactly those mutants |
| Lead rulings | `leadRulings` (rulings applied before the freeze, with when they were posted; none so far) and `leadRulingPending` |
| Pre-registration hash | `preregSha256`: the SHA-256 of the canonical JSON of `preregistration` |

## Commands

```sh
npx tsx scripts/s-v1-freeze.ts --check   # the committed corpus and prereg match the tree
npx tsx scripts/s-v1-analysis.ts --results <results.json> --mutation-log <proof output>
```

The analysis exits 0 for "property holds", 1 for "not shown" (the report gives the codes), and 2 when the input is refused.

While `leadRulingPending` lists anything, the analysis never reads "property holds": a run that meets every bar item still reads "not shown" with `LEAD_RULING_PENDING` (exit 1), and the report lists the pending rulings. The bar can hold only after the lead rules and s-v1 is re-frozen with the rulings recorded, before any conformance run.

The mutation log must list exactly the mutants of the frozen `scripts/schedule-mutation-proof.py` (label and file). A made-up row reads `MUTANT_UNKNOWN` and an absent one `MUTANT_MISSING`, both "not shown".

It refuses input when any of these is true: a file has changed since the freeze; the S bar in the spec has changed; or the results come from another corpus or another pre-registration. It also refuses results that claim to be evidence. Rows come from the $0 scripted executor only. They prove the mechanism, never agent capability, and never count as evidence.

`python3 scripts/s-v1-mutation-proof.py` is the mutation proof for this pre-registration's own analysis. Each mutant re-freezes before the tests run, so the freeze check cannot be what kills it.

## Not yet built

The **conformance runner** drives `src/schedule` over `trg-v1` with the scripted executor and writes the results file. It is the next step, and no conformance run happens until it exists. If the runner shows that a frozen expectation is wrong before any run, s-v1 may be re-frozen. Once a conformance run has happened, any change is s-v2.

## Lead ruling pending

These are listed in `preregistration.leadRulingPending`:

- the bar itself;
- property bar vs #536's P1/P2 (spec-2 §6);
- an out-of-scope mismatch fails the bar;
- the ledger-write-fails case is out of scope for bar item 1.
