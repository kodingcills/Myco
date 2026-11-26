# Myco false-completion benchmark: public package (draft)

**Status: draft, docs only (Tier 0).** It holds no results. No number may appear here until
real runs exist and their ledgers are published with them (M2 plan R8).

The benchmark asks one question about a computer-use agent: **when it says "done", is the
saved document actually right?** Every trial is judged by an independent grader that reads
only the saved file's bytes, the pristine fixture and the task's intent. It never sees the
agent's claim or any gate's verdict.

| Page | For |
|---|---|
| [Task-set card](task-set-card.md) | What fc-v1 contains, how it was built, what it does and does not measure |
| [Grading protocol](grading-protocol.md) | How a trial is graded and how arm results are counted, step by step |
| [Reproduce on Linux](reproduce-linux.md) | Regrading published results, and producing your own documents with headless LibreOffice, with no VM, no account and no model |

The engineering reference behind these pages is
[`docs/benchmark/false-completion.md`](../false-completion.md). The bundle itself is
[`benchmark/false-completion/fc-v1/`](../../../benchmark/false-completion/fc-v1/), with its own
README for running a third-party arm.

## What will be published with results

When there are real runs, a release adds the following, and nothing else:
- the arm ledgers (`myco.benchmark.arm-row/1`) and grade ledgers (`myco.benchmark.grade-row/1`);
- the saved documents the grader read, named by trial;
- the check's output, recomputable from those files with the commands in
  [Reproduce on Linux](reproduce-linux.md) §1.

Traces, run directories, host paths, VM details and model output are never part of it
(`docs/benchmark/false-completion.md` §5).
