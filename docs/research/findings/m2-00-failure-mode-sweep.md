# Finding M2-00 — Failure-mode sweep: what is actually wrong with desktop computer-use agents

> **Status: IN PROGRESS — skeleton only. No evidence has been collected yet.**
> Research input that gates M2 planning (Linear TIF-105). Nothing below the
> Method section is a finding until this banner is replaced.

Date opened: 2026-11-22. Level: L1 (primary sources, parallel extraction, one
synthesis pass). Branch: `tif-105-failure-mode-sweep`.

## Question

Across lab computer-use stacks (Anthropic, OpenAI, Gemini) and open-source
harnesses (Cua, Agent S, UI-TARS, OpenCUA, Microsoft HCU, others), **which
failure types account for how much of the observed failures**, which of them
are caused by the model and which by the harness or tool design, and which
would Myco's three levers — state oracles, fault injection, verified
procedures — actually fix?

The output decides what M2 is, so the bar is quantitative: a rate per failure
type with its source, sample size, and the model/harness/benchmark version it
was measured on.

## Method

1. **Dedup first.** Read `m2-01-competitive-teardown.md`,
   `mvp-competitive-teardown.md`, `benchmark-survey.md`,
   `f1-ef-fault-taxonomy.md` and `index.jsonl`. Those already cover developer
   surfaces, action-response shapes, grader design, reset, and variance
   reporting. This finding does not repeat them; it adds failure *rates* and
   failure *attribution*.
2. **Fan out by area**, one research subagent each, primary sources only:
   - Anthropic computer use (tool versions, the zoom action, documented
     limitations, system cards and evals)
   - OpenAI CUA / Operator / Responses computer tool (loop, safety checks,
     system cards)
   - Gemini computer use (public docs and model cards)
   - Open-source harnesses (Cua, Agent S/Simular, UI-TARS, OpenCUA, HCU, UFO,
     and the agent papers' own error analyses)
   - OSWorld family failure mining (OSWorld, OSWorld-Verified, OSWorld 2.0 and
     third-party analyses of them)
   - Windows Agent Arena, AndroidWorld and other desktop suites
   - Robustness, false-success and lever-efficacy literature (perturbation and
     pop-up studies, recovery benchmarks, evaluator-reliability audits,
     procedure/skill-memory ablations)
3. **Citation discipline** (PIPELINE.md): every number carries a source URL and
   a pointer (section, table or figure). A number seen only in a secondary
   source, or not confirmed by fetching the primary source, is marked
   `UNVERIFIED`. No rate is invented. Where a share has to be estimated, the
   arithmetic and its assumptions are shown next to the number.
4. **Synthesis.** One taxonomy; one rate table with columns evidence, rate,
   confidence, model vs harness, Myco lever; a section on failures that tool
   design actively causes; a ranked list of M2 bets.
5. **Verification.** An independent verifier thread spot-checks at least 15
   citations and numbers against the sources at the exact head SHA and reports
   PASS or FAIL. Merge requires green CI and that PASS.

Out of scope: running any agent, benchmark or VM. No spend, no accounts.

## Evidence

_Pending._

## Decision

_Pending._

## Proposed smallest experiment

_Pending._

## Next action

_Pending._

## Reopen if

_Pending._

## Cost spent

_Pending._
