# Track J pre-registration, j-v1

**Status: proposed, not ratified. Lead ruling pending on the 5-point non-inferiority margin
(capability spec §6).** No run has used this pre-registration, and no result is claimed. Until
the lead rules, `prereg.json` lists the margin under `leadRulingPending`, and the analysis
reports every pack as "not shown" (`LEAD_RULING_PENDING`), whatever its numbers.

| | |
|---|---|
| Pre-registration | `prereg.json` (this directory) |
| Pre-registration hash (SHA-256 over canonical JSON) | `5b749c6563d8a56d911782bb3d4b0bc64c302d81093229b058d67a53e157549e` |
| Analysis script | `src/actions/j-v1-analysis.ts`, entry `analyzeJV1` |
| Analysis script SHA-256 | `515c2ad3bbbee69a9b0443483c98e2c661670554a89d010076b74ba1026a3a01` |
| Harness side (loader, schedule, J row adapter) | `src/actions/j-v1-harness.ts` |
| Tests | `test/actions/j-v1-prereg.test.ts`, `test/actions/j-v1-analysis.test.ts` |

## What it freezes

The bar of capability spec §2 J as written, tested in a fixed sequence at one-sided alpha
0.05: (1) verified-rate non-inferiority, the one-sided 95% upper bound of
(`hcu+shell` − `hcu+shell+J`) by Newcombe's paired score interval below 5 points; (2) wall time
per verified task and (3) steps per verified task, each by a paired bootstrap over tasks
(10,000 resamples, the pre-registered seed) whose one-sided 95% upper bound of J/baseline is
below 1.0. Task set fc-v1, the 90 satisfiable tasks (manifest SHA-256 in `prereg.json`), one
trial per task per arm, step budget 30, model `claude-sonnet-5-5`, gate absent in both arms,
graded by `false-completion-grader/1`.

**Canonical JSON** here means: object keys sorted by UTF-16 code unit, no whitespace,
`JSON.stringify` for strings, numbers, booleans and null. Reformatting `prereg.json` does not
change the hash; changing any value does.

## Choices this pre-registration makes where the spec is silent

Each is written into the frozen script and pinned by a test; the reviewer and the lead can
change any of them before the first run (after it, only a `j-v2` can).

- **Assignment.** From the assignment seed, the first draw picks the opening arm; the tasks,
  sorted by id, are shuffled (Fisher-Yates). Consecutive task pairs run in ABBA order. The
  analysis refuses a pack that ran in any other order.
- **Random stream.** mulberry32 seeded with the first four bytes of SHA-256(seed).
- **Bootstrap.** Both ratio components use the same resamples. A resample in which either arm
  has no verified task scores +Infinity (it counts against J). The upper bound is the sorted
  ratios' element at index ceil(0.95 · R) − 1.
- **Per-trial outcomes.** A trial with a harness fault (for example `UNRECORDED_ROUTE`: an
  action without a route record) stays in the denominator and is never verified. A trial with
  a boundary breach is void (never verified) and also marks the bar "not shown" as a breached
  guardrail.
- **Model id.** `claude-sonnet-5-5`, the R1 pilot's model, so the J pair shares its planner
  with the Ultra `hcu+shell` harness's head-to-head.
- **Not run under j-v1.** The 10 invalid-target tasks (the spec's J task set is the 90
  satisfiable tasks) and the secondary comparison against C1 (no Ultra C1 harness exists).

## Before the first run

The lead rules on the margin; ratification is a commit that empties `leadRulingPending` (and
changes the margin if the lead says so), which changes the hash above. Packs record that new
hash and the commit it was frozen in.
