# Corrections ON/OFF A/B: pre-registration

Status: pre-registered, committed before any run. No A/B trial, simulated dry runs aside,
has run against this file. Track E follow-up (Tier 2). The runner is `src/pilot/ab.ts`
(`scripts/m2-corrections-ab-run.ts`). The analysis is #547 (`src/m2/corrections-ab.ts`,
`scripts/m2-corrections-ab.ts`).

This file is the pre-registration. Its SHA-256 is computed by
`npx tsx scripts/m2-corrections-ab-run.ts prereg-hash`. The machine-readable copy,
`docs/benchmark/corrections-ab-prereg.json`, pins it (`markdownSha256`). Every arm config, run
header and A/B pack records it. A pack whose recorded hash is not this committed file's is
refused: by the runner's `check-pack`, and by #547's `--prereg-file` / `--prereg-declared`.
Changing one byte here is a new pre-registration, and runs under the old one stop exporting.

## The fixed design (lead decision, verbatim)

The lead's decision, as recorded by the coordinator. This is the fixed design.

> Lead decision (2026-11-26), recorded by the coordinator: the fixed pre-registration design for the corrections ON/OFF A/B (track E follow-up, TO FILE comment 7196317962). The pre-registration file must state this verbatim as the fixed design.
>
> **Stage 0: non-confirmatory, plumbing only.**
> - The pilot's 30 tasks per arm, paired by task.
> - Purpose: prove arm byte-identity, the ledger and anchor (#518), the grader wiring, and zero gate misses.
> - It makes NO effect claim, and its rows are excluded from the confirmatory test.
>
> **Stage 1: confirmatory.**
> - The full fc-v1 task set, 100 paired trials per arm. Seeds are fresh; no Stage 0 rows are reused.
> - Primary test: a one-sided exact sign test on discordant pairs (grader-verified ON vs OFF), alpha = 0.05.
> - A miss is recorded as "corrections not shown to help". It is not a fail.
> - Report the discordant counts and the paired difference with a 95% CI, alongside the p-value.
>
> **Fail-closed.** Any gate miss (the gate says VERIFIED, the grader fails) is an integrity incident. It halts the run and gets its own record before anything resumes.
>
> **Pacing.** Stage 1 runs in resumable chunks, paced to leave builder and verifier headroom on Ultra. No API. Real runs wait for the integrity fixes and the lead's GO.

The sections below make that design operational. Where they say more, they only fix
parameters the design leaves open. None of them changes it.

## Hypothesis

H1: with the gate's agent-safe corrections (#514) ON, the agent finishes more fc-v1 tasks than
with them OFF. Finishing means grader-verified, as defined below. H0: corrections do not raise
the grader-verified rate. The test is one-sided.

## Arms

- **ON:** the R1 pilot harness (#524), with `corrections: "on"` for the `calc-record-edit`
  family. The trial's gate server gets `--corrections calc-record-edit`, and the harness's own
  post-stop check gets `GateConfig.corrections`.
- **OFF:** the same harness with `corrections: "off"`.
- The two arm configs are byte-identical apart from `corrections`. The runner diffs them at
  every depth and refuses any other difference. It also diffs the launch plans: the only
  difference allowed is the ON arm's `--corrections` flag on the gate server. #547 repeats the
  config check on the packs.
- Same model (`claude-sonnet-5-5`), same argv, same tool grant, same system text, same
  environment allowlist, same pacing, same retry budget.

## Primary metric

The **grader-verified rate**: the agent claimed DONE, the gate accepted it, and the independent
grader (`src/benchmark/grade/`) passes the saved document. It is never the gate's verdict alone.
The grader never sees corrections: its only inputs are the bundle and the saved document.

## Success bar

Stage 1 only. The one-sided exact sign test on the discordant pairs (ON-only verified vs
OFF-only verified) gives p < 0.05. Then the result is "corrections help". Otherwise it is
"corrections not shown to help". A miss is not a fail. Stage 0 never claims an effect.

## Stages

| | Stage 0 | Stage 1 |
|---|---|---|
| Role | non-confirmatory, plumbing only | confirmatory |
| Task set | the pilot's 30 (`benchmark/pilot/r1/config.json` trials) | fc-v1, all 100 tasks |
| Pairs (trials per arm) | 30 | 100 |
| k (runs per task per arm) | 1 | 1 |
| Seed | `stages.0.seed` in the JSON | `stages.1.seed`, fresh (must differ from Stage 0's) |
| Trial keys | `ab-s0-on-*`, `ab-s0-off-*` | `ab-s1-on-*`, `ab-s1-off-*` |
| Effect claim | none, whatever the numbers say | the primary test |

- Stage 1 reuses no Stage 0 row. Its trials are new attempts under their own keys, and #547
  refuses a Stage 1 trial key found in the Stage 0 ledgers.
- The seed sets the task order, the chunks and which arm runs first in each chunk. It is a
  seeded Fisher-Yates shuffle over sha256, with no `Math.random`. The runner writes the schedule
  on the first run, then re-derives it and compares it on every resume.
- Unregistrable tasks (fc-v1's invalid-target tasks) are paired like any other task. Neither
  arm can verify them, so they are concordant "neither" pairs.

## Pacing

- **Per trial:** the pilot's default pacing. One trial at a time. 90 s between trial starts.
  A rate limit waits 5 min, doubling to at most 60 min. Four rate limits in a row pause the run.
  A trial stops after 30 min. Three non-limit harness faults close a trial.
- **Chunks:** 10 pairs per chunk, so 20 trials. Stage 0 has 3 chunks and Stage 1 has 10. Each
  chunk runs both arms, in the seeded order.
- **Headroom on Ultra:** one chunk per invocation by default, and 30 min between chunks inside
  one invocation. The operator re-runs the same command to continue.
- **No API:** headless Claude Code on the subscription only. The pilot's preflight refuses any
  API-key variable by name.

## Harness faults, ledger, resets

- A harness fault is re-run in place under the topped-up-run ruling. Only faults raised before
  a decision count (rate limit, lost login, timeout, crash, spawn failure, transport error,
  unclassified error result). The faulted attempt stays in the ledger, linked by `supersedes`.
  An agent outcome is never re-run.
- Every attempt goes to #518's attempt ledger (`attempts.jsonl`, hash-chained), and its head
  goes to the host-side anchor outside the pack.
- Every decided trial records its reset boot class (#546). A live trial whose reset is missing
  or is not a cold boot halts the run.

## Stopping rule

1. A stage stops when all its pairs are decided. There is no early stop for efficacy or
   futility, and no interim analysis. `status` prints progress counts and never a p-value.
2. A gate miss halts the run at once (see Fail-closed).
3. Rate limits, a lost login, a `PAUSE` file or the chunk budget pause the run. Re-running the
   same command resumes it. A pause is not a stop.
4. A trial that spends its harness-fault budget is closed, and the stage reports `incomplete`.
   An incomplete Stage 1 is analysed as is: #547 refuses missing pairs, so it makes no effect
   claim. Pairs are never dropped to make up a number.
5. Stage 1 starts only after Stage 0 has finished with zero gate misses, and after the lead's
   GO for Stage 1.

## Fail-closed: gate misses

- The runner grades every decided trial with the independent grader as soon as the trial is
  decided, in both arms. A gate miss is a trial the gate VERIFIED whose grade is not pass.
- On a gate miss the runner halts the whole run. It starts no new trial; trials already in
  flight finish and are recorded. It writes an integrity-incident record to
  `<run>/stage<N>/incidents/`.
- Nothing resumes until an operator acknowledges the record with an ack file that names the
  record's sha256 (`ack-incident`). The runner never writes an ack.
- The incident stays in the pack, and #547 reports it as `halted`. It is never counted as data.

## Analysis

Run #547's CLI on each exported pack:

```
npx tsx scripts/m2-corrections-ab.ts --stage <0|1> \
  --on-arm <pack>/on/arm.jsonl --on-grades <pack>/on/grades.jsonl \
  --off-arm <pack>/off/arm.jsonl --off-grades <pack>/off/grades.jsonl \
  --on-config <pack>/on/run-config.json --off-config <pack>/off/run-config.json \
  [--stage0-on-arm <stage0-pack>/on/arm.jsonl --stage0-off-arm <stage0-pack>/off/arm.jsonl] \
  --prereg-file docs/benchmark/corrections-ab-prereg.md --prereg-declared <pack's recorded sha256>
```

The runner's `analyze` command checks the pack first, then prints and runs exactly this
command. Report the 2x2 table, the discordant counts (ON-only, OFF-only), the one-sided exact
sign-test p, the paired difference (ON rate minus OFF rate) with its 95% CI (Newcombe, method
10), and the effect reading.

## Evidence use

Experiment only. Neither arm is ever R1 evidence, the OFF arm included. Every arm row carries
`experiment: "corrections-ab/stage-<N>"`, and every pack carries an `EXPERIMENT` marker and no
`pack.json`. `checkBenchmark(..., { evidence: true })` and the M2 pack CLI refuse them. The ON
arm is also refused by the corrections-on rule. A simulated run is also marked `SIMULATED`.

## Real runs

A real run waits for all of these. The runner checks each one and refuses with the reason:

- this file and its JSON are committed and unchanged;
- the lead's GO is committed in `docs/benchmark/corrections-ab-go.json`, naming the stage and
  this file's sha256;
- the integrity fixes have landed. The gate must read the tasks' format: fc-v1 persists xlsx,
  and the gate reads CSV until the xlsx replacement for #503. #546's cold-boot guard must be
  merged;
- the operator passes `--launch-real-trials` and the `--plan-sha256` printed by `plan`.

Until a live driver with VM-side capture is wired, `launch` refuses after these checks.
