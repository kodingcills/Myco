# Track J pre-registration, j-v1

**Status: lead ruling of 2026-11-27 05:39Z recorded; frozen for review. No run has used this
pre-registration, and no result is claimed.**

| | |
|---|---|
| Pre-registration | `prereg.json` (this directory) |
| Pre-registration hash (SHA-256 over canonical JSON) | `832354f63c4e78b962872d9d77fc4068aba1e55666751751b52fed0e2f98ec70` |
| Analysis script | `src/actions/j-v1-analysis.ts`, entry `analyzeJV1` |
| Analysis script SHA-256 | `898456aa5020b5847f29c772e2a0cb15731a6545d0021245706706546c2162f3` |
| Harness side (loader, schedule, J row adapter) | `src/actions/j-v1-harness.ts` |
| Tests | `test/actions/j-v1-prereg.test.ts`, `test/actions/j-v1-analysis.test.ts`, `test/actions/j-v1-harness.test.ts` |

## The lead's ruling (05:39Z, relayed by the coordinator on PR #636)

Capability spec §6 asked whether the 5-point non-inferiority margin is right at n = 90. The
lead chose **option (c)**: keep the 5-point margin and pre-register **k = 2 repeats per task per
arm**. The same margin rule applies to track L. The ruling has a condition: estimate the VM-hours
J needs at k = 2, and if that would delay the R1 pilot, the `hcu+shell` head-to-head, the
corrections A/B or the 90 s demo, switch to **option (b)**, a 7-point margin at k = 1, before
freezing and never after any data. `prereg.json` records the ruling under `leadRulings`, and
`leadRulingPending` is empty.

**Why k = 2 rescues the margin.** With equal arms and about 11% of pairs discordant, the
one-sided 95% Newcombe bound is about 6.2 points at 90 pairs (fails 5) and about 4.2 points at
180 pairs (passes). Both figures are pinned in `j-v1-analysis.test.ts`.

**VM-hours estimate** (`vmHoursEstimate` in `prereg.json`). The repo's measured per-trial cost
on the single Windows VM is 140 s cold reset + about 100 s redeploy + about 135 s trial = 375 s
(`docs/baseline/screenshot-agent.md`, budget). At k = 2, J runs 90 tasks × 2 arms × 2 = 360
trials: **37.5 VM-hours**. If the Ultra trial takes twice as long as M1's, about 51 VM-hours.
Option (b) would be 180 trials, 18.75 VM-hours. Track L runs on the Linux path, not the Windows
VM, so its estimate belongs to L's own pre-registration.

**Why option (c) stands.** Spec §4 and m2-plan §7.0 give a capability track VM time only when
the critical path does not need the VM. J's Windows arm also waits for the guest-side router
(fast-path.md §6). Run that way, J's 37.5 hours come after and around the four critical-path
items and do not delay them. **If the coordinator's VM schedule says otherwise, j-v1 switches
to option (b) in this PR, before it merges.** The analysis already supports k = 1 and the
7-point margin: the option (b) tests run the same script.

## What it freezes

The bar of capability spec §2 J as written, tested in a fixed sequence at one-sided alpha 0.05:

1. **Verified-rate non-inferiority.** The one-sided 95% upper bound of
   (`hcu+shell` − `hcu+shell+J`), by Newcombe's paired score interval over the 180
   (task, repeat) pairs, is below 5 points.
2. **Wall time per verified task.** A paired bootstrap over tasks (10,000 resamples, the
   pre-registered seed; each resampled task brings both of its repeats in both arms) gives a
   one-sided 95% upper bound of J/baseline below 1.0.
3. **Steps per verified task.** The same bootstrap and the same test, on steps.

The rest of the setup:

- Task set: fc-v1, the 90 satisfiable tasks (manifest SHA-256 in `prereg.json`).
- k = 2 trials per task per arm, step budget 30.
- Model: `claude-sonnet-5-5`.
- Gate absent in both arms.
- Graded by `false-completion-grader/1`.

**Canonical JSON** here means: object keys sorted by UTF-16 code unit, no whitespace,
`JSON.stringify` for strings, numbers, booleans and null. Reformatting `prereg.json` does not
change the hash. Changing any value does.

## Choices this pre-registration makes where the spec is silent

Each choice is written into the frozen script and pinned by a test. The reviewer and the lead
can change any of them before the first run. After it, only a `j-v2` can.

- **Assignment.** The first draw from the assignment seed picks the opening arm. The tasks,
  sorted by id, are then shuffled (Fisher-Yates). Each task's four trials run as one ABBA block,
  alternating ABBA and BAAB over task positions. The analysis refuses a pack that ran in any
  other order.
- **Pairing at k = 2.** Repeat r of the baseline pairs with repeat r of J, numbered by the
  schedule. The Newcombe bound treats the 180 pairs as independent and does not model
  clustering by task. Fast-path.md §5's k = 2 proposal, and the ruling's margin arithmetic, both
  rest on that same assumption. The bootstrap does resample whole tasks.
- **Random stream.** mulberry32, seeded with the first four bytes of SHA-256(seed).
- **Bootstrap.** Both ratio components use the same resamples. A resample in which either arm
  has no verified trial scores +Infinity, which counts against J. The upper bound is the sorted
  ratios' element at index ceil(0.95 · R) − 1.
- **Per-trial outcomes.**
  - A trial with a harness fault (for example `UNRECORDED_ROUTE`: an action without a route
    record) stays in the denominator and is never verified.
  - A trial with a boundary breach is void (never verified). It also marks the bar "not shown"
    as a breached guardrail.
- **Parity (spec §1.3, §1.5).** Every row records `instructionSha256`, `fixtureSha256`,
  `stepBudget` and `outputCeiling`. All trials of one task, in both arms and both repeats, must
  share one instruction hash and one fixture hash, and every row must carry the pre-registered
  step budget (30) and output ceiling (1024). Otherwise the bar is not shown
  (`PARITY_MISMATCH`), with the numbers still computed.
- **The frozen-in commit (spec §3 item 2).** A pack records the pre-registration hash and the
  commit on `main` that froze this pre-registration. The analysis refuses a pack without a
  40-hex commit (`PACK_FROZEN_COMMIT`). The script does no I/O (it imports `node:crypto` and
  the shared guard below), so checking that the commit really holds this `prereg.json` is the
  pack tooling's job (it has git).
- **The shared capability-analysis guard (GitHub #652, lead ruling 2026-11-27 06:21Z).**
  Before any decision the script calls `guardCapabilityAnalysis` from
  `src/capability/analysis-guard.ts`, which imports nothing and is pinned by its own SHA-256
  under `analysis.modules` (the loader checks both hashes). It refuses a pack whose
  pre-registration hash does not match (`PREREG_HASH_MISMATCH`), and the verdict is never
  "shown" while `leadRulingPending` is non-empty (`LEAD_RULING_PENDING`, `exitCode` 3) or any
  row's `simulated` is anything but absent or `false` (`SIMULATED`). Adopting it changed the
  analysis script and so this pre-registration's hash; no run had used j-v1, so this is an
  edit before the first run (spec §3 item 3), not a new version.
- **No gate.** The J row adapter refuses a fast-path row that carries a gate verdict: j-v1 is
  gate-absent in both arms, and only the independent grader's grade is read.
- **Model id.** `claude-sonnet-5-5`, the R1 pilot's model, so the J pair shares its planner
  with the Ultra `hcu+shell` harness's head-to-head.
- **Not run under j-v1.** The 10 invalid-target tasks are left out, because the spec's J task
  set is the 90 satisfiable tasks. The secondary comparison against C1 is left out, because no
  Ultra C1 harness exists.
