# Track R pre-registration, version r-v1

Track R is "Task recording to automation" (`docs/product/task-recording.md`). Its bar is
`docs/product/capability-spec-2.md`, section R. This folder freezes that bar for the first
measurement. Nothing here has been run, and no result is claimed. The values listed in
`prereg.json` under `leadRulingPending` are proposals until the lead rules on them.

| File | What it is |
|---|---|
| `prereg.json` | The pre-registration: the bar, the task set and its manifest SHA-256, the seeds, the step budget, the model id, and the analysis files with their SHA-256 |
| `prereg.sha256` | The pre-registration hash: SHA-256 over canonical JSON (sorted keys, no whitespace) of `prereg.json`. Every pack records it |
| `fr-v1-manifest.json` | Task set `fr-v1`, built by `src/recording-eval/fr-v1.ts`: 30 single-edit Calc tasks on fresh CSV fixtures, and four demonstration families, one per data column |

## Commands (offline, $0)

```sh
npx tsx scripts/r-v1-analysis.ts hash               # prints the pre-registration hash
npx tsx scripts/r-v1-analysis.ts manifest --check   # the committed manifest matches the builder
npx tsx scripts/r-v1-analysis.ts analyse --pack DIR --evidence
```

A pack directory holds `pack.json` (`myco.capability.r-pack/1`), `trials.jsonl`
(`myco.capability.r-trial/1`, one row per trial) and `grades.jsonl` (the independent grader's
`myco.benchmark.grade-row/1` rows). VERIFIED is a `done` claim the grader graded `pass`. The
derived oracle's verdict counts only toward the R5 prerequisite and the false-accept guardrail.
The analysis refuses to run if this script, the analysis module or the planted-marker
scanner (`src/recording/scrub.ts`) no longer matches the SHA-256 frozen in `prereg.json`
(`ANALYSIS_CODE_CHANGED`), or if `prereg.json` no longer hashes to the committed
`prereg.sha256` (`PREREG_NOT_COMMITTED`). A pack whose recorded hash differs from the
prereg is refused `PREREG_HASH_MISMATCH`.
While `leadRulingPending` lists anything, the analysis reports `LEAD_RULING_PENDING`: the
statistics are computed as numbers, but nothing is reported as shown and `barShown` is false.
A trial or grade row whose `simulated` field is anything but exactly `false` is refused
`ROW_SIMULATED`.

## Before the first trial (queued; not done in this change)

1. **The lead's ruling** on the `leadRulingPending` values, and the lead's GO for track R
   (capability-spec section 4). A changed value means a new prereg file, and therefore a new hash.
2. **Operator demonstrations, a human step.** These run on the Linux path and need no VM.
   - The operator records one demonstration per family, using
     `pnpm myco-record record --doc <fixture>.csv --out <family>.json`.
   - Each demonstration uses that family's demonstration fixture from the manifest
     (`demonstrationFamilies[].fixtureSeed`).
   - The recording must have `simulated: false`.
   - Each recording's SHA-256 goes into the pack's `demonstrations`.
   - Scripted-human recordings never count.
3. **The arms.** These are built separately and are not part of this change:
   - the `run_workflow` agent tool, with its own scoped review;
   - the R arm runner on the Ultra `hcu+shell` harness, which writes `myco.capability.r-trial/1` rows;
   - C1 on the same harness, if the secondary comparison is run.
