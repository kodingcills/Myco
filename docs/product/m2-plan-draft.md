# M2 plan (DRAFT for Tiffany's review)

> **Status: DRAFT for Tiffany's review. Not approved.** Nothing in this document starts
> work. No M2 code, experiment, VM run or paid run has been made for it, and none may start
> until Tiffany (or the lead on her delegation) approves a version of this plan and the outer
> loop creates the issues in §5. Where the repo leaves a choice open, this draft lists the
> options and does not pick one silently.

Written 2026-11-25 against main `5cc8fde7` (M1 signed off). Workstream 4 of pre-M2.
Updated the same day against main `bb0209e0`: §6 adds the "Open-source ready" workstream
Tiffany approved for the draft at 9:26 AM ET, with its issues in §5 and its questions (Q7, Q8)
in §4. That workstream, like the rest of this plan, is held until Tiffany reviews the draft.

**Inputs read.** `docs/product/vision.md`; `docs/m1-scorecard.md`; `docs/architecture/m1.md`
(ADR-0001 to ADR-0010 live there; there is no `docs/adr/` directory and no `GLOSSARY.md` on
main); the TIF-105 sweep, `docs/research/findings/m2-00-failure-mode-sweep.md`, and its
summary `docs/research/findings/m2-recommendation.md`; `docs/foundry/contract.md` §7a; the
row-8 packs `docs/research/experiments/m1-row8-step1/`, `m1-row8-sweep2/` and
`m1-row8-corrupt/`; `docs/coordination/m1-state.md`; `docs/backlog/*.md`;
`docs/product/wedge-recommendation.md`, `mvd-preregistration.md` and
`dev-surface-decision.md`.

---

## 1. M2 goal

### 1.1 Proposed goal (one paragraph)

**Prove that Myco's state oracle can stand between any agent and the word "done": no
agent's completion claim is accepted without a persisted-state verdict, the verdict holds
up under deliberate faults, and the same verdict extends to a second task family and to a
multi-step task where it buys one targeted retry.** M1 proved that Myco can execute and
verify one operation in one Windows app with its own compiled program. M2 turns that
verifier into a gate that *other* agents call, measures how often it stops a false
completion, and tests it beyond the single-cell Calc edit. This is the order the TIF-105
sweep recommends (`m2-recommendation.md`: "the outcome oracle used as a gate, then as a
retry point, then proven under faults"). It also follows the vision's mission line, "verify
every step against real app state, and retry from a known-good point", and its
"transactional actions" step on the solution path (`vision.md`, Approach and Winning).

### 1.2 What M2 adds beyond M1

| | M1 (signed off) | M2 (proposed) |
|---|---|---|
| Who acts | Myco's own compiled program | **Any agent harness**; Myco gives the verdict |
| What the verdict does | Scores a trial after the fact | **Gates** the agent's "done", and later picks the retry point |
| Faults | 4 classes (kill, invalid target, dropped save, focus change), ≥ 10 trials | M1's 4 plus the sweep's literature-backed classes, **≥ 30 trials**, rates per class with intervals |
| Oracle trust | Call-graph review of independence (row 2) | Plus **mutation self-test**: every oracle must fail at least one seeded corruption |
| Task shape | One cell, one save | One more task family (second app or multi-step), plus a checkpointed multi-step task |
| Baseline | Screenshot agent vs Myco's program (row 7) | The **same** agent with and without the gate, so the comparison isolates the gate |
| Reproducibility | Segmented cold operators, "given the VM bundle" | **One** cold operator end to end, with the scorecard check as the gate |

### 1.3 What the docs leave open (options, not picks)

The repo has not chosen a product direction, and this plan must not pre-empt that.
MVP Discovery owns the A/B/C choice; `wedge-recommendation.md` is a *provisional*
recommendation for A (narrowed to "verified GUI tests for coding agents"), and its own text
says the pre-registered rule "has not fired: no paired trials exist yet". The TIF-105 sweep
says bets 1, 2, 3 and 5 are needed under both A and B (`m2-00` Decision, "How the bets sit
against A/B/C"), which is why the goal above is written to hold under either.

Three choices remain open for Tiffany:

| Choice | Option | For | Against |
|---|---|---|---|
| **O1. Second task family** | (a) Writer, via TIF-99 (`m2-03` chose Writer) | Same ARM64 install; a documented object model and converter; tests that the oracle generalises across apps | Writer AutoCorrect rewrites typed text at save, a new failure class to handle (`m2-03` §2.1) |
| | (b) A multi-step Calc family (several records, several sheets) | No new adapter; feeds the checkpoint row (R5) directly | Says nothing about a second app |
| | (c) Both | Covers both claims | Roughly doubles fixture, oracle and VM work |
| **O2. Which harness calls the gate** | (a) The C1 screenshot agent (`src/baseline/`) | Already instrumented; row 7's agent; the cleanest gated-vs-ungated pair | Paid model calls; Cua stack |
| | (b) An ordinary coding agent over MCP/stdio (`dev-surface-decision.md`) | The "callable from any harness" claim; direction A's own acceptance 4 (`wedge-recommendation.md`) | Not yet run inside any agent environment (`wedge-recommendation.md`, "What is not measured") |
| | (c) Both | Proves harness independence | More spend and more VM time |
| **O3. Trial counts** | (a) Keep M1's 30 normal / ≥ 10 faulted per row | Fits one Mac and one VM | Foundry §7a: a 30-trial count is a demonstration, not a reportable rate; 0/10 bounds false success only below about 26–28% |
| | (b) Foundry §7a counts: ~100 normal over 3 seeds, ~30 faulted | The counts a "rate" claim needs | ~35 min of reset time per 100 trials at 21 s warm, far more cold (`foundry/contract.md` §7a); depends on TIF-98 |

---

## 2. Proposed M2 scorecard

**Rules carried over from M1.** A row says DONE only when its evidence exists in the repo
and a script recomputes it. No hand tallies. No exclusions: a harness fault counts as
non-verified (lead ruling on `m1-row8-sweep2`; row 7 keeps Myco's index 3 in for the same reason).
Every count states its denominator and a Wilson 95% interval. The pass bars below assume
option O3(a). Under O3(b), replace 30 with 100 normal trials over 3 seeds wherever the row
claims a rate.

**One recomputation gate for the whole table.** `scripts/m2-scorecard-check.py` (proposed,
§5 issue M2-06), built the way `scripts/scorecard-check.py` was for M1 (TIF-225, #434):
it recomputes every number in `docs/m2-scorecard.md` from committed artifacts, fails on any
mismatch or unattributed number, and **fails on zero input** (the TIF-223 lesson: a
validator that prints `ALL OK` on 0 files proves nothing).

| # | Criterion | Pass bar | Evidence that proves it | How it is recomputed |
|---|---|---|---|---|
| **R1** | **Completion gate.** An external agent may not report "done" without a `verified` verdict from the oracle; the verdict sits behind a separate tool from the actuator (`m2-02` design) | Across ≥ 30 gated trials, including fault trials: **0 false DONE accepted**. Every accepted "done" carries a `verified` verdict whose evidence was read from persisted state | Per-trial `result.json` with the agent's claim, the gate call, the verdict and the persisted read; a committed ledger | `m2-scorecard-check.py` joins claim, gate call and verdict per row; counts accepted-but-not-verified; reports Wilson upper bound on the false-accept rate |
| **R2** | **Oracle self-test.** Every oracle used in M2 catches a named corruption | Each oracle (Calc, and the second family's) **fails ≥ 1 seeded corruption per class it claims**; 0 mutants survive among the classes it claims | Mutation-test report: oracle × seeded corruption × verdict (Foundry §7b verifier self-test) | Script re-runs the host-side mutation suite (no VM) and diffs against the committed report |
| **R3** | **Second task family** (O1) runs and verifies | ≥ 27 of 30 varied normal trials `verified`, Wilson interval reported (or ~100 over 3 seeds under O3(b)) | `trials.jsonl`, `params.json`, fixture fingerprints, as in `m1-013-sweep-v3/` | `scripts/m1-scorecard.py` generalised to a family argument; byte-identical to the committed scorecard |
| **R4** | **Fault-injected false-success suite** | ≥ 30 eligible faulted trials across M1's four classes plus the sweep's classes that apply to a local app (pop-up or overlay, non-default starting state, missing object or infeasible request; login wall only if the family has one). **0 false successes**, detection rate and false-success rate **per class** with exact intervals; at least some faulted claims are `verified` after recovery, so the zero is evidenced (the m1-014 audit rule) | `ledger.jsonl`, `summary.json`, `schema-validation.log`, per-class table | `m1-corrupt-suite-record.py --final` (or its M2 successor) rebuilds ledger and summary byte-identical; script checks per-class counts and intervals |
| **R5** | **Checkpoint oracles with one targeted retry** on a multi-step task | Paired against the same arm without retry: lift **≥ 2 points**, the sweep's reject line (`m2-00` P-2); exact sign test on discordant pairs reported, and called underpowered if fewer than 6 discordant pairs (`mvd-preregistration.md` §1) | Paired ledger: per-trial checkpoint verdicts, the retry point, the final verdict, both arms | Script recomputes the paired table, the lift and p, as `scripts/row7-compare.py compare --check` does for M1 row 7 |
| **R6** | **Gated vs ungated baseline.** The same agent, same tasks, same model settings, with and without R1's gate | Report the false-DONE matrix for the ungated arm (P-8) and the gate's effect on accepted false DONE; **no bar on the agent's success rate** (the gate is a detector, not a repair: `m2-00` §4) | Both arms' ledgers, instruction text recorded per row (the arm-002 parity lesson), per-row fixture hash (row 7 limit 2), output ceiling recorded (#340) | Extended `row7-compare.py` on the committed graded-field extracts; fails if the doc stops quoting its figures |
| **R7** | **Evidence** | Every M2 run emits schema-valid `trace.jsonl` + `result.json` + verdict; ledgers have 0 unaccounted entries | Committed packs with `schema-validation.log` | `validate-live <runs> --expect N` per pack (fails on zero, incomplete or miscounted runs since TIF-223) |
| **R8** | **Harness-fault accounting** | Every non-verified row carries a machine-readable cause: agent, oracle, or harness (with a harness class such as convert deadline, deploy copy, sshd, timeout, load). Harness faults ≤ 1 per 30 trials per pack, each with a filed issue | `status` and cause fields in `trials.jsonl`; host 1-minute load recorded per row | Script tallies causes and load per pack; fails if any non-verified row has no cause |
| **R9** | **Reproducibility: one cold operator, end to end** | A single Claude operator with a cold context, on a fresh clone of main, using only the repo and the VM bundle, runs every M2 runbook step in **one session** (not segmented), asks **no question the repo could have answered**, and ends with `scripts/m2-scorecard-check.py` exit 0. Every finding is logged and fixed in a runbook PR before sign-off; a step that "worked once someone ruled" fails the row (M1 test-plan rule) | Operator report committed under `docs/research/experiments/m2-repro/`, with wall clock per step and every divergence; the check's output | The check itself is the gate. Its output and exit code are committed beside the report |

**Stated limits, carried forward rather than hidden.** Unless Tiffany chooses otherwise
(§4, Q5), R9 still passes only "given the VM bundle": `build-all.sh` has never run end to
end, and the ISO, payloads and `clean-base` snapshots live outside the repo (M1 row 8
limits; `docs/eval-runbook.md` §10).

**Not on the scorecard, on purpose.** Verified procedures (`m2-00` bet 4) and guarded steps
(bet 6) are not M2 rows. The sweep ranks procedures as an experiment (single-run success
flat, −5.6 strict and −18.5 partial on long workflows, drift unmeasured) and guarded steps
last (read-back ablation −0.6 [−7.2, +6.7]) (`m2-00` Decision). They appear in §5 as
experiments or deferred work.

---

## 3. Failure modes M2 must address

Each row cites the TIF-105 finding or the M1 lesson behind it. "Sweep" means
`docs/research/findings/m2-00-failure-mode-sweep.md`. Almost every sweep rate is
single-source (tagged `1src` in that doc); none was reproduced.

### 3.1 From the TIF-105 sweep

| # | Failure mode | Evidence | M2 response |
|---|---|---|---|
| F1 | **Silent false completion.** The agent says done; persisted state says no | Sweep §1a: 91–105 of 361 OSWorld-Verified tasks end in a false DONE at 100 steps (86–96% of failed tasks); 5 of 9 DONE claims failed a state check (KiCad) | R1 gate; R6 measures it on Myco's own baseline |
| F2 | **The unmet last mile on long or multi-app work** | Sweep §1.0 and §1f: partial minus strict 31–37 points on OSWorld 2.0; a diagnosed re-run fixes 28.47% of 144 failures against 13.89% blind | R5 checkpoints and one targeted retry |
| F3 | **False success under faults is unmeasured anywhere** | Sweep §4 (fault injection) and §6 "Other gaps": no desktop study injects a killed app, interrupted save or permission denial and measures the agent's report | R4 suite, with per-class rates |
| F4 | **The verifier is itself wrong** | Sweep §4 (state oracle, "Would not fix: its own errors"): 76 of 450 checker-side errors before calibration; 10 of 57 OSWorld FAIL verdicts wrong; generated verifiers missed a corrupted document 38 of 38 | R2 mutation self-test; keep the three-valued `uncertain` verdict (ADR-0002) |
| F5 | **Harness and tool defects hide failures** | Sweep §1.0 "Tool-design limits" and §2: one harness defect hid 22–28% of a lab's reported failures, another 26% | R8 cause accounting; R4 doubles as a harness conformance suite (sweep §4, "Its second use") |
| F6 | **Structural reads are blind in places** | Sweep §1.0 and Decision bet 5: UIA-only observation caused 62.8% of failures on Windows Agent Arena (n not published) | Build the second app's read path for the oracle, not as agent observation (TIF-99; R3) |
| F7 | **Stale UI and focus theft** | Sweep §1.0: an adversarial focus change redirected 45 of 45 actions; stale-category tool errors 88 of 10,783 calls | Already an M1 fault class; kept in R4. The pre-action guard stays low priority (sweep P-4) |
| F8 | **Procedure drift under app updates** | Sweep §6 gap 4: no published breakage rate; none estimated | Out of the M2 scorecard; TIF-100 owns the measurement |

### 3.2 From M1

| # | Lesson | Where it is recorded | M2 response |
|---|---|---|---|
| L1 | **Timeouts tuned on a quiet host fail under load.** The tunnel call timed out at 15 s, not 60 s (TIF-216); a fixture convert missed its 240 s deadline at host load 12–15 (TIF-219, now 360 s and tagged as a harness fault); `pnpm test` failed 43 of 1,080 on 5 s timeouts at load 13–15 (G23) | `m1-scorecard.md` rows 3 and 8; `m1-row8-sweep2/README.md`; `m1-013-convert-timeout.md` | Data-derived deadlines; host load recorded per row and kept in the guest load gate (`PAUSED_LOAD`, `scripts/m1-sweep.sh`); R8 |
| L2 | **The guest is flaky right after a cold reset.** sshd dropped the agent copy (TIF-220, about 1 in 28 cycles) | `m1-row8-sweep2/README.md` trial 14; `docs/eval-runbook.md` §4 failure table | Keep the verified, bounded deploy copy; count any residue under R8 |
| L3 | **Validators that pass on empty input.** `validate-live` printed `ALL OK` on 0 files (TIF-223) | `m1-row8-corrupt/README.md` | Every M2 check takes an expected count and fails on zero (R7, M2-06) |
| L4 | **The secret guard and the runbook disagree.** The guest token fetch was refused and blocked §5 and §6 (H5, fixed by TIF-228); the guard blocks commands that name the token-file path variable (J4, TIF-232); §5 needed the TIF-209 `session_info` CLI | `m1-row8-step1/README.md`, `operator-report-3.md`, `operator-report-4.md` | Design every M2 credential step for the guard from the start: a secrets file path at the point of use, never a value (AGENTS.md, TIF-206) |
| L5 | **Runbooks drift from the code.** H1–H13 and J1–J11 were contradictions or gaps; the runbook never named the scorecard check (J8); an agent's tool calls do not share one shell (J9) | `operator-report-3.md`, `operator-report-4.md` | R9 makes a cold operator the test; the runbook names the M2 check and its pass line; no "same shell" assumptions |
| L6 | **Reproduction was segmented, and only "given the VM bundle".** Several operators ran steps in segments; `build-all.sh` has never run end to end | `m1-scorecard.md` row 8 | R9 asks for one operator, one session. Closing the VM-bundle limit is an open question (§4, Q5) |
| L7 | **Baseline parity breaks in quiet ways.** Instruction text differed (arm-002); a 256-token cap turned truncation into agent failures (#340); the step budget is asymmetric; no per-row fixture hash; no frames in transcripts; `falseSuccess` 0/30 by construction bounds nothing | `m1-scorecard.md` row 7 and its two arm-002 sections | R6 records instruction text, fixture hash and output ceiling per row, and measures false DONE on claims, not on non-verified rows |
| L8 | **C1's per-action `verified:false` carries no information, and its audit never runs on refuted rows** | `docs/backlog/tif-c1-verified-audit.md` | Resolve before R6 reuses the C1 harness (§5, M2-14) |
| L9 | **Evidence in `/tmp` is one reboot from gone** | `m1-scorecard.md`, "Evidence durability (M1-016)" | Commit trimmed packs as each row lands |
| L10 | **The host is shared and fragile**: sleep, Spotlight and swap exhaustion each blocked a sweep | `m1-state.md` logs 41, 43, 44, 45 | Plan VM time against R3–R6's trial multiplication; see Q3 |
| L11 | **Small counts claim less than they look.** 0 of 10 false successes cannot rule out a 27.8% rate | `mvd-preregistration.md` §1; `foundry/contract.md` §7a | O3 and the ≥ 30 faulted trials in R4 |

---

## 4. Risks and open questions for Tiffany

**Questions only Tiffany can settle**

- **Q1. Does M2 wait for MVP Discovery's A/B/C decision?** The goal in §1.1 is written to
  hold under A and B. If Discovery picks C (branchable desktops), R5's retry point would
  likely become a fork, and the plan needs rework.
- **Q2. O1, O2, O3** (§1.3): the second task family, which harness calls the gate, and the
  trial counts.
- **Q3. VM time and the shared Mac.** R3, R4, R5 and R6 multiply trials (retries,
  fault matrix, paired arms) on one Mac and one VM that M1 found fragile (L10). TIF-98
  (faster reset) becomes a dependency, not a nicety (`m2-recommendation.md`, m2-05).
- **Q4. Spend.** R6 under O2(a), and any gate demonstration with a model in the loop, needs
  paid model calls. M1's row 7 ran under a $9.00 cap ($7.8521 used). M2 needs its own cap
  and approval; model policy stays Claude only.
- **Q5. Close the "given the VM bundle" limit in M2, or carry it again?** Running
  `build-all.sh` end to end would make R9 a from-scratch reproduction, at the cost of VM
  time and the external ISO and payloads.
- **Q6. Who signs M2 off,** and against which version of this plan (M1: the lead on
  Tiffany's delegation of 2026-11-23).
- **Q7. Which license?** The repo has no `LICENSE` file, GitHub reports no license, and
  `package.json` and `viewer/package.json` say `"private": true` (§6.3). Until a license is
  added, the default is all rights reserved: people can read the code but have no grant to
  use, change or redistribute it. The options:

  | Option | For | Against |
  |---|---|---|
  | Apache-2.0 | Permissive, with an explicit patent grant; common for infrastructure that companies embed. Fits the vision's "open interface spec … with Myco as the reference implementation" (`vision.md`, paradigm bet 2) | Anyone, including a hosted competitor, can ship it closed |
  | MIT | Simplest permissive license; least friction for adoption | No patent grant; same closed-fork exposure |
  | AGPL-3.0 (or another copyleft) | A hosted service built on Myco must publish its changes | Many companies forbid AGPL dependencies, which cuts against "the default runtime" (`vision.md`, Winning) |
  | Source-available (for example BSL) | Keeps commercial control | Not open source by the OSI definition; contributors and agent ecosystems treat it differently |

  The repo has three languages (TypeScript, Python `agent/`, Rust `runtime/`) and copies
  primitives from Vercel Labs agent-desktop (ADR-0003, "steal agent-desktop's primitives").
  Whatever license is picked has to be compatible with the licenses of those copied sources
  and of the dependencies, which this draft has not checked.
- **Q8. When does Myco "go public"?** The GitHub repo **is already public** (`gh repo view`
  reports `PUBLIC`), so the code, the 656 commits on main, the other pushed branches and the
  28 `archive/*` and review tags can already be read and cloned. "Public release" in this plan therefore means
  the point at which Myco is announced and outside contributors are invited, not the
  visibility switch. The options:

  | Timing | For | Against |
  |---|---|---|
  | Before M2 | Outside users shape the agent-facing API and the task-family extension point while they are still cheap to change | Engineering time goes to packaging while the gate (R1) does not exist yet; the release would show M1 only |
  | At M2's end | The release can show the gate, faults and a second task family, the M2 claim; §6 items that shape design are done anyway | Layout and API decisions are made without outside input; a moved tree breaks fewer users, but contributors arrive late |
  | After M2 | No distraction from the scorecard | The longest time with an already-public repo that has no license, no security policy and an unscanned history (§6.5) |

  Whatever the timing, the §6.5 safety pass is urgent rather than gated on a release date,
  because the history is already exposed. Tiffany may also want to decide whether the repo
  should stay public until that pass is done.

**Risks**

- **The evidence base is thin.** Almost every sweep rate is single-source and unreproduced
  (`m2-00` limits). The cheapest falsifier, P-7, could shrink bet 1 before any build: if
  frontier false DONE is under 10% of runs, the ranking changes (`m2-recommendation.md`).
  Recommend running P-7 and P-8 (host only, no spend) before committing build effort.
- **A detector is not a repair.** Detection alone moved success about 3 points (sweep §4).
  R1 and R6 deliberately set no success bar; if Tiffany wants M2 to show agents *finishing*
  more work, R5 is the only row that measures it, and its 4–8 point payoff is an estimate
  from two single-source inputs.
- **Two stacks.** M1 ran on the TypeScript host and Python guest agent (ADR-0001); the
  developer surface decision fronts the Rust runtime over MCP/stdio
  (`dev-surface-decision.md`, `myco-rt-mcp`). Which one hosts the gate tool is unsettled.
- **Windows coverage.** Everything ran on Windows 11 ARM64 under UTM with LibreOffice. The
  vision places most value in Office, line-of-business apps, Java and Citrix (`vision.md`,
  Platforms); M2 as drafted does not reach them.
- **Login-wall faults** (one of the sweep's four added classes) have no natural analogue in
  a local office app; R4 includes them only if the chosen family has one.
- **Baseline step budget.** Row 7's baseline had 30 planner steps, and 29 of its 30
  failures were budget exhaustion; whether a larger budget changes any row is not measured
  (row 7 limit 1). R6 inherits that question unless Tiffany sets a budget rule.

---

## 5. Proposed Linear M2 milestone (for the outer loop to paste)

Agents may not create Linear issues (AGENTS.md), so this is a list only. `M2-nn` labels are
placeholders for TIF ids. Tiers follow `docs/coordination/CONTRIBUTING-agents.md` §A
(0: docs only; 1: small low-risk code; 2: scoring, verdicts, recovery, VM, locks, spend,
secrets, schemas, evidence numbers). "Existing" means the id already exists; do not
duplicate it.

**Milestone: M2: the oracle as a gate (DRAFT, pending Tiffany's approval of
`docs/product/m2-plan-draft.md`)**

| Label | Title | One-line scope | Depends on | Tier |
|---|---|---|---|---|
| M2-01 | Ratify the M2 goal and scorecard | Tiffany answers Q1–Q6 and O1–O3; the plan becomes `docs/m2-scorecard.md` with empty rows | none | 0 |
| M2-02 | Claim-versus-state audit on public trajectories (sweep P-7) | Host only, no spend: final claim vs evaluator score on public OSWorld runs; falsifier: frontier false DONE < 10% | none | 1 |
| M2-03 | False-DONE matrix for the C1 baseline (sweep P-8) | From committed r6 rows, the share of the baseline's completion claims the M1 oracle refutes; relates to TIF-75 | none | 1 |
| M2-04 | Completion gate tool (sweep P-1) | Expose the three-valued verdict as a tool separate from the actuator; an agent's "done" is accepted only on `verified` | M2-01 | 2 |
| M2-05 | Oracle mutation self-test (R2) | Seeded corruptions per oracle class; the suite fails if any mutant survives | M2-01 | 2 |
| M2-06 | `scripts/m2-scorecard-check.py` | Recompute every number in `docs/m2-scorecard.md` from committed artifacts; fail on mismatch, unattributed number or zero input | M2-01 | 2 |
| M2-07 | Per-row cause, load and fixture hash in trial records (R8) | Machine-readable agent / oracle / harness cause with harness class, host 1-min load, fixture hash on every row | M2-01 | 2 |
| M2-08 | Extend EF-003 with the sweep's fault classes (sweep P-3) | Add pop-up or overlay, non-default starting state, missing object or infeasible request (login wall if applicable); per-class rates with exact intervals | M2-05; extends existing TIF-52 | 2 |
| TIF-99 | Writer UNO read path, built for the oracle | Existing issue. Only if O1 picks (a) or (c) | M2-01 | existing |
| M2-09 | Multi-step task family with checkpoint oracles | Only if O1 picks (b) or (c); per-checkpoint postconditions computed host-side | M2-01, M2-05 | 2 |
| M2-10 | One targeted retry from the last verified checkpoint (sweep P-2) | On a refuted checkpoint, one retry from the last verified point with the verdict fed back; paired against no-retry | M2-09, TIF-98 | 2 |
| TIF-98 | Faster VM reset | Existing issue. Sets the cost of R4, R5 and R6 | none | existing |
| M2-11 | Gated vs ungated baseline arm (R6) | Same agent, tasks and settings, with and without the gate; needs Tiffany's spend cap and approval | M2-04, M2-07, M2-14, Q4 | 2 |
| M2-12 | M2 runbook sections | Add every M2 step, name `m2-scorecard-check.py` and its pass line, guard-compatible credential steps, no "same shell" assumptions (L4, L5) | M2-04, M2-06 | 0 |
| TIF-232 | Tighten the secret-guard match on token-file path variables | Existing post-M1 issue (J4) | none | existing |
| M2-13 | M2 sweeps and suites (R3, R4, R5 runs) | The VM runs that fill R3–R5, under the guest load gate, packs committed as each lands | M2-06, M2-07, M2-08, M2-10, TIF-98 | 2 |
| M2-14 | Resolve C1 `verified:false` and the skipped audit | The issue filed in `docs/backlog/tif-c1-verified-audit.md`, before R6 reuses the C1 harness | none | 1 |
| M2-15 | TIF-200 follow-ups | The items in `docs/backlog/tif-200-followups.md` (denominator wording, aggregate-cost fallback, fixture text) | none | 1 |
| M2-16 | Cold single-operator reproduction (R9) | One cold Claude operator, fresh clone, one session, every M2 step, ends with `m2-scorecard-check.py` exit 0; findings fixed before sign-off | M2-12, M2-13, M2-11 | 2 |
| M2-17 | `build-all.sh` end to end (optional) | Only if Tiffany answers Q5 yes: rebuild the VM bundle from the repo's toolchain | Q5 | 2 |
| M2-18 | Pre-action guard (sweep P-4), deferred | Target and focus check before each step; not before M2-04, M2-08 and M2-10 | M2-10 | 2 |
| M2-19 | Oracle-validated procedure replay (sweep P-5), experiment only | Under existing TIF-100 and TIF-101; not an M2 scorecard row | M2-04 | 2 |

**Open-source ready workstream (§6).** Proposals only, held until Tiffany reviews the draft.

| Label | Title | One-line scope | Depends on | Tier |
|---|---|---|---|---|
| OSS-01 | Pre-publication safety pass (hard gate) | Run gitleaks over the whole history and every ref (`--all`, including the `archive/*` tags), plus a scan for host paths (`/Users/…`, `/private/tmp/…`, `/home/…`, `~/…`); report findings by count and location, never by value; any history rewrite only on Tiffany's explicit OK | none | 2 |
| OSS-02 | Decide license and release timing | Tiffany answers Q7 and Q8; record the decision in the repo | OSS-01 report | 0 |
| OSS-03 | Target repo layout | Decide the top-level layout and where internal M1 evidence, ledgers and coordination docs go; a design doc only, no moves | M2-01 | 0 |
| OSS-04 | Public agent-facing API spec | Document the tool contract an outside agent calls (the six `myco-rt-mcp` ops plus M2-04's gate), versioned; decide which stack serves it | M2-01, M2-04 design | 0 |
| OSS-05 | Task-family extension point | Define and document how a new task family plugs in (intent, fixture generator, ground truth, oracle, mutation self-test), proven by the second family | M2-01, M2-05 | 0 for the doc, 2 for any interface change |
| OSS-06 | Move internal evidence out of the newcomer path | Execute OSS-03's layout; keep every scorecard link and `scorecard-check.py` green | OSS-03, OSS-01 | 2 (moves M1 evidence) |
| OSS-07 | Project basics | Add `LICENSE` (after OSS-02), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, issue and PR templates | OSS-02 | 0 |
| OSS-08 | Public CI for outside contributors | Confirm every job runs without secrets on GitHub-hosted runners; add fork-PR rules and a required-checks list | OSS-07 | 1 |
| OSS-09 | Whole-history secret scan in CI | Add a scheduled or manual gitleaks job over all refs, beside the per-PR scan | OSS-01 | 1 |
| OSS-10 | VM-free quickstart for outsiders | Rewrite `docs/product/quickstart.md` and the README for someone outside the project: the mock path, no TIF ids, no VM | OSS-06 | 0 |
| OSS-11 | Versioned install and prebuilt releases | Decide the published names (npm, PyPI, crates or binaries), drop `"private": true` where it applies, tag a first version, build release artifacts in CI | OSS-02, OSS-04, OSS-08 | 1 |
| OSS-12 | Newcomer docs | Architecture overview, the agent-facing API (from OSS-04) and "add a task family" (from OSS-05) | OSS-04, OSS-05, OSS-06 | 0 |

Suggested order: M2-01, then M2-02 and M2-03 in parallel (no VM, no spend; either can
re-rank the plan), then M2-04 to M2-07, then the VM-bound work, then M2-16 last. OSS-01
can start as soon as Tiffany approves it, because the history is already public (Q8).
OSS-03, OSS-04 and OSS-05 run beside M2-04 and M2-05, because they shape M2's design.
The rest of the OSS work can follow.

---

## 6. Open-source ready workstream

Approved by Tiffany for this draft on 2026-11-25 at 9:26 AM ET. **Nothing here has started.**
No file has moved, and no Linear issue exists. Each item names what is in the repo today
(main `bb0209e0`) and whether it **SHAPES** M2's design, so it must be decided early, or can
**TRAIL**.

**One fact changes the framing:** the GitHub repo `kodingcills/Myco` is **already public**
(`gh repo view` reports `PUBLIC`, with no license). "Open-source ready" therefore means
making an already-visible repo usable and safe for outsiders, not preparing a private repo
for its first exposure. See Q8.

### 6.1 Repo layout: SHAPES

**Today.** The top level mixes product code with project operations. The product code is
`src/` (TypeScript host: `core`, `fake`, `tasks`, `integration`, `win`, `verify`, `baseline`,
`foundry`, `discovery`, `faults`), `agent/` (Python guest agent), `runtime/` (Rust crates
and `guest/`), `viewer/`, `schemas/`, `bin/`, and the eval harness, which is spread across
`src/integration/`, `scripts/` (sweep, suite and scorecard drivers such as `m1-sweep.sh`,
`m1-corrupt-suite.sh`, `m1-scorecard.py`, `scorecard-check.py`) and `test/`. Beside them sit
`foundry/`, `dogfood/`, `tasks/` (three YAML task files) and `HANDOFF.md` (an MVP Discovery
session handoff). Under `docs/`, newcomer material (`product/`, `architecture/`, `eval-runbook.md`)
sits beside internal records: `docs/research/experiments/` (379 tracked files, about 2.4 MB of
M1 evidence packs, run ledgers and operator reports), `docs/coordination/` (owner state
files, VM queue, `m1-state.md`), `docs/backlog/`, `docs/research/ledger.jsonl` and
`index.jsonl`, and `docs/design/reviews/`. The README's "Layout" section already lists the
code dirs but sends a newcomer to `docs/coordination/` and `docs/research/` as peers.

**Proposed direction** (for OSS-03 to decide, not decided here): top-level `runtime/`,
`agent/`, `viewer/`, an eval-harness directory gathering what is now split across
`src/integration/`, `scripts/` and `test/`, and `docs/` for newcomer docs only. M1 evidence,
ledgers, coordination and backlog files move under one internal tree (for example
`project/` or `records/`) or to a separate repo.

**Constraint the move must respect.** `docs/m1-scorecard.md` cites evidence by path,
`scripts/check-scorecard-links.py` and `scripts/scorecard-check.py` check those paths, and
the trial-trace table links into `docs/research/experiments/m1-runs/`. A move must keep
every check green in the same PR (OSS-06 is Tier 2 for that reason).

**Why SHAPES:** M2 adds new packs, a new scorecard and a new check script (§2); deciding the
layout first means they land in their final place instead of moving twice.

### 6.2 Easy start: quickstart SHAPES, releases TRAIL

**Today.** `docs/product/quickstart.md` already runs with no VM: the mock transport, measured
at about 3 s from install to a `verified` report on macOS arm64, Node 24, pnpm 10. It is
written for "a fresh coding-agent session" and quotes internal context (TIF ids, acceptance
numbers). The README's "Setup" and "Run something" sections do the same with the fake app.
There are **no GitHub releases**; the 28 git tags are `archive/*` branch tombstones and two
review tags, not versions. Every package is unpublished: `package.json` (`@myco/core`
0.1.0) and `viewer/package.json` are `"private": true`, `agent/pyproject.toml` is
`myco-agent` 0.1.0 with no publish step, and nothing builds `runtime/` binaries for release.

**Proposed.** A quickstart for outsiders built on the existing mock path, then a versioned
install (package names, a first tag, a changelog entry) and prebuilt artifacts from CI.

**Why:** the quickstart SHAPES, because the M2 gate (R1) is what an outsider would try first,
so the quickstart should exercise it; prebuilt releases and package names TRAIL, because
they wrap whatever API exists and change nothing in it.

### 6.3 Project basics: TRAIL (license decision early)

**Today.** Present: `README.md`, `AGENTS.md` (agent rules), and
`docs/coordination/CONTRIBUTING-agents.md` (an internal contributor guide for agents, full of
TIF and tier rules). `.githooks/pre-commit` runs gitleaks on staged files. **Missing:**
`LICENSE`, a root `CONTRIBUTING.md` for outside humans, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
`CHANGELOG.md`, and any `.github/ISSUE_TEMPLATE/` or `PULL_REQUEST_TEMPLATE.md` (`.github/`
holds only `workflows/`).

**Why TRAIL:** none of these change M2's design; but the license is a gate for outside
contributions and for publishing packages, so Q7 should be answered early even though the
file can land late.

### 6.4 Public CI: TRAIL

**Today, from `.github/workflows/`:**

| Workflow / job | Runner | Needs secrets or self-hosted resources? |
|---|---|---|
| `ci.yml` `secret-scan` | `ubuntu-latest` | No. Downloads a checksum-pinned gitleaks and scans only the commits the PR or push adds |
| `ci.yml` `check` (typecheck, lint, test, build) | `macos-latest`, `ubuntu-latest` | No |
| `ci.yml` `agent` (pytest) | `macos-latest`, `ubuntu-latest` | No |
| `ci.yml` `runtime-agent-linux` (cargo tests) | `ubuntu-latest` | No |
| `ci.yml` `viewer-perf` | `macos-latest`, `ubuntu-latest` | No; runs on pushes to main and on PRs labelled `perf` |
| `tif-170-race-diagnostics.yml` `race` | `ubuntu-latest` | No; manual dispatch or PRs that touch the race test files |

No workflow references `secrets.*` or a self-hosted runner. Everything that needs our
resources stays out of CI: the Windows VM and its bundle (`docs/env/vm-toolchain/`, the
`clean-base` snapshots), the guest token, and paid model keys. So outside contributors' PRs
can already run the full suite, subject to GitHub's first-time-contributor approval setting,
which this draft has not checked.

**Gaps to close:** a documented list of required checks; a statement that VM-bound and paid
paths are never run in CI (so a contributor knows why a PR cannot exercise them); and the
per-PR secret scan's own limit, "older history predates the scanner" (the comment in
`ci.yml`), which OSS-09 covers.

**Why TRAIL:** CI already works without secrets; what remains is policy and documentation.

### 6.5 Pre-publication safety pass: HARD GATE, and urgent

**This is a hard gate.** No announcement, no package publish and no invitation to outside
contributors before it passes. Because the repo is already public, it is also urgent: it
finds what is *already* exposed.

**Today.** CI's gitleaks job scans only each PR's new commits, and its own comment says the
older history predates the scanner, so the full history (656 commits on main at `bb0209e0`,
plus the other pushed branches and the 28 tags,
whose `archive/*` refs keep otherwise-deleted branches reachable) has never had a
whole-history scan recorded in the repo. Host paths are present in the tracked tree today:
a fixed-string count found files containing `/Users/` (14 files), `/private/tmp/` (22),
`/home/` (22) and `~/` (72). Many are likely harmless (runbook paths such as `~/VMs/…`, and
operator report paths), but some may carry a username or an internal machine layout.
Operator reports under `docs/research/experiments/` were redacted by hand before commit
(for example the secret scan in `m1-row8-step1/README.md`), which is a check per pack, not a
history-wide one.

**The pass:**

1. `gitleaks git` over every ref (`--all` log options, tags included), with `--redact`,
   findings recorded by count, file and commit, never by value.
2. A host-path scan over the full history (`git log --all -p`, or `git grep` against every
   commit) for `/Users/…`, `/private/tmp/…`, `/home/…` and home-relative paths, classified
   as harmless (generic paths in runbooks) or private (usernames, personal directories,
   machine names).
3. A review of the current tree for anything else that should not be public: internal
   coordination state, personal names in logs, and links to private resources.
4. A written report to Tiffany. **Any history rewrite (for example `git filter-repo`) needs
   her explicit OK**, and the report must say that a rewrite cannot recall copies already
   cloned or forked while the repo was public; a leaked key must be rotated, whatever happens
   to the history.

**Why it SHAPES nothing in M2 but blocks the release:** it changes no design, but the release
and package work (OSS-06, OSS-10, OSS-11) must wait for it.

### 6.6 Docs: API and extension point SHAPE, architecture overview TRAILS

**Today.** `docs/architecture/m1.md` holds the M1 ADRs (ADR-0001 to ADR-0010) and is
M1-specific; `docs/architecture/runtime.md`, `evidence-schema.md` and
`windows-utm-backend.md` cover the Rust runtime, the evidence schema and the VM backend.
The agent-facing surface is described in `docs/product/dev-surface-decision.md` (MCP/stdio
to `myco-rt-mcp`, six ops: `create`, `observe`, `act`, `evidence`, `reset`, `destroy`) and
in `docs/research/findings/m2-02-mcp-api-design.md`, but there is no versioned API
reference. There is no "how to add a task family" guide; the pieces exist in
`src/tasks/` (families, fixture generation, ground truth), `src/verify/` (the UNO verifier),
`src/fake/` and the `tasks/*.yaml` files.

**Proposed.** An architecture overview that is not tied to M1; an agent-facing API reference
generated or checked against the code; and an "add a task family" guide.

**Why:** the agent-facing API SHAPES, because M2-04's gate tool *is* the public API and its
contract must be fixed before an outside agent depends on it; the task-family extension
point SHAPES, because M2's second family (O1) is the first real test of it, so the
interface should be designed rather than discovered; the architecture overview TRAILS,
because it describes whatever M2 builds.

### 6.7 Summary

| Item | Shapes or trails | Reason, in one line |
|---|---|---|
| 6.1 Repo layout | **SHAPES** | M2's new packs, scorecard and check script should land in their final place, not move twice |
| 6.2 Quickstart | **SHAPES** | The gate is what an outsider tries first, so the quickstart should exercise R1 |
| 6.2 Releases and versioned install | TRAILS | Packaging wraps the API without changing it |
| 6.3 Project basics | TRAILS (license early) | No design impact, but the license gates contributions and publishing |
| 6.4 Public CI | TRAILS | CI already runs without secrets; what is left is policy and docs |
| 6.5 Safety pass | **HARD GATE**, urgent | It blocks any release, and the history is already public |
| 6.6 Agent-facing API | **SHAPES** | M2-04's gate is the public contract and must be fixed before outsiders depend on it |
| 6.6 Task-family extension point | **SHAPES** | M2's second family is its first real test; design it, don't discover it |
| 6.6 Architecture overview | TRAILS | It describes what M2 builds |
