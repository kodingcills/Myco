# `myco verify`: re-verify a recorded run

`myco verify` re-runs the gate's own check on a recorded run's captured data and compares it
with what the run's gate logged. It is an operator CLI, never an agent tool, and it only reads.
Spec: [demo-replay-and-verify-any-agent.md](../product/demo-replay-and-verify-any-agent.md) §3
(issue #666).

```
myco verify <runId> --task <taskId> --mock-evidence <evidenceRoot>
            [--tasks <file> [--no-builtin]] [--decision-log <file>] [--json]
```

Exit codes: 0 verified, 1 refuted, 2 uncertain, 3 usage (the same as `myco-gate check`).

## What it does

1. A fresh gate, bound to the operator's `--task` and `<runId>`, reads the evidence and decides
   `{ taskId, runId }`. The request is built from the operator's flags only. The oracle, the
   registry and the decision rule are the gate's, unchanged.
2. With `--decision-log` (the audit log of the one gate bound to this run), every line is one
   of this run's calls. Calls are attributed by that binding, never by the line's
   `request.runId`. The log must pass the binding check of spec §1.2. A log shared by several
   gates, or a malformed line, makes the result `uncertain` with `VERIFY_LOG_BINDING`, and then
   no call is compared.
3. Each call is recomputed by its shape. A parse rejection is reported and never compared. A
   call naming another run is recomputed as `ASSIGNMENT_MISMATCH` against this run's
   assignment. Any other call is re-run through the same bound gate.
4. Compare, never adopt. A logged decision is compared only when it read the same bytes as the
   recompute (the same evidence refs), or read nothing (an assignment rejection). A call made
   before the agent saved, or on an older save, is reported with `loggedVerdictAgrees: null`.
   A compared disagreement makes the result `uncertain` with `VERIFY_LOG_DISAGREES`.

The output (`--json`) is a closed `myco.verify/1` object. It holds no claim, reason text,
path or evidence path. An id that carries an identity string is written as `h-<60hex>`.

## Trust

This build has the mock / development source only. Every result is `trust: "mock"` and
`simulated: true`: it is never evidence, never an R1 number and never a grader result. The
sealed-vault source (`--vault`, receipt-bound) waits for the lead's ruling on persisting the
vault key (spec §1.3). The recording source, transcripts and proof bundles are later build
PRs. Each of these flags is a usage error here (exit 3), never a silent fallback.

`myco verify` uses the gate's oracle, so it is never the independent grader. Its import graph
never reaches `src/benchmark/grade/` (tested).
