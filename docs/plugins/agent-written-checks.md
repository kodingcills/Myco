# Agent-written checks (M2 track C)

M2 plan §7.1, row C: "The agent writes a check for its own task. The check goes through R5's
mutation self-test before anything relies on it, and is never the grader."

Source: `src/agent-checks/`. Tests: `test/agent-checks/`. Built on track T's plugin SDK and
sandbox ([byoa.md](byoa.md), [plugin-sandbox.md](../security/plugin-sandbox.md)).

## 1. What a check is

A check is a `myco.plugin/1` oracle directory (manifest plus entry module, see
[byoa.md](byoa.md)) that an agent writes for the task it was assigned. It may claim the R5
corruption classes it catches. It must declare the format of its family's documents
(`.csv` for `calc-record-edit`).

## 2. Propose: the R5 self-test, over host-owned cases

`proposeAgentCheck(dir, { taskId, runId, family }, { intent, fileName })`:

1. binds the check to one task, one run and one supported family (today: `calc-record-edit`),
   and to the task as the check will see it on a real run: its intent
   (`{ fixtureSeed, rowKey, column, newValue }`) and the basename of its state file (`.csv`);
2. registers it through track T with **host-owned** self-test cases, built afresh for this
   proposal (`agentCheckSelfTestCases`, from `calcCasesFor` in
   `src/oracle-selftest/subjects.ts`):
   - three cases of the bound task itself: its intent and its file name, exactly as a real run
     carries them;
   - two more cases with fresh random fixture seeds, random parameter picks and random file
     names;
   - the read corruptions the host derives from every correct document (three truncations,
     three flipped bytes and a missing file per case);
   - in every case, beyond the one-error documents, 16 more drawn documents (#610 item 1):
     - a **two-error document for every pair** of the five single errors (`CALC_ERRORS` in
       `src/oracle-selftest/subjects.ts`): a wrong value at the target, the new value written
       to another cell instead (wrong target), 1 to 3 other cells changed, a row with a fresh
       key inserted, a row other than the target's deleted. That is 10 documents; the target's
       own error decides the class (`wrong-value`, else `wrong-target`, else `collateral`);
     - a document with **only an inserted row** and one with **only a deleted row**
       (`collateral`);
     - a wrong value of each **out-of-grammar shape** (`CALC_ODD_VALUES`, `wrong-value`):
       over 64 characters (65 to 200), CSV-quoted (the quoted text may hold a comma or a
       space), with a leading or trailing space, and a negative number at or below -20000.

   Every corruption is drawn afresh, per case, from host-side randomness (`node:crypto`) the
   sandboxed check cannot observe or seed: the wrong value (an edit of the new value, a number
   moved by a random amount, random digits, a random word or another cell of the sheet), the
   cell the right value is written to instead, the 1 to 3 collateral cells and their values,
   and the truncation and byte-flip offsets. Only the clean copy, the unedited sheet
   (`edit-missing`) and the missing file are the same on every draw, and a check must be
   honest on those anyway. Every corruption carries its case's intent and file name. The
   check's own `selftestCases` hook is never called, so its author cannot choose the damage it
   happens to catch.

   So a check's author, who knows the task's intent, cannot compute the self-test documents in
   advance. A check that is honest only on its seed, its file name, the bound task, the
   documents the round-2 self-test would have shown it, or the target values those held fails
   it (`test/agent-checks/predictable-selftest.test.ts`). So does a check that embeds the
   bound task's pristine fixture, counts the errors in a document, and lies on any document
   with two errors, an inserted or deleted row, or an out-of-grammar target value
   (`test/agent-checks/wide-selftest.test.ts`, `wide-values.test.ts`). What the self-test
   cannot rule out is a check that lies only on documents unlike anything it draws (§5);
3. refuses the check unless every correct document verifies and every corruption of every
   claimed class is caught. A throw or a timeout is a harness fault, never a catch.

Also refused: a check that claims no value class (`edit-missing`, `wrong-value`,
`wrong-target`, `collateral`), because a check of a task must check the edit and not only that
a file exists; a check that is also a reader; and a task whose intent names no record and
column of its fixture, or changes nothing.

| Hostile check | Refusal code |
|---|---|
| always `verified` | `AGENT_CHECK_SELFTEST_FAILED` |
| always `refuted` | `AGENT_CHECK_SELFTEST_FAILED` |
| claims a class it does not catch | `AGENT_CHECK_SELFTEST_FAILED` |
| throws on every document | `AGENT_CHECK_SELFTEST_FAILED` |
| throws or hangs instead of refuting | `AGENT_CHECK_SELFTEST_HARNESS_FAULT` |
| passes only its own easy cases | `AGENT_CHECK_SELFTEST_FAILED` |
| honest only when it recognises the self-test (seed, file name, bound task) | `AGENT_CHECK_SELFTEST_FAILED` |
| honest only on the bound task's precomputed self-test documents, or on the target values they hold | `AGENT_CHECK_SELFTEST_FAILED` |
| honest on one-error documents only: lies on two errors (wrong target plus a changed cell, plus an inserted row, or any target error plus a deleted row, or any two errors) | `AGENT_CHECK_SELFTEST_FAILED` |
| lies on a target value over 64 characters, quoted, space-edged, or at or below -20000 | `AGENT_CHECK_SELFTEST_FAILED` |
| misses a flipped byte while claiming `corrupt-byte` | `AGENT_CHECK_SELFTEST_FAILED` |
| claims only `missing-file` | `AGENT_CHECK_NO_VALUE_CLAIM` |
| also a reader | `AGENT_CHECK_NOT_ORACLE_ONLY` |
| wrong format, bad manifest, bad binding, bad task, unsupported family | `AGENT_CHECK_SELFTEST_CASES_INVALID`, `AGENT_CHECK_MANIFEST_INVALID`, `AGENT_CHECK_BINDING_INVALID`, `AGENT_CHECK_TASK_INVALID`, `AGENT_CHECK_FAMILY_UNSUPPORTED` |

## 3. Run: a labelled advisory signal

`runAgentCheck(check, binding, doc, intent)` runs an accepted check in track T's sandbox: no
network, no filesystem write, empty environment, bounded time, memory and output. It runs
only for the task and run it was proposed for, with the bound intent and a document of the bound
file name (`AGENT_CHECK_TASK_MISMATCH` otherwise; the check is handed the bound intent), only
as the object `proposeAgentCheck` issued (`AGENT_CHECK_NOT_ACCEPTED`), and only while its
files are unchanged (`PLUGIN_CHANGED`). Every failure is `uncertain` with a code only.

Its only output is a frozen `myco.agent-check-signal/1`:

```json
{ "kind": "myco.agent-check-signal/1", "advisory": true, "r1Evidence": false,
  "evidenceClass": "agent-written-advisory", "status": "verified", "code": "TARGET_OK",
  "codeSource": "check",
  "provenance": { "source": "agent-written-check", "taskId": "...", "runId": "...",
                  "family": "calc-record-edit", "check": "...", "version": "...",
                  "manifestSha256": "...", "treeSha256": "...", "selftest": { "pass": true, "...": "..." } } }
```

## 4. What a check can never do

- **Be the grader.** `src/agent-checks/` and `src/benchmark/grade/` share no code in either
  direction (`test/agent-checks/boundaries.test.ts`). A target-only check verifies a document
  with collateral damage that the gate refutes and the grader fails
  (`test/agent-checks/no-influence.test.ts`). This is why it is advisory.
- **Change a gate verdict.** `myco.gate/v1` takes `taskId`, `runId` and `claim` only. A request
  that carries the signal under any field name is rejected (`UNKNOWN_FIELD` or
  `ORACLE_INPUT_REJECTED`) and nothing is read. The signal pasted into the claim text changes
  nothing. No gate module imports `src/agent-checks/`.
- **Count as evidence.** `checkBenchmark` (always, with or without `evidence`), `checkPack`
  (every committed record: arm, grade, trial-ops, `pack.json`, attempts, anchor, superseded)
  and `checkAbPack` (every record of an A/B pack: `pack.json`, both arms' arm, grade and ops
  rows and `run-config.json`, and the Stage-0 arms) refuse any row that carries any one of the
  signal's markers (`kind`, `evidenceClass`, `provenance.source`) at any depth. The scan is in
  `src/agent-checks/label.ts`, which imports nothing. The scorecard's AB row
  (`scripts/m2-scorecard-check.py`) cites an A/B pack only if `checkAbPack` passes it (through
  `scripts/m2-evidence-check.ts`), so it refuses a pack that carries a signal
  (`test/agent-checks/ab-pack.test.ts`).

## 5. Not yet

- Families other than `calc-record-edit` (Writer, multi-step Calc) join when their host cases
  fit the sandbox budget: each self-test document is one sandboxed process.
- No agent-facing tool proposes a check yet, and nothing displays signals. Both need their own
  reviewed change, and both must keep the signal advisory.
- **A check can still lie on a document unlike anything the self-test draws.** #610 item 1
  widened the draw (§2: every pair of errors, inserted and deleted rows, four out-of-grammar
  value shapes); it narrowed the gap and did not close it. Exactly what is still never drawn:
  - three or more distinct errors in one document, or two of the same kind beyond what one
    error draws (two inserted rows, two deleted rows, a wrong target in two cells);
  - an out-of-grammar value combined with any other error, or written anywhere but the
    target (an inserted row's cells and changed cells hold in-grammar values);
  - value shapes outside the six in-grammar kinds and the four odd shapes: an empty cell,
    non-ASCII text, a formula, a value with an embedded quote or newline, a leading `+`, a
    number in scientific notation or with a thousands separator (except by chance), and a
    negative number above -20000 that is neither a shift of up to 10,000 nor a one-character
    edit of the value it replaces;
  - structural edits other than one inserted or deleted row: a changed, added or removed
    header or column, reordered rows or columns, duplicated keys, a changed key, blank lines,
    `CRLF` line endings, a byte-order mark, a missing final newline;
  - any `.xlsx` document.

  A check that answers honestly on everything the draw can produce and says `verified` to,
  say, a document with a wrong target and two inserted rows passes R5 and lies on that real
  document; `test/agent-checks/known-limit.test.ts` executes exactly that, and shows the gate
  refutes the document, the grader fails it, and `checkBenchmark`, `checkPack` and
  `checkAbPack` refuse the lying signal. Content cannot be made indistinguishable from every
  possible real document. This is why the signal is advisory and refused as evidence
  everywhere: it never changes a gate verdict, an R1 row, a scorecard cell or a grade
  (§3, §4).
- The self-test cannot be told from a real run by intent or file name, but the
  sandbox still lets a check read the clock. A check that is honest only before a date it
  chose ("time bomb") passes the self-test. The sandbox should present a fixed clock to
  checks; until then, a signal stays advisory, which is what makes this harmless.
- `calc-record-edit` self-tests use `.csv` state files only; `.xlsx` tasks (TIF-274) need the
  xlsx cases bound the same way.
- The sandbox reads the whole check directory. Whoever creates check directories must not put
  a hardlink to any other file in one.
