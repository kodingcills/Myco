# M2 recommendation (TIF-105)

> **Status: research input, not a product decision.** It ranks M2 work. It does not retract or pre-empt MVP Discovery's A/B/C product choice. Nothing below has a Linear id until the outer loop creates one (ISSUE-FIRST).

Date: 2026-11-22. Combines [m2-00](m2-00-failure-mode-sweep.md) (merged as 72be504, independently verified: round 1 FAIL at b15a00f on a superseded arXiv version, round 2 PASS at 010a32a, 69 items checked, 0 mismatches) with m2-01..05. Almost every number in m2-00 rests on one source; the tags are in that doc.

## Recommendation

**M2 is the outcome oracle used as a gate, then as a retry point, then proven under faults.** In order:

1. **Completion gate (m2-00 bet 1, P-1).** No "done" without a three-valued state-oracle verdict, callable by any agent harness, oracles mutation-tested. Why: at a 100-step budget, 86–96% of failed OSWorld-Verified tasks end with the agent claiming completion (91–105 of 361 tasks), and 5 of 9 DONE claims fail a state check in one lab's benchmark. A state verifier matched humans on 113 of 120 against 95 of 120 for an LLM judge. Honest limit: detection alone moved success about 3 points, so this is a detector, not a repair.
2. **Checkpoint oracles with one targeted retry (bet 2, P-2).** For long and multi-app work. Partial minus strict credit is 31–37 points for every top system on OSWorld 2.0, and a diagnosed re-run fixed 28.5% of failures against 13.9% blind. The 4–8 point payoff estimate rests on one paper's package comparison; reject below 2 points measured.
3. **Fault-injected false-success suite (bet 3, P-3).** Nobody publishes false-success rates under faults; this is the proof for 1 and 2 and the open ground. Extends EF-003 with four literature-backed fault classes.
4. **Structural state adapters per app, built for the oracle (bet 5).** Already TIF-99 (Writer UNO read). Build it as the oracle's read path, not as the agent's eyes: the accessibility channel is worth only 2.8 points as agent observation.
5. **Procedures stay an experiment (bet 4).** Under TIF-100 and TIF-101. They buy repeatability and cost (Pass^3 +3.6 to +15.8, 15–217× cheaper per run), not single-run capability; long workflows were negative (−5.6 strict, −18.5 partial); UI-drift breakage is unmeasured.
6. **Guarded steps last (bet 6, P-4).** The one ablation with confidence intervals found no measurable effect (−0.6 [−7.2, +6.7]). Build the pre-action check the gate and procedures need; no separate track.

Do not spend M2 on: click grounding (11 of 144 frontier failures), step budgets (1 of 144), more planner layers, LLM/VLM judges as the verifier (15–28% false accepts), or prompt-injection defence.

## How the five M2 findings bear on it

- **m2-01 (teardown).** No competitor proves persisted outcomes. m2-00 adds that both labs tell integrators to verify outcomes and ship no tool for it, so the gap is the lab-level one, not only the product-level one. Orgo's $0.023–$0.368/machine-hour remains the price a verified-outcome product is compared against.
- **m2-02 (MCP/API design).** The gate is the same design: the verdict behind a separate tool from the actuator, `application_commit: not_verified` in every receipt. m2-00 says "callable from any harness"; that is surface-agnostic and does not decide MCP versus anything else. The earlier "M2 = MCP/API" lock-in stays retracted.
- **m2-03 (second app).** Supports TIF-99 as the first adapter; no new issue.
- **m2-04 (procedure learning).** m2-00 confirms the drift rate is still unmeasured and says what TIF-100 must produce; TIF-101's admission gate is the validator the oracle provides.
- **m2-05 (fast reset).** Retries and a fault matrix multiply trials, so the reset cost (cold, about 21 s, not the 8.3 s live path) sets the price of bets 2 and 3: TIF-98 matters more under this ranking.

## How it sits against A/B/C (no choice implied)

Bets 1, 2, 3 and 5 are needed under A (verified desktops for coding agents) and under B (verified operations for software without APIs). Bet 4 matters most under B. For C (branchable desktops), forked attempts are one way to get best-of-N, worth 7.3 points at N=10 with a model judge; the sweep found nothing against C.

## Cheapest falsifiers first (no VM, no spend)

- **P-7: claim-versus-state audit on public trajectories.** If false DONE is under 10% of runs for frontier agents, bet 1 shrinks and the ranking changes.
- **P-8: false-DONE matrix for Myco's own screenshot baseline,** from recorded C1 arm rows after the arm finishes (relates to TIF-75).

## Gaps, not estimated

UI-drift breakage rates for procedures (TIF-100) and any failure breakdown for Gemini computer use.

## Proposed issues

Proposed in m2-00 "Proposed TIF issues", P-1 through P-8, none created. Existing ids: TIF-98 (reset), TIF-99 (Writer), TIF-100 (drift), TIF-101 (ADR-0017), TIF-102 (paid-tier teardowns, needs Tiffany's approval). P-1 and P-3 are the ones this recommendation says to open first.
