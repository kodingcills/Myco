# Cross-app workflows: the `cross-app-steps` family (capability track P, tier 2)

A multi-app task (read values from a PDF, enter them into a Calc sheet, then report them in a
Writer document) verified end to end, with a checkpoint per step decided from that step's own
persisted bytes. This page covers the task family, the checkpoint rule, the formats and their
readers, the frozen task set, how it is tested, and a proposed measurement bar for the
capability spec.

Code: `src/tasks/cross-app.ts` (task definition), `src/gate/cross-app.ts` (gate family),
`src/gate/cross-app-demo.ts` (harness, scripted agent, scenarios),
`src/linux/cross-app-actuator.ts` + `scripts/linux/writer_actuator.py` (real headless
LibreOffice), `src/benchmark/grade/cross-app.ts` + `report-text.ts` (independent grader),
`src/oracle-selftest/cross-app-subjects.ts` (R5 self-test subjects),
`src/tasks/cross-app-taskset.ts` + `benchmark/cross-app/xa-v1/` (frozen task set).

## The task

An agent gets three documents and an instruction (`crossAppInstruction`; the values are not in
it, they are in the notice):

| Step | App | What the agent does | Persisted bytes |
|---|---|---|---|
| 1 | PDF -> Calc | reads record A's value from `source.pdf` and enters it in `sheet.csv` | `step-1/sheet.csv`, `step-1/report.txt` |
| 2 | PDF -> Calc | reads record B's value from `source.pdf` and enters it in `sheet.csv` | `step-2/sheet.csv`, `step-2/report.txt` |
| 3 | Calc -> Writer | fills the report lines `<A>:` and `<B>:` in `report.txt` with the values now in the sheet | `step-3/sheet.csv`, `step-3/report.txt` |
| end | | (after the agent's last stop) | `end/sheet.csv` (the task's `stateFile`), `end/report.txt` |

The harness, not the agent, takes every snapshot: after the agent stops each step it copies
BOTH documents into the trial's evidence location (`<evidenceRoot>/<runId>/step-<k>/`), and
after the last stop again into `end/`. The agent never writes there. The source notice is a
sealed fixture: the harness places the registered bytes beside the evidence, and the gate
checks their SHA-256 against the spec on every decision (FIXTURE_MISMATCH / FIXTURE_UNREADABLE
otherwise, both `uncertain`). Nobody parses the PDF to decide.

The spec (operator-owned, `CrossAppSpec`) is general: 2-10 steps, each `calc` or `writer`
with 1-10 edits. A `writer` edit must report a value an earlier `calc` step entered (same
record, column and value), so the data flow PDF -> Calc -> Writer is part of the spec check.

## Checkpoints and the verdict (version 1)

Write `expected(k)` for the pair of documents after steps 1..k: the pristine sheet with every
calc edit of steps 1..k, and the report template with every writer field of steps 1..k
filled.

- **Step k's own check:** both snapshots of step k equal `expected(k)` under the
  **whole-document rule**, per document: every sheet cell (union of both key sets) and every
  report line. A wrong or missing edit of step k is TARGET_MISMATCH; any other difference
  (a cell or line changed, cleared or added; an earlier step's edit broken; a later step's
  edit made early) is DOCUMENT_COLLATERAL. Collateral changes are failures.
- **Checkpoint k holds** iff the own checks of steps 1..k all hold. **A later step can never
  mask an earlier failure:** a wrong step-1 snapshot refutes checkpoints 1..n whatever the
  later snapshots and the end state hold (pinned by the `masked-step-1` scenario: the agent
  fixes step 1 during step 2, the end state is correct, the trial is still refuted at step 1).
- **The last checkpoint also needs the end state** (`end/`) to equal `expected(n)`.
- **`verified` iff every checkpoint holds.** The gate computes `lastVerified` itself from the
  validated checkpoint verdicts (as for `calc-multi-step`). A refuted result carries the codes
  and reasons of the FIRST failing check (`step k (sheet.csv|report.txt): <CODE>: ...`), the
  list of steps whose own snapshot fails, and the refuted checkpoints. Reasons name cells (A1)
  and report lines (number or label), never a value.
- **Fail closed:** the gate reads every listed file before any oracle runs
  (`OracleFamily.stateFiles`); one missing is `uncertain` STATE_MISSING, one unreadable or
  symlinked `uncertain` STATE_UNREADABLE, one that does not parse `uncertain` STATE_CORRUPT.
  Only a validated oracle output with every checkpoint verified can be `verified`.

**Retries** use the existing one-retry harness unchanged (`runMultiStepTrial`,
`src/gate/multistep.ts`): on a refuted first attempt with `retryBudget: 1`, the harness
restores both guest documents to `expected(lastVerified)` (host-generated), deletes the
captures of the steps it is about to redo and the end state, and lets the agent redo steps
`lastVerified + 1 .. n`; the second gate result is the verdict. Never a third attempt.
Corrections are not supported for this family (a policy naming it is refused at start).

The agent's input to the gate is unchanged: `{ taskId, runId, claim }` over `myco.gate/v1`.
No new agent-facing input was added; the multi-file read is operator-side (registry +
reader).

## Formats and readers

| Document | Format | Gate reader | Grader reader | Hardened-parsing rules |
|---|---|---|---|---|
| sheet | CSV (Calc's own CSV filter; stored in place) | `parseDocument` (`calc-document.ts`), the strict reader the Calc families already use | `readCsvGrid` (`grade/sheet.ts`, RFC 4180) | already in use (gate stays CSV-only for Calc) |
| report | plain UTF-8 text (Writer's "Text (encoded)" filter; stored in place) | `parseReport` (`gate/cross-app.ts`), new | `readReportLines` (`grade/report-text.ts`), new and separately written | met: see below |
| notice | PDF | not parsed (digest only) | not parsed (digest only) | n/a |

The report readers are new, so both meet these rules (each pinned by tests in
`test/cross-app/family.test.ts` and `test/cross-app/grader.test.ts`):

1. strict UTF-8 (fatal decode); invalid bytes are "could not look";
2. at most one leading BOM (Writer writes one), a second one is refused;
3. no control character but TAB (NUL, ESC, DEL refused);
4. lines end in LF or CRLF; a CR that does not end a line (a CR-only file) is refused;
5. bounded: at most 10,000 lines of at most 10,000 characters, plus the gate reader's 16 MiB
   file limit;
6. no container, no XML, no entities, no decompression: nothing to inflate or recurse;
7. every refusal is a typed error that becomes `uncertain` (gate, STATE_CORRUPT) or
   `ungradable` (grader), never a verdict and never a throw out of the gate or grader.

Normalisation is limited to: dropping one leading BOM, CRLF -> LF, trailing spaces/tabs of a
line, and trailing empty lines (as trailing empty CSV rows are no content). A field line is
`<rowKey> <column>: <value>`; blanks after the colon are skipped.

Both apps were checked on LibreOffice 24.2 (headless, Python-UNO): Calc stores the CSV in
place without rewriting untouched cells (dates and currency included), and Writer stores the
report as UTF-8 with LF and a leading BOM.

## Independent grader

`gradeCrossApp` (`src/benchmark/grade/cross-app.ts`) grades the same evidence from the
committed bundle bytes: the pristine sheet and report template as handed to the guest (each
pinned by SHA-256), the notice's digest, the steps, and the column types. It locates every
target in those bytes (row by key, column by header, report field by its `<label>:` line),
so it derives the expected documents differently from the gate (which regenerates them from
the seed and spec), and it shares no code with the gate: `test/benchmark/independence.test.ts`
walks the grader's import graph (now including `cross-app.ts` and `report-text.ts`) and the
reverse direction from the gate's cross-app modules. It reports `pass` / `fail` /
`ungradable` and the first failing step; on every scenario (hermetic and real LibreOffice) it
agrees with the gate.

## R5 oracle self-test

Each step oracle runs through the R5 runner (`src/oracle-selftest/run.ts`) with seeded
corruptions of its own snapshot, every other snapshot correct, and is held to the R5 bar
(`test/cross-app/oracle-selftest.test.ts`):

| Oracle | Cases | Claimed classes | Caught |
|---|---|---|---|
| `cross-app/calc-step` (sheet snapshot of steps 1 and 2) | 6 | edit-missing, wrong-value, wrong-target, collateral, truncated, corrupt-byte, missing-file | all, each refuted at its own step's checkpoint (value classes) or `uncertain` (corrupt-byte, missing-file) |
| `cross-app/writer-step` (report snapshot of step 3) | 3 | same seven | all, same |

`partial-save` and `missing-main-part` are container classes and do not apply to CSV or plain
text; they are not claimed. `truncated` is refuted rather than `uncertain` (no integrity
marker in CSV or text, so the whole-document rule catches it), as for the Calc gate. A bite
check shows the bar fails an end-state-only oracle. These subjects are kept out of the
committed R5 report (`docs/research/experiments/r5-oracle-selftest/`) so this track stays
additive; folding them in is a follow-up.

## Frozen task set xa-v1

`benchmark/cross-app/xa-v1/`: 12 tasks (`tasks.jsonl`), each with its spec and spec digest
(the gate's `specSha256`), the instruction and its digest, the family version, the state file
and every evidence file, and three fixtures named by their SHA-256 (`fixtures/<sha>.csv`,
`.txt`, `.pdf`). `manifest.json` pins every file; pre-register the set by its digest:

```
sha256(benchmark/cross-app/xa-v1/manifest.json) = d740ed0434c664cc79fa9517562ba7c540489ffc39f7f24a58a6cc758975c79c
```

Rebuild or check: `npx tsx scripts/cross-app-taskset.ts [--check]` (deterministic; the PDF is
written by hand with no dates or ids). The set covers every typed data column (name, qty,
joined, salary).

## How it is tested ($0, no VM, no model)

- `test/cross-app/family.test.ts`: the family through the real gate: verdicts, no masking,
  end state, collateral, BOM/CRLF accepted, reasons carry no values, every fail-closed path.
- `test/cross-app/scenarios.test.ts`: every xa-v1 task x every scenario, scripted agent,
  in-process actuator, real gate, grader agreement; the retry budget; the agent's request
  shape; and one pass through the gate's MCP process with an operator tasks file.
- `test/linux/cross-app-libreoffice.test.ts`: the same scenarios against real headless Calc
  and Writer (opt-in: `MYCO_LINUX_PATH=1`; the `linux path` CI job sets
  `MYCO_LINUX_PATH_REQUIRED=1` and installs `libreoffice-writer`, so it fails rather than
  skips there). Skips cleanly without soffice, Python-UNO or Writer.
- `test/cross-app/grader.test.ts`, `oracle-selftest.test.ts`, `taskset.test.ts`.

Scenarios (`CROSS_APP_SCENARIOS`):

| Scenario | Retry budget | Expected |
|---|---|---|
| clean | 0 | verified, `lastVerified` 3 |
| wrong-value-step-1 / -2 / -3 | 0 | refuted, `lastVerified` 0 / 1 / 2, TARGET_MISMATCH, first reason names that step |
| collateral-step-2 (sheet) / collateral-step-3 (report) | 0 | refuted, `lastVerified` 1 / 2, DOCUMENT_COLLATERAL |
| masked-step-1 (step 1 wrong, fixed during step 2, end state correct) | 0 | refuted at step 1 |
| slip-step-2-then-repair | 1 | verified on the retry, restored from checkpoint 1 |
| slip-step-3-twice | 1 | refuted after two attempts, retry from checkpoint 2 |

All rows are `scripted` provenance and are never evidence.

## Measurement bar proposal (for docs/product/capability-spec.md)

Proposed for the capability spec's cross-app track, to measure what Myco adds over the
baseline arms on cross-app tasks:

- **Primary metric: graded verified rate on cross-app tasks.** Over a pre-registered task set
  (xa-v1, by manifest digest), the share of trials whose final gate verdict is `verified` AND
  whose independent grade is `pass`. Denominator: every trial started (harness faults
  re-run in place per the topped-up-run rule and counted once; uncertain counts as not
  verified).
- **Arms:** the baseline arm(s) (the agent alone, same tasks, same instruction text by
  digest, same apps and step protocol, no gate feedback, no retry) versus the Myco arm (gate
  per trial, one retry from the last verified checkpoint). Report each arm's rate with its
  denominator and a 95% interval, and the difference.
- **Bar (proposal):** the Myco arm's graded verified rate exceeds the baseline's by a margin
  pre-registered before the run, AND the false-verified rate is zero (no trial with gate
  `verified` and grader `fail` or `ungradable`). A false VERIFIED fails the bar outright.
- **Secondary:** per-step failure distribution (first refuted checkpoint per arm: where
  cross-app tasks break), repair rate (verified on the retry / refuted on the first attempt),
  and masking incidence (trials whose end state is correct but an earlier checkpoint is
  refuted: what an end-state-only check would have wrongly accepted).
- **Cost:** R7 = total estimated cost of ALL trials / verified trials; null cost is never 0;
  cost is a token-derived estimate, never billed USD.
- **Evidence rules:** only live trials with sealed captures count; scripted and mock rows
  (everything on this page) never count. The vault path needs the multi-file capture below
  before cross-app trials can be evidence.

## Limits and follow-ups

- **Vault path:** `sealedEvidenceReader` serves only a task's `stateFile`, so a cross-app task
  on the sealed vault path is `uncertain` (fail closed) until the vault captures every listed
  file. TO FILE.
- **Committed R5 report:** fold the two cross-app subjects into
  `docs/research/experiments/r5-oracle-selftest/` (changes that shared report). TO FILE.
- **xlsx / odt:** when the xlsx replacement for #503 lands, a cross-app version can use the
  native formats; this version uses CSV and plain text because the gate reads them today.
- **Windows VM path:** not exercised here (no VM in this track).
