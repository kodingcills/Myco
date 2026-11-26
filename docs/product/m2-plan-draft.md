# M2 plan

> **Status: approved.** Tiffany approved this plan on 2026-11-25 at 15:02 ET with edits
> (a)–(g), and approved starting the M2 build. Her written assessment is not in this repo;
> this document applies the decisions (a)–(g) as relayed by the coordinator and adds no
> detail beyond them. Where a point is still open, §4 says so. The outer loop files the
> issues in §5 in Linear; agents do not (AGENTS.md).

First written 2026-11-25 against main `5cc8fde7` (M1 signed off) as the pre-M2 Workstream 4
draft (TIF-241). This version is updated against main `15ef2c3c`.

**Inputs.** `docs/product/vision.md`; `docs/m1-scorecard.md`; `docs/architecture/m1.md`
(ADR-0001 to ADR-0010); the TIF-105 sweep `docs/research/findings/m2-00-failure-mode-sweep.md`
and `m2-recommendation.md`; `docs/foundry/contract.md` §7a; `docs/product/mvd-preregistration.md`
(the `hcu+shell` arm); the row-8 packs under `docs/research/experiments/m1-row8-*`;
`docs/coordination/m1-state.md`; `docs/ci.md`; `docs/backlog/*.md`.

---

## 1. M2 goal

### 1.1 Goal

**Prove that Myco's state oracle can stand between a coding agent and the word "done", and
that it beats the agent checking its own work.** Claude Code calls Myco's gate over MCP. No
completion claim is accepted without a persisted-state verdict. The gate's false-done rate
is graded by independent ground truth, not by the gate itself. Head to head on the same
tasks, the gate is compared with a coding agent that checks its own work with a shell
(`hcu+shell`). The verdict holds under deliberate faults, including an agent that tampers
with the oracle's inputs and instructions injected into screen content. It extends to a
multi-step Calc family with one targeted retry and to a host-only Writer oracle. M2 ends
with a public false-completion benchmark, a Linux path an outsider can run, a 90-second
demo, and an announcement.

This follows the order the TIF-105 sweep recommends ("the outcome oracle used as a gate,
then as a retry point, then proven under faults", `m2-recommendation.md`). The head-to-head
is the question MVP Discovery left open: "a competent coding agent with HCU and shell access
can read a JSON store itself" (`docs/coordination/mvp-discovery-state.md`, item 5), which is
why `mvd-preregistration.md` calls `hcu+shell` the arm that decides the wedge.

### 1.2 What M2 adds beyond M1

| | M1 (signed off) | M2 |
|---|---|---|
| Who acts | Myco's own compiled program | **Claude Code**, calling Myco's gate over MCP |
| What the verdict does | Scores a trial after the fact | **Gates** the agent's "done" and picks the retry point |
| Who grades the verdict | The oracle, checked by a call-graph review (row 2) | **Independent ground truth** (a Foundry-style grader or a host-side recompute), never the gating oracle |
| Comparison | Screenshot agent vs Myco's program (row 7) | **Myco's gate vs `hcu+shell`** on the same tasks |
| Faults | 4 classes, ≥ 10 trials | M1's classes plus **agent tampering with oracle inputs** and **injected instructions in screen content** |
| Oracles | Hand-written, Calc only | Plus a host-only Writer oracle, **agent-written oracles** under the mutation self-test, and the **cost of writing an oracle** |
| Task shape | One cell, one save | **Multi-step Calc** with checkpoints and one retry |
| Cost | Spend only | **Cost per verified task** |
| Reach | Internal | **Linux path**, **public benchmark**, **90-second demo**, **announcement**, Apache-2.0 |

### 1.3 Decisions (from Tiffany's approval)

| Question | Decision | Source |
|---|---|---|
| Q1. Wait for MVP Discovery's A/B/C choice? | **Resolved: do not wait.** The head-to-head becomes a core M2 row | (a) |
| Q2 / O2. Which harness calls the gate? | **Resolved: Claude Code over MCP** | (e) |
| O1. Second task family | **Resolved: multi-step Calc, plus a host-only Writer oracle** | (e) |
| O3. Trial counts | **Resolved: about 100 trials for the false-done row (R1); 30 for demo rows** | (b) |
| Q3. VM time on the shared Mac | **Resolved in part: a faster VM reset comes first, as an enabling item** | (b) |
| Scope | **Resolved: cut roughly in half.** The process-only rows (old R7 evidence, R8 harness-fault accounting, R9 cold-operator reproduction) are dropped as rows and kept as CI checks (§2.2). At most about 15 issues | (d) |
| Q7. License | **Resolved: Apache-2.0.** Ships as its own separate PR; not part of this plan's issue list | Tiffany |
| Q8. Release timing | **Resolved: announce at the end of M2.** The repo is already public, so the history safety pass (§6) is still urgent | (f) |
| Q4, Q5, Q6 | **Open** (§4) | — |

---

## 2. M2 scorecard

**Rules carried over from M1.** A row is DONE only when its evidence is committed and a
script recomputes it. No hand tallies. No exclusions: a harness fault counts as
non-verified (lead ruling in `m1-row8-sweep2/README.md`). Every count states its denominator
and a Wilson 95% interval. Demo rows use 30 trials; R1 uses about 100 (decision (b)).

### 2.1 Rows

| # | Criterion | Pass bar | Evidence | How it is recomputed |
|---|---|---|---|---|
| **R1** | **False-done gate.** Claude Code may not report "done" without a `verified` verdict from the gate | About **100** gated trials, including fault trials: **0 false DONE accepted**, where "false" is decided by **independent ground truth** (a Foundry-style grader or a host-side recompute of the expected state), **never by the gating oracle**. Wilson upper bound on the false-accept rate reported | Per trial: the agent's claim, the gate call and verdict, and the independent grader's result; committed ledger | The check joins claim, gate verdict and independent grade per row and counts accepted claims the grader rejects |
| **R2** | **Head-to-head: Myco's gate vs `hcu+shell`** | Same tasks, fixtures and model settings for both arms; 30 paired trials (the demo-row count); report each arm's false-done rate and success rate under the same independent grader, the paired table and an exact sign test (called underpowered below 6 discordant pairs, `mvd-preregistration.md` §1) | Both arms' ledgers, instruction text per row (the arm-002 parity lesson), fixture hash per row, output ceiling recorded (#340) | A `row7-compare.py`-style script recomputes counts, pairs and p, and fails if the doc stops quoting them |
| **R3** | **Fault suite, including two security classes** | 30 eligible faulted trials across M1's classes plus **agent tampers with oracle inputs** and **injected instruction in screen content**. **0 false successes**; per-class detection and false-success rates with exact intervals | `ledger.jsonl`, `summary.json`, per-class table | The suite's record script rebuilds ledger and summary byte-identical; the check verifies per-class counts |
| **R4** | **Verdict integrity** | The agent cannot write the oracle, fixtures, ground truth or run artifacts. Every R3 tamper trial ends non-verified or with the tamper detected, and an isolation test proves the agent's tool surface has no path to those inputs | The isolation test's output; the R3 tamper rows | Isolation test in CI; R3's tamper rows recomputed with R3 |
| **R5** | **Oracles: self-test, agent-written oracles, authoring cost** | Every oracle (Calc, multi-step Calc, Writer) fails ≥ 1 seeded corruption per class it claims. Agent-written oracles go through the same mutation self-test, and the report says how many pass. The cost of writing an oracle is measured (time and model cost; hand-written vs agent-written) | Mutation report: oracle × corruption × verdict; authoring log | Host-side, no VM: re-run the mutation suite and diff against the committed report |
| **R6** | **Multi-step Calc with one targeted retry; host-only Writer oracle** | Multi-step Calc: 30 trials (demo row) with checkpoint oracles and one retry from the last verified checkpoint, paired against no retry; report the lift. Writer: the oracle runs host-only against generated documents and passes R5's self-test | Paired ledger with checkpoint verdicts; Writer self-test report | Paired script as for R2; Writer recomputed with R5 |
| **R7** | **Cost per verified task** | Reported for both R2 arms: model cost, wall clock and VM time, each as the total over ALL of the arm's trials (failed and refuted trials still cost) divided by the arm's `verified` count, with the denominators. A null cost is unmeasured and never counts as 0 | Per-trial cost fields in the ledgers | The check sums cost fields over all trials and divides by the verified count |
| **R8** | **Reach** | A Linux path an outsider can run without our Windows VM, exercised in public CI; the false-completion benchmark published (tasks, grader, results); a 90-second demo of: the agent says done → REFUTED → retry → VERIFIED | The CI job; the published benchmark; the demo recording and the run it shows | CI runs the Linux path; the benchmark's grader recomputes its published numbers |

### 2.2 Process checks, kept as CI gates (not rows)

Decision (d) drops the process-only rows. What they guarded stays enforced, as checks:

- **Schema validity:** every committed run has schema-valid `trace.jsonl` and `result.json`;
  `validate-live <runs> --expect N` fails on zero, incomplete or miscounted runs (TIF-223,
  TIF-226).
- **Recomputation:** an M2 scorecard check, built like `scripts/scorecard-check.py`
  (TIF-225), recomputes every number in the M2 scorecard and fails on mismatch,
  unattributed numbers or zero input.
- **Cause on every non-verified row:** agent, oracle or harness, with a harness class
  (convert deadline, deploy copy, sshd, timeout, load) and host 1-minute load per row (the
  TIF-216/219/220 lessons).

The cold single-operator reproduction (old R9) is no longer a row. The runbook still has to
let an operator run the M2 evaluation, and the Linux path in R8 is the outsider route.

### 2.3 Security gates (before the named event)

- **Guest internet allowlist, before any real data or credentials** enter a guest.
- **Public CI hygiene,** before the announcement: no `pull_request_target` with PR code, no
  self-hosted runner on Tiffany's Mac or VM, and approval required for first-time
  contributors. Today `docs/ci.md` (from #464) records that every workflow uses
  `pull_request`, never `pull_request_target` or `workflow_run`, and that only
  GitHub-hosted runners are used. First-time-contributor approval is a repository Actions
  setting: `docs/ci.md` says a first-time fork PR waits for approval "depending on the
  repository's Actions setting", so the setting itself still has to be set and recorded.

---

## 3. Failure modes M2 addresses

"Sweep" means `docs/research/findings/m2-00-failure-mode-sweep.md`. Almost every sweep rate
is single-source and was not reproduced.

| # | Failure mode | Evidence | M2 response |
|---|---|---|---|
| F1 | Silent false completion | Sweep §1a: 91–105 of 361 OSWorld-Verified tasks end in a false DONE at 100 steps | R1 |
| F2 | A gate graded by itself proves nothing | Sweep §4: checkers erred in 76 of 450 executions before calibration; generated verifiers missed a corrupted document 38 of 38 | R1's independent grader; R5 self-test |
| F3 | An agent checking its own work may be enough | `mvd-preregistration.md` (why `hcu+shell` decides the wedge) | R2 |
| F4 | The last mile on multi-step work | Sweep §1f: partial minus strict 31–37 points; a diagnosed re-run fixes 28.47% of 144 failures vs 13.89% blind | R6 |
| F5 | False success under faults is unmeasured | Sweep §6: no desktop study injects a kill, interrupted save or permission denial | R3 |
| F6 | The agent reaches the oracle's inputs | The verdict is only independent if the agent cannot write what it reads (ADR-0002, ADR-0005) | R4, R3 tamper class |
| F7 | Instructions injected into screen content | Sweep: pop-ups when injected, attack success 86% on average (§1.0). The sweep ranked prompt-injection *defence* as not worth a bet; M2 adds injection as a *fault class to measure*, not a defence track | R3 injection class |
| F8 | Oracles are expensive to write | Vision tradeoff: "verifiers need domain knowledge" (`vision.md`) | R5 authoring cost; agent-written oracles |
| L1 | Timeouts tuned on a quiet host fail under load (TIF-216, TIF-219, G23) | `m1-scorecard.md` rows 3 and 8 | CI cause field and load per row; faster reset first |
| L2 | The guest is flaky right after a cold reset (TIF-220) | `m1-row8-sweep2/README.md` | Verified deploy copy kept; harness cause recorded |
| L3 | Validators pass on empty input (TIF-223) | `m1-row8-corrupt/README.md` | Every check takes an expected count |
| L4 | The secret guard and the runbook disagree (H5/TIF-228, J4/TIF-232) | `m1-row8-step1/` | Credential steps use secrets-file paths at the point of use |
| L5 | Baseline parity breaks quietly (arm-002 instruction text, #340 truncation, step-budget asymmetry) | `m1-scorecard.md` row 7 | R2 records instruction, fixture hash and output ceiling per row |

---

## 4. Risks and open questions

**Still open**

- **Q4. Spend.** R1, R2 and the demo call a paid model (Claude Code, and the `hcu+shell`
  arm's planner, `claude-sonnet-5-5` in `mvd-preregistration.md`). M2 needs its own cap and
  approval. Model policy stays Claude only.
- **Q5. Close the "given the VM bundle" limit** (`build-all.sh` has never run end to end)?
  Less pressing now that R8's Linux path is the outsider route, but undecided.
- **Q6. Who signs M2 off.**

**Risks**

- **VM time.** R1's ~100 trials, R2's paired arms, R3 and R6 all share one Mac and one VM
  (`m1-state.md` logs 41–45). The faster reset is first for this reason (`foundry/contract.md`
  §7a: ~35 min of reset per 100 trials at 21 s warm).
- **The independent grader is new.** R1 depends on it; if it shares code or inputs with the
  gating oracle, R1 grades itself. Keep it separate by construction and review it as Tier 2.
- **`hcu+shell` is not built for this.** `docs/foundry/baseline-status.md` records it as
  not-run, needing VM time, trusted live evidence ingestion, complete tool-call audits and
  independently observed save snapshots.
- **A detector is not a repair.** Detection alone moved success about 3 points (sweep §4);
  R6 is the only row that measures repair.
- **The evidence base is thin.** Almost every sweep rate is single-source.

---

## 5. Linear M2 milestone (for the outer loop to file)

At most about 15 issues, per decision (d). `M2-nn` labels are placeholders for TIF ids.
Tiers follow `docs/coordination/CONTRIBUTING-agents.md` §A. **VM** means single owner,
under the lock; **non-VM** means host or CI only. **Start now** marks issues with no
unmet dependency that can run in parallel from day one.

**Milestone: M2: the oracle as a gate**

| Label | Title | One-line scope | Depends on | Tier | VM? | Start now |
|---|---|---|---|---|---|---|
| M2-01 | Faster VM reset (existing TIF-98) | Enabling item: cut reset cost before the ~100-trial and paired runs | none | 2 | VM | **yes** (VM owner) |
| M2-02 | Gate API and MCP server for Claude Code | Expose the three-valued verdict as a tool separate from the actuator; Claude Code's "done" is accepted only on `verified` | none | 2 | non-VM | **yes** |
| M2-03 | Verdict-integrity isolation (R4) | The agent's tool surface has no path to the oracle, fixtures, ground truth or artifacts; isolation test in CI | none | 2 | non-VM | **yes** |
| M2-04 | False-completion benchmark harness with independent grader | Task set, Foundry-style grader or host-side recompute independent of the gate, ledger format; the base for R1 and the public benchmark | none | 2 | non-VM | **yes** |
| M2-05 | Head-to-head `hcu+shell` arm (R2) | Build the arm under the same tasks and grader, closing the gaps `baseline-status.md` lists; runs happen in M2-12 | M2-04 for grading | 2 | non-VM build | **yes** |
| M2-06 | Linux path an outsider can run (R8) | A route that runs without our Windows VM, exercised in public CI | none | 1 | non-VM | **yes** |
| M2-07 | Multi-step Calc family with checkpoint oracles and one retry (R6) | Family, per-checkpoint postconditions, one retry from the last verified checkpoint | M2-02 | 2 | non-VM build; runs in M2-12 | no |
| M2-08 | Host-only Writer oracle (existing TIF-99, scoped host-only) | Writer read path for the oracle, run against generated documents on the host | none | 2 | non-VM | yes |
| M2-09 | Mutation self-test, agent-written oracles, authoring cost (R5) | Seeded corruptions per oracle; agent-written oracles under the same test; measured authoring cost | M2-07, M2-08 | 2 | non-VM | no |
| M2-10 | Fault classes: tamper with oracle inputs, injected screen instruction (R3) | Add both classes beside M1's; per-class rates | M2-03 | 2 | non-VM build; runs in M2-12 | no |
| M2-11 | M2 scorecard check, CI process gates, cost per verified task (R7) | Recompute every M2 number; schema, cause and load checks; cost fields per trial | M2-04 | 2 | non-VM | no |
| M2-12 | M2 evaluation runs (R1 ~100, R2, R3, R6) | The VM runs, under the guest load gate, packs committed as each lands | M2-01, M2-02, M2-04, M2-05, M2-07, M2-10, M2-11, M2-13 | 2 | VM | no |
| M2-13 | Guest internet allowlist | Restrict guest egress to an allowlist before any real data or credentials enter a guest | none | 2 | VM | yes (VM owner, after M2-01) |
| M2-14 | Public-release safety pass and CI hygiene | Whole-history gitleaks over every ref and a host-path history scan (report by count and location; any rewrite only on Tiffany's OK); set and record first-time-contributor approval; confirm no `pull_request_target` or self-hosted runner | none | 2 | non-VM | yes |
| M2-15 | Public benchmark, 90-second demo, announcement | Publish the benchmark; record the done → REFUTED → retry → VERIFIED demo; newcomer quickstart; announce | M2-12, M2-14, the Apache-2.0 PR | 1 | non-VM | no |

**Outside the list:** the Apache-2.0 `LICENSE` ships as its own PR (decision on Q7).
Deferred, not M2 issues: the pre-action guard (sweep P-4) and oracle-validated procedure
replay (sweep P-5, under TIF-100 and TIF-101).

**Parallel start.** The five named candidates start now: M2-02 (gate API and MCP server),
M2-06 (Linux path), M2-03 (verdict-integrity isolation), M2-04 (benchmark harness) and
M2-05 (head-to-head arm, building against M2-04's grader as it lands). M2-01 starts now
too, as the VM owner's first item. M2-08 and M2-14 have no dependencies and can also start.

---

## 6. Open-source readiness (folded into M2)

The repo `kodingcills/Myco` is already public, with no license. Since the draft, main has
landed: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, issue and PR
templates (TIF-258, #466); least-privilege, fork-safe CI with pinned actions and
`docs/ci.md` (#464); and removal of absolute home paths from the current tree (#465, with
`test/no-home-paths.test.ts`). Still missing: `LICENSE` (Apache-2.0, its own PR) and a
whole-history scan. The CI secret scan covers only each PR's new commits, so commits from
before the scanner, other pushed branches and the 28 `archive/*` and review tags remain
unscanned (M2-14).

What stays from the draft's workstream, under the ~15-issue cap:

| Item | Shapes or trails | Reason | Where it lives |
|---|---|---|---|
| Agent-facing API | **Shapes** | The gate is the public contract | M2-02 |
| Task-family extension point | **Shapes** | Multi-step Calc and Writer are its first real tests | M2-07, M2-08 |
| Linux path / easy start | **Shapes** | It is how outsiders run Myco | M2-06, M2-15 |
| History safety pass | **Hard gate**, urgent | Blocks the announcement; the history is already public | M2-14 |
| Public CI hygiene | Trails, gate before announcement | Mostly done in #464; the approval setting remains | M2-14 |
| Repo layout, prebuilt releases, versioned install, architecture docs | Trail | Not in decisions (a)–(g); revisit after M2 or within M2-15 if time allows | — |
