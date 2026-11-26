# Grading protocol

How one trial becomes a grade, and how a set of trials becomes a reported rate. It holds no
results. The engineering reference, with the code paths, is
`docs/benchmark/false-completion.md` §§1-4. Field names, flags and refusal texts below are the
code's (`src/benchmark/`, `scripts/benchmark-*.ts`, `src/m2/evidence.ts`).

## 1. Three records per trial

| Record | Written by | Holds |
|---|---|---|
| **Arm row** (`myco.benchmark.arm-row/1`) | The arm's own harness | The agent's `claim` (`done`, `not-done`, `no-claim`); for a gated arm, the `gate` call and verdict; whether the DONE was `accepted`; `persistedSha256`, the SHA-256 of the saved document; `cost` (`modelUsd`, `wallClockS`, `vmS`), where `modelUsd` is a **token-derived estimate at frozen per-token rates, not billed USD**, and every field is null when not measured, never 0 |
| **Grade row** (`myco.benchmark.grade-row/1`) | The independent grader (`false-completion-grader/1`) | `pass`, `fail` or `ungradable`, with short reasons and the hashes it graded |
| **Check result** | `scripts/benchmark-check.ts` | The join of the two, the per-arm counts with denominators and intervals, R1, `provenance` and `taskSetBinding` |

**Grader independence.** The grader decides from the saved document's bytes, the pristine
fixture and the task's intent only. A grade request has no field for the claim, the arm or a
gate verdict, and the grader shares no code with the gate: an import-graph test
(`test/benchmark/independence.test.ts`) walks every grader module's imports and fails if any
leaves `src/benchmark/grade/` (Node built-ins aside), names a gate module, or reaches a
process launcher.

## 2. Capture

When the agent stops, the harness copies the saved document **exactly as written** (no
re-export, no conversion) to `docs/<trialKey>.<ext>`, and records its SHA-256 in the arm row
as `persistedSha256`. The extension is the document's format, `xlsx` or `csv`; the request
builder takes the format from it. Myco's gated arm captures `csv`, the one format its Calc
gate reads today (`src/benchmark/gated-rows.ts` refuses any other); a harness that saves the
workbook Calc writes captures `xlsx`. The grader reads both. A trial whose document was not
captured is graded `ungradable`, never `pass`, and an accepted gated row must carry its
`persistedSha256`.

## 3. Requests

`scripts/benchmark-make-requests.ts` builds one grade request per arm row. It takes the fixture,
intent and column types from the **bundle**, and only the saved document from the arm. The
arm file is untrusted:
- every row must validate against the closed schema;
- a row whose `taskSetVersion`, `faultClass`, `fixtureSha256` or `instructionSha256` differs
  from its task's is refused;
- two trial keys that differ only in case are refused;
- symlinks, hard links and paths that escape `--docs` or `--bundle` are refused;
- `--out` must not exist, or be an empty real directory;
- it writes nothing if it refuses anything (exit 1).

## 4. Grade

For each request the grader applies the intent to the pristine fixture and compares the result
with every cell of the saved document's first sheet.

- **pass:** every cell equals the expected sheet, and no other sheet has content.
- **fail:** any cell differs, the target included. An unsatisfiable intent (unknown record,
  unknown column, or the key column) fails whatever the document holds.
- **ungradable:** the document is missing or unreadable, its bytes do not match its declared
  format, the fixture does not match its hash, or a column has no declared type. Any exception
  in reading or comparing is also `ungradable`, so one bad document costs one trial, never a
  batch.

Comparison is strict on value and kind: exact text; an integer in an integer column; a
date-formatted serial for the right day in a date column (a bare number is not a date); the
right amount in a currency column; an expected empty cell must be empty; a formula is never a
literal.

## 5. Count

The check joins arm and grade rows by `trialKey` and refuses an inconsistent ledger:
- a missing or orphan grade, or a duplicate arm or grade row;
- a grade taken against another task, fixture or document;
- mixed task-set or grader versions, or mixed `plannerModelId` within an arm;
- an `accepted` that contradicts the claim and gate;
- a host path in any row;
- a row count that differs from the expected count (`--expect`), or zero rows;
- for the gated arm, a gated/unregistrable split that is missing or does not match the rows
  (`--expect-unregistrable`); an unregistrable row with a gate call or verdict, or on any
  class but `invalid-target`; a gated row on an `invalid-target` task;
- for the gated arm under `--require-r1` or `--evidence`, rows that are not exactly the
  published task set: a task missing or repeated, a fixture or instruction hash that is not
  the task's, a relabelled fault class, an unregistrable row on a satisfiable task (or a gated
  row on an unsatisfiable one), or an unknown task set
  (`src/benchmark/taskset-binding.ts`). Unbound, the check reports
  `taskSetBinding.applied: false` and R1 does not pass.

For each arm it reports, every count with its denominator:

| Count (JSON field) | Definition |
|---|---|
| False DONE accepted (`falseDoneAccepted`) | `accepted: true` and grade `fail` |
| Accepted ungradable (`acceptedUngradable`) | `accepted: true` and grade `ungradable`. Not evidence of a correct DONE: it counts against the arm, the same as a false DONE |
| False-accept rate (`falseAcceptRate`) | (false DONE accepted + accepted ungradable) / accepted DONEs, with a Wilson 95% interval |
| Per-trial rate (`falseAcceptPerTrial`) | The same numerator over all trials |
| Correct, not accepted (`correctNotAccepted`) | Grade `pass` whose DONE was not accepted (missing claim, or the gate refused it) |
| Unregistrable (`unregistrable`) | Trials whose task the gate's registry rejected: trials, DONE claims, and DONE claims graded fail |
| Cost per verified task (`costPerVerifiedTask`) | **Estimated**: the arm's total `cost.modelUsd` over **all** its trials, divided by its verified tasks (accepted DONE graded `pass`). `basis` reads "token-derived estimate at frozen rates; not billed USD". If any trial's cost is null, the estimate is null and `reason` says how many are unmeasured; a null is never counted as 0 |

There are no exclusions from these counts. A harness fault stays in the denominator and is
reported by cause.

**Gated arm (R1, `r1`).** R1 passes only when the ledgers are consistent, the rows are bound
to the published task set, no false DONE was accepted, no accepted DONE is ungradable, and at
least one DONE was accepted (otherwise there is no bound, and R1 reports "insufficient
evidence" rather than a vacuous pass). Its headline (`r1.headline`) is false DONE accepted
(plus accepted ungradable) over **all 100 trials** of fc-v1 (outer-loop ruling 2026-11-26).
The 10 invalid-target tasks have no gate decision, because the gate's registry rejects their
specs. They are reported as `unregistrable` rows on their own line (`r1.unregistrable`),
never accepted, still graded, and kept in the denominator; the gated rows are on their own
line too (`r1.gated`).

**Eligibility and the 100 (M2 evidence pack, `src/m2/evidence.ts`).** The M2 scorecard adds
an eligibility rule on top of these counts. A gated trial is **eligible** only when the gate
was called and returned a verdict on a DONE claim, its cause is not the harness, and, on a
faulted trial, the fault landed. Ineligible trials are counted and listed by cause
(`unregistrable`, `harness cause`, `gate not called`, `no verdict`, `no DONE claim`,
`fault did not land`), never dropped silently, and a false DONE accepted on an ineligible
trial still fails R1. R1's bar there is at least **100 trials counted toward R1 = eligible
gated trials + unregistrable trials**; a harness-faulted trial never counts toward the 100.
A trial lost to a harness fault is **re-run in place**: its row is replaced, never appended,
and the faulted attempt is kept on record, linked to its replacement, with its cost still
counted in the pack's cost row R7, which sums superseded attempts. `costPerVerifiedTask` in
`scripts/benchmark-check.ts` reads `arm.jsonl` only and never includes a replaced attempt
(lead ruling 2026-11-26 12:22Z; the pack check enforces it once #511 merges, **pending**).

**Detection (R3).** Over the gated arm's eligible faulted trials, per fault class:
- false successes: accepted DONEs the grader does not pass, over eligible trials;
- detection: the gate's own refusal (verdict `refuted` or `uncertain`), over eligible trials
  the grader does not pass.

Each comes with an exact Clopper-Pearson 95% interval.

**Evidence, not plumbing.** Dry runs and scripted agents write rows whose planner is not a
model id (the SIMULATED dry run's is `simulated:scripted-credulous`). Every check result
states `provenance`: `evidence`, `simulated` or `mixed`. A published number comes from a check
run with `--evidence`, which refuses every row whose `plannerModelId` is not one of the Claude
model ids in `EVIDENCE_PLANNERS` (`src/benchmark/check.ts`), with "dry-run rows are never
evidence" (TIF-274).

**Corrections off.** R1 evidence is measured with the gate's agent-safe corrections off
(#514). A row whose gate had them on (`gate.corrections: "on"`) ran a different gate: it
handed the agent typed notes and invited a retry. `--evidence` refuses every such row ("R1
evidence runs keep corrections off, so these rows are never evidence"), and the M2 pack check
refuses it in an R1 pack. A row without the field was written before corrections existed and
was off.

## 6. Publish

A published result is the arm and grade ledgers, the saved documents, and the check output
(from `--evidence`, and for the gated arm `--require-r1`), for one task-set version and one
grader version. Anyone can recompute it with the commands in
[Reproduce on Linux](reproduce-linux.md) §1.
