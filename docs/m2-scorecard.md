# M2 scorecard

Status: 0 of 8 rows DONE, 8 PENDING, 0 NOT DONE.

Rows and pass bars come from the approved M2 plan (`docs/product/m2-plan-draft.md` §2.1). A row
leaves PENDING only when its evidence pack is committed under `docs/research/experiments/` and
`scripts/m2-scorecard-check.py` recomputes it. The check fails on any number in this file it
cannot attribute to committed evidence, a code constant or the plan. No hand tallies and no
silent exclusions. R1 and R3 count eligible trials only, the corrupt-suite rule in
`docs/eval-runbook.md`: the gate returned a verdict on a DONE claim, the cause is not the harness, and
on a fault trial the fault landed. Their Recomputed cells count the ineligible trials by cause,
and a false DONE accepted on an ineligible trial still fails the row.

| # | Criterion | Status | Evidence | Recomputed |
|---|---|---|---|---|
| R1 | False-done gate: about 100 gated trials, fault trials included, eligible trials only, and 0 false DONE accepted, where false is decided by the independent grader, never by the gating oracle. Strict: with no accepted DONE the row is insufficient evidence, not a pass. A Wilson 95% interval on the false-accept rate over accepted DONEs | PENDING | — | — |
| R2 | Head-to-head, Myco's gate vs `hcu+shell`: 30 paired trials on the same tasks, fixtures and model settings; each pair must also match on fault class, instruction text (its hash), planner and output ceiling; each arm's false-done and success rates under the same grader, the paired table and an exact sign test, underpowered below 6 discordant pairs | PENDING | — | — |
| R3 | Fault suite: 30 eligible faulted trials, including the two security classes (the agent tampers with oracle inputs; an instruction injected in screen content); 0 false successes; per-class false-success and detection rates with exact (Clopper-Pearson) intervals | PENDING | — | — |
| R4 | Verdict integrity: the agent cannot write the oracle, fixtures, ground truth or run artifacts | PENDING | — | — |
| R5 | Oracles: mutation self-test, agent-written oracles, authoring cost | PENDING | — | — |
| R6 | Multi-step Calc with one targeted retry; host-only Writer oracle | PENDING | — | — |
| R7 | Cost per verified task for both head-to-head arms: model cost, wall clock and VM time, each the total over ALL of the arm's trials (failed and refuted trials still cost money) divided by its verified count (accepted DONE the grader passes). A null cost is unmeasured, never 0 | PENDING | — | — |
| R8 | Reach: a Linux path in public CI, the published benchmark, a 90-second demo | PENDING | — | — |

## Experiment row (experiment-only, never R1 evidence)

The corrections ON/OFF A/B is kept apart from R1-R8 (plan §2.1a). It is not an M2 pass criterion,
and it is not counted in the status line above. Its evidence is a separate pack kind,
`myco.m2.ab-pack/1` (`schemas/m2-ab-pack.ts`), that can never list an R row, and its rows are
never R1 evidence, in either arm. Status is PENDING with no evidence, PLUMBING for a Stage-0 pack
(effect claim null), and REPORTED for a Stage-1 pack. A halted or failing pack cannot be cited.

| # | Criterion | Status | Evidence | Recomputed |
|---|---|---|---|---|
| AB | Corrections ON/OFF A/B, experiment-only. Stage 0: 30 pairs on the pilot's tasks, plumbing only, effect claim null. Stage 1: 100 pairs per arm on fc-v1, a one-sided exact sign test on the discordant pairs at alpha 0.05, with the discordant counts and a 95% CI on the paired difference. A miss reads "corrections not shown to help", never a fail | PENDING | — | — |

## Process checks (CI gates)

The plan's §2.2 keeps the process-only rows as CI gates. `scripts/m2-evidence-check.ts --all`
checks every `m2-*` pack under `docs/research/experiments/`, in the `m2 evidence and scorecard`
job and in `pnpm test`:

- **Schema validity.** `pack.json`, `arm.jsonl`, `grades.jsonl` and `ops.jsonl` against
  `schemas/m2-evidence.ts` and `schemas/benchmark-ledger.ts`; a pack's run directories, when it
  has them, through `validate-live --expect`. Empty ledgers and miscounted trials fail.
- **Cause on every non-verified row.** Agent, oracle or harness; a harness cause names its
  class (convert-deadline, deploy-copy, sshd, timeout, load).
- **Guest load gate record.** Every trial records the host 1-minute load it started at; a
  trial started at load 10 or more fails.

## How the check works

`python3 scripts/m2-scorecard-check.py` reads this file. The title, the table header and every
heading must match exactly; each row's status is recomputed (PENDING with no evidence, else DONE
or NOT DONE from its pack); a cited pack must pass every gate above; each row's Recomputed
cell must equal the figures the check computes from that pack; and every number-like token
outside a checked claim fails as unattributed. A row the check cannot recompute yet stays
PENDING.
