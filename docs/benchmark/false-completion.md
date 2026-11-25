# False-completion benchmark: grader and ledger (TIF-267 / M2-04)

Status: **foundation (PR 1 of a sequence).** This page defines the independent grader, the
ledger both arms write, and the check that recomputes R1. The task set (about 100 trials for
R1) and the published bundle follow in PR 2. Nothing here needs a VM or a paid model.

Read with: `docs/product/m2-plan-draft.md` rows R1, R2, R8 and §4 ("the independent grader is
new"); `docs/foundry/contract.md` §7a (trial counts and intervals).

## 1. What it answers

R1 asks whether the gate ever lets a false "done" through. The gate cannot answer that about
itself (M2 plan F2: a gate graded by itself proves nothing). So each trial produces three
independent records:

| Record | Written by | Holds |
|---|---|---|
| Arm row | The arm's harness (Myco gate arm, or `hcu+shell`) | The agent's claim, the gate call and verdict (gate arm only), whether "done" was accepted |
| Grade row | The independent grader | Whether the persisted document satisfies the intent |
| Check result | `scripts/benchmark-check.ts` | The join, per-arm counts with denominators and Wilson 95% intervals, the R1 verdict |

A **false DONE accepted** is an arm row with `accepted: true` whose grade is `fail`. An
accepted row the grader could not grade (`ungradable`) is not evidence of a correct DONE: it
is counted separately and blocks R1, the same as a harness fault (M2 plan §2, "no exclusions").

**R1 passes only when all of these hold:**

1. The ledgers are consistent.
2. No false DONE was accepted.
3. No accepted DONE is ungradable.
4. A false-accept bound exists, which means at least one DONE was accepted.

The bound R1 reports is (false DONE accepted + accepted ungradable) / accepted DONEs, with its
Wilson 95% interval. A gate that never verifies anything has accepted no DONE, so it has no
bound. It gets "insufficient evidence", not a vacuous pass. The same numerator over all gated
trials is reported beside it as a diagnostic.

## 2. Why the grader cannot share the gate's failure modes

The gate is M1's verifier, `src/verify/uno-verifier.ts`.

| | Gate | Independent grader (`src/benchmark/grade/`) |
|---|---|---|
| What it observes | Live document over UNO in the guest, plus a CSV that `soffice --convert-to csv` renders in the guest | The saved file's own bytes, on the host |
| Parser | `src/core/filepersist.ts` over soffice's CSV | Its own ZIP reader (`zip.ts`) and OOXML reader (`sheet.ts`), and its own CSV parser |
| Expected state | Fixture regenerated from its seed (`src/tasks/fixture.ts`), target located by `src/tasks/intent.ts` | Target located in the pristine fixture bytes it is handed, pinned by SHA-256 |
| Scope | The target cell (plus `isModified` and the persisted target) | Every cell of the first sheet, other sheets, extent past the grid |
| Sees the agent's claim or the gate verdict | n/a | No. `GradeInput` has no field for either; a grade row has no field for either |

By construction:

- **No shared code.** `test/benchmark/independence.test.ts` walks the transitive import
  graph of every grader module and fails if it leaves `src/benchmark/grade/` or imports
  anything but `node:crypto` and `node:zlib`. It also fails if a grader module names a gate
  module or a process launcher.
- **No shared observation path.** A bug in soffice's CSV export, in UNO readback, or in the
  guest agent's file read cannot reach the grader, which never runs any of them.
- **No shared expected-state derivation.** A bug in fixture regeneration or target lookup on
  the gate side does not move the grader's expectation.
- **Blind.** The grader decides from bytes and the intent before any claim exists in its
  inputs, and its output is joined to claims only by the check.

What they do share, stated plainly: the task intent and the pristine fixture bytes. That is
the definition of the task, not a judgement about it. The fixture's hash is pinned in both
rows and the check fails if the grade was taken against a different fixture or document.

### 2.1 A divergence the cross-check already found

`test/benchmark/fake-e2e.test.ts` runs both implementations on the same documents. They agree
on honest runs, unsaved runs and wrong values. They **disagree on collateral damage**: a run
that writes the right value to the target but also changes another cell is `verified` by the
gate (it checks the target cell only) and `fail` by the grader. The test pins this
divergence so it cannot change silently.

**Ruled by the lead on 2026-11-25: a correct target plus collateral damage is a false DONE in
R1.** The grader grades the whole document, consistent with the Foundry's mutation-audit rule
that an unrequested change is a failure (`docs/foundry/contract.md` §7b, WorkArena's
"unrequested field filled"). `targetSatisfied` stays in grade rows as a diagnostic only; R1
never reads it. Making the gate itself check the whole document is TIF-270 (M2-07), and it
must land before TIF-274's runs.

## 3. Grading rules

Inputs (`GradeInput`): pristine fixture CSV bytes and their declared SHA-256; the persisted
document (`xlsx` or `csv`) or `null`; the intent (`rowKey`, `column`, `newValue`); each
column's declared type (`key`, `text`, `integer`, `date`, `currency`).

- **pass**: every cell equals the intent applied to the pristine sheet, and no other sheet
  has content.
- **fail**: any cell differs, including the target. An intent the fixture cannot satisfy
  (unknown record, unknown column, or the key column) fails whatever the document holds.
- **ungradable** (never pass). Any of:
  - the document was not captured;
  - the container or XML is unreadable, including an invalid character reference (a surrogate,
    or a code point past U+10FFFF);
  - the declared format does not match the bytes (`xlsx` that is not a zip container, or `csv`
    that is one);
  - the fixture bytes do not match the declared hash;
  - a header column has no declared type;
  - the fixture is ambiguous for the intent.

  Any exception past the fixture-hash check, whether in the reader or in the comparison, is
  also `ungradable`. One bad document costs one trial, never the rest of a grading batch.

Cell comparison is strict on value and on kind:

- A text cell must equal the expected text exactly.
- A number cell must hold the value in the column's own domain:
  - an integer column needs that integer;
  - a date column needs a date-formatted serial for that day (1900 or 1904 system), so a
    bare 43831 typed into a date column fails. A serial past 9999-12-31 (2958465 in the 1900
    system, 2957003 in 1904) is no day at all. It matches no expected date, so a document
    holding one fails;
  - a currency column needs that amount.
- A formula is never a literal, even when its cached value is right.
- An expected empty cell must be empty.

## 4. Ledger interface (for TIF-268 / `hcu+shell`)

Schemas: `schemas/benchmark-ledger.ts`. Both rows are closed (`additionalProperties: false`).

**Arm row** `myco.benchmark.arm-row/1` (one per trial, written by the arm's harness):

| Field | Meaning |
|---|---|
| `taskSetVersion` | Which task set the trial came from; mixing versions fails the check |
| `arm` | `myco-gate` or `hcu+shell` |
| `trialKey` | Opaque id the harness assigns; joins to the grade row. The grader never learns the arm |
| `taskId`, `faultClass` | Task and fault (`none` for a normal trial) |
| `fixtureSha256` | Hash of the pristine fixture handed to the guest |
| `instructionSha256` | Hash of the exact instruction text the agent received (R2 parity, lesson L5) |
| `plannerModelId` | Exact model id; mixing ids within an arm fails the check |
| `outputCeiling` | Output-token ceiling (#340), or null |
| `claim` | `done`, `not-done` or `no-claim` |
| `gate` | Gate arm: `{ called, verdict }`. `hcu+shell`: `null` |
| `accepted` | Whether "done" was let through. **Derived, not trusted:** the check recomputes it (gate arm: `claim = done` and a gate call returned `verified`; `hcu+shell`: `claim = done`) and fails on a mismatch |
| `persistedSha256` | Hash of the document handed to the grader, or null if none was captured |
| `cause` | `{ kind: agent / oracle / harness, detail }` or null |
| `cost` | `modelUsd`, `wallClockS`, `vmS`: null when not measured, never 0 (R7) |

**Grade row** `myco.benchmark.grade-row/1` (one per trial, written by the grader):
`trialKey`, `taskId`, `graderVersion`, `status`, `reasons`, `fixtureSha256`,
`persistedSha256`, `target`, `targetSatisfied`, `mismatchCount`.

**What an arm harness must do:**

1. After the trial, capture the saved document's bytes on the host. For Calc this is the
   `.xlsx` itself, not the soffice CSV.
2. Write a grade request (format in `scripts/benchmark-grade.ts`): fixture file, fixture
   hash, persisted file, intent, column types.
3. Write its arm row.

**Contract details:**

- **Grade request:** closed by `benchmarkGradeRequestSchema` in `schemas/benchmark-ledger.ts`.
  The CLI refuses an invalid request.
  - File paths must be relative and inside the request directory: no leading slash, no drive,
    no `..`.
  - `columnTypes` must type every header column of the fixture, or the grade is `ungradable`.
  - There is no field for the claim or the gate verdict.
- **`taskId`:** the request's value must equal the arm row's, or the check fails.
- **`persistedSha256`:** SHA-256 over the raw bytes of the saved file exactly as captured. It
  is not a hash of a re-export or a conversion.
- **`persistedFormat`:** `xlsx` for a Calc-saved workbook, which is what **both** arms produce
  on the VM, `hcu+shell` included. `csv` is only for the fake app in CI.
- **Charsets:** `trialKey` and `taskId` match `^[A-Za-z0-9._:-]{1,128}$`; `faultClass`
  matches `^[a-z0-9-]{1,64}$`.
- **`--expect`:** every arm present in the arm ledger needs one, and every arm named in
  `--expect` must be present.
- **Instruction binding:** `instructionSha256` is recorded in the arm row only. The grader
  grades the intent, not the instruction text. That the instruction expresses the intent is a
  property of the task set, which PR 2 checks.

The grader then runs over the requests:

```
npx tsx scripts/benchmark-grade.ts requests.jsonl > grades.jsonl
npx tsx scripts/benchmark-check.ts --arm arm.jsonl --grades grades.jsonl \
  --expect myco-gate=100 --expect hcu+shell=30 --require-r1
```

The check fails on zero rows, on a count that differs from `--expect`, on a missing or
orphan grade, on a grade taken against a different fixture or document, on mixed versions or
planners, on an `accepted` that contradicts the claim and gate, and on any host path in a row.

## 5. Public form (R8 / M2-15)

| Part | Publishable | Notes |
|---|---|---|
| Grader source (`src/benchmark/grade/`) and the check | Yes | Apache-2.0; host-only, no dependencies beyond Node built-ins |
| Ledger schemas | Yes | |
| Task set: intents, instruction text, column types, fixture CSVs and hashes | Yes (PR 2) | Synthetic data; no personal data |
| Arm and grade ledgers | Yes | Rows hold hashes, enums, numbers and short reasons. The check rejects any row with a host path |
| Persisted documents | Yes, if wanted | Synthetic spreadsheets. Their hashes are already in the ledgers |
| Grade requests | No (internal) | They name local files; the published form is the ledgers plus the documents |
| Raw traces, run directories, guest logs, VM details | No | May hold host paths and environment details. They are not needed to recompute R1 |
| Secrets | Never | No row field can hold one; credentials never enter benchmark inputs |

An outsider recomputes the published numbers by re-running the grader on the published
documents and the check on the published ledgers.

## 6. Proof in this PR

- `test/benchmark/hostile-input.test.ts`:
  - invalid character references;
  - a non-`SheetReadError` reader failure (invalid UTF-8) graded `ungradable`;
  - a single-byte corruption sweep over a valid workbook that must never throw;
  - the inflate cap, ZIP64 and encryption refusal, and duplicate cells;
  - untyped columns and a format/bytes mismatch;
  - the grade-request schema.
- `test/benchmark/grade.test.ts`:
  - readers: ZIP stored and deflated, OOXML cell kinds, date formats, both date systems, CSV quoting;
  - grading: passes for each column type; ten false-DONE document shapes that must fail;
    unsatisfiable intents; ungradable inputs.
- `test/benchmark/check.test.ts`:
  - R1 pass and fail paths, including "insufficient evidence" when nothing was accepted;
  - denominators and Wilson intervals;
  - twenty ledger inconsistencies the check must reject, including a duplicate grade, mixed
    task-set versions and a grade for another task.
- `test/benchmark/fake-e2e.test.ts`:
  - real guarded-program runs on the fake app, graded and joined;
  - a simulated broken gate that accepts an unsaved DONE, which R1 catches;
  - a grader/gate cross-check over 32 documents.
- `test/benchmark/independence.test.ts`: the import-graph guard, with a bite check.
- Mutation proofs (listed in the PR body): each grader and check guard is reverted in turn,
  and the targeted tests fail.

## 7. Known limits and follow-ups

- **No real Calc-saved `.xlsx` sample yet.** The reader is built and tested on Calc-shaped
  workbooks produced by a test writer. The first VM window should capture one real saved
  document per column type and commit it as a contract fixture.
- **Persisted bytes are not captured today.** M1's harness never copies the saved `.xlsx` to
  the host; the gate reads it in the guest. **The lead confirmed (2026-11-25) that capturing
  the persisted bytes on the host for every trial is a hard requirement for TIF-274.** It
  uses #470's capture, taken after the agent stops. Without it, every row is `ungradable`
  and R1 cannot pass, so the failure is loud.
- **The task set is PR 2:** about 100 R1 trials across normal and fault classes, built from
  the M1 parameter generator, with fixtures and instruction text committed by hash.
- **Gate whole-document check:** TIF-270 (M2-07), before TIF-274 (§2.1).
