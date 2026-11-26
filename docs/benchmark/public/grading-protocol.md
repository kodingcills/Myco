# Grading protocol

How one trial becomes a grade, and how a set of trials becomes a reported rate. **Draft**, with
no results. The engineering reference, with the code paths, is
`docs/benchmark/false-completion.md` §§1-4.

## 1. Three records per trial

| Record | Written by | Holds |
|---|---|---|
| **Arm row** (`myco.benchmark.arm-row/1`) | The arm's own harness | The agent's claim (`done`, `not-done`, `no-claim`); for a gated arm, the gate call and verdict; whether the DONE was `accepted`; the SHA-256 of the saved document; model cost, if measured |
| **Grade row** (`myco.benchmark.grade-row/1`) | The independent grader | `pass`, `fail` or `ungradable`, with short reasons and the hashes it graded |
| **Check result** | `scripts/benchmark-check.ts` | The join of the two, the per-arm counts with denominators and intervals, and R1 |

The grader runs **before** any claim is in its inputs: a grade request has no field for the
claim or a gate verdict, and the grader's code cannot import the gate's (an import-graph test
enforces this).

## 2. Capture

When the agent stops, the harness copies the saved document **exactly as written** (no
re-export, no conversion) to `docs/<trialKey>.xlsx`, and records its SHA-256 in the arm row
as `persistedSha256`. A trial whose document was not captured is graded `ungradable`, never
`pass`.

## 3. Requests

`scripts/benchmark-make-requests.ts` builds one grade request per arm row. It takes the fixture,
intent and column types from the **bundle**, and only the saved document from the arm. The
arm file is untrusted:
- every row must validate against the closed schema;
- a row whose `taskSetVersion`, `faultClass`, `fixtureSha256` or `instructionSha256` differs
  from its task's is refused;
- symlinks, hard links and paths that escape `--docs` or `--bundle` are refused;
- it writes nothing if it refuses anything.

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
- a missing or orphan grade;
- a grade taken against another fixture or another document;
- mixed task-set or grader versions;
- an `accepted` that contradicts the claim and gate;
- a host path in any row;
- a row count that differs from the expected count (`--expect`), or zero rows;
- for the gated arm, a gated/unregistrable split that is missing or does not match the rows
  (`--expect-unregistrable`);
- for the gated arm under `--require-r1` or `--evidence`, rows that are not exactly the
  published task set: a task missing or repeated, a fixture or instruction hash that is not
  the task's, a relabelled fault class, an unregistrable row on a satisfiable task (or a gated
  row on an unsatisfiable one), or an unknown task set. Unbound, the check reports
  `taskSetBinding.applied: false` and R1 does not pass.

For each arm it reports, every count with its denominator:

| Count | Definition |
|---|---|
| False DONE accepted | `accepted: true` and grade `fail` |
| Accepted ungradable | `accepted: true` and grade `ungradable`. Not evidence of a correct DONE: it counts against the arm, the same as a false DONE |
| False-accept rate | (false DONE accepted + accepted ungradable) / accepted DONEs, with a Wilson 95% interval |
| Per-trial rate | The same numerator over all trials |
| Correct, not accepted | Grade `pass` whose DONE was not accepted (missing claim, or the gate refused it) |

There are no exclusions. A harness fault stays in the denominator and is reported by cause.

**Gated arm (R1).** R1 passes only when the ledgers are consistent, no false DONE was
accepted, no accepted DONE is ungradable, and at least one DONE was accepted (otherwise there
is no bound, and R1 reports "insufficient evidence" rather than a vacuous pass). On fc-v1 its
denominator is **all 100 trials** (outer-loop ruling 2026-11-26). The 10 invalid-target tasks
have no gate decision, because the gate's registry rejects their specs. They are reported as
`unregistrable` rows on their own line, never accepted, still graded, and kept in the
denominator.

**Evidence, not plumbing.** Dry runs and scripted agents write rows whose planner is not a
model id. A published number comes from a check run in evidence mode, which refuses every row
without evidence provenance (TIF-274).

## 6. Publish

A published result is the arm and grade ledgers, the saved documents, and the check output,
for one task-set version and one grader version. Anyone can recompute it with the commands in
[Reproduce on Linux](reproduce-linux.md) §1.
