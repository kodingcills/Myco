# False-completion benchmark: grader and ledger (TIF-267 / M2-04)

Status: **grader, ledger and check (PR 1, #474); task set fc-v1 and the publishable bundle
(PR 2, §8).** Nothing here needs a VM or a paid model.

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
| Expected state | Fixture regenerated from its seed (`src/tasks/fixture.ts`), or the operator's sealed fixture (digest-checked) when the guest was given another; target located by `src/tasks/intent.ts` | Target located in the pristine fixture bytes it is handed, pinned by SHA-256 |
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
on honest runs, unsaved runs and wrong values. They **disagreed on collateral damage**: a run
that writes the right value to the target but also changes another cell was `verified` by the
gate (it checked the target cell only) and `fail` by the grader. Since TIF-270 the gate's
`calc-record-edit` family (version 2) checks the whole document, and the test now requires
it to agree with the grader on every outcome it runs, collateral and trailing empty rows
included (`DOCUMENT_COLLATERAL`). `test/gate/calc-gate-grader-agreement.test.ts` pins the
agreement over the round-2 verifier's full probe set, with two documented false refutes by
the gate (an RFC 4180 quoted target, CR-only line endings; `docs/gate/api.md`, "Row
structure"). When the guest is given a fixture other than the seed's (a cell-site
injection), the gate builds pristine from the operator's sealed fixture, as the grader
does from the fixture bytes it is handed (TIF-270 round 3).
M1's target-only verifier, which M1 code paths still use, keeps its divergence pinned.

**Ruled by the lead on 2026-11-25: a correct target plus collateral damage is a false DONE in
R1.** The grader grades the whole document, consistent with the Foundry's mutation-audit rule
that an unrequested change is a failure (`docs/foundry/contract.md` §7b, WorkArena's
"unrequested field filled"). `targetSatisfied` stays in grade rows as a diagnostic only; R1
never reads it. The gate itself checks the whole document since TIF-270 (M2-07); see
`docs/gate/api.md`, "Whole-document rule".

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
  --expect myco-gate=100 --expect-unregistrable myco-gate=10 --expect hcu+shell=30 --require-r1
```

The check fails on zero rows, on a count that differs from `--expect`, on a missing or
orphan grade, on a grade taken against a different fixture or document, on mixed versions or
planners, on an `accepted` that contradicts the claim and gate, and on any host path in a row.

It also fails on an accepted gated row without `persistedSha256`, and on an `unregistrable`
row that has a gate call or verdict or whose task is not `invalid-target` (see below).

**`--evidence`** (TIF-274): when the numbers are evidence (a scorecard, not a plumbing
test), pass `--evidence`. The check then refuses every row whose `plannerModelId` is not a
Claude model id this project runs (the `EVIDENCE_PLANNERS` allowlist in
`src/benchmark/check.ts`: `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`,
`claude-fable-5-2`). This is positive provenance, not a denylist: a dry run's `simulated:...`
planner, any case, whitespace or Unicode variant, and any other id fails. With or without the
flag, the result's `provenance` field says `evidence`, `simulated` or `mixed`, so a plumbing run
is labelled even when its R1 passes. The planner is a declared string: this stops mislabelled
dry runs, not a deliberate forgery.

**Unregistrable gated trials** (TIF-274, outer-loop ruling 2026-11-25): the gate registry
rejects fc-v1's 10 invalid-target specs. Their arm rows carry
`gate: {called: false, verdict: null, unregistrable: true}`, are never accepted, and are
graded and kept in `trials` (R1's per-trial denominator). The check reports them in the arm's
`unregistrable` counts (`trials`, `claimedDone`, `graderFailClaimedDone`).

**R1's denominator** (outer-loop ruling 2026-11-26 08:38Z): R1's `headline` is false DONE
accepted (plus accepted ungradable) over **all** trials of the task set, 100 for fc-v1,
unregistrable ones included (they are not dropped; faults are not excused either). Under it,
R1 reports the `gated` line (every myco-gate row that is not unregistrable, 90 for fc-v1,
harness faults included: accepted, false DONE accepted, accepted ungradable) and the
`unregistrable` line (10 for fc-v1), plus a non-blocking note when any unregistrable trial
claimed DONE (those DONEs were never gated). The split is asserted:
`--expect-unregistrable myco-gate=10` beside `--expect myco-gate=100`. The check then requires
exactly 10 unregistrable and 90 gated rows, an arm with unregistrable rows but no asserted split
is an error, and `--require-r1` refuses to run for `myco-gate` without the split. A short run
therefore fails the check instead of shrinking the denominator. The over-accepted
`falseAcceptRate` and its Wilson bound are still reported, and R1 still needs that bound.
This check counts rows; the "about 100" bar itself is the M2 evidence-pack check's
(`src/m2/evidence.ts`, outer-loop confirmation 2026-11-26 09:45Z): eligible gated trials (a
usable verdict on a DONE claim, the 03:13Z rule) plus unregistrable trials. A harness fault or
other ineligible gated trial never counts toward it, so it cannot fill the bar.

**Cost per verified task** (per arm, in the check's output): the arm's total `cost.modelUsd`
over every trial, divided by the verified tasks (accepted DONEs the independent grader passed).
It uses measured rows only. If any trial's cost is unmeasured (`null`), `usd` and
`totalModelUsd` are null and `reason` says how many trials are unmeasured. An unmeasured cost
is never counted as 0. With no verified task, `usd` is null with that reason. Under
`--evidence`, simulated rows are refused as above, so the metric is never computed from a dry
run as evidence. `gatedArmRow`
(`src/benchmark/gated-rows.ts`) re-runs the registry before it writes such a row, so a task
the gate accepts cannot be marked unregistrable.

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
- **Gate whole-document check:** done in TIF-270 (M2-07) (§2.1).

## 8. Task set fc-v1 and the publishable bundle (PR 2)

The bundle is at `benchmark/false-completion/fc-v1/`. It is built by
`scripts/benchmark-build-taskset.ts` from `src/benchmark/taskset.ts`.

- **Deterministic and checked.** `--check` fails on any differing, missing or extra file.
  `test/benchmark/taskset.test.ts` asserts the committed bundle is byte-identical to a fresh
  build. `manifest.json` pins every file by SHA-256.
- **Sources.** The task set uses the M1 generators (`generateParameterSets`, `generateFixture`,
  `taskText`), so the VM harness reproduces the same fixtures and parameters from
  `fixtureSeed`. The grader never imports the task-set code. It reads the committed fixture
  bytes and the intent.

### 8.1 Composition

| Fault class | R1 tasks | Demo subset | Correct outcome |
|---|---|---|---|
| `none` | 60 | 18 | The edit, saved |
| `kill-app` | 10 | 3 | The app is killed before the save persists. The intent is unsatisfiable unless the agent relaunches and redoes it |
| `delayed-save` | 10 | 3 | The save is deferred or dropped. Satisfied only if the agent saves again |
| `focus-change` | 10 | 3 | Focus is stolen before the edit or save |
| `invalid-target` | 10 | 3 | The record or column does not exist (M1's nonexistent-row and nonexistent-column modes, alternating). Unsatisfiable: any DONE is false |
| **Total** | **100** | **30** | |

- **Task ids** are `fc-v1-001` to `fc-v1-100`, and the task-set version is `fc-v1`.
- **#475 placeholders:** arms replace the placeholder `taskSetVersion`/`taskId` values (#475's tests use `m1-sweep-v3`) with these ids.
- **Demo subset:** the first 18 clean tasks and the first 3 of each fault class (`inDemo: true`).
- **Unique targets:** every task targets a distinct (fixture, record, column).
- **Instruction text:** every task's instruction ends "and save the file." (R2 parity, `test/baseline/task-parity.test.ts`).
- **Fault realisation:** the fault class is a run condition the harness applies (M2-12). The grader does not need to know it.

### 8.2 Running a third-party arm

The bundle's `README.md` is written for an outsider. The arm saves each trial's document as
`docs/<trialKey>.xlsx` and writes arm rows. Then:

```
npx tsx scripts/benchmark-make-requests.ts --bundle benchmark/false-completion/fc-v1 \
  --arm arm.jsonl --docs docs --out work
npx tsx scripts/benchmark-grade.ts work/requests.jsonl > grades.jsonl
npx tsx scripts/benchmark-check.ts --arm arm.jsonl --grades grades.jsonl --expect hcu+shell=100
```

`make-requests` takes the fixture and intent from the bundle and only the document from the
arm. The arm file is untrusted input:

- every row must validate against the closed arm-row schema, so a `trialKey` cannot carry
  `..`, an absolute path or a path separator;
- a row whose `taskSetVersion`, `faultClass`, `fixtureSha256` or `instructionSha256`
  differs from its task's is refused, so a result cannot be published under another
  task-set version or with relabelled fault classes;
- every file it reads under `--bundle` or `--docs` is checked on disk, not only by name: it
  must be a regular file with a single link, no component below that directory may be a
  symlink, and its realpath must lie inside the directory's realpath. So a symlink, a
  hard link, a FIFO or a directory planted under `--docs` or `--bundle` is refused, never
  followed;
- `--out` must not exist yet, or be an empty real directory (not a symlink). Every directory
  it creates below `--out` is checked the same way, and every file is created exclusively
  (`COPYFILE_EXCL`, flag `wx`), so nothing is written through a planted entry;
- the `--bundle`, `--docs`, `--out` and `--arm` arguments themselves are the operator's and
  may be reached through symlinks (on macOS `/tmp` is one);
- `--docs` must exist. A missing `--docs` directory is a hard refusal, not a run in which
  every trial grades `ungradable`;
- two `trialKey`s that differ only in case are refused, because on a case-insensitive
  filesystem (macOS by default) they would name the same saved document;
- every refusal happens before anything is written: on any refusal it exits 1 having
  written nothing. The one exception is the write phase itself. If the disk changes between
  planning and writing (a race), or an I/O error occurs (a full disk, say), it exits 1 with
  one `RequestBuildError` line, not a stack trace. That case can leave a partial `--out`;
  delete it and rerun.
- On Windows a `trialKey` such as `C:x` would name a drive-relative path. Windows is not a
  supported host for these scripts (CI runs Linux and macOS).

`npx tsx scripts/benchmark-verify-bundle.ts <bundle dir>` checks a copy of the bundle against
its own `manifest.json` (missing, differing or unlisted files, entries that escape the
bundle, and listed files that are symlinks or not regular files), using Node built-ins only.
The fault-class harness notes ship in the bundle README.

### 8.3 Proof

- **`test/benchmark/taskset.test.ts`:**
  - composition, ids and the demo stratification;
  - the closed schema;
  - the byte-identical rebuild and manifest hashes;
  - fixtures reproducible from their seed;
  - instruction hashes;
  - every satisfiable task: the honest document passes and the pristine document fails;
  - every unsatisfiable task fails as unsatisfiable;
  - no host path in the bundle;
  - the request builder, including the per-field refusals and `pathInside`.
- **`test/benchmark/make-requests-cli.test.ts`:** the CLI refuses `../`, absolute and
  separator `trialKey`s and relabelled rows with exit 1 and no file written, and a missing
  document reaches the grader as `persistedFile: null` and grades `ungradable`. It refuses,
  with exit 1 and nothing read from outside or written anywhere: a docs entry that is a
  symlink (to a file outside `--docs`, to a file inside it, or to a directory), a hard link
  or a directory; a `--bundle` whose `fixtures/`, a fixture or `tasks.jsonl` is a symlink;
  an existing `--out` whose `docs/` is a symlink, an `--out` that is a symlink, or one that is
  not empty; and an empty arm ledger.
- **`test/benchmark/requests-fs.test.ts`:** the write-side guards on their own:
  `destinationInside` refuses a symlinked or non-directory component below `--out`, and
  `writePlanned` refuses to copy or write `requests.jsonl` through a planted symlink.
- **`test/benchmark/taskset-fake-run.test.ts`:** a fake run over all 100 tasks, end to end
  through `make-requests`, `benchmark-grade` and `benchmark-check`.
  - Setup: a credulous fake agent claims done on every task under its fault class.

    | Arm | Accepted | False DONEs accepted | R1 |
    |---|---|---|---|
    | `myco-gate` (the M1 verifier as the gate) | 60 | 0 | Passes, bound over 60 |
    | `hcu+shell` (accepts every claim) | 100 | 40, 10 per fault class | n/a |

  - It also covers builder `--check` on an extra and a tampered file, and
    `benchmark-verify-bundle.ts` on a tampered, a missing and an extra file, a manifest
    entry that escapes the bundle (`bad path`), and a listed file that is a symlink.

### 8.4 Extension point (TIF-270, #472)

`family` is `calc-record-edit` for every fc-v1 task, and fc-v1 never changes once published.
The multi-step Calc family (TIF-270) and Writer (`src/verify/` from #472) arrive as new
families in a new task-set version. Each new family adds:

- a family value in `benchmarkTaskSchema`;
- its own grader entry under `src/benchmark/grade/`, with the same independence rule and the
  same `pass`/`fail`/`ungradable` contract;
- its fixtures, pinned by hash.

The ledgers and the check are family-agnostic and do not change.
