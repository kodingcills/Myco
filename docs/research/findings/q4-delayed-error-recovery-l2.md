# Finding Q4 — L2 proposal: delayed-error recovery (CUA-Recovery)

Date: 2026-11-19. Level: proposal only — **not started, not M1 scope.** Routed to
the outer loop for Linear mirroring and go/no-go.

## Question

CUA-Recovery (cited as arXiv 2610.27645) reports that agents struggle to
recognize and repair mistakes made many steps earlier (2,250 human-verified
error states across 100 tasks). Does Myco's recovery design (ADR-0006) hold
when the wrong action lands ~15 steps before its consequence becomes visible,
and the world has legitimately moved on since?

## Evidence and citation status

**VERIFIED 2026-11-19** against the primary source (arXiv abstract page) and
the authors' repo README:

- **Title:** "CUA-Recovery: Benchmarking Error Recovery in Long-Horizon
  Computer-Use Agents" (Xu Hu, Haoming Li, Yuxiang Wang, et al.; 2026-10-20;
  cs.AI/cs.CL/cs.LG). Matches the brief.
- **Dataset:** "a human-verified test suite of 2,250 erroneous states over 100
  tasks and a training suite of 8.6K trajectories over 377 tasks." Matches the
  brief's 2,250 / 100.
- **The "many steps earlier" dimension is explicit and quantified:** the test
  suite takes over each state at depth `d ∈ {0, 5, 10, 15, 20, 25}` steps after
  the root cause, with no error warning. The brief's "~15 steps" is one of the
  paper's own depths, not an invention.
- **Headline result:** across six agents and six takeover depths, Error
  Awareness Rate (EAR) ≤ 44.0% and Pass@3 ≤ 25.5%. Fine-tuning Qwen3.5-35B-A3B
  on the training suite lifts average EAR 19.9% → 35.2% and Rubric Score
  5.0% → 16.1% on held-out recovery states.
- **Mechanism:** ReRail composes MyPCBench tasks into long multi-application
  workflows with an executable gold lineage, collects verifier-confirmed
  failures from real policies, locates each root cause against the gold
  lineage, and replays to controlled takeover depths. Code:
  <https://github.com/xu-hu-2002/CUA-Recovery> (MIT).
- **Why it matters for Myco:** the authors' repo README states the M1 thesis
  almost verbatim —
  "An early wrong action is written into files, spreadsheets, or databases,
  stays hidden for many steps, and surfaces only after the step that caused it
  has left the agent's context." Its takeover-depth protocol is directly
  reusable as the L2's trial schedule (use `d ∈ {0,5,10,15,20,25}`, not an
  ad-hoc "k+15").

One correction to the brief's framing: the paper measures *inherited* errors
in a takeover setting (a fresh agent inherits a corrupted state), not a single
agent's self-monitoring over a long run. The L2 below tests the single-agent
case, which is the gap the paper leaves open and the one M1's runner actually
faces.

Why this matters independently of the citation: M1's fault injectors
(M1-010) all produce **immediately detectable** faults (kill-app,
invalid-target, delayed-save, focus-change all surface at or near the step
they arm). Nothing in M1 tests a fault whose blast radius appears N steps
later — which is exactly where screenshot agents' errors compound silently
(vision.md) and where the CUA-Recovery result says recovery is hardest.

## Decision

**Investigate experimentally** — draft L2 below. No code changes; no M1 scope
change (M1-013/014/015 run as planned).

## Proposed smallest experiment (L2 draft — for outer loop to route)

**Title:** Delayed-error recovery: inject at step k, detect at k+15.

**Design:**

1. **Task family extension, not new family.** Reuse `calc-record-edit`
   (M1-009) with a multi-edit program: 20 sequential cell edits in one
   session, each edit a guarded step. This already exists as a parameter sweep;
   the L2 adds one thing — a `stale-write` fault class.
2. **New fault injector `stale-write`** implementing M1-010's `FaultInjector`
   interface: at step k (sampled from the paper's takeover depths
   `d ∈ {0, 5, 10, 15, 20, 25}` mapped onto a 20-edit program), silently
   write a wrong value to the target cell *between* the runner's postcondition
   check and the next step (i.e., through the UNO channel or a second UIA
   client, outside the adapter the runner is watching). The runner's
   per-step guards all pass; the corruption is invisible until the final
   persisted-file parse — or until a later step re-reads that cell.
3. **Ground truth** is trivially host-side: seed + intent + fault schedule,
   same as ADR-0005. The correct final file is known; the fault is known; the
   only question is what the runtime *reports*.
4. **Detection arms (the actual experiment):**
   - Arm A (M1 as-is): final verification only. Expected: `refuted` at the
     end — detection but no recovery. This is the baseline and must pass
     (false success here = critical bug).
   - Arm B (periodic re-verification): every m steps, re-verify all previously
     written cells against intent. Expected: detection at step k+m, recovery =
     re-apply edits k..k+m from known-good (ADR-0006 retry-from-snapshot
     semantics, but the "snapshot" is the intent log, not a VM fork).
   - Arm B is the hypothesis under test: **intent-log replay is Myco's cheap
     substitute for VM fork-and-retry when the fault is in-app state, not
     machine state.** This is the experiment's real payload.
5. **Metrics:** detection step (k+?), recovery success rate over ≥30 injected
   trials per arm, falseSuccesses (must be 0 in both arms), extra wall-clock
   cost of Arm B's periodic re-verification, and ledger rows per
   docs/architecture/evidence-schema.md.

**Plug-in points (no M1 changes needed to propose this):**

- `FaultInjector` interface and fault schedule: M1-010 (merged).
- Dogfood scenarios: DF-S02 (`find-seeded-bug`) exercises a related failure shape at task
  scale [INFERENCE: the scenario does not state this] — a wrong persistence decision discovered later. The L2 result feeds
  the Dogfood owner's Phase 1 scenario design directly; DF-S04
  (crash-recovery) is the adjacent already-planned scenario.
- Evidence/ledger: M1-012 schema needs no changes; `stale-write` is a new
  `corruptionClass` string.

**Budget (proposed, to be set in the Linear issue):** ≤1 glm-5.3 worktree
worker, ≤2 days compute on the existing myco-win11 VM (M1 coordinator
sign-off needed — the VM is M1-owned), ~60 injected trials, 1 independent
kimi-k3 verifier pass. No new infrastructure.

**Kill criteria:** if Arm A ever reports `verified` on a corrupted trial, the
finding is a P0 M1 bug, not an L2 result — stop and escalate.

## Next action

Outer loop: (1) decide whether to mirror this as a Linear issue in project
"Myco Research" (team TIF), (2) sequence it **after** M1-014 so it doesn't
contend for the VM. The CUA-Recovery citation is already verified (2026-11-19,
see Evidence above); no fetch needed.

## Reopen-if

- Citation verification fails materially (paper doesn't exist or doesn't say
  this) → rewrite motivation; the OpenAdapt numbers alone still justify it.
- M1-014 shows nonzero `uncertain` collapse or any false success → this L2 is
  preempted by an M1 fix.

## Cost spent

3 tool calls (arXiv abstract page + authors' repo README + one index/ledger
update). Design: this thread, ~1 synthesis pass.
