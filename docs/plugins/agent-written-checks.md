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

`proposeAgentCheck(dir, { taskId, runId, family })`:

1. binds the check to one task, one run and one supported family (today: `calc-record-edit`);
2. registers it through track T with **host-owned** self-test cases: the R5 subjects of the
   family (`calcCases(3)` in `src/oracle-selftest/subjects.ts`), plus the read corruptions the
   host derives from every correct document. The check's own `selftestCases` hook is never
   called, so its author cannot choose the damage it happens to catch;
3. refuses the check unless every correct document verifies and every corruption of every
   claimed class is caught. A throw or a timeout is a harness fault, never a catch.

Also refused: a check that claims no value class (`edit-missing`, `wrong-value`,
`wrong-target`, `collateral`), because a check of a task must check the edit and not only that
a file exists; and a check that is also a reader.

| Hostile check | Refusal code |
|---|---|
| always `verified` | `AGENT_CHECK_SELFTEST_FAILED` |
| always `refuted` | `AGENT_CHECK_SELFTEST_FAILED` |
| claims a class it does not catch | `AGENT_CHECK_SELFTEST_FAILED` |
| throws on every document | `AGENT_CHECK_SELFTEST_FAILED` |
| throws or hangs instead of refuting | `AGENT_CHECK_SELFTEST_HARNESS_FAULT` |
| passes only its own easy cases | `AGENT_CHECK_SELFTEST_FAILED` |
| claims only `missing-file` | `AGENT_CHECK_NO_VALUE_CLAIM` |
| also a reader | `AGENT_CHECK_NOT_ORACLE_ONLY` |
| wrong format, bad manifest, bad binding, unsupported family | `AGENT_CHECK_SELFTEST_CASES_INVALID`, `AGENT_CHECK_MANIFEST_INVALID`, `AGENT_CHECK_BINDING_INVALID`, `AGENT_CHECK_FAMILY_UNSUPPORTED` |

## 3. Run: a labelled advisory signal

`runAgentCheck(check, binding, doc, intent)` runs an accepted check in track T's sandbox: no
network, no filesystem write, empty environment, bounded time, memory and output. It runs
only for the task and run it was proposed for (`AGENT_CHECK_TASK_MISMATCH` otherwise), only
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
- **Count as evidence.** `checkBenchmark` (always, with or without `evidence`) and `checkPack`
  (every committed record: arm, grade, trial-ops, `pack.json`, attempts, anchor, superseded)
  refuse any row that carries any one of the signal's markers (`kind`, `evidenceClass`,
  `provenance.source`) at any depth. The scan is in `src/agent-checks/label.ts`, which imports
  nothing.

## 5. Not yet

- Families other than `calc-record-edit` (Writer, multi-step Calc) join when their host cases
  fit the sandbox budget: each self-test document is one sandboxed process.
- No agent-facing tool proposes a check yet, and nothing displays signals. Both need their own
  reviewed change, and both must keep the signal advisory.
