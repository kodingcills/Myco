# Finding M2-00 — Failure-mode sweep: what is actually wrong with desktop computer-use agents

> **Status: research input, not a product decision.**
> This finding gates M2 planning (Linear TIF-105). It ranks M2 bets. It does not
> retract or pre-empt MVP Discovery's A/B/C product choice. No agent, benchmark or
> VM was run for it.

Date: 2026-11-22. Level: L1 (seven parallel primary-source extractions, one
spot-check pass, one synthesis pass). Branch: `tif-105-failure-mode-sweep`.
Checked against the TIF-105 spec and `docs/research/tif-105-coverage-brief.md`.

**In brief**

1. **The failure mix inverted between 2024 and 2026.** Click grounding went from
   "more than 75%" of 550 failed examples to 7.6% (11 of 144). Ending at
   the step limit went from 70% of one 2024 system's failures to a root cause in 1
   of 144. Reasoning and control is now 52.8% (76 of 144).
2. **Failures end silently.** At a 100-step budget, 86–96% of failed
   OSWorld-Verified tasks end with the agent claiming completion: 91–105 of 361
   tasks, or 25–29% of everything attempted. On long workflows 81–90 of 108
   trajectories (75–83%) stop or claim "done" with work remaining. No lab's tool
   contract carries an outcome.
3. **Model versus harness depends on how you measure it.** Human root-cause labels
   put 112 of 144 failures (78%) on the model and none on its tools. But two labs
   each found one harness defect that had been hiding 22–28% of their reported
   failures, and on Windows with accessibility-only observation 62.8% of failures
   were control detection.
4. **The three levers are not equally supported.** The state oracle has the
   strongest evidence, as a *detector*: it does not repair on its own. Fault
   injection is open ground: nobody publishes false-success rates under faults.
   Verified procedures buy repeatability and cost, not single-run capability, and
   the nearest competitor has already published.
5. **Recommended ranking:** a state-oracle completion gate first, checkpointed
   retry second, a fault-injected false-success suite as the proof. Procedures
   stay an experiment. Per-step guards rank last: the one ablation that reports
   confidence intervals found no measurable effect.
6. **Two gaps stay open and are not estimated:** UI-drift breakage rates for
   procedures (TIF-100), and any failure breakdown for Gemini computer use.

Almost every number below rests on a single source. They are tagged `1src`.

## Question

Across lab computer-use stacks (Anthropic, OpenAI, Gemini) and open-source
harnesses (Cua, Agent S, UI-TARS, OpenCUA, Microsoft HCU, UFO, others), **which
failure types account for how much of the observed failures**, which are caused
by the model and which by the harness or tool design, and which would Myco's
three levers — state oracles, fault injection, verified procedures — actually
fix?

## Evidence

### How to read the numbers

Status tags, used in every table:

| Tag | Meaning |
|---|---|
| `V2` | Read from the primary source by two independent fetches this session (two research agents, or one agent plus the spot-check pass). |
| `V` | Read from the primary source this session. |
| `D` | Derived here from `V`/`V2` inputs. The arithmetic is shown beside the number. |
| `S` | Seen only in a secondary source or a search summary. |
| `UNVERIFIED` | From memory, or the source could not be fetched. Not to be repeated as fact. |
| `1src` | **Single-source.** The number rests on one study or one vendor document. Fetching that source twice (`V2`) does not make it corroborated. |
| `2src` | The same quantity is reported by two independent studies. |

Four limits on `V` and `V2`:

- Web pages and arXiv HTML reached the research agents through a fetch tool that
  returns extracted text and, for long pages, a model summary of the tail. `V`
  means "seen in the primary source through that tool", not a human reading.
  Quotes are given only where the text came back verbatim.
- Anthropic system-card numbers were extracted from the downloaded PDFs. Two cards
  (Opus 4.7, Sonnet 5) are image-only and were read by OCR; those are marked
  `(OCR)`.
- A rate applies to the model, harness, benchmark version and year it was measured
  on. The mix shifts with capability, so every row names its cohort. A 2024
  distribution does not describe a 2026 agent.
- Versions. After the first verifier pass, every cited arXiv paper was checked
  against the arXiv listing. Three had been read at an older version (`[MINI]`
  v1, `[WGUI]` v4, `[PCE]` v1) and were re-read at the latest; only `[MINI]` had
  changed numbers. Every arXiv-sourced row was then re-checked against the
  latest page text. Tags were not upgraded: `V2` still marks only what had two
  reads before that pass.

Every rate is given with its denominator, or with "n not published" where the
source withholds it. Source keys (`[CUAD]`, `[OSW2]`, …) resolve in "Sources" at
the end of this section. `Pass@k` means any of k runs succeeds; `Pass^k` means
all k succeed.

### 1. Failure taxonomy and rates

#### 1.0 The spec's eight failure types at a glance

TIF-105 names eight failure types. This table answers it in its own vocabulary.
Each row points to the detailed tables below. The shares come from different
studies with different definitions, so they are not additive. Every number is
`1src` unless marked.

| Spec failure type | Best available rate, with denominator | Conf. | Model vs harness | Myco lever | Detail |
|---|---|---|---|---|---|
| **Grounding** | Frontier, 2025–26: 11 of 144 failures (7.6%) `[CUAD]` and 9 of 122 (7.4%) `[MIS]`, `2src`. In 2024: "more than 75%" of 550 failed examples `[OSW]` | high | Model. The residual depends on image resolution, which is harness (9.3 points, `[O-54]`) | Verified procedure (element references); low priority | §1b, §1c |
| **False success** | 91–105 of 361 tasks end in a false DONE at 100 steps, 86–96% of failed tasks `[VLAA]`; 5 of 9 DONE claims fail a state check `[SNK]`; 81–90 of 108 long-horizon trajectories `[OSW2]` | medium | Model makes the claim; the harness accepts it | **State oracle** (detects) | §1a |
| **State drift** (the agent's picture of application state diverging from the real state) | Small as a labelled root cause: context loss 2 and memory hallucination 1 of 144 `[CUAD]`; state loss 2 of 122 `[MIS]`; stale state 2 of 105 `[MINI]`. When the starting state is not the default, success falls 17–34 points `[WGUI]`. No study labels "state drift" as such | low | Mixed: model, plus harness history truncation | State oracle (re-read state); preconditions | §1b, §1e, §3 item 9. Interface drift across app versions is a separate, unmeasured question: §6 gap 4 |
| **Pop-ups and stale UI** | Pop-ups when injected: attack success 86% on average `[POP]` (abstract figure; five models, 50 OSWorld and 72 VisualWebArena tasks); success 24.21% → 10.28% `[HIJ]`; distracted in 20–21 of 29 `[MAC]`. In ordinary benchmark runs: distraction 0 of 144, unexpected system behaviour 1 of 144 `[CUAD]`. Stale UI: stale-category tool errors 88 of 10,783 calls (0.82%) `[HCU]`; timing or race 0 of 144 `[CUAD]`; an adversarial focus change redirected 45 of 45 actions `[FOCUS]` | high that pop-ups halve success when present; low on how often they occur in real use | Pop-ups: model. Stale UI: harness | Fault injection to measure; guarded steps to fix | §1c, §1e |
| **Long-horizon planning** | Reasoning and control 76 of 144 (52.8%) `[CUAD]`; multi-app tasks hold 42.6% of the residual failures of the top eight agents `[LB]`; partial minus strict score 31–37 points on OSWorld 2.0, where strict success falls from 20–24% on tasks under 45 human-minutes to 0% above 163 (Opus 4.7 and GPT-5.5) `[OSW2]` Table 3, App. G.2 Table 21 | high | Model | Checkpoint oracle for the unmet last mile; verified procedures for the 36 of 144 that are redundant-strategy, parameter or decomposition errors; nothing for the rest | §1b, §1f |
| **Recovery** | 659 of 1,202 errors self-recover in-trace (54.8%) `[SREC]`; error awareness at most 44.0% over 2,250 inherited error states `[REC]`; recovery and repair under 7% of the action budget `[OSW2]`; a diagnosed re-run fixes 28.47% of 144 failures against 13.89% blind `[CUAD]` | medium | Model | State oracle with checkpointed retry (estimated 4–8 points, §4); fault injection to measure | §1e, §4 |
| **Timing** | Tuned Linux harness: timing or race 0 of 144 `[CUAD]`. Younger harnesses: action latency 0 of 105 failures `[MINI]` (v2); time limit 18.64% of GUI-only failures, count not published `[MCPW]`. Mechanism: observe-to-act gap 6.51 s `[FOCUS]`; fixed sleeps in every reference harness read | low | Harness | Guarded steps that wait on state | §1c, §3 item 4 |
| **Tool-design limits** | One harness defect hid 22–28% of a lab's reported failures (≈17–21 of 361 tasks) `[A-SC]` and 26% (9.3 of 35.3 points) `[O-54]`; UIA-only observation 62.8% of failures on Windows, n not published `[UFO2]`; 11 of 105 on AndroidWorld `[MINI]`. As a labelled root cause: 0 of 144 `[CUAD]` | medium | Harness | State oracle independent of the action path; fault injection as a conformance suite | §1c, §2, §3 |

#### 1a. How failures end

| Failure type | Evidence (cohort) | Rate, with denominator | St. | Conf. | Model vs harness | Myco lever |
|---|---|---|---|---|---|---|
| **False completion claim** — agent says done, state says no | Sonnet 4.6 and Gemini 3 Flash in the VLAA-GUI harness, OSWorld-Verified, 361 tasks, 100 steps `[VLAA]` §4.3, Table 10 | Sonnet 4.6: **105 false DONE = 95.5% of failed tasks = 29.1% of 361**; with the paper's completion check 91 = 91.9% = 25.2%. Gemini 3 Flash: 102 = 91.9% = 28.3%; with the check 100 = 86.2% = 27.7%. DONE accuracy 69.6–73.5%, so 26–30% of completion claims are false (number of claims not published). At 15 steps false DONE is 53.7% and 38.7% of failures, because step exhaustion replaces it | `V2` `1src` | medium | Model makes the claim; the loop accepts it | **State oracle** (detects; does not repair) |
| Same, state-checked, professional app | Sonnet 4.5 in the Cua harness, 25 KiCad tasks, netlist-reading verifier `[SNK]` | 4 of 25 pass; 16 of 25 hit the 150-step cap; 5 of 25 declared done on a wrong artifact; **5 of 9 DONE claims failed verification** | `V2` `1src` | medium (n=25, vendor blog, runs per task not stated) | Model | State oracle |
| Premature stop or false done, long workflows | Four models, OSWorld 2.0, 108 tasks each, 500 steps `[OSW2]` App. F Table 19 | **81, 84, 90 and 86 of 108 trajectories (75.0–83.3%)**; final-state exactness failure 103, 97, 92 and 91 of 108 (84.3–95.4%). Labels overlap; assigned by GPT-5.5, "further human-verified" | `V2` `1src` | medium (LLM labels) | Model | State oracle, per checkpoint |
| False DONE, small local models | Qwen3-VL-30B at 50 steps, OpenCUA-7B at 100, OSWorld, 361 tasks × 5 trials `[CANDID]` Tables 3, 5, 6 | ≈42% (97.4 of ≈233.5 failures) and ≈90% (241.3 of ≈266.9). The paper does not define "False Success" or state its unit; read here as mean tasks per trial. Categories not exclusive | `D` `1src` | low | Model | State oracle |
| Step-budget exhaustion | Claude 4.5 Sonnet, 50 steps, OSWorld `[CUAD]` Table 7 | Root cause in **1 of 144** failures (0.7%) | `V2` `1src` | high | Model; not a budget effect at 50 steps | None |
| Same, 2024, as a termination mode | FRIDAY (GPT-4o), OSWorld, 369 tasks at 18.8% success `[OSC]` Tables 2, 4 | "Reach step limit" 70.4% of failure cases (count not published; the paper states no step-limit value) | `V` `1src` | medium | Not attributed: a termination mode, not a cause | — |
| Budget as a cure | Sonnet 4.5 and CoAct-1 on the official leaderboard, 361 tasks `[LB]` | 50 → 100 steps recovers 4.80 of 41.92 failing points (11.5%); CoAct-1 100 → 150 recovers 0.83 of 40.07 (2.1%) | `D` `1src` | high | Model | None |

Two caveats on the headline row. `[VLAA]` does not say who adjudicated "false"
(most likely the OSWorld evaluator). And its failed-task denominators are 3–7
tasks smaller than its own success rates imply (105/0.955 ≈ 110 failed, against
361 × (1 − 0.6881) ≈ 113). The size of the effect survives both; the second
decimal does not.

The phenomenon is multi-source: four independent studies in this table find it
on four cohorts. Each individual rate is single-source.

#### 1b. Root causes, frontier model in a mature Linux harness

The best single source: `[CUAD]` (CUAErrorBench). 204 failed OSWorld trajectories,
two annotators per case plus adjudication, 94.6% agreement on the top-level
category before adjudication. The table uses the 144 failures from Claude 4.5
Sonnet at 50 steps. That run had 203 successes over 361 tasks, so 158 failures;
the paper does not explain the 14 that are missing from the annotated set.

Every row is `V2` `1src` (`[CUAD]` Table 7, read through a page summary by two
independent fetches, then confirmed against page text).

| Root cause | Count of 144 | Share | Model vs harness | Myco lever |
|---|---|---|---|---|
| **Reasoning and control** | 76 | **52.8%** | Model | Split below |
| — inefficient or redundant strategy | 20 | 13.9% | Model | Verified procedure |
| — progress misjudgment ("stopping too early or failing to stop") | 17 | 11.8% | Model | State oracle |
| — parameter or argument error | 9 | 6.3% | Model | Verified procedure |
| — constraint violation | 8 | 5.6% | Model | State oracle, if the constraint is asserted |
| — decomposition failure | 7 | 4.9% | Model | Verified procedure |
| — outcome misinterpretation ("misreads feedback … after an action") | 6 | 4.2% | Model | State oracle |
| — other reasoning (action-intent 4, impossible plan 2, context loss 2, memory 1) | 9 | 6.3% | Model | None |
| **Perception** (misrecognition 8, omission 7, semantic 7, other 3) | 25 | 17.4% | Model | State oracle only if the agent reads through it |
| **Infeasible task attempted instead of declined** | 19 | 13.2% | Model plus benchmark protocol | State oracle (precondition) |
| **Grounding and interaction** (coordinate 8, mechanics 3) | 11 | **7.6%** | Model | Verified procedure (element references) |
| **Benchmark or evaluation artifact** | 10 | 6.9% | Benchmark | — |
| Environment (instability 1, system behaviour 1, step limit 1) | 3 | 2.1% | Environment | Fault injection |
| Malformed action, timing or race, rendering, tool failure, distraction | 0 | 0% | — | — |

Summed (`D` `1src`): model-side 112 of 144 = **77.8%**; infeasible-task handling
19 = 13.2%; benchmark 10 = 6.9%; environment 3 = 2.1%; tool or harness 0.

Lever reach on this cohort (`D` `1src`, my reading of the subtype definitions):

- State oracle addresses 42 of 144 = **29.2%** directly (progress misjudgment 17,
  outcome misinterpretation 6, infeasible 19), and 50 of 144 = 34.7% if stated
  constraints are asserted.
- Verified procedures address 36 of 144 = **25.0%** (redundant strategy,
  parameter error, decomposition), plus the 11 grounding cases (7.6%).
- 34 of 144 (23.6%: other reasoning 9, perception 25) is model capability that
  none of the three levers touches.

For contrast, the same benchmark in 2024: "more than 75%" of 550 failed examples
showed mouse-click inaccuracies (`[OSW]` §5.4, `V2` `1src`). Grounding fell by an
order of magnitude in two years.

A second, weaker lens. `[MIS]` labels 122 genuine failures pooled over five
benchmarks, web and desktop, with LLM annotators plus human review: feedback-blind
no-op repetition 36 (29.5%), plan loop 20 (16.4%), specification violation 18
(14.8%), grounding 9 (7.4%), premature stop 8 (6.6%), tool arguments 6,
hallucinated feature 5, missed verification 4, state loss 2 (`V2` `1src`). It
describes behaviours, not root causes, and its inter-annotator agreement is low
(κ = 0.41 between the two LLM annotators on diagnoses; four-rater Fleiss' κ = 0.36). The grounding share is the one
quantity two studies agree on: 9 of 122 (7.4%) against 11 of 144 (7.6%), `2src`.

Older open-source breakdowns, for the trend only:

- Agent S, GPT-4o, 2024: execution errors in 39 and grounding errors in 26 of an
  inferred 49 failed tasks (79.6%, 53.1%; non-exclusive; the paper states the 39,
  the 49 is back-solved) (`[AS1]` Table 3, `V` `1src`).
- Agent S2, 2025: planning 41.0%, grounding 20.5%, interaction 17.9%, navigation
  10.3%, infeasible not recognised 10.3% (`[S2]` Fig. 8, `V` `1src`; values read
  from the PDF text layer; n not published, back-solved ≈39).

#### 1c. Harness and tool-design effects, measured as deltas

These do not appear in root-cause labels. An annotator records what the agent did
wrong with the tools it had, not what a different tool would have prevented.

| Effect | Evidence (cohort) | Size, with denominator | St. | Conf. | Myco lever |
|---|---|---|---|---|---|
| **Defect in a lab's own eval harness** | Anthropic: a zoom-tool bug when paired with batched actions, plus a 16K per-turn output cap. OSWorld-Verified, 361 tasks, 100 steps, 5 runs `[A-SC]` Opus 4.7 §8.9.4 `(OCR)`; Opus 4.8 Table 8.1 fn 28 and §8.12.6; Mythos Preview §6.11.4 (the 79.6); Fable 5 / Mythos 5 Table 8.1 fn 27 and §8.16.3 (the 85.4 rescore) | Opus 4.7 78.0 → 82.8 (4.8 points ≈ 17 of 361 tasks = 4.8/22.0 = **22% of the failures first reported**); Mythos Preview 79.6 → 85.4 (5.8 points ≈ 21 tasks = 5.8/20.4 = **28%**) | `V` `D` `1src` | medium (two causes not separated) | Fault injection (conformance tests for the tool layer) |
| **Screenshot resolution** | OpenAI GPT-5.3-Codex, OSWorld-Verified, same weights, new image-detail parameter `[O-54]` footnote | 64.7 → 74.0 (9.3 of 35.3 failing points = **26% of that model's failures**). Task count and step budget not published on the page | `V2` `D` `1src` | high | State oracle (state, not pixels) |
| Same, grounding only | Opus 4.7 on ScreenSpot-Pro, 1,581 tasks, old versus new image limit `[A-SC]` Opus 4.7 §8.9.3 `(OCR)` | 69.0 → 79.5 without tools; crop tooling adds 5.6–25.4 points across models | `V` `1src` | medium | — |
| Same, enterprise UI | OpenAI computer-use-preview, UI-CUBE, 136 simple tasks, 1024×768 → 4K `[CUBE]` Table 6 | 91.2 → 35.3 | `V2` `1src` | high | — |
| **Observation channel on Windows** | UFO2-base, GPT-4o, UIA-only detection, Windows Agent Arena (154 tasks), authors' manual review of all failures `[UFO2]` §6.2, Fig. 19 | **Control-detection failures 62.8% of failures.** The text says "more than 62%"; 62.8% is the label in Figure 19, readable only in the PDF. n not published (≈74 of ≈118, from 23.4% of 154 in Table 1) | `V2` `1src` | medium (one system, 2025) | Object-model adapters for the oracle |
| Unverified input and timing, mobile | Re-run single-agent baseline, AndroidWorld, 105 failures, labels by two LLM judges with author adjudication (κ = 0.59) `[MINI]` v2 §3.2 | Text believed entered but not 9; action latency 0; stale state 2 = **11 of 105 (10.5%)**. The other 94: repetitive loops 20, reasoning drift 10, error propagation 2, and 62 outside the paper's taxonomy (31 of them perception or grounding) | `V` `D` `1src` | low (one baseline, google/gemini-3.1-pro-preview per Table 1 note a and Table 8; LLM judges) | State oracle per step |
| Scaffold layers | Agent S2 → without hierarchical planning, GPT-5, OSWorld, 361 tasks `[S3]` Table 2 | 48.8 → 57.9 (**+9.1**), LLM calls per task 73.6 → 41.4 | `V2` `1src` | high | None (a caution) |
| Step cap | Four agents on the official leaderboard, 361 tasks, 15 → 50 steps `[LB]` | +12.7 to +16.6 points | `D` `1src` | high | — |
| Malformed tool calls | HCU, GPT-5.4, OSWorld 1.0, 361 tasks × 3 runs = 1,083 task-runs `[HCU]` Table 11, Table 2 | 2,460 of 14,160 AX/GUI calls rejected (17.37%) without the usage skill; 147 of 10,783 (1.36%) with. Task score moves only 64.00 → 65.59 | `V2` `D` `1src` | high | Verified procedure (compiled calls) |
| Stale observation | Claude Opus 4.6, 10 OSWorld tasks, adversarial focus change `[FOCUS]` Tables 1, 3, 10 | Observe-to-act gap 6.51 s mean; a focus change redirected 45 of 45 actions; a pre-action check intercepted all focus attacks at under 0.1 s (it does not cover in-page DOM changes) | `V` `1src` | low (one author, adversarial) | Verified procedure (precondition) |
| GUI-only action surface | CoAct-1 on OSWorld `[COACT]` Table 4; UFO2, GUI-only against GUI + API actions `[UFO2]` Table 5; OSWorld-MCP, 361 tasks, 50 steps `[OSMCP]` Table 1 | Hybrid code + GUI 60.76 against GUI-only 50.68 (+10.1); GUI + API +6.1 to +8.2; MCP tools +2.4 to +3.2 for strong agents, invoked in at most 36.3% of tasks | `V2` `1src` each | high | Verified procedure |
| GUI-only failures that are harness | Claude 3.7 Sonnet, MCPWorld, 201 tasks × 3 attempts `[MCPW]` Table 5 | Time limit 18.64% + cursor 5.08% + element not found 1.69% = 25.4% of failures (count not published) | `V` `D` `1src` | medium | — |
| Accessibility channel as agent observation | HCU, GPT-5.4, OSWorld 1.0, 361 tasks × 3 runs `[HCU]` Table 2 | 65.59 with the accessibility channel, 62.79 without (**+2.8**); 66.08 without the GUI channel | `V2` `D` `1src` | high | — (why adapters are built for the oracle, not the agent) |
| Per-step verification, by ablation | WorldGUI-Agent (GPT-4o) on WorldGUI `[WGUI]` Table 5; mobile-use full system, AndroidWorld Cloud-90 subset, 90 tasks × 2 seeds `[MINI]` v2 §5.3 | Without the action-level critic 26.0 → 9.7 (**−16.3**). Without typed-text read-back 79.4 → 78.9 (**−0.6**, 95% CI −7.2 to +6.7); without goal verification −3.3 (95% CI −10.6 to +3.3) | `V` `1src` each | low: one positive result on a weak stack, one null result with intervals | Guarded steps |

#### 1d. Benchmark and evaluator error (not agent failure)

| Effect | Evidence | Size, with denominator | St. | Conf. |
|---|---|---|---|---|
| FAIL verdicts that are wrong | Audit of 150 FAIL trajectories across five benchmarks `[MIS]` Table 2 | OSWorld **10 of 57 (17.5%)**: 8 evaluator false negatives, 2 broken tasks. All five benchmarks 23 of 150 (15.3%) | `V2` `1src` | medium |
| Same, as a root-cause label | `[CUAD]` | 10 of 144 (6.9%) | `V2` `1src` | high |
| Invalid or GUI-free tasks | Epoch review of 361 OSWorld tasks `[EP1]` | ~10% serious errors; ~8% impossible by design; ~10% depend on live web; ~15% need only a terminal and ~30% more can substitute one. Approximate shares of 361 | `V` `1src` | medium |
| Grader errors on long tasks | Epoch audit of 50 of 108 OSWorld 2.1 tasks `[EP2]` | Errors in 36 of 50 tasks; false negatives touch 25.4% of score mass, false positives 17.6% | `V` `1src` | medium |
| Infeasible tasks reward FAIL | Qwen2.5-VL-72B, OSWorld, 30 steps `[PCE]` Table 4 | 86.7% on 30 infeasible tasks against 4.4% on 339 feasible | `V2` `1src` | high |
| LLM or VLM judge accepts a failed run | Screenshot VLM judge against the official evaluator `[VERI]` Table 1 | OSWorld 27.9% of failed episodes (≈201 of 361 tasks failed); ScienceBoard 24.8% (≈129 of 169 failed); AndroidWorld 15.4% (116 tasks; failed count not captured) | `V2` `1src` (table read through a page summary both times, then confirmed against page text; failed counts are `D` from the actor's success rate) | medium |
| Direction of judge error | Eight VLM judges on OSWorld runs `[OSR]` §E.5 | 88% of judge errors are false positives (count not captured) | `V` `1src` | medium |
| State verifier against LLM judge | 120 tasks adjudicated by humans `[OC]` §5.1 | Verifier matches humans on **113 of 120 (94.2%)**; LLM judge 95 of 120 (79.2%). Judge model not named | `V2` `1src` | high |
| State checkers err too | 450 calibration executions `[OC]` §5.3; 38-task corruption test `[SCALE]` | 76 of 450 (16.9%) checker-side errors before repair, 68 repaired; 0 of 38 generated verifiers failed a corrupted document | `V2` `1src`; `V` `1src` | medium |
| Evaluator keeps no evidence | 82 AndroidWorld records `[AWAUD]` Table 2 | 41 of 82 verdicts unsupportable (no retained post-state); 2 of 82 confirmed false successes | `V` `1src` | medium |

#### 1e. Robustness under perturbation

| Perturbation | Evidence (cohort) | Size, with denominator | St. | Conf. | Model vs harness | Myco lever |
|---|---|---|---|---|---|---|
| Pop-ups and overlays | Five 2024 models, 50 OSWorld and 72 VisualWebArena tasks `[POP]`; UI-TARS-1.5-7B, 3,321 corrupted tasks built from OSWorld's 369 `[HIJ]` Table 2; Claude and OpenAI CUA on macOS, 29 tasks `[MAC]` Table 5 | Attack success 86% on average (abstract; the averaging basis is not stated); success 24.21% clean → 10.28% under pop-ups; distracted in 21 of 29 (72.4%) and 20 of 29 (69.0%) | `V` `1src`; `V` `1src`; `V2` `1src` | high | Model | Fault injection to measure; guarded steps to fix |
| Non-default starting state | WorldGUI-Agent (GPT-5.1), ten Windows and web applications, 111 base tasks and 500 augmented variants `[WGUI]` Table 4 | Office 64.4 → 37.6; Windows usage 62.5 → 40.4; Web 85.7 → 53.5; Coding 63.6 → 46.6; Media 60.0 → 26.5. Humans lose 4–14 points | `V2` `1src` | medium | Mixed | Fault injection; preconditions |
| Missing object or impossible task | Anthropic's impossible-task GUI evaluation, neutral prompt `[A-SC]` Fable 5 Fig. 6.3.7.A | Model fabricates a workaround in **9.4–34.5% of runs** (Opus 4.8 … Opus 4.6); 2.8–31.6% when the prompt discourages it. n not published | `V` `1src` (bar labels read from page renders) | medium | Model, prompt-steerable | State oracle (precondition) |
| Login wall with no credentials | Production Claude models, GUI tasks `[A-SC]` Fable 5.1 §6.3.2 | 100% of rollouts attempt to guess credentials. n not published | `V` `1src` | medium | Mixed | Fault injection; guard that halts |
| Self-inflicted side effects | GPT-5.5 and Opus 4.7, OSWorld 2.0, 108 tasks each `[OSW2]` §4.2; App. E.2 Table 14 | Bypass the visible interface in 72 of 216 trajectories (33%); force-kill an application in 11 and 12 of 108 | `V` `1src` | high | Harness (code tools) plus model | State oracle (side-effect checks) |
| App crash and system anomalies | Five agents, 152 Android tasks `[DGARA]` Table 1 | −8.6 to −32.9 points, mean −17.5. **No desktop equivalent is published** | `V` `1src` | medium | Model | Fault injection |
| Benign corruptions with small effect | UI-TARS-1.5-7B, same 3,321 tasks `[HIJ]` Table 2 | Network error −2.2; app minimised −3.4; accidental touch −1.7 points | `V` `1src` | medium | Model | — |
| Own errors | 1,202 errors on OSWorld-Verified `[SREC]` §4.1; six agents, 2,250 error states `[REC]` Table 2, App. G.3 Table 18 | 659 of 1,202 (54.8%) self-recover in-trace; error awareness ≤ 44.0%; recognising an inherited error lifts the pass rate only 12.2% → 15.6% | `V` `1src` each | medium | Model | Fault injection to measure |
| In-run recovery machinery | BEAP-Agent, GPT-4o planner, OSWorld, 369 tasks, 50 steps `[BEAP]` Table 1; ReTrace, OSWorld, two runs `[RETR]` Table 3 | Removing backtracking: 28.2 → 26.3 (**−1.9**). Adding explicit recovery: Sonnet 4.6 70.27 → 71.81 (+1.5); EvoCUA-32B 54.88 → 51.55 (−3.3) | `V` `1src` each | medium | Model | — |

#### 1f. Repeatability, cost, and where the residual failures sit

| Finding | Evidence | Size, with denominator | St. | Conf. | Myco lever |
|---|---|---|---|---|---|
| Run-to-run inconsistency | Agent S3 with GPT-5 (Fig. 1); six agents (Tables 1–2), OSWorld `[REL]` Fig. 1, Tables 1–2 | Pass@10 ≈ 78% against Pass^10 ≈ 36%; Pass^1 → Pass^3 falls 9–15 points. Task count not captured | `V` `1src` | high | Verified procedure; oracle as selector |
| Best-of-N with a model judge | Agent S3, GPT-5, OSWorld, 361 tasks `[S3]` Table 1 (N=10), Table 5 (N=4) | 62.6 → 69.9 at N=10 (+7.3 of 37.4 failing points = 19.5%). At N=4, selected 66.5 against Pass@N 74.7 | `V2` `D` `1src` | high | State oracle as selector |
| Step and latency waste | Agent S2 and others, OSWorld, 369 tasks `[OSH]` §3.1 and Table 1; §5.2 and Table 5 | Planning plus reflection 76–96% of task time; efficiency-weighted scores 2.7× and 4.3× lower than raw success | `V2` `1src` | high | Verified procedure |
| Residual failures by domain | Top eight OSWorld-Verified rows, 358–361 tasks each, pooled success 83.8% `[LB]` | Multi-app **42.6%** of failures; Chrome 18.4%; Impress 10.5%; Calc 6.2%; everything else under 6% each | `D` `1src` (failures = tasks − score, summed over the eight rows) | high | Oracle and procedures across apps |
| Windows concentration | Navi on WAA, 154 tasks `[WAA]` Table 4; PC Agent-E on WAA-V2, 141 tasks `[PCE]` Table 3 | Office share of failures 43.0 of 123.8 (34.7%) and 40.0 of 90.1 (44.4%); Office success 0–7% for every agent, 2024–2025 | `D` `1src` each | medium (no 2026 frontier per-domain data on Windows) | Oracle via object models |
| Cross-app work on Windows | Best of five frontier models, 181 tasks `[WW]` Table 2 | 20.44% final-state success with 50.32% of intermediate checkpoints passed | `V` `1src` | medium | State oracle on terminal state |
| Long-horizon last mile | OSWorld 2.0, 108 tasks `[OSW2]` Table 3; OSWorld 2.x, 82 and 108 tasks `[A-SC]` Fable 5.2 §8.13.3, Opus 5.5 | Partial minus strict score **31–37 points** for every top system. A failing attempt still holds 65–76% of credit: (89.3 − 54.6)/45.4 = 76%; (81.8 − 48.7)/51.3 = 65% | `V` `D` `1src` each | high | State oracle per checkpoint |
| Effort spent on self-checking | Four models, OSWorld 2.0 `[OSW2]` §4.1.2 | Recovery and repair together under 7% of the action budget; verification 9.8% of five-step windows | `V2` `1src` | medium | State oracle |

### 2. Model versus harness: three lenses that disagree

| Lens | What it says | Source |
|---|---|---|
| Human root-cause labels, frontier model, tuned Linux harness | Model 112 of 144 (77.8%); infeasible-task handling 19 (13.2%); benchmark 10 (6.9%); environment 3 (2.1%); **tools 0** | `[CUAD]`, `1src` |
| Same weights, harness changed | One latent defect hid **22–28%** (Anthropic, ≈17–21 of 361 tasks) and **26%** (OpenAI, 9.3 of 35.3 points) of reported failures | `[A-SC]`, `[O-54]`, `1src` each |
| Other harnesses | Harness share **62.8%** (UIA-only on Windows, n not published), 25.4% (GUI-only MCPWorld, n not published), 11 of 105 (10.5%) (AndroidWorld baseline, v2) | `[UFO2]`, `[MCPW]`, `[MINI]`, `1src` each |

`[INFERENCE]` How these fit together:

- For a frontier model in a mature Linux screenshot harness, the labelled split is
  **77.8% model and 20.1% benchmark and task protocol** (13.2% infeasible-task
  handling plus 6.9% benchmark artifact), with 2.1% environment and no tool
  failures (`[CUAD]`, 144 failures). A latent harness defect would sit inside the
  model share. Its size has been measured only twice, one harness change each time (Anthropic's bundled two fixes): 22–28%
  and 26% of reported failures while the defect was live. This is a reading of
  three single-source measurements, not a measured standing split.
- A harness defect is invisible until someone changes the harness. Both lab
  findings came from re-running prior models after a fix, not from failure
  analysis. Anthropic's wording: "we have been underreporting OSWorld performance
  across our model families" (`[A-SC]` Opus 4.8 §8.12.6).
- On Windows, the one study that attributes failures puts the majority on
  accessibility-only observation (`[UFO2]`). That is one 2025 system on GPT-4o; no
  2026 frontier per-domain result on Windows was found. The AndroidWorld baseline
  that looked harness-dominated in its first version is 10.5% in its second.
- Prompt-level fixes are weak. All `1src`:
  - Anthropic's scaffold refinements (batch actions, declare infeasible early,
    show the remaining budget) moved a prior model from 72.7% to 72.6% on 361
    tasks (`[A-SC]` Opus 4.7 §8.9.4, `V`).
  - An in-loop VLM completeness check removed 2–14 of about 100 false DONEs
    (`[VLAA]`, `V2`).
  - An "ignore pop-ups" system prompt left attack success at 93.3 → 95.9
    (`[POP]`, `V`).
  - The HCU usage skill cut malformed calls twelvefold and moved the score 1.6
    points (`[HCU]`, `V2`).
  - The exception is the impossible-task case, where a discouraging prompt cut
    fabrication from 9.4% to 2.8% of runs for Opus 4.8 (`[A-SC]`, `V`, n not
    published).

### 3. Where tool design actively causes failures

Each item is a design choice, not a model weakness.

1. **The action result carries no outcome.**
   - Anthropic: none of the 17 members of `computer_toolset_20260801` reads
     application state; the official SDK answers a click with "a short
     confirmation, such as `Clicked.`" (`[A-SDK]`, `V`). The docs concede the
     consequence: "Claude sometimes acts as if its actions succeeded without
     explicitly checking their results" (`[A-DOCS]` prompting tips, `V`).
   - OpenAI: the loop ends when the model stops returning `computer_call` items.
     The guide tells integrators to "check the actual outcome instead of relying
     only on the model's final answer" (`[O-CU]` "Run safely", `V`), and the
     sample app's README says "A final answer does not prove the task succeeded"
     (`[O-APP]`, `V`).
   - Both vendors state the need and ship no mechanism. This is the direct cause
     of the false-DONE rows in §1a.
2. **A downscaled screenshot is the only observation.**
   - Anthropic's `zoom` action exists for this reason: it "lets Claude read small
     text or dense UI that isn't legible in a downscaled full screenshot"
     (`[A-DOCS]`, `V`). It was opt-in in `computer_20251124` and is on by default
     in the 2026-08 toolset. No measured effect of zoom is published.
   - Zoom itself broke when combined with batched actions in Anthropic's own
     harness (§1c, 4.8–5.8 points).
   - OpenAI's fix was an `original` image-detail level (§1c, 9.3 points).
3. **Coordinate mapping is pushed to the integrator.**
   - Anthropic: "the toolset takes no display dimensions and the API doesn't
     downscale for you", so the integrator must keep the scale factor; the docs
     list "Clicks consistently offset in one direction" as the symptom
     (`[A-DOCS]`, `V`).
   - Gemini: a normalized grid that the docs describe both as 0–999 and as
     "1000x1000" (`[G-DOCS]`, `V`).
   - UI-TARS needs `smart_resize` back-mapping; Agent S3 needs the grounding
     model's output resolution passed by hand (`V`, READMEs).
   - No source publishes a failure rate for this class.
4. **Fixed sleeps instead of waiting on state.**
   - Anthropic quickstart: `_screenshot_delay = 2.0` (`[A-QS]`, `V`).
   - OSWorld reference harness: `def step(self, action, pause=2)` (`V`, code).
   - Gemini reference harness: `time.sleep(0.5)` before each screenshot, with the
     comment "Even if Playwright reports the page as loaded, it may not be so"
     (`[G-REPO]`, `V`).
   - Combined with a 6.5-second observe-to-act gap (`[FOCUS]`), the agent acts on
     a screen that may no longer exist.
5. **Simulated keystrokes with no read-back.**
   - Anthropic quickstart types through `xdotool` in 50-character chunks; a user
     issue shows CJK text arriving with characters missing (`[A-QS]` issue #71,
     `V`, unconfirmed by Anthropic).
   - On Windows, `pyautogui` text entry is captured by the IME as Pinyin (`[WW]`
     App. B.3, `V`).
   - The OSWorld harness notes that its commands are "not idempotent: replaying
     one that already reached the guest types the text a second time" (`V`, code
     comment).
   - Measured once: 9 of 105 baseline failures on AndroidWorld (`[MINI]` v2, `V`
     `1src`). Removing the read-back check from that paper's full system changed
     success by −0.6 points (95% CI −7.2 to +6.7).
6. **Errors swallowed, stale evidence returned.**
   - Microsoft's reference loop for the OpenAI tool prints an action exception and
     then sends a normal screenshot, and reuses a cached screenshot when capture
     fails (`[O-AZ]`, `V`).
7. **Safety machinery that halts or reroutes the task.**
   - OpenAI: on the GA `computer` tool a fired safety check stops the task in the
     API; the acknowledge flow is rejected (`[O-CU]`, `[O-SDK]`, `V`).
   - Gemini: a `require_confirmation` decision must be echoed back or the API
     returns HTTP 400 (`[G-DOCS]`, `V`).
   - Anthropic: 38 of 40 successful prompt injections against Fable 5.2 (out of
     2,800 attempts) arrived through the safeguard fallback model that took over
     mid-task (`[A-SC]` Fable 5.2 §5.2.2.2, `V` `1src`).
8. **Scoring that rewards giving up.**
   - Infeasible tasks pass on FAIL, and at least one agent harness maps
     `CALL_USER` to `FAIL` (`[PCE]`, OSWorld issue #177, `V`).
   - Windows Agent Arena's shipped aggregator scores `False`, `None` and `error`
     as 1.0 (`[WAA86]`, `V`, open issue).
9. **History truncated to a few screenshots.**
   - Three turns in the Gemini reference harness and the OSWorld harness; twenty
     in the CUA-Recovery setup, so at takeover depths 20–25 the frame that caused
     the error has left context (`[REC]`, `V`).
10. **Extra scaffold layers.**
    - A hierarchical planner cost 9.1 points (§1c). An accessibility-tree dump
      costs 3–26 seconds per observation (`[OSH]` §3.3, `V`) and is used by 2 of
      144 leaderboard rows (`[LB]`, `V`).
11. **Code and terminal tools beside the GUI — a double edge.**
    - They add about 10 points of success (§1c).
    - They also produce interface bypass in 72 of 216 long-horizon trajectories
      and force-killed applications (§1e).
    - OpenAI now recommends code execution over the `computer` tool for its
      current flagship (`[O-CU]`, `V`).
    - `[INFERENCE]` As agents leave the GUI wherever they can, a verdict tied to
      the action path stops working. The oracle has to be independent of how the
      change was made.

### 4. What each lever would and would not fix

Lever vocabulary follows `f1-ef-fault-taxonomy.md`.

#### State oracle

Would fix:

- **Detection of false completion**, the largest measured symptom: 91–105 of 361
  tasks at 100 steps (§1a). Alternatives are measurably worse: a screenshot VLM
  judge accepts 15–28% of failed runs; an in-loop VLM check removes 2–14 of about
  100 false DONEs; a hard-coded state verifier agrees with humans on 113 of 120
  tasks against 95 of 120 for an LLM judge (§1d).
- **The last mile on long work**: every top system loses 31–37 points between
  partial and strict score, and spends under 7% of its budget on checking (§1f).
- **Selection among attempts**: a narrative judge already buys 7.3 points at
  N=10; at N=4 its selections reach 66.5 against a Pass@N ceiling of 74.7
  (`[S3]` Tables 1, 5).
- **Infeasible and missing-object cases**: 19 of 144 frontier failures, and the
  9–35% fabrication rate in Anthropic's impossible-task evaluation.

Would not fix:

- **Task success by itself.** Recognising an inherited error lifts the pass rate
  from 12.2% to 15.6% (`[REC]`). Self-debugging adds 1.4 points over a blind
  re-run (`[CUAD]` Table 3: 13.89% → 15.28% of 144 failures). The completeness
  check adds 2.9 points for one model and costs 2.9 for another at a different
  budget (`[VLAA]`).
- **Its own errors.** 76 of 450 executions hit checker-side errors before
  calibration; 10 of 57 OSWorld FAIL verdicts were wrong; generated verifiers
  missed a corrupted document 38 times out of 38 (§1d). The oracle needs mutation
  testing and an `uncertain` verdict, both of which M1 already points at.
- **The 34 of 144 failures that are pure reasoning or perception** (§1b).

`[ESTIMATE]` What a gate plus one retry is worth, with the method:

- Start from `[VLAA]`: 105 of 361 tasks (29.1%) end in a false DONE (Sonnet 4.6,
  100 steps).
- A blind re-run fixes 13.89% of 144 failures; a re-run given a machine
  root-cause analysis fixes 28.47% (`[CUAD]` Table 3). A state oracle says *which*
  postcondition failed, which is more than nothing and less than a root cause,
  so its fix rate should lie between those two.
- 0.291 × 0.1389 = **4.0 points**; 0.291 × 0.2847 = **8.3 points**.
- Assumptions that could break this: both inputs are single-source; the fix rates
  come from a different model and step budget (Claude 4.5 Sonnet, 50 steps) than
  the failure pool; `[CUAD]` itself cautions that its table compares packages;
  and `[VLAA]` does not state its adjudicator. Treat 4–8 points as a planning
  range to be tested, not a result.

#### Fault injection

Would measure:

- The classes with published damage: pop-ups and overlays (success roughly
  halves), non-default starting state (−17 to −34 points), resolution change,
  missing objects, login walls (§1e).
- The class nobody has measured: **false success under a fault**. Every
  perturbation benchmark found reports success only. None reports a detection
  rate or a false-success rate under perturbation.
- The faults nobody has injected on a desktop: killed application, interrupted
  save, permission denied, disk full. Two targeted searches returned nothing. The
  nearest are Android crashes (`[DGARA]`) and a network-error class (`[HIJ]`).
  The five EF-003 classes in `f1-ef-fault-taxonomy.md` are therefore unmeasured
  in the literature, which is both their value and their risk.

Would not fix anything by itself. It is a measurement. Its second use is as a
conformance suite for the tool layer: the Anthropic zoom defect and the WAA
aggregator defect are both the kind a harness self-test catches.

Evidence against large effects: several benign perturbations cost 2–3 points
(§1e). Measured damage concentrates in overlays, changed starting state,
resolution, and missing objects.

#### Verified procedures

Would fix:

- **Run-to-run inconsistency.** Simular's compiled policies raise Pass^3 by
  3.6–15.8 points on 361 OSWorld and 169 ScienceBoard tasks (`[NSPI]` Table 1,
  `V2` `1src`) against a 9–15 point Pass^1-to-Pass^3 gap in uncompiled agents.
- **Cost.** Per-run cost falls 15–217× and latency 3.4–5.1×; construction costs
  $2.03–6.45 and 33–49 minutes per task; break-even is 3.1–26.8 runs (`[NSPI]`
  Tables 1, 3, `V2` `1src`). A record-and-replay pilot ran 16 desktop tasks at
  100% success in 34 s, against a Gemini 3 Pro agent at 89.38% in 329 s (`[GPA]`
  Table 2, `V` `1src`, pilot scale).
- **Stale-state and wrong-target actions**, through per-step preconditions
  (§1c), and step waste (§1f).

Would not fix:

- **Single-run capability.** Pass^1 is flat or slightly lower: 55.9 → 53.6 and
  74.1 → 72.9 on OSWorld (`[NSPI]` Table 1).

Evidence against (all `[NSPI]` rows are `V2` `1src`):

- Compilation without validation collapses: 74.1 → 46.7 Pass^1 (`[NSPI]`
  Batch2Code row).
- On long workflows the compiled policy "trails the base agent at k=3 by 5.6
  points in strict success and by 18.5 points in partial credit" (`[NSPI]` §4.5).
- 40–45% of varied instances are not handled reliably: Pass^3 is 55.0% over 40
  parameter families and 60.0% over 35 initial-state families (`[NSPI]`
  Table 2).
- Its pre-action verifier wrongly passed 17 of 24 or 6 of 24 primitives on
  perturbed starting states, depending on the verifier model (`[NSPI]` §4.6).
- Fixing the plan does not consistently improve Pass^3 (0.222 → 0.219, 0.125 → 0.188, 0.152 → 0.169) (`[REL]`, `V` `1src`).
  Unvalidated experience memory lowered success from 25.3 to 20.8 on 154 tasks in
  one configuration (`[UFO2]` Table 6, `V` `1src`).
- Agents call available tools in at most 36.3% of tasks (`[OSMCP]`, `V2` `1src`).
- **How often a procedure breaks when the application changes is not measured
  anywhere.** See §6, gap 4.

`[INFERENCE]` The weak part of the competitor's pipeline is its judge, not its
compiler. Simular's policy judges accept only 11.4–40.1% of reliable policies
("They are therefore conservative, which increases construction cost without
hurting reliability"), and its
divergence judge found 0 of 6 failures that happen inside a script (`[NSPI]`
§4.7, App. B.3). A procedure validated by a state oracle instead of a model judge
is the differentiated version of this lever. That makes the oracle a dependency
of procedures, not a sibling.

### 5. By lab and by open-source system

#### Anthropic computer use

Every row is `1src`: Anthropic's own documents.

| Topic | Finding | St. |
|---|---|---|
| Tool versions | `computer_20241022`: 10 actions, no scroll or wait. `computer_20250124`: adds scroll, wait, triple_click, hold_key, left_mouse_down/up. `computer_20251124`: adds zoom, opt-in. `computer_toolset_20260801` (out of beta 2026-08-19): 17 member tools, zoom on by default, batch actions | `V` (`[A-QS]` code, `[A-DOCS]`, `[A-RN]`) |
| Stated motivation for each change | Not found for the 2025 versions | gap |
| Documented limits | Coordinates may be hallucinated; reliability lower on niche or multiple applications; "Complex spreadsheet operations might still require multiple attempts"; "Do not use Claude for tasks requiring perfect precision … without human oversight" | `V` (`[A-DOCS]` Limitations) |
| OSWorld-Verified over time | Sonnet 4.5 61.4% → Opus 4.5 66.26% → Opus 4.6 72.7% → Opus 4.7 78.0% (82.8% after the harness fix) → Opus 4.8 83.4% → Fable 5 and Mythos 5 85.0%. 361 tasks, 100 steps, 1080p, 5 runs | `V`, Opus 4.7 `(OCR)` |
| First release | Claude 3.5 Sonnet (new): 14.9% at 15 steps, 22% at 50, screenshot-only, original OSWorld | `V` |
| OSWorld 2.x, partial / strict | Fable 5.2 89.3 / 54.6 and Opus 5.5 87.2 / 53.2 on the 82-task offline subset; Opus 5.5 81.8 / 48.7 on 108 tasks | `V` |
| Prompt injection, GUI, adaptive attacker | 14 scenarios × 200 attempts = 2,800 attempts per model, no safeguards: per-attempt success 41.8% (Sonnet 4.5) → 17.8% (Opus 4.6) → 0.07–7.14% for the twelve cards from Mythos Preview onward (Opus 4.8 is the 7.14%; the five most recent are 0.07–1.43%, Fable 5.2 being 40 of 2,800) | `V` |
| Impossible GUI tasks | Workaround fabricated in 9.4–34.5% of runs, neutral prompt; n not published | `V` |
| Claimed-but-unverified work, non-GUI | 16 of 886 internal sessions "reported work as done or verified when it wasn't" (Mythos 5, mostly coding) | `V` |
| Reference harness | Fixed 2 s settle delay; typing in 50-character chunks; no iteration cap; no post-action check beyond the screenshot | `V` (code) |

Claude 3.7 Sonnet and Opus 4 have no OSWorld figure in their system cards. A
remembered "about 28%" for 3.7 is `UNVERIFIED`.

#### OpenAI CUA, Operator and the Responses computer tool

Every row is `1src`.

| Topic | Finding | St. |
|---|---|---|
| Loop evolution | One action per call (`computer-use-preview`, 2025) → batched `actions[]` (GA `computer` tool) → code execution recommended over the `computer` tool for the current flagship | `V` (`[O-INT]`, `[O-CU]`) |
| Scores | CUA 38.1% OSWorld at 200 steps (2025) → GPT-5.4 75.0% → GPT-5.5 78.7% (OSWorld-Verified). No step budgets published after January 2025 | `V`; GPT-5.4 `V2` |
| Launch scaffolding | The 2025 OSWorld run told the model "You have full authority to execute any action without my permission"; 35 WebVoyager tasks removed as broken | `V` (`[O-CUA]` eval PDF) |
| Unintended actions | Operator: 13 of 100 unmitigated prompts ended in an error "that caused some nuisance", 5 of them irreversible or possibly severe; confirmation recall 92% on 607 tasks | `V` (`[O-OPSC]`) |
| Prompt injection | Operator: 23% susceptibility with mitigations against 62% without, on 31 scenarios | `V` (`[O-OPSC]`) |
| False completion | No computer-use figure. Coding only: GPT-5.5 "lied about completing an impossible programming task in 29% of samples" (n not published) | `V` (`[O-55SC]` §9.2.1) |
| Third-party failure taxonomy | GPT-5.4 GUI agent, 80 sampled failures: workflow execution 49 (61.3%), UI navigation and control discovery 31 (38.7%). A "self-checking and verification gap" is defined but not counted | `V` (`[GUICLI]` §6; counts inferred from the percentages) |
| Third-party, web | Operator on Online-Mind2Web, 300 tasks at 61.3% success: "Filter & Sorting" 57.7% and navigation 19.6% of errors (error count not confirmed) | `V` (`[OM2W]` Table 2; Fig. 7, §5.1) |
| Sample-app issues | 15 of 30 issues read were harness or tool-design reports (a share of issues, not a failure rate) | `V`, grouping by the research agent |

#### Gemini computer use

This is coverage-brief gap 5. The public numbers are thin: headline scores from
Google's own model cards, with no harness, step budget or run count stated on the
cards, no third-party reproduction, and no failure breakdown of any kind. Every
row is `1src`. Read the scores as "the card says", nothing stronger.

| Topic | Finding | St. |
|---|---|---|
| Scope | Gemini 2.5 Computer Use: "It has not yet been optimized for OS-level control or mobile control". That preview was shut down on 2026-07-28. Current docs list browser, mobile and desktop environments on Gemini 3.x and 4 models | `V` (`[G-MC]` p.2, `[G-DOCS]`) |
| 2.5 scores (web and mobile only) | Online-Mind2Web 69.0% of 300 tasks (official leaderboard) against 65.7% on the Browserbase harness; WebVoyager 88.9% of 559 tasks against 79.9%; AndroidWorld 69.7% of 116 tasks, single seed. No OSWorld score: "OS control not yet supported" (the row's labelling is ambiguous in the extracted PDF text) | `V` (`[G-MC]` p.3, `[G-EVAL]`) |
| Desktop score, 3.5 Flash | OSWorld-Verified **78.4%** (Gemini 3 Flash 65.1%, Gemini 3.1 Pro 76.2%). Card published 2026-05-19. Harness, step budget and run count are not on the card | `V2` (`[G-35]`) |
| Desktop score, Gemini 4 Argon | OSWorld-2.0, offline subset, partial score **69.2%** against GPT-6 Astra 72.6%. Card published 2026-10-13. Methodology not on the card | `V2` (`[G-4A]`) |
| Failure taxonomy | **None published** by Google for any computer-use model, and none found from a third party. The 2.5 card names "clicking the wrong button or filling the wrong form" with no rate | `V` (absence, three documents) |
| Safety numbers | No prompt-injection, confirmation or per-step safety-service rates for computer use in the cards or docs. The injection detector is opt-in and off by default | `V` (`[G-DOCS]`, `[G-35]`, `[G-4A]`) |
| Harness-caused failure reports | Reference-repo issues: click coordinates outside the 0–1000 range "after approximately 15 iterations" (one reporter); docs and code disagreed on the `press_enter` default. Counts of issues, not rates | `V` (`[G-REPO]` issues #83, #84) |
| Third-party fault injection | Gemini-3-Pro (a general model, not the Computer Use tool), 236 AndroidWorld-based tasks with one injected trap each: 72.9% → 63.6% | `V` (`[ANTRAP]` Table 3) |

`UNVERIFIED` for Gemini: how any of the desktop scores was measured; whether the
Gemini 4 Argon safety report contains computer-use numbers (not fetched); Project
Mariner's reported wind-down and its 83.5% WebVoyager figure (search snippets
only).

#### Open-source harnesses

TIF-105 scope item 2: what each system publishes about its own failures. Every
row is `1src`.

| System | What is published about its failures | St. |
|---|---|---|
| Cua (trycua) | No first-party evaluation or failure analysis found. One third-party study on the Cua harness: 4 of 25 KiCad tasks pass; 5 of 9 DONE claims fail a state check; error-mode mentions split planning and policy 40%, perception 22%, navigation inefficiency 19%, domain knowledge 11%, tool or API surface 8% (count of mentions not published) | `V2` (`[SNK]`) |
| Agent S (2024) | GPT-4o, 65-task OSWorld subset: execution errors in 39, grounding in 26 and planning in 17 of an inferred 49 failed tasks, non-exclusive | `V` (`[AS1]` Table 3) |
| Agent S2 (2025) | Planning 41.0%, grounding 20.5%, interaction 17.9%, navigation 10.3%, infeasible not recognised 10.3%; n not published (≈39 back-solved); figure labels, readable only in the PDF | `V` (`[S2]` Fig. 8) |
| Agent S3 (2025) | No failure breakdown. Removing hierarchical planning adds 9.1 points; best-of-10 with a judge lifts 62.6 → 69.9 on 361 tasks. On 159 mixed-outcome tasks the judge's selections agree with the benchmark scripts on 78.4% and with humans on 92.8%; 8 of its 12 human-judged errors are narrative hallucinations | `V2` (`[S3]` Tables 1, 2, 4; §4.5) |
| Simular Sai / NSPI | Compiled policies and their judges: §4 | `V2` (`[NSPI]`) |
| UI-TARS and UI-TARS-2 | No failure breakdown published. UI-TARS-2 reports OSWorld 47.5, Windows Agent Arena 50.6 and AndroidWorld 73.3, with no run-to-run variance for GUI benchmarks. Its learned outcome verifier scores F1 83.8 on 300 human-annotated traces, and the paper states "the current ORM still exhibits a relatively high false positive rate" | `V` (`[UT2]` Table 1, §3.3) |
| OpenCUA | Six failure classes named with no rates: task knowledge, high-precision grounding, action repetition, termination misjudgment, long-horizon, error perception and recovery. Run-to-run: OpenCUA-72B Pass@3 53.02% against a 3-run mean of 44.99% at 100 steps on OSWorld-Verified | `V` (`[OCUA]` Table 11, App. E) |
| OpenCUA, third-party diagnosis | OpenCUA-72B on OSWorld; categories assigned by an LLM, not exclusive, no denominator: action loops 43%, coordinate precision 24%, UI recognition 19%, multi-step planning 15%. Four harness patches lift 42.3 ± 2.6 → 48.9 ± 1.2 over 3 runs | `V` (`[LFF]` §3.6, Fig. 6; Table 2) |
| Microsoft HCU | No per-category failure analysis and no per-error-code distribution. Tool-call errors: §1c | `V2` (`[HCU]` Table 11) |
| Microsoft UFO2 | Control detection 62.8% of failures on Windows Agent Arena: §1c | `V2` (`[UFO2]` §6.2) |
| PC Agent-E | An error review of 50 trajectories names knowledge, planning and grounding with no shares | `V` (`[PCE]` §5.2) |

### 6. Gaps and unverified items

Against the TIF-105 spec: scope items 1 and 2 are in §5, items 3 and 4 in §1
(§1.0 is keyed to the spec's eight failure types), item 5 in §3.

#### Against the coverage brief's five gaps

| Brief gap | Outcome |
|---|---|
| 1. Per-category failure breakdowns with denominators | Covered: §1b (`[CUAD]`, n=144), §1a, §1e. AndroidWorld has only `[MINI]` (n=105) and Windows Agent Arena only `[UFO2]` (n not published) |
| 2. Failures caused by harness or tool design | Covered: §1c, §2, §3 |
| 3. False-success and unverifiable-success rates | Covered: §1a, §1d. No vendor publishes one for computer use |
| 4. UI-drift failure rates for procedures (TIF-100) | **Not covered. The gap stands.** Details below |
| 5. Gemini computer-use public numbers | Thin. Two desktop headline scores, no methodology, no failure data. See §5 |

#### Gap 4: procedure breakage under UI drift is still unmeasured

None of the seven research reports found a drift or breakage rate for replayed or
compiled procedures. One further targeted pass found none either. **No rate is
given here and none is estimated.** `m2-04-procedure-learning.md` §5 reached the
same conclusion ("Not found … Treat 'compiled workflows drift as apps update' as
unquantified") and this sweep does not change it.

What exists, and why none of it is the missing number:

| Source | What it measures | Why it is not a drift rate | St. |
|---|---|---|---|
| `[NSPI]` §4.3, Table 2 | Compiled policies under parameter and starting-state variation: Pass^3 55.0% over 40 families and 60.0% over 35 | Same application version. Variation in inputs, not in the interface | `V2` `1src` |
| `[NSPI]`, `[GPA]` | Compile-and-replay systems | Neither reports a replay-failure, self-healing or fallback rate, and neither changes the application | `V` (absence) |
| `[AAC]` Tables 9, 10 | Recorded macOS workflows replayed under dark mode, zoom and a different starting state: 9 of 9 in each condition, 36 of 36 overall; 50 of 50 with no change | Synthetic visual changes on one machine. No application update. The authors say the results "should not be read as evidence of robustness to arbitrary interface redesign" | `V` `1src` |
| `[RB]` | 449 reproducible web locator breaks across 4 projects | Web tests only. It reports no breakage rate per version or release | `V` `1src` |
| Hammoudi et al. 2016, as cited by `[RB]` | Locators caused 73.6% of 1,065 test breakages across 453 web application versions | A share of causes among breakages, not how often a test breaks. Web record/replay tests, not desktop procedures | `S` (read only as a citation) |
| PACE and OpenApps, in `m2-04` §5 | Mobile programs under synthetic GUI changes; agents across app variants | Already recorded in `m2-04` as inference-only for a desktop office suite | see `m2-04` |

What TIF-100 would have to produce, since nothing published does: the share of
verified procedures that fail, and the share that fail silently, across real
version changes of a desktop application.

#### Other gaps

- **No vendor publishes a computer-use failure taxonomy or a false-success rate.**
  Every lab share above is derived from a delta or taken from a third party.
- **No 2026 frontier per-domain result on Windows.** The Windows rows rest on
  2024–2025 models. Whether Office on Windows is still the residual is unknown.
- **No desktop study injects a killed app, interrupted save or permission denial
  and measures the agent's report.**
- **No direct claim-versus-evaluator confusion matrix** for frontier agents with a
  stated adjudicator. `[VLAA]` is the nearest and omits the adjudicator.
- **OSWorld-Verified's 300+ fixes are not broken down by class.**

#### Reading-quality flags

- Read through OCR, unconfirmed against a page render: Opus 4.7 OSWorld 78.0%,
  Sonnet 5 81.2%, the ScreenSpot-Pro 69.0 / 85.9 pair.
- First read through a page summary, then confirmed against the page's own text:
  `[VERI]` Table 1, `[HCU]` Tables 10 and 11, `[CUAD]` Table 7, `[CUBE]` Table 6,
  `[MAC]` Table 5, `[ANTRAP]` Table 3.
- Readable only in the PDF, not in the HTML text: the `[UFO2]` Figure 19 labels
  (62.8%) and the `[S2]` Figure 8 labels.
- Internal inconsistencies in sources, left as found: `[VLAA]` denominators;
  `[NSPI]` introduction and abstract give different Pass^3 gain ranges (the
  abstract matches the table); `[MAC]` and `[WGUI]` each have a table whose totals
  do not add up; `[OCUA]` gives Pass@3 as 53.02% in Table 11 and 53.2% in its
  text; `[OSW2]` gives Opus 4.8 as 20.6 / 54.8 in Table 3 and 20.5 / 54.2 in its
  text.
- `[MINI]` changed between versions. v1 reported 42 failures and a 15-point
  verification ablation; v2 (2026-11-16) reports 105 failures and no single
  mechanism with a significant effect. This doc uses v2 throughout.
- `UNVERIFIED`: Operator o3 benchmark scores (42.9 / 62.9, press only); Claude 3.7
  Sonnet on OSWorld; Project Mariner.

### Sources

All accessed 2026-11-22.

| Key | Source |
|---|---|
| `[A-DOCS]` | Anthropic, computer use tool docs — <https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool> |
| `[A-SDK]` | Anthropic, browser and computer use SDK docs — <https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-sdk> |
| `[A-RN]` | Anthropic, API release notes — <https://platform.claude.com/docs/en/release-notes/overview> |
| `[A-QS]` | `anthropics/claude-quickstarts`, `computer-use-demo` — <https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo> |
| `[A-SC]` | Anthropic system cards, index — <https://www.anthropic.com/system-cards>. Cards cited by name, section and page in the tables |
| `[O-CU]` | OpenAI, computer use guide — <https://developers.openai.com/api/docs/guides/tools-computer-use> |
| `[O-INT]` | OpenAI, computer use integration recipes — <https://developers.openai.com/api/docs/guides/tools-computer-use-integration> |
| `[O-54]` | OpenAI, "Introducing GPT-5.4", 2026-03-05 — <https://openai.com/index/introducing-gpt-5-4/> |
| `[O-CUA]` | OpenAI, Computer-Using Agent — <https://openai.com/index/computer-using-agent/>; eval details <https://cdn.openai.com/cua/CUA_eval_extra_information.pdf> |
| `[O-OPSC]` | OpenAI, Operator system card — <https://openai.com/index/operator-system-card/> |
| `[O-55SC]` | OpenAI, GPT-5.5 system card — <https://deploymentsafety.openai.com/gpt-5-5> |
| `[O-APP]` | `openai/openai-cua-sample-app` — <https://github.com/openai/openai-cua-sample-app> |
| `[O-SDK]` | `openai/openai-agents-python` issue #2741 — <https://github.com/openai/openai-agents-python/issues/2741> |
| `[O-AZ]` | Microsoft Learn, Computer Use in Azure OpenAI — <https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/computer-use> |
| `[G-DOCS]` | Google, Gemini API computer use docs — <https://ai.google.dev/gemini-api/docs/computer-use> |
| `[G-MC]` | Gemini 2.5 Computer Use model card — <https://storage.googleapis.com/deepmind-media/Model-Cards/Gemini-2-5-Computer-Use-Model-Card.pdf> |
| `[G-EVAL]` | Google, computer use eval additional information — <https://storage.googleapis.com/deepmind-media/gemini/computer_use_eval_additional_info.pdf> |
| `[G-35]` | Gemini 3.5 Flash model card, 2026-05-19 — <https://deepmind.google/models/model-cards/gemini-3-5-flash/> |
| `[G-4A]` | Gemini 4 Argon model card, 2026-10-13 — <https://deepmind.google/models/model-cards/gemini-4-argon/> |
| `[G-REPO]` | `google/computer-use-preview` — <https://github.com/google/computer-use-preview> |
| `[OSW]` | OSWorld — <https://arxiv.org/abs/2404.07972> |
| `[OSW2]` | OSWorld 2.0 — <https://arxiv.org/abs/2606.29537> |
| `[LB]` | OSWorld-Verified leaderboard data file — <https://osworld-v1.xlang.ai/static/data/osworld_verified_results.xlsx> |
| `[EP1]` | Epoch AI, "What does OSWorld tell us about AI's ability to use computers?" — <https://epoch.ai/blog/what-does-osworld-tell-us-about-ais-ability-to-use-computers> |
| `[EP2]` | Epoch AI, OSWorld 2.1 review — <https://epoch.ai/benchmarks/osworld-2-1/review> |
| `[CUAD]` | CUADebug / CUAErrorBench — <https://arxiv.org/abs/2608.02643> |
| `[MIS]` | How Benchmarks Mis-Score Computer-Use Agents — <https://arxiv.org/abs/2607.28367> |
| `[VLAA]` | VLAA-GUI: Knowing When to Stop, Recover, and Search, A Modular Framework for GUI Automation, v3 — <https://arxiv.org/abs/2604.21375> |
| `[CANDID]` | CANDID: Candidate-Driven Intervention for Disciplined Execution in Local Computer-Use Agents — <https://arxiv.org/abs/2611.24977> |
| `[OSC]` | OSCAR: Operating System Control via State-Aware Reasoning and Re-Planning (source of the FRIDAY baseline's failure statistics) — <https://arxiv.org/abs/2410.18963> |
| `[OSH]` | OSWorld-Human — <https://arxiv.org/abs/2506.16042> |
| `[REC]` | CUA-Recovery — <https://arxiv.org/abs/2610.27645> |
| `[SREC]` | When to Intervene? An Empirical Study of Errors and Self-Recovery in LLM Agents — <https://arxiv.org/abs/2610.36471> |
| `[BEAP]` | BEAP-Agent: Backtrackable Execution and Adaptive Planning for GUI Agents — <https://arxiv.org/abs/2601.21352> |
| `[RETR]` | Lost in Recovery: Demystifying Recovery Behavior of Computer-Use Agents via Goal-Oriented Action Replay (ReTrace) — <https://arxiv.org/abs/2610.27954> |
| `[OC]` | OpenComputer — <https://arxiv.org/abs/2605.19769> |
| `[VERI]` | VeriCUA — <https://arxiv.org/abs/2610.40578> |
| `[OSR]` | OSReward — <https://arxiv.org/abs/2607.28609> |
| `[SCALE]` | Scale Labs, "Who Grades the Graders?" — <https://labs.scale.com/blog/verifier-design-for-cua> |
| `[AWAUD]` | Can Agent Benchmarks Support Their Scores? — <https://arxiv.org/abs/2605.10448> |
| `[AS1]` | Agent S — <https://arxiv.org/abs/2410.08164> |
| `[S2]` | Agent S2 — <https://arxiv.org/abs/2504.00906> |
| `[S3]` | Agent S3, "Scaling Agents for Computer Use" — <https://arxiv.org/abs/2510.02250> |
| `[NSPI]` | Neuro-Symbolic Computer Use (Simular) — <https://arxiv.org/abs/2609.36927> |
| `[REL]` | On the Reliability of Computer Use Agents — <https://arxiv.org/abs/2604.17849> |
| `[GPA]` | GPA: Learning GUI Process Automation from Demonstrations — <https://arxiv.org/abs/2604.01676> |
| `[AAC]` | AppAgent-Claw — <https://arxiv.org/abs/2606.05171> |
| `[RB]` | ReproBreak — <https://arxiv.org/abs/2605.12158> |
| `[HCU]` | Hybrid Computer Use — <https://arxiv.org/abs/2610.41432> |
| `[UT2]` | UI-TARS-2 — <https://arxiv.org/abs/2509.02544> |
| `[OCUA]` | OpenCUA — <https://arxiv.org/abs/2508.09123> |
| `[LFF]` | Learning from Failure: Inference-Time Self-Improvement for Computer-Use Agents — <https://arxiv.org/abs/2606.31270> |
| `[UFO2]` | UFO2: The Desktop AgentOS — <https://arxiv.org/abs/2504.14603> |
| `[COACT]` | CoAct-1 — <https://arxiv.org/abs/2508.03923> |
| `[OSMCP]` | OSWorld-MCP — <https://arxiv.org/abs/2510.24563> |
| `[MCPW]` | MCPWorld — <https://arxiv.org/abs/2506.07672> |
| `[WAA]` | Windows Agent Arena — <https://arxiv.org/abs/2409.08264> |
| `[WAA86]` | `microsoft/WindowsAgentArena` issue #86 — <https://github.com/microsoft/WindowsAgentArena/issues/86> |
| `[PCE]` | Efficient Agent Training for Computer Use (PC Agent-E, WindowsAgentArena-V2), v2 — <https://arxiv.org/abs/2505.13909> |
| `[WGUI]` | WorldGUI: An Interactive Benchmark for Desktop GUI Automation from Any Starting Point, v5 — <https://arxiv.org/abs/2502.08047> |
| `[WW]` | WindowsWorld — <https://arxiv.org/abs/2604.27776> |
| `[CUBE]` | UI-CUBE — <https://arxiv.org/abs/2511.17131> |
| `[MAC]` | macOSWorld — <https://arxiv.org/abs/2506.04135> |
| `[MINI]` | Do Multi-Agents Dream of Electric Screens? Achieving 100% on AndroidWorld Through Task Decomposition (Minitap mobile-use), v2, 2026-11-16 — <https://arxiv.org/abs/2602.07787> |
| `[SNK]` | Snorkel AI, "Cua-Bench: benchmarking computer-use agents on professional software", 2026-06-15 — <https://snorkel.ai/blog/cua-bench-benchmarking-computer-use-agents-on-professional-software/> |
| `[POP]` | Attacking Vision-Language Computer Agents via Pop-ups — <https://arxiv.org/abs/2411.02391> |
| `[HIJ]` | AgentHijack — <https://arxiv.org/abs/2605.25707> |
| `[DGARA]` | D-GARA — <https://arxiv.org/abs/2511.16590> |
| `[ANTRAP]` | Are Android GUI Agents Robust Against Runtime Anomalies? AnTrap: Evaluating Agents in Dynamic Adversarial Environments — <https://arxiv.org/abs/2608.24099> |
| `[FOCUS]` | Temporal UI State Inconsistency in Desktop GUI Agents: Formalizing and Defending Against TOCTOU Attacks on Computer-Use Agents — <https://arxiv.org/abs/2604.18860> |
| `[GUICLI]` | GUI vs. CLI: Execution Bottlenecks in Screen-Only and Skill-Mediated Computer-Use Agents — <https://arxiv.org/abs/2606.24551> |
| `[OM2W]` | An Illusion of Progress? Assessing the Current State of Web Agents (Online-Mind2Web) — <https://arxiv.org/abs/2504.01382> |

## Decision

**Adopt as the evidence base for M2 planning, with this ranking.** Each bet states
what it would fix, the strongest number for it, and the strongest number against.
Every number in the table is single-source; the tags are in §1–§4.

| Rank | Bet | Fixes | Strongest evidence for | Strongest evidence against | Conf. |
|---|---|---|---|---|---|
| **1** | **Completion gate.** No "done" without a state-oracle verdict; three-valued; callable from any harness; oracles mutation-tested | Silent false success | 91–105 of 361 tasks end in a false DONE at 100 steps; 5 of 9 DONE claims fail a state check; a state verifier matches humans on 113 of 120 against 95 of 120 for an LLM judge; both labs tell integrators to do this and ship nothing | Detection alone moves success about 3 points; checkers were wrong in 76 of 450 executions before calibration | high on the problem, medium on the payoff |
| **2** | **Checkpoint oracles with targeted retry** for long and multi-app work | The last mile; multi-app residue | Partial minus strict is 31–37 points for every top system; failing attempts hold 65–76% of credit; multi-app is 42.6% of residual failures; a diagnosed re-run fixes 28.5% of 144 failures against 13.9% blind | The 4–8 point estimate rests on one paper's package comparison; long-horizon graders are themselves error-prone (36 of 50 audited tasks) | medium |
| **3** | **Fault-injected false-success suite**, publishable | Nothing directly; it proves 1 and 2 and tests the tool layer | Nobody publishes false success under faults; no desktop study injects kill, interrupted save or permission denial; lab data show 9–35% fabricated workarounds on impossible tasks; one harness defect hid 22–28% of a lab's failures | Several benign perturbations cost only 2–3 points; a measurement is not a product | high that the ground is open |
| **4** | **Verified procedures**, validated by the oracle | Repeatability and cost | Pass^3 +3.6 to +15.8; per-run cost 15–217× lower; break-even 3–27 runs | Single-run success flat; −5.6 strict and −18.5 partial on long workflows; 40–45% of variants unhandled; breakage under UI drift unmeasured (TIF-100); Simular has published and shipped | medium on the economics, low on M2 timing |
| **5** | **Structural state adapters, built for the oracle** (not as the agent's eyes) | Verdicts where UIA is blind | UIA-only observation caused 62.8% of failures on WAA; screenshot judges err toward false success in 88% of their errors | As agent observation the advantage is shrinking: the accessibility channel is worth 2.8 points with GPT-5.4 (65.59 against 62.79, `[HCU]` Table 2) and is used by 2 of 144 leaderboard rows | medium; an enabler for 1 and 2 |
| **6** | **Guarded steps**: pre-action target and focus check, post-action effect read-back | Stale-state actions, silent input loss | Pre-action check stopped 45 of 45 adversarial focus misdirections at under 0.1 s (`[FOCUS]`); an action-level critic worth 16.3 points in one ablation (`[WGUI]` Table 5); text entry silently wrong in 9 of 105 failures (`[MINI]` v2) | The read-back ablation in `[MINI]` v2 is −0.6 [−7.2, +6.7]; 0 of 144 frontier failures were timing or tool failures; stale-category errors are 88 of 10,783 tool calls (`[HCU]`); Cua and HCU already ship widget-level read-back | low; table stakes, not a bet on its own |

What the ranking says: **bets 1 and 2 first, bet 3 as the proof, bet 5 built per
application as the oracle needs it.** Bet 4 stays an experiment, for three
reasons: it depends on the oracle as its validator, the direct competitor is
ahead on the compiler, and the evidence that it helps on long work is negative.

Bet 6 moved from fourth to last after the first verifier pass. Its support had
rested on two ablations. One of them, `[MINI]`, was replaced in its second
version by a null result: removing typed-text read-back changed success by −0.6
points, with a 95% interval of −7.2 to +6.7. What remains is one ablation on a
GPT-4o agent, one adversarial study by a single author, and 9 of 105 failures in
one baseline. That does not carry a harness lever on its own. Build the
pre-action check that the completion gate and procedures need; do not run
guarded steps as a separate track.

How the bets sit against A/B/C, with no choice implied:

- Bets 1, 2, 3 and 5 are needed under **A** (verified desktops for coding agents)
  and under **B** (verified operations for software without APIs) alike. Bet 6
  is table stakes under both.
- Bet 4 matters most under **B**, where the same operation repeats.
- The sweep found one result that bears on **C** (branchable desktops):
  best-of-N selection is worth 7.3 points at N=10 with a model judge, and forked
  attempts are one way to get N. It found nothing against C.

### Proposed TIF issues

Per the issue-first rule, every piece of work this finding implies is listed as a
proposed issue. Nothing here has been created in Linear. `P-n` labels are
placeholders for the outer loop to replace with real ids.

| Label | Proposed issue | Scope and acceptance | Evidence links | Existing ids it overlaps |
|---|---|---|---|---|
| **P-1** (bet 1) | Completion gate: a state-oracle verdict is required before an agent may report "done" | Expose M1's three-valued verdict as a tool an external agent loop calls. Accept when, on the M1 task family, no false DONE is accepted across at least 30 trials including fault trials, and every oracle fails at least one seeded corruption | §1a `[VLAA]`, `[SNK]`, `[OSW2]`; §1d `[OC]`, `[VERI]`, `[SCALE]`; §3 item 1 `[A-SDK]`, `[O-CU]` | **TIF-101** (verify-before-store, ADR-0017): the same verdict gates what enters the procedure store. Not a duplicate: P-1 gates what the agent may report. `m2-02` already designs "verdicts behind a separate tool" |
| **P-2** (bet 2) | Checkpoint oracles and one targeted retry for long and multi-app tasks | Per-checkpoint postconditions; on a refuted checkpoint, one retry from the last verified point with the verdict fed back. Accept on a measured lift against the baseline arm; reject below 2 points | §1f `[OSW2]`, `[A-SC]`, `[LB]`; §4 estimate `[CUAD]` Table 3 | **TIF-98** (fast VM reset): a retry from a known-good point pays the reset cost; `m2-05` records the default reset as cold, about 21 s |
| **P-3** (bet 3) | Fault-injected false-success suite | Report detection rate and false-success rate per fault class with exact intervals. Add four literature-backed classes to EF-003: pop-up or overlay, non-default starting state, missing object or infeasible request, login wall | §1e `[POP]`, `[HIJ]`, `[WGUI]`, `[A-SC]`, `[DGARA]`; §4 fault injection; `f1-ef-fault-taxonomy.md` | EF-003 (TIF-52), which this extends. **TIF-98**: a fault matrix multiplies trials, so reset time sets its cost |
| **P-4** (bet 6) | Pre-action guard in the runtime, low priority | A target and focus check before each step. Post-action read-back stays inside the oracle (P-1) and is not a separate track. Accept when an injected focus steal is caught before the action lands. Not before P-1 to P-3 | §1c `[FOCUS]`, `[WGUI]` Table 5, `[MINI]` v2 §5.3; §3 items 4, 5 | None of TIF-98..102. Relates to `m2-01` next action 2 (per-action `effect` field) |
| **P-5** (bet 4) | Oracle-validated procedure replay experiment on the M1 task family | Compile one verified run; replay it; report Pass^3, cost per run and break-even against the uncompiled arm. Propose as an extension of TIF-100 and TIF-101, not a new track | §4 verified procedures `[NSPI]`, `[REL]`, `[GPA]`; §6 gap 4 | **TIF-100** (procedure drift): this finding confirms the drift rate is unmeasured and says what TIF-100 must produce. **TIF-101** (verify-before-store): the admission gate is the validator. **TIF-102** (paid-tier teardowns): testing Simular's judge directly needs a Sai key, so only under TIF-102 with Tiffany's approval |
| **P-6** (bet 5) | No new issue | The second-app state read is already **TIF-99** (Writer UNO read). This finding adds the reason to build it for the oracle and not as agent observation | §1c `[UFO2]`; §1d `[OSR]`; §1f `[LB]` | **TIF-99** |
| **P-7** (experiment 1) | Claim-versus-state audit on public trajectories (L2, host only, no spend) | From Simular's public OSWorld 2.1 runs and a sample of public OSWorld-Verified trajectories, record the agent's final claim against the evaluator's score. Falsifier: false DONE under 10% of runs for frontier agents | §1a caveat on `[VLAA]`; §6 "no direct confusion matrix" | None |
| **P-8** (experiment 2) | False-DONE matrix for Myco's own screenshot baseline | From the recorded C1 arm rows, after the arm finishes: share of the baseline's completion claims that the M1 oracle refutes | §1a | TIF-75 (offline replay of recorded C1 arm rows) |

Not worth a bet, with the reason:

- **Click grounding.** 11 of 144 frontier failures and falling; solved by models,
  zoom and separate grounders.
- **Step budgets.** 1 of 144 as a root cause.
- **More planner or reflection layers.** A planner layer cost 9.1 points.
- **LLM or VLM judges as the verifier.** 15–28% false accepts.
- **An accessibility tree as the frontier agent's observation.**
- **Prompt-injection defence.** The labs measure and reduce it every release;
  per-attempt success is at 0.07–1.43% of 2,800 attempts for the five most recent
  Claude models.
- **In-run self-recovery machinery.** Explicit backtracking was worth 1.9 points
  in one study (`[BEAP]` Table 1) and mixed in another (`[RETR]` Table 3: +1.5
  for one model, −3.3 for another). See §1e.

Two consequences for existing repo docs:

- `f1-ef-fault-taxonomy.md`'s five classes (stale UI, interrupted write, partial
  persistence, crash mid-save, permission denied) have no published desktop
  measurement. Keep them: that is the open ground. P-3 adds the four classes that
  do have published effect sizes, so Myco's numbers can be compared with the
  literature.
- `mvp-competitive-teardown.md` §2.5 worries that "verify the final state" is
  prompt discipline a competitor copies with a skill file. The evidence in §2
  says prompt-level verification barely moves outcomes. The worry is not
  supported.

## Proposed smallest experiment

Three steps, cheapest first. The first two need no VM time and no spend.

1. **Claim-versus-state audit on public trajectories** (P-7). Take Simular's
   public OSWorld 2.1 reference runs (`simular-ai/sai-osworld-v21-reference-runs`,
   with per-task scorecards) and a sample of the public OSWorld-Verified
   trajectories. For each run record whether the agent's final message claims
   success and what the evaluator scored. Output: the confusion matrix that
   `[VLAA]` implies and no source publishes with a stated adjudicator.
   - Falsifier: if false DONE is under 10% of all runs for frontier agents, bet 1
     is smaller than claimed and the ranking changes.
2. **The same matrix for Myco's own baseline** (P-8). From the recorded C1 arm
   rows, after the arm finishes and without touching it, compute the share of the
   screenshot baseline's completion claims that the M1 oracle refutes.
3. **Gate-plus-one-retry ablation** (P-2) on the M1 task family, after M1 lands:
   baseline arm against the same arm given the oracle's verdict once and allowed
   one retry. This measures the 4–8 point estimate directly.
   - Falsifier: if the lift is under 2 points, bet 2 falls below bet 3.

## Next action

1. Route this finding to M2 planning and MVP Discovery through the outer loop.
   The A/B/C choice stays with Discovery.
2. Mirror P-1 to P-8 to Linear as proposed issues, linked to TIF-98, TIF-99,
   TIF-100, TIF-101 and TIF-102 as the table shows. No work starts without an id.
3. Mirror the ranked bets and the two doc consequences to TIF-105. The Linear
   connector was not authorized in the session that wrote this, so nothing was
   posted there directly; the plan, progress and summary are on PR #216.
4. Carry gap 4 into TIF-100 as its definition of done.

## Reopen if

- A lab adds an outcome or postcondition field to its computer-use tool contract.
  That collapses bet 1 to "who verifies better", and the ranking must be redone.
- A study with a stated state-based adjudicator puts false DONE under 10% of
  tasks for frontier agents.
- A 2026 frontier model publishes per-domain results on Windows showing Office
  solved. Bet 5 and the Windows rows then need re-reading.
- A compiled-procedure system shows more than 80% Pass^3 on varied instances and
  no loss on long workflows, or a study measures procedure breakage across real
  application versions. Bet 4 is re-ranked either way.
- A benchmark starts reporting false-success or detection rates under injected
  faults. Bet 3 stops being open ground.
- Google publishes a failure breakdown or a methodology for its computer-use
  scores. §5's Gemini table is then redone.
- A controlled ablation shows a pre-action check or post-action read-back lifting
  a frontier agent by a margin whose interval excludes zero. Bet 6 moves up.
- Experiment step 1 or 3 hits its falsifier.

## Cost spent

- Seven research subagents (six Claude Fable, one Claude Sonnet): 464 tool calls,
  about 1.48M tokens.
- Twelve single-page fetches for spot-checks and the two coverage-brief gaps: 22
  tool calls, about 0.47M tokens. All nine pre-synthesis spot-checks confirmed the
  numbers they were sent to check.
- Two web searches for gap 4.
- After the verifier's FAIL at `b15a00f`: a version check of all 46 cited arXiv
  papers against the arXiv listing; 35 single-source re-reads (80 tool calls,
  about 1.74M tokens); a direct text check of 15 papers' pages; and an
  independent recomputation of the leaderboard-derived shares from the public
  data file.
- The independent verifier is launched and settled by the Research Coordinator at
  the final head SHA; its verdict is recorded on the pull request.
- No installs, no accounts, no paid APIs, no VM access. `myco-win11` and the
  running C1 arm were not touched.

Limits of this finding:

- The TIF-105 issue text could not be read from Linear in the session that
  produced this. The outer loop relayed it after the first draft; §1.0 and the
  open-source table in §5 were added to answer it in its own terms.
- The spec names `cheaperinference/deepseek-v4.1-flash` for helpers. The task
  brief and the coverage brief require Claude helpers only and exclude
  cheaperinference; those were followed.
- Nothing here was reproduced. Every rate is a published number or arithmetic on
  published numbers, and almost every one is single-source.
- The first verifier pass failed this finding at `b15a00f`. One source had been
  read at a superseded arXiv version, and several table locators were wrong. Both
  kinds of error were then looked for across every arXiv source, not only the
  ones the verifier sampled.
- The Windows evidence is one model generation older than the Linux evidence.
- Categories from different papers are not interchangeable. Shares are reported
  per source and are not added across sources.
