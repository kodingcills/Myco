# Track I pre-registration, version 1 (structured state access)

**Status: frozen as proposed, lead ruling pending.** No trial has been run. The values the
capability spec leaves to the lead are written here as proposed and listed in
`prereg.json` under `leadRulingPending`. Nothing here is ratified until the lead says so.
Until the first measurement run, a ruling may change a value in place; after it, any
change makes `i-v2` (capability spec §3).

| File | What it is |
|---|---|
| `prereg.json` | The pre-registration (capability spec §3 item 1) |
| `prereg.sha256` | The **pre-registration hash**: SHA-256 of `prereg.json`'s canonical JSON (sorted keys, no whitespace) |

## What it fixes

- **Bar:** capability spec §2 "I. Structured state access", pinned by the SHA-256 of that
  section's text. In a fixed sequence at one-sided alpha 0.05: (1) exact McNemar, `C1+I`
  better than `C1` on verified, at least 5 discordant tasks; (2) only if 1 is shown, the
  paired-bootstrap upper bound of steps per verified task, `C1+I`/`C1`, below 1.0
  (10,000 resamples).
- **Task set:** fc-v1, by the SHA-256 of `manifest.json` (and `tasks.jsonl` against it),
  k = 1. The bar is on the 90 satisfiable tasks. The 10 invalid-target tasks are a
  guardrail.
- **Seeds:** assignment (seeded ABBA order), bootstrap, and fc-v1's own build seeds.
- **Step budget** 30 (C1's `STEP_BUDGET`), retry budget 0, no wall-clock budget.
- **Model id** (proposed: the R1 pilot's model). **Gate:** absent in both arms.
- **Analysis:** `npx tsx scripts/capability-i-analysis.ts <pack.json>`. The script and every
  module it imports are frozen by SHA-256 in `analysis.files`. The analysis refuses to run
  if any of them changed.

## Lead ruling pending: nothing is shown

While `leadRulingPending` is non-empty (or is not a list of strings), the analysis reports
status `LEAD_RULING_PENDING`, shows no bar component, and the CLI exits 3, whatever the
pack says. A proposed bar is never reported as met. When the lead rules, the ruling and its
timestamp are recorded here, the entry leaves `leadRulingPending`, and the hashes are
re-pinned before the first run. No ruling has been posted yet.

## What the analysis refuses

The analysis reports "not shown", with the reason, for any of these: a pack whose
pre-registration hash is not this one; a hash that the pack's recorded commit does not
hold; any row that is not exactly `simulated: false` (a missing field or the string
`"false"` is refused too), or a non-model planner; a planner other than the pre-registered
model; a malformed row; a step count over the budget; a missing or duplicated (task, arm)
trial (no exclusions); a tool-output scan breach; task facts that do not split 90/10; or
more false DONEs on invalid-target tasks in `C1+I` than in `C1`.

CLI exit codes: 0 shown, 1 not shown, 2 could not run (including any flag: there is no
`--require-r1` or `--evidence` mode), 3 `LEAD_RULING_PENDING`.

Tests: `test/state/i-prereg.test.ts`, `test/state/i-analysis.test.ts`.
